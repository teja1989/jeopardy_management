package com.jeopardy.flink.sink;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jeopardy.flink.engine.Stage3MilestoneEngineFunction;
import com.jeopardy.flink.model.CanonicalEvent;
import com.jeopardy.flink.model.CrossOrderSignal;
import com.jeopardy.flink.model.DlqMessage;
import com.jeopardy.flink.model.EntityMutation;
import com.jeopardy.flink.model.RawKafkaMessage;
import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema;
import org.apache.flink.util.Collector;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Kafka JSON serialization & deserialization schemas for all Jeopardy internal and source topics.
 *
 * <p>Emitted {@code jeopardy.ui.updates} and {@code jeopardy.alerts.out} JSON fields match
 * {@code com.jeopardy.api.stream.UiUpdateKafkaConsumer} 100%.
 */
public final class KafkaJsonSerializationSchemas {
    private static final Logger LOG = LoggerFactory.getLogger(KafkaJsonSerializationSchemas.class);

    private KafkaJsonSerializationSchemas() {}

    /**
     * Lightweight ~300-byte real-time SSE delta emitted to {@code jeopardy.ui.updates}.
     */
    public static KafkaRecordSerializationSchema<EntityMutation> uiUpdatesSchema(String topic) {
        return new KafkaRecordSerializationSchema<EntityMutation>() {
            private static final long serialVersionUID = 1L;
            private transient ObjectMapper mapper;

            @Override
            public ProducerRecord<byte[], byte[]> serialize(
                    EntityMutation m,
                    KafkaSinkContext context,
                    Long timestamp) {
                if (m == null || m.getEntityKey() == null) {
                    return null;
                }
                if (mapper == null) {
                    mapper = new ObjectMapper();
                }
                long ts = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : System.currentTimeMillis();
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("eventType", nonBlank(m.getDeltaEventType(), "ENTITY_UPDATED"));
                payload.put("customerId", m.getCustomerId());
                payload.put("entityKey", m.getEntityKey());
                payload.put("journeyId", m.getJourneyId());
                payload.put("orderFamily", m.getOrderFamily());
                payload.put("orderType", m.getOrderType());
                payload.put("status", m.getEntityStatus());
                payload.put("jeopardySeverity", nonBlank(m.getJeopardySeverity(), "NONE"));
                payload.put("severity", nonBlank(m.getJeopardySeverity(), "NONE"));
                payload.put("hasActiveFallout", m.isHasActiveFallout());
                payload.put("milestoneId", m.getMilestoneId());
                payload.put("templateId", m.getTemplateId());
                payload.put("displayName", m.getDisplayName());
                payload.put("milestoneStatus", m.getMilestoneStatus());
                payload.put("falloutId", m.getFalloutId());
                payload.put("falloutStatus", m.getFalloutStatus());
                payload.put("timestamp", Instant.ofEpochMilli(ts).toString());

                return buildRecord(mapper, topic, m.getEntityKey(), payload);
            }
        };
    }

