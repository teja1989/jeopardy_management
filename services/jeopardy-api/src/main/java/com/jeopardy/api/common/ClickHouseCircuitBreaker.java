package com.jeopardy.api.common;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Shared fast-fail circuit breaker across ClickHouse analytics services so a single
 * ClickHouse failure or timeout immediately trips protection for all endpoints instead
 * of cascading multi-second stalls.
 */
@Component
public class ClickHouseCircuitBreaker {

    public static final long DEFAULT_COOLDOWN_MS = 20_000L;

    private final long cooldownMs;
    private final AtomicLong openUntilMs = new AtomicLong(0L);

    @Autowired
    public ClickHouseCircuitBreaker() {
        this(DEFAULT_COOLDOWN_MS);
    }

    public ClickHouseCircuitBreaker(long cooldownMs) {
        this.cooldownMs = Math.max(1_000L, cooldownMs);
    }

    public boolean isOpen() {
        return System.currentTimeMillis() < openUntilMs.get();
    }

    public void trip() {
        openUntilMs.set(System.currentTimeMillis() + cooldownMs);
    }

    public void reset() {
        openUntilMs.set(0L);
    }

    public long cooldownSeconds() {
        return Math.max(1L, cooldownMs / 1_000L);
    }
}
