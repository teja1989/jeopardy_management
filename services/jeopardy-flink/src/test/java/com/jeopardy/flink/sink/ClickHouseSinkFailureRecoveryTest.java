package com.jeopardy.flink.sink;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.apache.flink.api.common.RuntimeExecutionMode;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntPredicate;
import java.util.zip.GZIPInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * End-to-end MiniCluster tests: a real Flink job with checkpointing writes to a fake ClickHouse HTTP
 * endpoint that fails mid-stream. Before the fix, failed batches were logged and dropped, and buffered
 * rows could be lost when a checkpoint completed before they were flushed.
 */
class ClickHouseSinkFailureRecoveryTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Ids received by the fake server, across all attempts (duplicates allowed: at-least-once). */
    private static final Set<Long> RECEIVED = ConcurrentHashMap.newKeySet();
    private static final AtomicInteger REQUESTS = new AtomicInteger();
    private static final AtomicInteger FAILURES = new AtomicInteger();
    private static volatile IntPredicate failRequest = n -> false;
    private static volatile long badRowId = -1;

    private HttpServer server;
    private String url;

    @BeforeEach
    void startServer() throws Exception {
        RECEIVED.clear();
        REQUESTS.set(0);
        FAILURES.set(0);
        failRequest = n -> false;
        badRowId = -1;

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            int n = REQUESTS.incrementAndGet();
            byte[] body = exchange.getRequestBody().readAllBytes();
            String enc = exchange.getRequestHeaders().getFirst("Content-Encoding");
            if ("gzip".equalsIgnoreCase(enc)) {
                try (InputStream in = new GZIPInputStream(new ByteArrayInputStream(body))) {
                    body = in.readAllBytes();
                }
            }
            String ndjson = new String(body, StandardCharsets.UTF_8);

            if (failRequest.test(n)) {
                FAILURES.incrementAndGet();
                byte[] msg = "Code: 210. DB::Exception: Connection refused".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(503, msg.length);
                exchange.getResponseBody().write(msg);
                exchange.close();
                return;
            }

            Set<Long> ids = new HashSet<>();
            for (String line : ndjson.split("\n")) {
                if (!line.isBlank()) {
                    JsonNode node = MAPPER.readTree(line);
                    ids.add(node.get("id").asLong());
                }
            }
            if (badRowId > 0 && ids.contains(badRowId)) {
                byte[] msg = ("Code: 27. DB::Exception: Cannot parse input: row " + badRowId)
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("X-ClickHouse-Exception-Code", "27");
                exchange.sendResponseHeaders(500, msg.length);
                exchange.getResponseBody().write(msg);
                exchange.close();
                return;
            }
            RECEIVED.addAll(ids); // ClickHouse inserts are atomic per request
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        url = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void clickHouseOutageMidStreamFailsTaskAndReplaysWithoutLosingRows() throws Exception {
        long total = 3_000;
        // Requests 4..10 fail: more than the retry budget (1 try + 2 retries), so the task must fail,
        // restart from the last checkpoint and replay. Later requests succeed.
        failRequest = n -> n >= 4 && n <= 10;

        runJob(total, true);

        assertTrue(FAILURES.get() >= 3, "The outage must actually have been hit");
        Set<Long> missing = new HashSet<>();
        for (long i = 1; i <= total; i++) {
            if (!RECEIVED.contains(i)) {
                missing.add(i);
            }
        }
        assertTrue(missing.isEmpty(), "Rows lost during ClickHouse outage: " + missing.size());
    }

    @Test
    void malformedRowIsQuarantinedWhileTheRestOfTheBatchIsWritten() throws Exception {
        long total = 500;
        badRowId = 123;

        runJob(total, false);

        assertFalse(RECEIVED.contains(123L), "Bad row must be rejected, not retried forever");
        assertEquals(total - 1, RECEIVED.size(), "Every other row must be written");
    }

    private void runJob(long total, boolean allowRestarts) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.setRuntimeMode(RuntimeExecutionMode.STREAMING);
        env.setParallelism(1);
        env.enableCheckpointing(100);
        if (allowRestarts) {
            env.setRestartStrategy(RestartStrategies.fixedDelayRestart(10, 50L));
        } else {
            env.setRestartStrategy(RestartStrategies.noRestart());
        }

        BatchedClickHouseSink<Long> sink = new BatchedClickHouseSink<Long>(
                url, "", "", "test_rows", 100, 200L,
                id -> Map.of("id", id))
                .withRetryBackoffMs(1L, 1L);

        env.fromSequence(1, total)
                .map(i -> {
                    Thread.sleep(1); // spread the stream over several checkpoints
                    return i;
                })
                .addSink(sink);

        env.execute("ClickHouseSinkFailureRecoveryTest");
    }
}
