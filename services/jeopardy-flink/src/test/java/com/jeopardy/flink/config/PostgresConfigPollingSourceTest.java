package com.jeopardy.flink.config;

import com.jeopardy.flink.config.PostgresConfigPollingSource.BundleRecord;
import org.apache.flink.streaming.api.functions.source.SourceFunction;
import org.apache.flink.streaming.api.watermark.Watermark;
import org.junit.jupiter.api.Test;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PostgresConfigPollingSourceTest {

    @Test
    void emitsNewBundleJsonWhenVersionAdvances() throws Exception {
        AtomicInteger pollCount = new AtomicInteger(0);
        List<Integer> observedAfterVersions = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch twoEmitted = new CountDownLatch(2);

        PostgresConfigPollingSource source = new PostgresConfigPollingSource(afterVersion -> {
            observedAfterVersions.add(afterVersion);
            int call = pollCount.incrementAndGet();
            if (call == 1) {
                return Optional.of(new BundleRecord(1, "{\"bundleVersion\":1,\"adapters\":[]}"));
            }
            if (call == 2) {
                return Optional.of(new BundleRecord(2, "{\"bundleVersion\":2,\"adapters\":[{\"id\":\"a1\"}]}"));
            }
            return Optional.empty();
        }, 15L);

        CapturingSourceContext ctx = new CapturingSourceContext(twoEmitted);
        AtomicReference<Throwable> uncaught = new AtomicReference<>();

        Thread runner = new Thread(() -> {
            try {
                source.run(ctx);
            } catch (Throwable t) {
                uncaught.set(t);
            }
        }, "test-pg-poller-advance");
        runner.start();

        assertTrue(twoEmitted.await(5, TimeUnit.SECONDS), "Expected v1 and v2 bundles to be emitted");
        source.cancel();
        runner.join(3_000L);
        source.close();

        assertNull(uncaught.get());
        assertEquals(2, ctx.emitted.size());
        assertEquals("{\"bundleVersion\":1,\"adapters\":[]}", ctx.emitted.get(0));
        assertEquals("{\"bundleVersion\":2,\"adapters\":[{\"id\":\"a1\"}]}", ctx.emitted.get(1));
        assertEquals(0, observedAfterVersions.get(0));
        assertEquals(1, observedAfterVersions.get(1));
        assertEquals(2, source.getLastSeenVersion());
    }

    @Test
    void skipsDuplicateEmissionsWhenVersionIsUnchanged() throws Exception {
        AtomicInteger pollCount = new AtomicInteger(0);
        CountDownLatch pollsCompleted = new CountDownLatch(4);

        PostgresConfigPollingSource source = new PostgresConfigPollingSource(afterVersion -> {
            int call = pollCount.incrementAndGet();
            try {
                if (call == 1) {
                    return Optional.of(new BundleRecord(5, "{\"bundleVersion\":5}"));
                }
                if (call == 2) {
                    // Simulate duplicate version returned despite afterVersion=5
                    return Optional.of(new BundleRecord(5, "{\"bundleVersion\":5,\"duplicate\":true}"));
                }
                if (call == 3) {
                    // Simulate older version returned
                    return Optional.of(new BundleRecord(4, "{\"bundleVersion\":4,\"stale\":true}"));
                }
                if (call == 4) {
                    return Optional.empty();
                }
                return Optional.empty();
            } finally {
                pollsCompleted.countDown();
            }
        }, 15L);

        CapturingSourceContext ctx = new CapturingSourceContext(null);
        AtomicReference<Throwable> uncaught = new AtomicReference<>();

        Thread runner = new Thread(() -> {
            try {
                source.run(ctx);
            } catch (Throwable t) {
                uncaught.set(t);
            }
        }, "test-pg-poller-dedupe");
        runner.start();

        assertTrue(pollsCompleted.await(5, TimeUnit.SECONDS), "Expected at least 4 poll iterations");
        source.cancel();
        runner.join(3_000L);
        source.close();

        assertNull(uncaught.get());
        assertEquals(1, ctx.emitted.size(), "Duplicate and stale versions must not be re-emitted");
        assertEquals("{\"bundleVersion\":5}", ctx.emitted.get(0));
        assertEquals(5, source.getLastSeenVersion());
    }

    @Test
    void survivesTransientFetcherExceptionsAndRecoversOnNextPoll() throws Exception {
        AtomicInteger pollCount = new AtomicInteger(0);
        CountDownLatch recovered = new CountDownLatch(1);

        PostgresConfigPollingSource source = new PostgresConfigPollingSource(afterVersion -> {
            int call = pollCount.incrementAndGet();
            if (call == 1) {
                throw new SQLException("Simulated PostgreSQL connection reset");
            }
            if (call == 2) {
                throw new IllegalStateException("Simulated transient timeout");
            }
            if (call == 3) {
                return Optional.of(new BundleRecord(3, "{\"bundleVersion\":3,\"recovered\":true}"));
            }
            return Optional.empty();
        }, 15L);

        CapturingSourceContext ctx = new CapturingSourceContext(recovered);
        AtomicReference<Throwable> uncaught = new AtomicReference<>();

        Thread runner = new Thread(() -> {
            try {
                source.run(ctx);
            } catch (Throwable t) {
                uncaught.set(t);
            }
        }, "test-pg-poller-recover");
        runner.start();

        assertTrue(recovered.await(5, TimeUnit.SECONDS), "Poller should recover and emit bundle v3 after transient errors");
        source.cancel();
        runner.join(3_000L);
        source.close();

        assertNull(uncaught.get());
        assertTrue(pollCount.get() >= 3);
        assertEquals(1, ctx.emitted.size());
        assertEquals("{\"bundleVersion\":3,\"recovered\":true}", ctx.emitted.get(0));
        assertEquals(3, source.getLastSeenVersion());
    }

    @SuppressWarnings("deprecation")
    private static final class CapturingSourceContext implements SourceFunction.SourceContext<String> {
        private final Object checkpointLock = new Object();
        private final List<String> emitted = Collections.synchronizedList(new ArrayList<>());
        private final CountDownLatch latch;

        private CapturingSourceContext(CountDownLatch latch) {
            this.latch = latch;
        }

        @Override
        public void collect(String element) {
            emitted.add(element);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void collectWithTimestamp(String element, long timestamp) {
            collect(element);
        }

        @Override
        public void emitWatermark(Watermark mark) {
            // No-op in unit test
        }

        @Override
        public void markAsTemporarilyIdle() {
            // No-op in unit test
        }

        @Override
        public Object getCheckpointLock() {
            return checkpointLock;
        }

        @Override
        public void close() {
            // No-op in unit test
        }
    }
}
