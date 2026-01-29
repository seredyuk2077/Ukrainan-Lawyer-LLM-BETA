# Git Audit — Останні 7 днів

**Період:** `git log --since="7 days ago"` · **Гілка:** `feature/supreme-court-case-law-rag`  
**Дата звіту:** 2025-01-29

---

## 1. Список комітів (hash, дата, message)

| # | Hash | Дата | Message |
|---|------|------|---------|
| 1 | `cc43a22` | 2026-01-23 | feat(legislation): PHASE 4-5 complete - health_red=0 + audit 40 docs |
| 2 | `dda39fe` | 2026-01-23 | docs(legislation): Gate A audit table заповнено |
| 3 | `e419c9c` | 2026-01-23 | docs(legislation): Gate A audit template готовий |
| 4 | `6b4e570` | 2026-01-23 | feat(legislation): Gate A complete - 100 documents + evidence |
| 5 | `9b3d610` | 2026-01-23 | feat(legislation): Gate A complete - 100 documents |
| 6 | `4143e88` | 2026-01-23 | feat(legislation): PHASE 0-2 - baseline + HARD batch collection + batch import start |
| 7 | `09227fd` | 2026-01-23 | feat(legislation): PHASE 0-1 - baseline + HARD 50 candidates collection |
| 8 | `5309a29` | 2026-01-23 | fix(legislation): PHASE 3.6.7 - verify chunk_index перевірка (0 не є falsy) |
| 9 | `22bfb96` | 2026-01-23 | fix(legislation): PHASE 3.6.7 - verify фільтрує тільки CURRENT версію (content_hash) |
| 10 | `de67fa2` | 2026-01-23 | fix(legislation): PHASE 3.6.4-3.6.5 - verify FAIL breakdown + reason codes + NA status |
| 11 | `a110ed5` | 2026-01-23 | fix(legislation): PHASE 3.6 - verify applicability + chunks=0 root fix |
| 12 | `bf81e7b` | 2026-01-23 | fix(legislation): PHASE 3.6 - verify applicability matrix + fix chunks=0 для документів з текстом |
| 13 | `65b3613` | 2026-01-23 | fix(legislation): виправлено дублікат оголошення lowerSummary/combinedText |
| 14 | `c688b02` | 2026-01-23 | fix(legislation): PHASE 3.4-3.5 COMPLETE - enrichment root fix + CRITICAL=0 |
| 15 | `9a03f18` | 2026-01-23 | fix(legislation): PHASE 3.4-3.5 - root fix enrichment + close CRITICAL to 0 |
| 16 | `afe875a` | 2026-01-23 | fix(legislation): PHASE 3 COMPLETE - VR_SPEAKER_ORDER виправлено у Supabase + Qdrant |
| 17 | `05b4aee` | 2026-01-23 | fix(legislation): PHASE 3.2-3.3 - VR_SPEAKER_ORDER detection + cache version bump |
| 18 | `9f23cc7` | 2026-01-23 | fix(legislation): передача document_number в enrichDocumentType з buildCanonical |
| 19 | `1961fbb` | 2026-01-23 | fix(legislation): PHASE 3 - VR_SPEAKER_ORDER root fix |
| 20 | `74ea353` | 2026-01-22 | docs(legislation): PHASE 3 progress tracking |

---

## 2. Змінені файли по комітах (A/M/D)

### cc43a22 — PHASE 4-5 complete
| Файл | Зона |
|------|------|
| M `scripts/legislation/AUDIT_GATE_A_100.md` | docs / audit |
| A `scripts/legislation/PHASE_4_5_COMPLETE.md` | docs / phase |
| A `scripts/legislation/audit_script.ts` | script / audit |

### dda39fe — Gate A audit table
| Файл | Зона |
|------|------|
| M `scripts/legislation/AUDIT_GATE_A_100.md` | docs / audit |

### e419c9c — Gate A audit template
| Файл | Зона |
|------|------|
| M `scripts/legislation/AUDIT_GATE_A_100.md` | docs / audit |

### 6b4e570 — Gate A complete 100 + evidence
| Файл | Зона |
|------|------|
| A `scripts/legislation/AUDIT_GATE_A_100.md` | docs / audit |
| A `scripts/legislation/GATE_A_FINAL.md` | docs / phase |

### 9b3d610 — Gate A complete 100
| Файл | Зона |
|------|------|
| A `scripts/legislation/GATE_A_COMPLETE.md` | docs / phase |
| M `scripts/legislation/PROD_READINESS_PROGRESS.md` | docs / progress |

### 4143e88 — PHASE 0-2 batch import start
| Файл | Зона |
|------|------|
| M `scripts/legislation/PROD_READINESS_PROGRESS.md` | docs / progress |
| M `scripts/legislation/commands/import-hard-soak-batch.ts` | commands / import |
| A `scripts/legislation/test/hard_batch_50.txt` | test / data |