    /**
     * Full operational Jeopardy / Breach / Fallout alert emitted to {@code jeopardy.alerts.out}.
     */
    public static KafkaRecordSerializationSchema<EntityMutation> alertsOutSchema(String topic) {
        return new KafkaRecordSerializationSchema<EntityMutation>() {
            private static final long serialVersionUID = 1L;
            private transient ObjectMapper mapper;

            @Override
            public ProducerRecord<byte[], byte[]> serialize(
                    EntityMutation m,
                    KafkaSinkContext context,
                    Long timestamp) {
                if (m == null || m.getEntityKey() == null || !m.shouldPage()) {
                    return null;
                }
                if (mapper == null) {
                    mapper = new ObjectMapper();
                }
                long ts = m.getLastEventTimeMs() > 0 ? m.getLastEventTimeMs() : System.currentTimeMillis();
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("eventType", "JEOPARDY_ALERT");
                payload.put("opsAlert", true);
                payload.put("caseId", m.getCaseId());
                payload.put("customerId", m.getCustomerId());
                payload.put("entityKey", m.getEntityKey());
                payload.put("journeyId", m.getJourneyId());
                payload.put("orderFamily", m.getOrderFamily());
                payload.put("orderType", m.getOrderType());
                payload.put("status", m.getEntityStatus());
                payload.put("jeopardySeverity", nonBlank(m.getJeopardySeverity(), "JEOPARDY"));
                payload.put("severity", nonBlank(m.getJeopardySeverity(), "JEOPARDY"));
                payload.put("milestoneId", m.getMilestoneId());
                payload.put("templateId", m.getTemplateId());
                payload.put("displayName", m.getDisplayName());
                payload.put("milestoneStatus", m.getMilestoneStatus());
                payload.put("hasActiveFallout", m.isHasActiveFallout());
                payload.put("falloutId", m.getFalloutId());
                payload.put("assignedQueue", m.getAssignedQueue());
                payload.put("alertReasonCode", m.getAlertReasonCode());
                payload.put("alertMessage", m.getAlertMessage());
                payload.put("breachProbability", m.getBreachProbability());
                payload.put("timestamp", Instant.ofEpochMilli(ts).toString());

                return buildRecord(mapper, topic, m.getEntityKey(), payload);
            }
        };
    }

    /**
     * Cross-Order SLA Signal serializer keyed by {@code targetEntityKey} for {@code jeopardy.cross-order.signals}.
     */
    public static KafkaRecordSerializationSchema<CrossOrderSignal> crossOrderSignalsSchema(String topic) {
        return new KafkaRecordSerializationSchema<CrossOrderSignal>() {
            private static final long serialVersionUID = 1L;
            private transient ObjectMapper mapper;

            @Override
            public ProducerRecord<byte[], byte[]> serialize(
                    CrossOrderSignal signal,
                    KafkaSinkContext context,
                    Long timestamp) {
                if (signal == null || signal.getTargetEntityKey() == null) {
                    return null;
                }
                if (mapper == null) {
                    mapper = new ObjectMapper();
                }
                return buildRecord(mapper, topic, signal.getTargetEntityKey(), signal);
            }
        };
    }

    /**
     * Dead-Letter Queue serializer for {@code jeopardy.dlq.parse-errors} and {@code jeopardy.dlq.uncorrelated}.
     */
    public static KafkaRecordSerializationSchema<DlqMessage> dlqSchema(String defaultTopic) {
        return new KafkaRecordSerializationSchema<DlqMessage>() {
            private static final long serialVersionUID = 1L;
            private transient ObjectMapper mapper;

            @Override
            public ProducerRecord<byte[], byte[]> serialize(
                    DlqMessage msg,
                    KafkaSinkContext context,
                    Long timestamp) {
                if (msg == null) {
                    return null;
                }
                if (mapper == null) {
                    mapper = new ObjectMapper();
                }
                String targetTopic = (msg.getDlqTopic() != null && !msg.getDlqTopic().isBlank())
                        ? msg.getDlqTopic()
                        : defaultTopic;
                String key = msg.getProcessInstanceId() != null
                        ? msg.getProcessInstanceId()
                        : msg.getSourceTopic();
                return buildRecord(mapper, targetTopic, key, msg);
            }
        };
    }

    /**
     * Preserves Kafka {@code topic}, {@code partition}, {@code offset}, and {@code timestamp}
     * alongside raw UTF-8 payload for Stage 1 multi-topic ingestion.
     */
    public static class RawKafkaMessageDeserializationSchema
            implements KafkaRecordDeserializationSchema<RawKafkaMessage> {
        private static final long serialVersionUID = 1L;

        @Override
        public void deserialize(
                ConsumerRecord<byte[], byte[]> record,
                Collector<RawKafkaMessage> out) {
            if (record == null || record.value() == null) {
                return;
            }
            String rawJson = new String(record.value(), StandardCharsets.UTF_8);
            long ingestTs = record.timestamp() > 0 ? record.timestamp() : System.currentTimeMillis();
            out.collect(new RawKafkaMessage(
                    record.topic(),
                    rawJson,
                    ingestTs,
                    record.partition(),
                    record.offset()));
        }

        @Override
        public TypeInformation<RawKafkaMessage> getProducedType() {
            return TypeInformation.of(RawKafkaMessage.class);
        }
    }

