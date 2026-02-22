# Pipeline U3 + U3a — Plan та Plan Builder

Кроки планування пошуку доказів: U3 ("де шукати?") → U3a (конкретні кроки) → enqueue U4.

## Кроки

1. **U3 Plan (rules engine)**
   - Вхід: RunRecord (query_profile, routing_flags), RunContext (query_profile + routing_flags).
   - Правила: direct_citation → use_lldbi; ambiguity hard → use_doclist; need_deep_retrieval → use_doclist; input_is_large → meta.use_preview; has_attachments → meta.assemble_attachments; degraded (немає query_profile) → консервативно LLDBI only.
   - Вихід: SearchPlan (sources, thresholds, reason_codes, meta).
   - Збереження: RunRecord.search_plan = { plan, built_at }; RunContext.search_plan; status = Planning.
   - Вихід події: enqueue U3a.

2. **U3a Plan Builder**
   - Вхід: SearchPlan (з RunContext або RunRecord.search_plan).
   - Алгоритм: lldbi_chunks, lldbi_acts (якщо use_lldbi), memory (якщо use_memory), doclist + import_fast (якщо use_doclist), web (якщо use_web).
   - Вихід: SearchStep[] (kind, params, order).
   - Збереження: RunRecord.search_plan = { plan, steps, built_at, next_step: 'U4' }; RunContext.search_steps; status = Planning.
   - Вихід події: enqueue U4.

3. **Failure policy**
   - Run not found → u3_failed / u3a_failed, лог, не падати процесом.
   - U3a: missing plan → u3a_failed, лог.
   - Schema invalid / exception → fallback plan (U3) або mark run failed.

## Observability

- Метрики: u3_processed_total, u3_failed_total, u3_duration_ms; u3a_processed_total, u3a_failed_total, u3a_steps_count.
- Логи: run_id, tenant_id, plan_version, reasons, sources, steps_count, next_step; без секретів і повних великих input (лише lengths).

## Тести

- Команда: `pnpm brain:u3:test`
- Умова: Brain server на порту 3081.
- Кейси: 7 (direct_citation, ambiguity_hard, labor, long_contract, table_like, tax_procedure, mixed_lang).
- Очікування: search_plan.plan + search_plan.steps заповнені, next_step = U4, sources.use_lldbi = true, sources.use_doclist за умовами.
