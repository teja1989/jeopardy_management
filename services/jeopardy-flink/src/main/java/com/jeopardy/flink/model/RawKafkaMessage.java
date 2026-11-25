package com.jeopardy.flink.model;

import java.io.Serializable;

public class RawKafkaMessage implements Serializable {
    private static final long serialVersionUID = 1L;

    private String sourceTopic;
    private String rawJson;
    private long ingestTimeMs;
    private int partition;
    private long offset;

    public RawKafkaMessage() {}

    public RawKafkaMessage(String sourceTopic, String rawJson, long ingestTimeMs, int partition, long offset) {
        this.sourceTopic = sourceTopic;
        this.rawJson = rawJson;
        this.ingestTimeMs = ingestTimeMs;
        this.partition = partition;
        this.offset = offset;
    }

    public String getSourceTopic() { return sourceTopic; }
    public void setSourceTopic(String sourceTopic) { this.sourceTopic = sourceTopic; }
    public String getRawJson() { return rawJson; }
    public void setRawJson(String rawJson) { this.rawJson = rawJson; }
    public long getIngestTimeMs() { return ingestTimeMs; }
    public void setIngestTimeMs(long ingestTimeMs) { this.ingestTimeMs = ingestTimeMs; }
    public int getPartition() { return partition; }
    public void setPartition(int partition) { this.partition = partition; }
    public long getOffset() { return offset; }
    public void setOffset(long offset) { this.offset = offset; }
}
