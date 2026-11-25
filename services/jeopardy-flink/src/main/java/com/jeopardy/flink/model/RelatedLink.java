package com.jeopardy.flink.model;

import java.io.Serializable;

public class RelatedLink implements Serializable {
    private static final long serialVersionUID = 1L;

    private String targetEntityKey;
    private String relationshipType;
    private String slaCoupling;

    public RelatedLink() {}

    public RelatedLink(String targetEntityKey, String relationshipType, String slaCoupling) {
        this.targetEntityKey = targetEntityKey;
        this.relationshipType = relationshipType;
        this.slaCoupling = slaCoupling;
    }

    public String getTargetEntityKey() { return targetEntityKey; }
    public void setTargetEntityKey(String targetEntityKey) { this.targetEntityKey = targetEntityKey; }
    public String getRelationshipType() { return relationshipType; }
    public void setRelationshipType(String relationshipType) { this.relationshipType = relationshipType; }
    public String getSlaCoupling() { return slaCoupling; }
    public void setSlaCoupling(String slaCoupling) { this.slaCoupling = slaCoupling; }
}
