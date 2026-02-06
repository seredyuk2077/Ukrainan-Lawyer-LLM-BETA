# U1 Gateway — Test Results

Остання перевірка: 2026-02-06

## Smoke tests

| Test | Command | Expected | Actual | Status |
|------|---------|----------|--------|--------|
| Health | `curl http://localhost:3081/health` | 200, healthy | `{"status":"healthy","database":"ok"}` | ✅ |
| Selftest | `DEV_API_KEY=test123 pnpm brain:selftest` | Exit 0 | 3/3 passed (dry-run, real run, 401) | ✅ |
| Small attachment | POST with 5B base64 | 202, manifest inline | 202, storage: inline | ✅ |
| Overflow (700KB) | POST with 700KB attachment | 202, manifest r2 | 202, storage: r2, r2_key | ✅ |

## API tests

| Test | Expected | Status |
|------|----------|--------|
| Validation 400 (empty body) | 400 VALIDATION_ERROR | ✅ |
| Auth 401 (no key) | 401 UNAUTHORIZED | ✅ |
| Dry-run | 200 dry_run_accepted, no DB write | ✅ |
| Real run | 202, run_id, accepted | ✅ |
| Idempotency | Same run_id for same key | ✅ |
| Rate limit | 429 ERR_BUDGET_EXHAUSTED | ✅ |

## R2 migration (lexery-legal-agent bucket)

| Test | Result |
|------|--------|
| Migration dry-run | 1 object listed |
| Migration run | Copied: 1, Skipped: 0, Failed: 0 |
| Idempotency (re-run) | Skipped: 1 (exists) |
| New overflow upload | 202, storage: r2 in lexery-legal-agent |

## OpenAPI

`docs/api/v1-runs.yaml`
