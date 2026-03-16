# U12 Deliver — pipeline

- **Input:** RunEvent step U12; run_id. Data: run from DB (llm_result, conversation_id).
- **Actions:** completeRun (status + completed_at); optional insert into messages; optional insert into mm_outbox.
- **Output:** Log persistedToRuns, messageInserted, outboxEnqueued. No return value to queue.
- **Flow:** U11 → U12. After U12, run is terminal for this pipeline; outbox consumed asynchronously.
