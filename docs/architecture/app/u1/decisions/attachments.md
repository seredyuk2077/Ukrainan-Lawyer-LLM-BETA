# ADR: Attachment Format для U1 (LEX-77 Spike)

## Context

[U1-E] Attachments потребує вибору формату: base64 в body або presigned URL.

## Порівняння

| Критерій | base64 inline | presigned URL |
|----------|---------------|---------------|
| Dev без бекенду | ✅ Просто | ❌ Хто видає URL? |
| Розмір payload | +33% overhead | Малий |
| Безпека | Тільки HTTPS | Тимчасовий доступ |
| UX для Product Backend | Зручно для MVP | Краще для prod |

## Рішення (Dev-first)

1. **Dev/MVP**: підтримувати **attachments[] як inline base64**
   - `{ name, contentType, contentBase64 }`
   - Поріг `ATTACHMENT_INLINE_MAX_BYTES` (default 500KB на файл)
   - Якщо сумарний розмір > `REQUEST_INLINE_MAX_BYTES` — reject або overflow → R2

2. **Prod (TBD)**: presigned URL — Backend видає URL, Brain завантажує за ним
   - В U1 поки не реалізовувати; залишити поле в manifest для майбутнього

3. **R2 threshold**:
   - Якщо attachment > ATTACHMENT_INLINE_MAX_BYTES → зберегти в R2 `runs/{tenant_id}/{run_id}/attachments/{filename}`
   - В manifest: `{ name, size, sha256, storage: "r2", r2_key }`

4. **R2 fail**: якщо R2 недоступний і є великі attachments → **fail** (400/503). Inline small attachments — без R2.

---

## Bucket structure: `lexery-legal-agent` (ADR extension)

З 2026-02: U1 runs/attachments використовують окремий R2 bucket **`lexery-legal-agent`** (не `legislation`).

### Bucket: `lexery-legal-agent`

| Prefix | Опис |
|--------|------|
| `runs/{tenant_id}/{run_id}/attachments/{filename}` | Overflow attachments (>512KB) |
| `runs/{tenant_id}/{run_id}/artifacts/...` | (резерв, майбутнє) |
| `runs/{tenant_id}/{run_id}/logs/...` | (резерв, майбутнє) |

### Правила

- `tenant_id`, `run_id` завжди присутні; fallback для dev без tenant: `dev-tenant`.
- `filename` sanitize: без `../`, пробіли → `_`.
- Metadata при PutObject: `contentType`, `sha256`, `sizeBytes` (x-amz-meta-*).
