# R2 storage key map

**Status:** Active. New writes use the unified namespace below. Legacy keys remain readable.

## Unified namespace (new writes)

All new writes use the same root pattern: `tenant/{tenant_id}/...`. Key builder: `scripts/lexery-legal-agent/lib/r2-keys.ts`.

| Scope | Key pattern | Module |
|-------|-------------|--------|
| Query overflow | `tenant/{tenant_id}/runs/{run_id}/input/query.txt` | `gateway/query-overflow.ts` |
| Attachments | `tenant/{tenant_id}/runs/{run_id}/attachments/{filename}` | `gateway/attachments.ts` |
| Full retrieval trace | `tenant/{tenant_id}/runs/{run_id}/retrieval/trace_full.v1.json` | `retrieval/retrieval-trace-r2.ts` |
| MM offload | `tenant/{tenant_id}/mm/offload/{memory_item_id}.json` | `mm/offload.ts` |
| MM Docs raw | `tenant/{tenant_id}/mm/docs/user/{user_id}/raw/{doc_id}/{filename}` | `mm/doc/r2.ts` |
| MM Docs canonical | `tenant/{tenant_id}/mm/docs/user/{user_id}/scope/{scope_type}/{scope_id}/{doc_id}/canonical.v1.json` | `mm/doc/r2.ts` |

Default tenant when not provided: `dev-tenant` (r2-keys); MM offload uses `global` when tenant is null.

## Legacy keys (read-only)

Existing objects may still use:

- `runs/{tenant}/{run}/input/query.txt`
- `runs/{tenant}/{run}/attachments/...`
- `runs/{tenant}/{run}/retrieval_trace_full.json`

Readers use the key stored in DB (e.g. `full_trace_r2_key`, attachment manifest `r2_key`); no key construction at read time, so both legacy and new keys work.

## Bucket

Single bucket: `config.r2BucketRuns` (e.g. `lexery-legal-agent`). No destructive migration; new objects use the new paths.

## MM Docs hardening notes

- Gateway accepts `runs/.../attachments/...` internal references only when the referenced run belongs to the same tenant and the same user as the caller.
- MM Docs raw reuse is limited to the same tenant + same user raw namespace.
- MM Docs canonical artifacts are never accepted back through generic attachment intake; they are consumed only through MM Docs retrieval.
