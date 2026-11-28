package com.jeopardy.flink.sink;

import com.jeopardy.flink.sink.CheckpointedBatchFlusher.Classification;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.sql.BatchUpdateException;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CheckpointedBatchFlusherTest {

    private static final long[] THREE_RETRIES = {1L, 1L, 1L};

    private static CheckpointedBatchFlusher<Integer> flusher(
            int batchSize,
            CheckpointedBatchFlusher.BatchWriter<Integer> writer,
            CheckpointedBatchFlusher.ErrorClassifier classifier,
            List<Integer> rejected) {
        return new CheckpointedBatchFlusher<>(
                "test", batchSize, writer, classifier, (row, err) -> rejected.add(row), THREE_RETRIES, ms -> { });
    }

    @Test
    void checkpointFlushWritesEverythingBufferedBelowBatchSize() {
        List<Integer> written = new CopyOnWriteArrayList<>();
        CheckpointedBatchFlusher<Integer> f = flusher(100, written::addAll, e -> Classification.RETRYABLE, new ArrayList<>());

        for (int i = 0; i < 7; i++) {
            f.add(i);
        }
        assertTrue(written.isEmpty(), "Below batch size, nothing is written until a flush");

        f.flushAllOrThrow(); // what snapshotState does

        assertEquals(List.of(0, 1, 2, 3, 4, 5, 6), written);
        assertEquals(0, f.bufferedCount());
    }

    @Test
    void transientFailuresAreRetriedThenSucceed() {
        List<Integer> written = new CopyOnWriteArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        CheckpointedBatchFlusher<Integer> f = flusher(10, batch -> {
            if (calls.incrementAndGet() <= 2) {
                throw new IOException("connection reset");
            }
            written.addAll(batch);
        }, e -> Classification.RETRYABLE, new ArrayList<>());

        f.add(1);
        f.add(2);
        f.flushAllOrThrow();

        assertEquals(3, calls.get());
        assertEquals(List.of(1, 2), written);
    }

    @Test
    void exhaustedRetriesFailTheCheckpointInsteadOfDroppingRows() {
        AtomicInteger calls = new AtomicInteger();
        CheckpointedBatchFlusher<Integer> f = flusher(10, batch -> {
            calls.incrementAndGet();
            throw new IOException("database down");
        }, e -> Classification.RETRYABLE, new ArrayList<>());

        f.add(1);
        assertThrows(CheckpointedBatchFlusher.SinkWriteException.class, f::flushAllOrThrow,
                "A checkpoint must fail when rows cannot be written");
        assertEquals(1 + THREE_RETRIES.length, calls.get());
    }

    @Test
    void fatalErrorsFailImmediatelyWithoutRetry() {
        AtomicInteger calls = new AtomicInteger();
        CheckpointedBatchFlusher<Integer> f = flusher(10, batch -> {
            calls.incrementAndGet();
            throw new IOException("401 unauthorized");
        }, e -> Classification.FATAL, new ArrayList<>());

        f.add(1);
        assertThrows(CheckpointedBatchFlusher.SinkWriteException.class, f::flushAllOrThrow);
        assertEquals(1, calls.get());
    }

    @Test
    void badRowIsIsolatedByBisectionAndGoodRowsAreStillWritten() {
        List<Integer> written = new CopyOnWriteArrayList<>();
        List<Integer> rejected = new ArrayList<>();
        CheckpointedBatchFlusher<Integer> f = flusher(8, batch -> {
            if (batch.contains(5)) {
                throw new IllegalArgumentException("cannot parse row 5");
            }
            written.addAll(batch);
        }, e -> Classification.BAD_DATA, rejected);

        for (int i = 0; i < 8; i++) {
            f.add(i); // 8th add triggers a size-based flush
        }

        List<Integer> sorted = new ArrayList<>(written);
        Collections.sort(sorted);
        assertEquals(List.of(0, 1, 2, 3, 4, 6, 7), sorted);
        assertEquals(List.of(5), rejected);
    }

    @Test
    void backgroundFailureFailsTheNextRecordSoNothingIsSilentlyLost() throws Exception {
        CountDownLatch attempted = new CountDownLatch(1);
        CheckpointedBatchFlusher<Integer> f = new CheckpointedBatchFlusher<>(
                "test", 1000,
                batch -> {
                    attempted.countDown();
                    throw new IOException("down");
                },
                e -> Classification.RETRYABLE, (r, e) -> { }, new long[0], ms -> { });
        try {
            f.add(1);
            f.startBackgroundFlush(50);
            assertTrue(attempted.await(5, TimeUnit.SECONDS));
            // Wait until the background thread has recorded the failure.
            long deadline = System.currentTimeMillis() + 5_000;
            while (System.currentTimeMillis() < deadline) {
                try {
                    f.checkFailure();
                    Thread.sleep(10);
                } catch (CheckpointedBatchFlusher.SinkWriteException expected) {
                    break;
                }
            }
            assertThrows(CheckpointedBatchFlusher.SinkWriteException.class, () -> f.add(2));
            assertThrows(CheckpointedBatchFlusher.SinkWriteException.class, f::flushAllOrThrow);
        } finally {
            f.close();
        }
    }

    @Test
    void checkpointWaitsForInFlightBackgroundFlush() throws Exception {
        CountDownLatch writeStarted = new CountDownLatch(1);
        CountDownLatch releaseWrite = new CountDownLatch(1);
        List<Integer> written = new CopyOnWriteArrayList<>();
        CheckpointedBatchFlusher<Integer> f = new CheckpointedBatchFlusher<>(
                "test", 1000,
                batch -> {
                    writeStarted.countDown();
                    releaseWrite.await(5, TimeUnit.SECONDS);
                    written.addAll(batch);
                },
                e -> Classification.RETRYABLE, (r, e) -> { }, new long[0], ms -> { });
        try {
            f.add(1);
            f.startBackgroundFlush(50);
            assertTrue(writeStarted.await(5, TimeUnit.SECONDS), "background flush should start");

            Thread checkpoint = new Thread(f::flushAllOrThrow);
            checkpoint.start();
            Thread.sleep(100);
            assertTrue(checkpoint.isAlive(), "Checkpoint must block while a batch is in flight");

            releaseWrite.countDown();
            checkpoint.join(5_000);
            assertTrue(!checkpoint.isAlive());
            assertEquals(List.of(1), written, "In-flight row must be durable when the checkpoint returns");
        } finally {
            f.close();
        }
    }

    // -------------------------------------------------------------------------
    // Error classification
    // -------------------------------------------------------------------------

    @Test
    void postgresSqlStatesAreClassified() {
        assertEquals(Classification.RETRYABLE, BatchedPostgresSink.classify(new SQLException("conn", "08006")));
        assertEquals(Classification.RETRYABLE, BatchedPostgresSink.classify(new SQLException("deadlock", "40P01")));
        assertEquals(Classification.RETRYABLE, BatchedPostgresSink.classify(new SQLException("serialization", "40001")));
        assertEquals(Classification.RETRYABLE, BatchedPostgresSink.classify(new SQLException("unknown")));
        assertEquals(Classification.BAD_DATA, BatchedPostgresSink.classify(new SQLException("too long", "22001")));
        assertEquals(Classification.BAD_DATA, BatchedPostgresSink.classify(new SQLException("not null", "23502")));
        assertEquals(Classification.FATAL, BatchedPostgresSink.classify(new SQLException("no table", "42P01")));
        assertEquals(Classification.FATAL, BatchedPostgresSink.classify(new SQLException("auth", "28P01")));

        BatchUpdateException wrapped = new BatchUpdateException();
        assertEquals(Classification.RETRYABLE, BatchedPostgresSink.classify(wrapped));
    }

    @Test
    void clickHouseErrorsAreClassifiedByExceptionCode() {
        assertEquals(Classification.RETRYABLE, BatchedClickHouseSink.classify(new IOException("reset")));
        assertEquals(Classification.RETRYABLE,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 503, -1)));
        assertEquals(Classification.RETRYABLE,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 429, -1)));
        // Too many parts (252) is load, not bad data
        assertEquals(Classification.RETRYABLE,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 500, 252)));
        // Parse errors are bad data even when ClickHouse answers 500
        assertEquals(Classification.BAD_DATA,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 500, 27)));
        assertEquals(Classification.BAD_DATA,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 400, -1)));
        assertEquals(Classification.FATAL,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 404, 60)));
        assertEquals(Classification.FATAL,
                BatchedClickHouseSink.classify(new BatchedClickHouseSink.ClickHouseInsertException("x", 403, 516)));

        assertEquals(27, BatchedClickHouseSink.parseClickHouseCode("27", null));
        assertEquals(60, BatchedClickHouseSink.parseClickHouseCode(null, "Code: 60. DB::Exception: Table missing"));
        assertEquals(-1, BatchedClickHouseSink.parseClickHouseCode(null, "boom"));
    }
}
