package com.jeopardy.flink.sink;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongConsumer;

/**
 * Buffering core shared by the PostgreSQL and ClickHouse sinks, built so that a completed Flink
 * checkpoint never covers rows that were not written.
 *
 * <h2>Guarantees</h2>
 * <ul>
 *   <li><b>At-least-once:</b> {@link #flushAllOrThrow()} is called from the sink's
 *       {@code snapshotState}. It waits for any in-flight background flush, writes everything that is
 *       buffered, and throws if anything could not be written. A throwing {@code snapshotState} fails
 *       the checkpoint, so Kafka offsets are never committed past unwritten rows.</li>
 *   <li><b>No silent drops:</b> a background flush that fails is remembered and rethrown on the next
 *       {@link #add} / {@link #flushAllOrThrow()} / {@link #checkFailure()}, which fails the task. Flink then
 *       restarts from the last completed checkpoint and replays the rows from Kafka.</li>
 *   <li><b>Transient errors are retried</b> with backoff before giving up.</li>
 *   <li><b>Bad rows are isolated, not fatal:</b> when the writer classifies an error as
 *       {@link Classification#BAD_DATA}, the batch is split in halves until the offending row(s) are found.
 *       Good rows are written; each rejected row is reported to {@link RejectHandler} (logged + counted)
 *       instead of crash-looping the whole pipeline on one malformed record.</li>
 *   <li><b>Ordering:</b> swapping the buffer and writing it happen under one lock, so batches are written
 *       in the order they were buffered.</li>
 * </ul>
 */
