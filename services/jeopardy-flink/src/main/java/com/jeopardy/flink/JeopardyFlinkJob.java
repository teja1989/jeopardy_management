package com.jeopardy.flink;

import com.jeopardy.flink.adapter.Stage1EventAdapterFunction;
import com.jeopardy.flink.config.PostgresConfigPollingSource;
import com.jeopardy.flink.correlator.PostgresProcessRegistryStore;
import com.jeopardy.flink.correlator.ProcessRegistryStore;
import com.jeopardy.flink.correlator.Stage2AsyncBpmnCorrelator;
import com.jeopardy.flink.correlator.Stage2OutOfOrderBufferFunction;
import com.jeopardy.flink.engine.Stage3MilestoneEngineFunction;
import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.CrossOrderSignal;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.EntityMutation;
import com.jeopardy.flink.model.FlinkTags;
import com.jeopardy.flink.model.RawAuditRecord;
import com.jeopardy.flink.model.RawKafkaMessage;
import com.jeopardy.flink.sink.BatchedClickHouseSink;
import com.jeopardy.flink.sink.BatchedPostgresSink;
import com.jeopardy.flink.sink.KafkaJsonSerializationSchemas;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.contrib.streaming.state.EmbeddedRocksDBStateBackend;
import org.apache.flink.runtime.state.storage.FileSystemCheckpointStorage;
import org.apache.flink.streaming.api.datastream.AsyncDataStream;
import org.apache.flink.streaming.api.datastream.BroadcastStream;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

/**
 * Main Apache Flink 1.20 entry point wiring the complete 3-Stage Jeopardy Management
 * &amp; Predictive SLA Streaming Topology:
 *
 * <ol>
 *   <li><b>Stage 1:</b> BroadcastState 1-to-N Event Adapter, ~95% BPMN Noise Filter, PII Redaction &amp; Parse DLQ.</li>
 *   <li><b>Stage 2:</b> Non-blocking AsyncDataStream + Caffeine/PG {@code parentProcessInstanceId} &amp; Fallout Correlator + 15s OOO Buffer &amp; Uncorrelated DLQ.</li>
 *   <li><b>Stage 3:</b> Keyed RocksDB Version-Pinned Milestone DAG, Fallout Overlay, Cross-Order SLA Signals, Processing-Time Timers &amp; Embedded ONNX Runtime Scorer.</li>
 *   <li><b>Hardened Sinks:</b> Key-sorted Micro-Batched PostgreSQL 16 Sink, ClickHouse Batch HTTP Sinks, Kafka SSE Deltas, Alerts, Cross-Order Signals &amp; DLQs.</li>
 * </ol>
 */
public class JeopardyFlinkJob {
    private static final Logger LOG = LoggerFactory.getLogger(JeopardyFlinkJob.class);

    public static final List<String> SOURCE_TOPICS = Arrays.asList(
            "flowable.activity.events",
            "flowable.fallout.events",
            "domain.order.events",
            "domain.fraud.events",
            "domain.payment.events",
            "domain.fulfillment.events",
            "domain.provisioning.events",
            "domain.billing.events"
    );

    public static final String TOPIC_CONFIG_UPDATES = "jeopardy.config.updates";
    public static final String TOPIC_CROSS_ORDER_SIGNALS = "jeopardy.cross-order.signals";
    public static final String TOPIC_UI_UPDATES = "jeopardy.ui.updates";
    public static final String TOPIC_ALERTS_OUT = "jeopardy.alerts.out";
    public static final String TOPIC_DLQ_PARSE = "jeopardy.dlq.parse-errors";
    public static final String TOPIC_DLQ_UNCORRELATED = "jeopardy.dlq.uncorrelated";

