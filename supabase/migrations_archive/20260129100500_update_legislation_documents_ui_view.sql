-- Update legislation_documents_ui view to drop dependency on legal_status.

CREATE OR REPLACE VIEW public.legislation_documents_ui AS
 SELECT
   CASE
     WHEN (sync_status = 'error' OR qdrant_status = 'error') THEN '🔴'
     WHEN (expected_chunks = 0 AND document_type_slug = ANY (ARRAY['law','code','cmu_resolution','vr_resolution','presidential_decree'])) THEN '🔴'
     WHEN expected_chunks <> indexed_chunks THEN '🔴'
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND expected_chunks = indexed_chunks AND sync_health = 'green') THEN '🟢'
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND (document_type_slug IS NULL OR category IS NULL OR document_number IS NULL OR storage_category IS NULL)) THEN '🟡'
     WHEN sync_health = 'yellow' THEN '🟡'
     WHEN sync_health = 'red' THEN '🔴'
     ELSE '⚪'
   END AS health_badge,
   CASE
     WHEN (sync_status = 'error' OR qdrant_status = 'error') THEN 'ERROR'
     WHEN (expected_chunks = 0 AND document_type_slug = ANY (ARRAY['law','code','cmu_resolution','vr_resolution','presidential_decree'])) THEN 'ERROR'
     WHEN expected_chunks <> indexed_chunks THEN 'ERROR'
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND expected_chunks = indexed_chunks AND sync_health = 'green') THEN 'OK'
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND (document_type_slug IS NULL OR category IS NULL OR document_number IS NULL OR storage_category IS NULL)) THEN 'WARN'
     WHEN sync_health = 'yellow' THEN 'WARN'
     WHEN sync_health = 'red' THEN 'ERROR'
     ELSE 'UNKNOWN'
   END AS health_label,
   CASE
     WHEN (sync_status = 'error' OR qdrant_status = 'error') THEN 1
     WHEN (expected_chunks = 0 AND document_type_slug = ANY (ARRAY['law','code','cmu_resolution','vr_resolution','presidential_decree'])) THEN 1
     WHEN expected_chunks <> indexed_chunks THEN 1
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND expected_chunks = indexed_chunks AND sync_health = 'green') THEN 4
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND (document_type_slug IS NULL OR category IS NULL OR document_number IS NULL OR storage_category IS NULL)) THEN 2
     WHEN sync_health = 'yellow' THEN 2
     WHEN sync_health = 'red' THEN 1
     ELSE 3
   END AS health_rank,
   rada_nreg,
   title,
   document_type_slug,
   document_type,
   category,
   document_number,
   CASE
     WHEN document_type_slug = ANY (ARRAY[
       'convention','ccu_opinion','ccu_decision','court_opinion',
       'presidential_order','minister_order','regulation','rules',
       'instruction','international_treaty','protocol','agreement',
       'other','constitution'
     ]) THEN '—'
     WHEN document_type_slug = ANY (ARRAY['law','code']) THEN
       CASE WHEN law_number IS NULL THEN '🔴 ERROR(NULL)' ELSE law_number::text END
     WHEN document_type_slug = ANY (ARRAY['cmu_resolution','vr_resolution','presidential_decree']) THEN
       COALESCE(law_number::text, '—')
     ELSE COALESCE(law_number::text, '—')
   END AS law_number_ui,
   expected_chunks,
   indexed_chunks,
   qdrant_status,
   sync_status,
   -- legal_status_ui removed (legacy column dropped)
   CASE
     WHEN (sync_status = 'synced' AND qdrant_status = 'indexed' AND expected_chunks = indexed_chunks AND sync_health = 'green') THEN '—'
     WHEN (sync_health = 'red' AND (sync_issue IS NULL OR sync_issue = '')) THEN '🔴 missing reason'
     ELSE COALESCE(sync_issue, '—')
   END AS sync_issue_ui,
   CASE
     WHEN act_is_part = false THEN '—'
     WHEN act_is_part = true AND act_group_key IS NULL THEN '🔴 missing'
     ELSE COALESCE(act_group_key, '—')
   END AS act_group_key_ui,
   CASE
     WHEN act_is_part = false THEN '—'
     WHEN act_is_part = true AND act_part_label IS NULL THEN '🔴 missing'
     ELSE COALESCE(act_part_label, '—')
   END AS act_part_label_ui,
   sync_health,
   rada_datred,
   imported_at,
   updated_at,
   r2_key
 FROM public.legislation_documents;