public final class CheckpointedBatchFlusher<T> implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(CheckpointedBatchFlusher.class);

    /** How a write failure should be handled. */
    public enum Classification {
        /** Network blip, timeout, 5xx/429, deadlock, connection loss: retry, then fail the task. */
        RETRYABLE,
        /** The data itself was rejected (constraint / parse error): bisect and quarantine bad rows. */
        BAD_DATA,
        /** Misconfiguration (auth, missing table): fail the task immediately. */
        FATAL
    }

    /** Writes one batch atomically. Must throw on any failure (never swallow). */
    @FunctionalInterface
    public interface BatchWriter<T> {
        void write(List<T> batch) throws Exception;
    }

    @FunctionalInterface
    public interface ErrorClassifier {
        Classification classify(Exception error);
    }

    @FunctionalInterface
    public interface RejectHandler<T> {
        void onRejected(T row, Exception error);
    }

    /** Wraps a failure that must fail the Flink task. */
    public static final class SinkWriteException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public SinkWriteException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private final String name;
    private final int batchSize;
    private final BatchWriter<T> writer;
    private final ErrorClassifier classifier;
    private final RejectHandler<T> rejectHandler;
    private final long[] retryBackoffMs;
    private final LongConsumer sleeper;

    private final Object bufferLock = new Object();
    private final ReentrantLock flushLock = new ReentrantLock();
    private final AtomicReference<Throwable> asyncFailure = new AtomicReference<>();

    private List<T> buffer;
    private ScheduledExecutorService scheduler;

    public CheckpointedBatchFlusher(
            String name,
            int batchSize,
            BatchWriter<T> writer,
            ErrorClassifier classifier,
            RejectHandler<T> rejectHandler,
            long[] retryBackoffMs) {
        this(name, batchSize, writer, classifier, rejectHandler, retryBackoffMs, CheckpointedBatchFlusher::sleepQuietly);
    }

    /** Visible for tests: allows a no-op sleeper so retry tests run instantly. */
    CheckpointedBatchFlusher(
            String name,
            int batchSize,
            BatchWriter<T> writer,
            ErrorClassifier classifier,
            RejectHandler<T> rejectHandler,
            long[] retryBackoffMs,
            LongConsumer sleeper) {
        this.name = name;
        this.batchSize = Math.max(1, batchSize);
        this.writer = writer;
        this.classifier = classifier;
        this.rejectHandler = rejectHandler;
        this.retryBackoffMs = retryBackoffMs != null ? retryBackoffMs.clone() : new long[0];
        this.sleeper = sleeper;
        this.buffer = new ArrayList<>(Math.min(this.batchSize, 512));
    }

    /** Starts the background time-based flush. Optional: without it, flushes are size- and checkpoint-driven only. */
    public void startBackgroundFlush(long intervalMs) {
        long interval = Math.max(50L, intervalMs);
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "flink-sink-flusher-" + name);
            t.setDaemon(true);
            return t;
        });
        this.scheduler.scheduleWithFixedDelay(this::backgroundFlush, interval, interval, TimeUnit.MILLISECONDS);
    }

    /** Buffers a row; flushes synchronously on the caller thread when the batch is full. */
    public void add(T row) {
        checkFailure();
        boolean full;
        synchronized (bufferLock) {
            buffer.add(row);
            full = buffer.size() >= batchSize;
        }
        if (full) {
            flushLocked();
        }
    }

    /**
     * Writes everything buffered, waiting for any in-flight background flush first.
     * Call from {@code snapshotState} and {@code close}. Throws if any row could not be written.
     */
    public void flushAllOrThrow() {
        checkFailure();
        flushLocked();
        checkFailure();
    }

    /** Rethrows a failure recorded by the background flusher, failing the task. */
    public void checkFailure() {
        Throwable t = asyncFailure.get();
        if (t != null) {
            throw new SinkWriteException(
                    "Sink '" + name + "' failed to write a batch; failing task so Flink replays from the last checkpoint",
                    t);
        }
    }

    public int bufferedCount() {
        synchronized (bufferLock) {
            return buffer.size();
        }
    }

    @Override
    public void close() {
        if (scheduler != null) {
            scheduler.shutdownNow();
            try {
                scheduler.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    // ---------------------------------------------------------------------

    private void backgroundFlush() {
        if (asyncFailure.get() != null) {
            return; // Already failed: stop writing so the task fails and replays cleanly.
        }
        try {
            flushLocked();
        } catch (Throwable t) {
            asyncFailure.compareAndSet(null, t);
            LOG.error("Background flush of sink '{}' failed; the task will fail on its next record or checkpoint", name, t);
        }
    }

    private void flushLocked() {
        flushLock.lock();
        try {
            List<T> batch;
            synchronized (bufferLock) {
                if (buffer.isEmpty()) {
                    return;
                }
                batch = buffer;
                buffer = new ArrayList<>(Math.min(batchSize, 512));
            }
            writeWithIsolation(batch);
        } finally {
            flushLock.unlock();
        }
    }

    private void writeWithIsolation(List<T> batch) {
        try {
            writeWithRetry(batch);
        } catch (BadDataException bad) {
            if (batch.size() == 1) {
                rejectHandler.onRejected(batch.get(0), bad.cause);
                return;
            }
            int mid = batch.size() / 2;
            writeWithIsolation(new ArrayList<>(batch.subList(0, mid)));
            writeWithIsolation(new ArrayList<>(batch.subList(mid, batch.size())));
        }
    }

    private void writeWithRetry(List<T> batch) {
        int attempt = 0;
        while (true) {
            try {
                writer.write(batch);
                return;
            } catch (Exception ex) {
                if (ex instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    throw new SinkWriteException("Sink '" + name + "' interrupted while writing", ex);
                }
                Classification c = classifier.classify(ex);
                if (c == Classification.BAD_DATA) {
                    throw new BadDataException(ex);
                }
                if (c == Classification.FATAL || attempt >= retryBackoffMs.length) {
                    throw new SinkWriteException(
                            "Sink '" + name + "' could not write batch of " + batch.size()
                                    + " rows (" + c + ", attempts=" + (attempt + 1) + ")",
                            ex);
                }
                long backoff = retryBackoffMs[attempt++];
                LOG.warn("Sink '{}' transient write failure (attempt {}/{}), retrying in {}ms: {}",
                        name, attempt, retryBackoffMs.length + 1, backoff, ex.getMessage());
                sleeper.accept(backoff);
            }
        }
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static final class BadDataException extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final transient Exception cause;

        BadDataException(Exception cause) {
            super(cause);
            this.cause = cause;
        }
    }
}
