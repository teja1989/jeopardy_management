package com.jeopardy.api.incidents;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "jeopardy.incidents")
public class IncidentProperties {

    private boolean enabled = true;
    private long pollIntervalMs = 30_000L;
    private int minImpactedEntities = 3;
    private double spikeMultiplier = 2.0;
    private int resolveQuietMinutes = 10;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public long getPollIntervalMs() {
        return pollIntervalMs;
    }

    public void setPollIntervalMs(long pollIntervalMs) {
        this.pollIntervalMs = pollIntervalMs;
    }

    public int getMinImpactedEntities() {
        return minImpactedEntities;
    }

    public void setMinImpactedEntities(int minImpactedEntities) {
        this.minImpactedEntities = minImpactedEntities;
    }

    public double getSpikeMultiplier() {
        return spikeMultiplier;
    }

    public void setSpikeMultiplier(double spikeMultiplier) {
        this.spikeMultiplier = spikeMultiplier;
    }

    public int getResolveQuietMinutes() {
        return resolveQuietMinutes;
    }

    public void setResolveQuietMinutes(int resolveQuietMinutes) {
        this.resolveQuietMinutes = resolveQuietMinutes;
    }
}