    @SuppressWarnings("deprecation")
    public static void main(String[] args) throws Exception {
        Map<String, String> cli = parseArgs(args);

        // Backward-compatible fallback bootstrap used if split source/internal bootstraps are not explicitly set
        String kafkaBootstrap = resolve(cli, "kafka-bootstrap", "KAFKA_BOOTSTRAP_SERVERS", "kafka:9092");
        // Strictly READ-ONLY upstream enterprise MSK / source event bus (consumed only; NEVER written to)
        String sourceKafkaBootstrap = resolve(cli, "source-kafka-bootstrap", "SOURCE_KAFKA_BOOTSTRAP_SERVERS", kafkaBootstrap);
        // Dedicated internal Jeopardy Kafka bus (cross-order signals, UI SSE deltas, alerts, DLQs, optional config topic)
        String internalKafkaBootstrap = resolve(cli, "internal-kafka-bootstrap", "INTERNAL_KAFKA_BOOTSTRAP_SERVERS", kafkaBootstrap);
        String configSourceMode = resolve(cli, "config-source-mode", "CONFIG_SOURCE_MODE", "KAFKA")
                .trim()
                .toUpperCase(Locale.ROOT);
        long configPollMs = Long.parseLong(resolve(cli, "config-poll-ms", "CONFIG_POLL_INTERVAL_MS", "3000"));
        String kafkaGroupId = resolve(cli, "kafka-group", "KAFKA_GROUP_ID", "jeopardy-flink-engine");
        String pgJdbcUrl = resolve(cli, "postgres-jdbc-url", "POSTGRES_JDBC_URL", "jdbc:postgresql://postgres:5432/jeopardy");
        String pgUser = resolve(cli, "postgres-user", "POSTGRES_USER", "jeopardy");
        String pgPassword = resolve(cli, "postgres-password", "POSTGRES_PASSWORD", "jeopardy");
        String chHttpUrl = resolve(cli, "clickhouse-http-url", "CLICKHOUSE_HTTP_URL", "http://clickhouse:8123");
        String chUser = resolve(cli, "clickhouse-user", "CLICKHOUSE_USER", "jeopardy");
        String chPassword = resolve(cli, "clickhouse-password", "CLICKHOUSE_PASSWORD", "jeopardy");
        String onnxModelDir = resolve(cli, "onnx-model-dir", "ONNX_MODEL_DIR", "/opt/flink/models");
        long checkpointMs = Long.parseLong(resolve(cli, "checkpoint-ms", "CHECKPOINT_INTERVAL_MS", "60000"));
        String checkpointDir = resolve(cli, "checkpoint-dir", "CHECKPOINT_DIR", "file:///tmp/jeopardy-flink-checkpoints");
        int explicitParallelism = Integer.parseInt(resolve(cli, "parallelism", "FLINK_PARALLELISM", "0"));
        boolean enableRocksDb = Boolean.parseBoolean(resolve(cli, "enable-rocksdb", "ENABLE_ROCKSDB", "true"));
        String initialBundlePath = resolve(cli, "initial-bundle-file", "INITIAL_BUNDLE_FILE", "");
        String initialBundleJson = loadInitialBundle(initialBundlePath);
        if (initialBundleJson == null || initialBundleJson.isBlank()) {
            initialBundleJson = loadInitialBundleFromPostgres(pgJdbcUrl, pgUser, pgPassword);
        }

        LOG.info("Starting JeopardyFlinkJob [sourceKafka={}, internalKafka={}, configSourceMode={}, configPollMs={}, pg={}, ch={}, onnxDir={}, rocksDb={}, checkpointDir={}, parallelism={}]",
                sourceKafkaBootstrap, internalKafkaBootstrap, configSourceMode, configPollMs,
                pgJdbcUrl, chHttpUrl, onnxModelDir, enableRocksDb, checkpointDir, explicitParallelism);

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        if (explicitParallelism > 0) {
            env.setParallelism(explicitParallelism);
        }
        env.enableCheckpointing(checkpointMs);
        env.getCheckpointConfig().setTolerableCheckpointFailureNumber(3);
        if (checkpointDir != null && !checkpointDir.isBlank()) {
            env.getCheckpointConfig().setCheckpointStorage(new FileSystemCheckpointStorage(checkpointDir));
        }
        if (enableRocksDb) {
            try {
                env.setStateBackend(new EmbeddedRocksDBStateBackend(true));
            } catch (Throwable t) {
                LOG.warn("Unable to initialize EmbeddedRocksDBStateBackend; using default state backend: {}",
                        t.getMessage());
            }
        }

        // ---------------------------------------------------------------------
        // 1. Sources: Read-Only Upstream MSK (8 Topics) + Decoupled Config Broadcast + Internal Signals
        // ---------------------------------------------------------------------
        KafkaSource<RawKafkaMessage> domainSource = KafkaSource.<RawKafkaMessage>builder()
                .setBootstrapServers(sourceKafkaBootstrap)
                .setTopics(SOURCE_TOPICS)
                .setGroupId(kafkaGroupId)
                .setStartingOffsets(OffsetsInitializer.earliest())
                .setDeserializer(new KafkaJsonSerializationSchemas.RawKafkaMessageDeserializationSchema())
                .build();

        WatermarkStrategy<RawKafkaMessage> rawWatermark = WatermarkStrategy
                .<RawKafkaMessage>forBoundedOutOfOrderness(Duration.ofSeconds(10))
                .withIdleness(Duration.ofSeconds(30))
                .withTimestampAssigner((msg, ts) -> msg.getIngestTimeMs() > 0 ? msg.getIngestTimeMs() : ts);

        DataStream<RawKafkaMessage> rawStream = env
                .fromSource(domainSource, rawWatermark, "Kafka-8-Source-Topics")
                .uid("source-8-domain-topics");

        BroadcastStream<String> configBroadcast;
        if ("POSTGRES".equals(configSourceMode)) {
            LOG.info("Config Broadcast transport: POSTGRES polling (config_publish_audit.bundle_jsonb every {}ms; zero Kafka writes)",
                    configPollMs);
            configBroadcast = env
                    .addSource(
                            new PostgresConfigPollingSource(pgJdbcUrl, pgUser, pgPassword, configPollMs),
                            "Postgres-Config-Broadcast")
                    .setParallelism(1)
                    .uid("source-config-updates-pg")
                    .broadcast(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);
        } else {
            LOG.info("Config Broadcast transport: KAFKA topic '{}' on internalKafka={}",
                    TOPIC_CONFIG_UPDATES, internalKafkaBootstrap);
            KafkaSource<String> configSource = KafkaSource.<String>builder()
                    .setBootstrapServers(internalKafkaBootstrap)
                    .setTopics(TOPIC_CONFIG_UPDATES)
                    .setGroupId(kafkaGroupId + "-config")
                    .setStartingOffsets(OffsetsInitializer.earliest())
                    .setValueOnlyDeserializer(new SimpleStringSchema())
                    .build();

            configBroadcast = env
                    .fromSource(configSource, WatermarkStrategy.noWatermarks(), "Kafka-Config-Broadcast")
                    .uid("source-config-updates")
                    .broadcast(FlinkTags.CONFIG_BROADCAST_DESCRIPTOR);
        }

        KafkaSource<CanonicalEvent> crossOrderSource = KafkaSource.<CanonicalEvent>builder()
                .setBootstrapServers(internalKafkaBootstrap)
                .setTopics(TOPIC_CROSS_ORDER_SIGNALS)
                .setGroupId(kafkaGroupId + "-signals")
                .setStartingOffsets(OffsetsInitializer.earliest())
                .setValueOnlyDeserializer(new KafkaJsonSerializationSchemas.CrossOrderSignalDeserializationSchema())
                .build();

        WatermarkStrategy<CanonicalEvent> signalWatermark = WatermarkStrategy
                .<CanonicalEvent>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                .withIdleness(Duration.ofSeconds(30))
                .withTimestampAssigner((ev, ts) -> ev.getEventTimeMs() > 0 ? ev.getEventTimeMs() : ts);

        DataStream<CanonicalEvent> crossOrderSignalsIn = env
                .fromSource(crossOrderSource, signalWatermark, "Kafka-Cross-Order-Signals-In")
                .uid("source-cross-order-signals")
                .filter(ev -> ev != null && ev.getEntityKey() != null && !ev.getEntityKey().isBlank())
                .name("Filter-Valid-Cross-Order-Signals");

        // ---------------------------------------------------------------------
        // 2. Stage 1: Broadcast Config Adapter, 95% Noise Filter, PII Scrub & Parse DLQ
        // ---------------------------------------------------------------------
        SingleOutputStreamOperator<CanonicalEvent> stage1Out = rawStream
                .connect(configBroadcast)
                .process(new Stage1EventAdapterFunction(initialBundleJson))
                .uid("stage1-event-adapter")
                .name("Stage1-1toN-Adapter-NoiseFilter-PII");

        DataStream<RawAuditRecord> rawAuditStream = stage1Out.getSideOutput(FlinkTags.RAW_AUDIT_TAG);
        DataStream<DlqMessage> parseDlqStream = stage1Out.getSideOutput(FlinkTags.PARSE_DLQ_TAG);

        rawAuditStream
                .addSink(BatchedClickHouseSink.forRawEvents(chHttpUrl, chUser, chPassword))
                .uid("sink-clickhouse-raw-events")
                .name("Sink-ClickHouse-raw_events");

        parseDlqStream
                .sinkTo(buildDlqSink(internalKafkaBootstrap, TOPIC_DLQ_PARSE))
                .uid("sink-dlq-parse-errors")
                .name("Sink-DLQ-parse-errors");

        // ---------------------------------------------------------------------
        // 3. Stage 2: Async BPMN/Fallout Correlator + 15s Out-of-Order Buffer
        // ---------------------------------------------------------------------
        DataStream<CanonicalEvent> directResolved = stage1Out
                .filter(ev -> ev != null
                        && !ev.isNeedsCorrelation()
                        && !ev.isRegisterInBpmnRegistry()
                        && ev.getEntityKey() != null
                        && !ev.getEntityKey().isBlank())
                .name("Stage2-Bypass-Direct-Resolved");

        DataStream<CanonicalEvent> toCorrelate = stage1Out
                .filter(ev -> ev != null
                        && (ev.isNeedsCorrelation()
                        || ev.isRegisterInBpmnRegistry()
                        || ev.getEntityKey() == null
                        || ev.getEntityKey().isBlank()))
                .name("Stage2-Route-To-Bpmn-Correlator");

        ProcessRegistryStore registryStore = new PostgresProcessRegistryStore(pgJdbcUrl, pgUser, pgPassword);

        DataStream<CanonicalEvent> asyncCorrelated = AsyncDataStream.unorderedWait(
                        toCorrelate,
                        new Stage2AsyncBpmnCorrelator(registryStore),
                        5_000L,
                        TimeUnit.MILLISECONDS,
                        100)
                .uid("stage2-async-bpmn-correlator")
                .name("Stage2-Async-BPMN-Fallout-Correlator");

        DataStream<CanonicalEvent> stage2Resolved = asyncCorrelated
                .filter(ev -> ev != null
                        && !ev.isNeedsCorrelation()
                        && ev.getEntityKey() != null
                        && !ev.getEntityKey().isBlank())
                .name("Stage2-Correlated-Resolved");

        SingleOutputStreamOperator<CanonicalEvent> oooResolved = asyncCorrelated
                .filter(ev -> ev != null
                        && (ev.isNeedsCorrelation()
                        || ev.getEntityKey() == null
                        || ev.getEntityKey().isBlank()))
                .keyBy(ev -> {
                    if (ev.getParentProcessInstanceId() != null && !ev.getParentProcessInstanceId().isBlank()) {
                        return ev.getParentProcessInstanceId();
                    }
                    if (ev.getProcessInstanceId() != null && !ev.getProcessInstanceId().isBlank()) {
                        return ev.getProcessInstanceId();
                    }
                    return "uncorrelated-unknown";
                })
                .process(new Stage2OutOfOrderBufferFunction(registryStore))
                .uid("stage2-ooo-buffer")
                .name("Stage2-15s-OOO-Buffer");

        DataStream<DlqMessage> uncorrelatedDlqStream = oooResolved.getSideOutput(FlinkTags.UNCORRELATED_DLQ_TAG);
        uncorrelatedDlqStream
                .sinkTo(buildDlqSink(internalKafkaBootstrap, TOPIC_DLQ_UNCORRELATED))
                .uid("sink-dlq-uncorrelated")
                .name("Sink-DLQ-uncorrelated");

        // ---------------------------------------------------------------------
        // 4. Stage 3: Keyed Milestone DAG, Fallout Overlay, SLA Timers & ONNX Scorer
        // ---------------------------------------------------------------------
        DataStream<CanonicalEvent> stage3Input = directResolved
                .union(stage2Resolved, oooResolved, crossOrderSignalsIn)
                .filter(ev -> ev != null && ev.getEntityKey() != null && !ev.getEntityKey().isBlank())
                .name("Stage3-Unified-Entity-Stream");

        SingleOutputStreamOperator<EntityMutation> mutations = stage3Input
                .keyBy(CanonicalEvent::getEntityKey)
                .connect(configBroadcast)
                .process(new Stage3MilestoneEngineFunction(initialBundleJson, onnxModelDir))
                .uid("stage3-milestone-sla-engine")
                .name("Stage3-Milestone-DAG-Timers-ONNX");

        // ---------------------------------------------------------------------
        // 5. Hardened Multi-Sink Fan-Out (PG, ClickHouse, SSE Deltas, Alerts, Cross-Order Signals)
        // ---------------------------------------------------------------------
        mutations
                .addSink(new BatchedPostgresSink(pgJdbcUrl, pgUser, pgPassword))
                .uid("sink-postgres-batched")
                .name("Sink-PostgreSQL-Batched-Upsert");

        mutations
                .addSink(BatchedClickHouseSink.forMilestoneTelemetry(chHttpUrl, chUser, chPassword))
                .uid("sink-clickhouse-milestone-telemetry")
                .name("Sink-ClickHouse-milestone_telemetry");

        mutations
                .filter(EntityMutation::isHasFalloutUpdate)
                .addSink(BatchedClickHouseSink.forFalloutEvents(chHttpUrl, chUser, chPassword))
                .uid("sink-clickhouse-fallout-events")
                .name("Sink-ClickHouse-fallout_events");

        mutations
                .sinkTo(KafkaSink.<EntityMutation>builder()
                        .setBootstrapServers(internalKafkaBootstrap)
                        .setKafkaProducerConfig(boundedProducerConfig(4 * 1024 * 1024))
                        .setRecordSerializer(KafkaJsonSerializationSchemas.uiUpdatesSchema(TOPIC_UI_UPDATES))
                        .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                        .build())
                .uid("sink-kafka-ui-updates")
                .name("Sink-Kafka-jeopardy.ui.updates");

        mutations
                .filter(EntityMutation::isHasJeopardyAlert)
                .sinkTo(KafkaSink.<EntityMutation>builder()
                        .setBootstrapServers(internalKafkaBootstrap)
                        .setKafkaProducerConfig(boundedProducerConfig(2 * 1024 * 1024))
                        .setRecordSerializer(KafkaJsonSerializationSchemas.alertsOutSchema(TOPIC_ALERTS_OUT))
                        .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                        .build())
                .uid("sink-kafka-alerts-out")
                .name("Sink-Kafka-jeopardy.alerts.out");

        DataStream<CrossOrderSignal> crossOrderOut = mutations.getSideOutput(FlinkTags.CROSS_ORDER_SIGNAL_TAG);
        crossOrderOut
                .sinkTo(KafkaSink.<CrossOrderSignal>builder()
                        .setBootstrapServers(internalKafkaBootstrap)
                        .setKafkaProducerConfig(boundedProducerConfig(2 * 1024 * 1024))
                        .setRecordSerializer(KafkaJsonSerializationSchemas.crossOrderSignalsSchema(TOPIC_CROSS_ORDER_SIGNALS))
                        .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                        .build())
                .uid("sink-kafka-cross-order-signals")
                .name("Sink-Kafka-jeopardy.cross-order.signals");

        env.execute("Jeopardy Management & Predictive SLA Flink Engine");
    }