    /**
     * Deserializes {@link CrossOrderSignal} messages from {@code jeopardy.cross-order.signals}
     * into Stage 3 {@link CanonicalEvent} signals keyed by {@code targetEntityKey}.
     */
    public static class CrossOrderSignalDeserializationSchema
            implements DeserializationSchema<CanonicalEvent> {
        private static final long serialVersionUID = 1L;
        private transient ObjectMapper mapper;

        @Override
        public CanonicalEvent deserialize(byte[] message) {
            if (message == null || message.length == 0) {
                return null;
            }
            try {
                if (mapper == null) {
                    mapper = new ObjectMapper();
                }
                CrossOrderSignal sig = mapper.readValue(message, CrossOrderSignal.class);
                if (sig == null || sig.getTargetEntityKey() == null || sig.getTargetEntityKey().isBlank()) {
                    return null;
                }
                CanonicalEvent ev = new CanonicalEvent();
                ev.setEntityKey(sig.getTargetEntityKey());
                ev.setSourceTopic("jeopardy.cross-order.signals");
                ev.setDomain("CROSS_ORDER");
                ev.setEventTimeMs(sig.getEventTimeMs() > 0 ? sig.getEventTimeMs() : System.currentTimeMillis());
                ev.setIngestTimeMs(System.currentTimeMillis());
                ev.setFailedTemplateId(sig.getTargetTemplateId());
                ev.setLinkedChangeOrderId(sig.getSourceEntityKey());

                String action = sig.getAction() != null ? sig.getAction().toUpperCase(Locale.ROOT) : "";
                if (action.contains("PAUSE")) {
                    ev.setEventType(Stage3MilestoneEngineFunction.EVENT_CROSS_ORDER_PAUSE);
                } else if (action.contains("RESUME")) {
                    ev.setEventType(Stage3MilestoneEngineFunction.EVENT_CROSS_ORDER_RESUME);
                } else if (action.contains("CANCEL")) {
                    ev.setEventType(Stage3MilestoneEngineFunction.EVENT_CROSS_ORDER_CANCEL);
                } else {
                    ev.setEventType("CROSS_ORDER_" + action);
                }
                if (sig.getTargetTemplateId() != null) {
                    ev.getDimensions().put("targetTemplateId", sig.getTargetTemplateId());
                }
                if (sig.getReason() != null) {
                    ev.getDimensions().put("crossOrderReason", sig.getReason());
                }
                return ev;
            } catch (Exception ex) {
                LOG.warn("Failed to deserialize CrossOrderSignal: {}", ex.getMessage());
                return null;
            }
        }

        @Override
        public boolean isEndOfStream(CanonicalEvent nextElement) {
            return false;
        }

        @Override
        public TypeInformation<CanonicalEvent> getProducedType() {
            return TypeInformation.of(CanonicalEvent.class);
        }
    }

    private static ProducerRecord<byte[], byte[]> buildRecord(
            ObjectMapper mapper,
            String topic,
            String key,
            Object value) {
        try {
            byte[] keyBytes = key != null ? key.getBytes(StandardCharsets.UTF_8) : null;
            byte[] valBytes = mapper.writeValueAsBytes(value);
            return new ProducerRecord<>(topic, keyBytes, valBytes);
        } catch (Exception ex) {
            LOG.warn("Failed to serialize Kafka JSON for topic '{}': {}", topic, ex.getMessage());
            return null;
        }
    }

    private static String nonBlank(String value, String fallback) {
        return (value == null || value.isBlank()) ? fallback : value;
    }
}
