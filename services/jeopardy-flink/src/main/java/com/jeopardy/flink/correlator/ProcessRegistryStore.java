package com.jeopardy.flink.correlator;

import java.io.Serializable;

/**
 * Backing lookup and registration store for Flowable BPMN
 * {@code (processInstanceId, parentProcessInstanceId) -> (entityKey, entityLevel)} correlation.
 */
public interface ProcessRegistryStore extends Serializable {

    /**
     * Optional lifecycle hook invoked inside Flink operator {@code open(...)}.
     */
    default void open() throws Exception {
    }

    /**
     * Optional lifecycle hook invoked inside Flink operator {@code close()}.
     */
    default void close() throws Exception {
    }

    /**
     * Registers or updates a Flowable process instance mapping to a business {@code entityKey}.
     */
    void register(
            String processInstanceId,
            String parentProcessInstanceId,
            String processDefKey,
            String entityKey,
            String entityLevel);

    /**
     * Walks {@code parent_process_instance_id} links starting from {@code startParentProcessInstanceId}
     * up to {@code maxDepth} hops and returns the closest ancestor's {@link ResolvedEntity}, or
     * {@code null} if not yet registered.
     */
    ResolvedEntity resolveByParentWalk(String startParentProcessInstanceId, int maxDepth);
}
