# ADR: QueryProfile JSON schema versioning (LEX-94 Spike)

## Context

QueryProfile зберігається в `runs.query_profile` (jsonb). Потрібна можливість еволюції схеми без ламання існуючих записів.

## Decision

- Додати поле `query_profile_version: number` у кожному QueryProfile.
- Поточна версія: **1**. Формат v1: intent, domain, entities, ambiguity, computed_flags, pipeline_step, updated_at.
- U3 та наступні кроки при читанні перевіряють `query_profile_version` і або обробляють тільки v1, або маплять старі версії на поточну.
- При зміні схеми (нові поля, перейменування) збільшувати версію і документувати в pipeline.md.

## Status

Spike closed. Implemented: `query_profile_version: 1` у classify/types.ts та consumer.