    private static KafkaSink<DlqMessage> buildDlqSink(String bootstrapServers, String defaultTopic) {
        return KafkaSink.<DlqMessage>builder()
                .setBootstrapServers(bootstrapServers)
                .setKafkaProducerConfig(boundedProducerConfig(2 * 1024 * 1024))
                .setRecordSerializer(KafkaJsonSerializationSchemas.dlqSchema(defaultTopic))
                .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
                .build();
    }

    private static Properties boundedProducerConfig(int bufferMemoryBytes) {
        Properties props = new Properties();
        props.setProperty("buffer.memory", String.valueOf(bufferMemoryBytes));
        props.setProperty("batch.size", "16384");
        props.setProperty("linger.ms", "15");
        props.setProperty("compression.type", "lz4");
        props.setProperty("acks", "1");
        return props;
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> map = new HashMap<>();
        if (args == null) {
            return map;
        }
        for (int i = 0; i < args.length; i++) {
            String token = args[i];
            if (token != null && token.startsWith("--")) {
                String key = token.substring(2);
                int eq = key.indexOf('=');
                if (eq > 0) {
                    map.put(key.substring(0, eq), key.substring(eq + 1));
                } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                    map.put(key, args[++i]);
                } else {
                    map.put(key, "true");
                }
            }
        }
        return map;
    }

    private static String resolve(Map<String, String> cli, String cliKey, String envKey, String defaultVal) {
        String v = cli.get(cliKey);
        if (v != null && !v.isBlank()) {
            return v.trim();
        }
        v = System.getenv(envKey);
        if (v != null && !v.isBlank()) {
            return v.trim();
        }
        return defaultVal;
    }

    private static String loadInitialBundle(String path) {
        if (path == null || path.isBlank()) {
            return "";
        }
        try {
            Path p = Path.of(path);
            if (Files.isRegularFile(p)) {
                return Files.readString(p, StandardCharsets.UTF_8);
            }
        } catch (Exception ex) {
            LOG.warn("Unable to read initial bundle file '{}': {}", path, ex.getMessage());
        }
        return "";
    }

    /**
     * Synchronously pre-loads the latest PUBLISHED config bundle from PostgreSQL before
     * starting the Flink topology so Stage 1 &amp; Stage 3 never process backlogged Kafka
     * events against an empty registry during cold start.
     */
    private static String loadInitialBundleFromPostgres(String jdbcUrl, String user, String password) {
        if (jdbcUrl == null || jdbcUrl.isBlank()) {
            return "";
        }
        String sql = "SELECT bundle_version, bundle_jsonb::text "
                + "FROM config_publish_audit "
                + "WHERE status = 'PUBLISHED' AND bundle_jsonb IS NOT NULL "
                + "ORDER BY bundle_version DESC LIMIT 1";
        try (java.sql.Connection conn = java.sql.DriverManager.getConnection(jdbcUrl, user, password);
             java.sql.PreparedStatement ps = conn.prepareStatement(sql);
             java.sql.ResultSet rs = ps.executeQuery()) {
            if (rs.next()) {
                int ver = rs.getInt(1);
                String json = rs.getString(2);
                if (json != null && !json.isBlank()) {
                    LOG.info("Pre-loaded initial config bundle v{} ({} chars) from PostgreSQL before topology start (zero cold-start event loss)",
                            ver, json.length());
                    return json;
                }
            }
        } catch (Exception ex) {
            LOG.warn("Could not pre-load initial config bundle from PostgreSQL (will wait for broadcast): {}",
                    ex.getMessage());
        }
        return "";
    }
}