### 09227fd — PHASE 0-1 HARD 50 candidates
| Файл | Зона |
|------|------|
| A `scripts/legislation/PROD_READINESS_PROGRESS.md` | docs / progress |

### 5309a29 — PHASE 3.6.7 chunk_index
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_6_FINAL.md` | docs / phase |
| M `scripts/legislation/commands/verify.ts` | commands / verify |

### 22bfb96 — verify CURRENT content_hash
| Файл | Зона |
|------|------|
| M `scripts/legislation/commands/verify.ts` | commands / verify |

### de67fa2 — verify FAIL breakdown + NA
| Файл | Зона |
|------|------|
| M `scripts/legislation/commands/verify.ts` | commands / verify |

### a110ed5 — PHASE 3.6 applicability + chunks=0
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_6_COMPLETE.md` | docs / phase |

### bf81e7b — verify applicability matrix + chunks=0
| Файл | Зона |
|------|------|
| M `scripts/legislation/canonical/parseUnits.ts` | canonical |
| M `scripts/legislation/commands/verify.ts` | commands / verify |
| A `scripts/legislation/lib/verifyApplicability.ts` | lib |

### 65b3613 — lowerSummary/combinedText duplicate
| Файл | Зона |
|------|------|
| M `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | documentTypes |

### c688b02 — PHASE 3.4-3.5 COMPLETE
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_4_5_COMPLETE.md` | docs / phase |
| M `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | documentTypes |

### 9a03f18 — PHASE 3.4-3.5 root fix
| Файл | Зона |
|------|------|
| M `scripts/legislation/commands/detect-type-absurdities.ts` | commands |
| M `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | documentTypes |
| M `scripts/legislation/lib/documentTypeEnrichment.ts` | lib |
| A `scripts/legislation/test/vr_speaker_order.test.ts` | test |

### afe875a — PHASE 3 COMPLETE VR_SPEAKER_ORDER
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_VR_SPEAKER_ORDER_COMPLETE.md` | docs / phase |
| M `scripts/legislation/commands/backfill-document-types.ts` | commands |
| M `scripts/legislation/lib/documentTypeEnrichment.ts` | lib |

### 05b4aee — PHASE 3.2-3.3 VR_SPEAKER_ORDER detection
| Файл | Зона |
|------|------|
| M `scripts/legislation/commands/detect-type-absurdities.ts` | commands |

### 9f23cc7 — document_number in enrichDocumentType
| Файл | Зона |
|------|------|
| M `scripts/legislation/canonical/buildCanonical.ts` | canonical |

### 1961fbb — PHASE 3 VR_SPEAKER_ORDER root fix
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_VR_SPEAKER_ORDER_FIX.md` | docs / phase |
| M `scripts/legislation/commands/backfill-document-types.ts` | commands |
| M `scripts/legislation/commands/detect-type-absurdities.ts` | commands |
| M `scripts/legislation/documentTypes/documentTypes.ts` | documentTypes |
| M `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | documentTypes |
| M `scripts/legislation/lib/documentTypeEnrichment.ts` | lib |

### 74ea353 — PHASE 3 progress
| Файл | Зона |
|------|------|
| A `scripts/legislation/PHASE_3_PROGRESS.md` | docs / progress |

---

## 3. ТОП файлів за частотою змін (7 днів)

| Файл | Кількість комітів | Примітка |
|------|-------------------|----------|
| `scripts/legislation/commands/verify.ts` | 5 | verify pipeline, write-health, applicability |
| `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | 5 | doc type inference, VR_SPEAKER_ORDER, ЦВК/РНБО |
| `scripts/legislation/AUDIT_GATE_A_100.md` | 4 | audit table/template |
| `scripts/legislation/lib/documentTypeEnrichment.ts` | 4 | enrichment, document_number |
| `scripts/legislation/commands/detect-type-absurdities.ts` | 3 | VR_SPEAKER_ORDER, cache bump |
| `scripts/legislation/commands/backfill-document-types.ts` | 2 | backfill, repair |
| `scripts/legislation/PROD_READINESS_PROGRESS.md` | 3 | progress tracking |
| `scripts/legislation/canonical/parseUnits.ts` | 1 | chunks=0 fix |
| `scripts/legislation/lib/verifyApplicability.ts` | 1 | **NEW** applicability matrix |
| `scripts/legislation/canonical/buildCanonical.ts` | 1 | document_number → enrich |
| `scripts/legislation/documentTypes/documentTypes.ts` | 1 | taxonomy |
| Інші (phase/docs, test) | 1 each | — |

---

*Створено: 2025-01-29 · COMMITS_LAST_7_DAYS*
