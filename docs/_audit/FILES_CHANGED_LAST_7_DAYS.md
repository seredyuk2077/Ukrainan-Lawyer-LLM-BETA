# Файли, змінені за останні 7 днів

**Період:** `git log --since="7 days ago"` · **Унікальні шляхи** (всередині `scripts/legislation` або повні).  
**Примітка:** "роль" — попередня підозра на призначення, без висновків прод/непрод.

| path | first seen commit | last seen commit | short note (роль) |
|------|-------------------|------------------|-------------------|
| `scripts/legislation/AUDIT_GATE_A_100.md` | 6b4e570 | cc43a22 | audit template + table, Gate A 100 docs |
| `scripts/legislation/PHASE_4_5_COMPLETE.md` | cc43a22 | cc43a22 | phase 4–5 summary, health_red=0, audit 40 |
| `scripts/legislation/audit_script.ts` | cc43a22 | cc43a22 | audit automation script |
| `scripts/legislation/GATE_A_FINAL.md` | 6b4e570 | 6b4e570 | Gate A final evidence |
| `scripts/legislation/GATE_A_COMPLETE.md` | 9b3d610 | 9b3d610 | Gate A complete 100 |
| `scripts/legislation/PROD_READINESS_PROGRESS.md` | 09227fd | 9b3d610 | baseline, HARD 50, batch progress |
| `scripts/legislation/commands/import-hard-soak-batch.ts` | 4143e88 | 4143e88 | batch import + verify + repair |
| `scripts/legislation/test/hard_batch_50.txt` | 4143e88 | 4143e88 | nreg list for hard batch |
| `scripts/legislation/PHASE_3_6_FINAL.md` | 5309a29 | 5309a29 | verify chunk_index fix |
| `scripts/legislation/commands/verify.ts` | bf81e7b | 5309a29 | verify pipeline, write-health, applicability |
| `scripts/legislation/PHASE_3_6_COMPLETE.md` | a110ed5 | a110ed5 | verify applicability + chunks=0 |
| `scripts/legislation/canonical/parseUnits.ts` | bf81e7b | bf81e7b | chunking, chunks=0 guard |
| `scripts/legislation/lib/verifyApplicability.ts` | bf81e7b | bf81e7b | applicability matrix for verify |
| `scripts/legislation/documentTypes/guessDocumentTypeV2.ts` | 65b3613 | c688b02 | doc type guess, VR/ЦВК/РНБО |
| `scripts/legislation/PHASE_3_4_5_COMPLETE.md` | c688b02 | c688b02 | enrichment root fix, CRITICAL=0 |
| `scripts/legislation/commands/detect-type-absurdities.ts` | 9a03f18 | 05b4aee | absurdity detector, cache bump |
| `scripts/legislation/lib/documentTypeEnrichment.ts` | 9a03f18 | afe875a | document_type enrichment |
| `scripts/legislation/test/vr_speaker_order.test.ts` | 9a03f18 | 9a03f18 | VR_SPEAKER_ORDER unit tests |
| `scripts/legislation/PHASE_3_VR_SPEAKER_ORDER_COMPLETE.md` | afe875a | afe875a | VR_SPEAKER_ORDER complete |
| `scripts/legislation/commands/backfill-document-types.ts` | 1961fbb | afe875a | backfill doc types, repair |
| `scripts/legislation/PHASE_3_VR_SPEAKER_ORDER_FIX.md` | 1961fbb | 1961fbb | VR root fix doc |
| `scripts/legislation/documentTypes/documentTypes.ts` | 1961fbb | 1961fbb | taxonomy, vr_speaker_order |
| `scripts/legislation/canonical/buildCanonical.ts` | 9f23cc7 | 9f23cc7 | canonical build, document_number → enrich |
| `scripts/legislation/PHASE_3_PROGRESS.md` | 74ea353 | 74ea353 | phase 3 progress tracking |

---

*Створено: 2025-01-29 · FILES_CHANGED_LAST_7_DAYS*
