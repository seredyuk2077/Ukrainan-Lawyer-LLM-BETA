/**
 * Importer (single doc) — canonical → R2 → AI enrichment → embeddings → Supabase → Qdrant → verify.
 *
 * Design goals:
 * - Idempotent (stable Qdrant IDs, safe R2 upload).
 * - No secrets in logs.
 * - Evidence: runs/* outputs + legislation_import_jobs.
 */
import { mkdir, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { RadaClient } from '../radaClient.js';
import { buildCanonical, CanonicalDocument } from '../canonical/buildCanonical.js';
import { generateR2Key, CATEGORY_TO_R2_FOLDER } from '../canonical/r2Path.js';
import { createR2Client, getLegislationBucket } from './r2Client.js';
import { uploadCanonicalJsonToR2 } from './r2Upload.js';
import { assertCanonicalKeyForWrite } from './r2Guardrails.js';
import { generateEnrichment } from './aiEnrichment.js';
import { generateEmbedding, generateEmbeddingsBatch } from '../canonical/embeddings.js';
import { QdrantRagClient } from './qdrantRagClient.js';
import { createSupabaseAdminClient, nowIso } from './supabaseAdmin.js';
import { createRunContext, logLine, writeJson } from './runs.js';
import { updateJobProgress, completeJob, failJob, findResumeJob, ImportStage } from './jobProgress.js';
import { normalizeCategory, TaxonomySlug } from '../taxonomy/taxonomy.js';

export interface ImportOptions {
  mode: 'add' | 'update';
  radaNreg: string;
  categoryOverride?: string;
  dryRun?: boolean;
  force?: boolean; // for update
  resume?: boolean; // for resume from existing job
}

export interface ImportResult {
  rada_nreg: string;
  title: string;
  content_hash: string;
  r2_key: string;
  expected_chunks: number;
  qdrant: { acts: number; chunks: number };
  skipped?: boolean;
  run_dir: string;
}

function toDatredDatetime(datred: string): string {
  // If already contains time, return as is; else convert YYYY-MM-DD to ISO at midnight UTC
  if (datred.includes('T')) return datred;
  return `${datred}T00:00:00Z`;
}

function buildActsEmbeddingText(params: { title: string; summary: string; keywords: string[] }): string {
  return `${params.title}\n${params.summary}\n${params.keywords.join(', ')}`.trim();
}

export async function importOne(opts: ImportOptions): Promise<ImportResult> {
  const supabase = createSupabaseAdminClient();

  // Existing doc (for previous_hash + update skip)
  const { data: existingDoc, error: existingErr } = await supabase
    .from('legislation_documents')
    .select('rada_nreg,title,content_hash,r2_key,rada_datred,qdrant_status,indexed_content_hash')
    .eq('rada_nreg', opts.radaNreg)
    .maybeSingle();
  if (existingErr) throw new Error(`Supabase read existing doc error: ${existingErr.message}`);

  const previousHash = existingDoc?.content_hash || null;
  const existingHash = existingDoc?.content_hash || null;

  const run = await createRunContext({ title: existingDoc?.title || 'import', radaNreg: opts.radaNreg });
  await logLine(run, `import:start ${nowIso()} mode=${opts.mode} nreg=${opts.radaNreg} dryRun=${String(Boolean(opts.dryRun))} resume=${String(Boolean(opts.resume))}`);

  // Resume check: якщо resume=true, шукаємо існуючий job
  let actualJobId: string | undefined = undefined;
  if (opts.resume && !opts.dryRun) {
    const resumeJob = await findResumeJob(supabase, opts.radaNreg);
    if (resumeJob) {
      actualJobId = resumeJob.jobId;
      const progress = resumeJob.progress;
      await logLine(run, `resume:found job_id=${actualJobId} stage=${progress.stage || 'unknown'}`);
      console.log(`↻ Resuming job ${actualJobId} from stage: ${progress.stage || 'unknown'}`);
    } else {
      await logLine(run, `resume:no_job_found, starting new import`);
    }
  }

  // Fetch from rada.gov.ua
  const rada = new RadaClient();
  const jsonData = await rada.fetchJson(opts.radaNreg);
  let txtData: string | null = null;
  try {
    txtData = await rada.fetchTxt(opts.radaNreg);
  } catch {
    txtData = null;
  }

  await mkdir(run.runDir, { recursive: true });
  const rawJsonPath = resolve(run.runDir, 'rada_raw.json');
  const rawTxtPath = resolve(run.runDir, 'rada_raw.txt');
  await writeFile(rawJsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
  if (txtData) await writeFile(rawTxtPath, txtData, 'utf-8');

  // Build canonical
  const canonical: CanonicalDocument = await buildCanonical({
    jsonPath: rawJsonPath,
    txtPath: txtData ? rawTxtPath : undefined,
    previousHash,
  });

  // Optional category override (affects ONLY r2_key placement, not content_hash)
  if (opts.categoryOverride) {
    canonical.metadata.category = opts.categoryOverride;
    canonical.metadata.r2_key = generateR2Key(canonical.metadata.category, canonical.metadata.rada_nreg);
  }

  const r2Key = canonical.metadata.r2_key || generateR2Key(canonical.metadata.category, canonical.metadata.rada_nreg);
  assertCanonicalKeyForWrite(r2Key);
  canonical.metadata.r2_key = r2Key;

  const expectedChunks = canonical.content.chunks.length;

  // Update skip logic
  if (opts.mode === 'update' && existingHash && canonical.metadata.content_hash === existingHash && !opts.force) {
    // Update last_checked_at only (unless dry-run)
    if (!opts.dryRun) {
      const { error: updErr } = await supabase
        .from('legislation_documents')
        .update({ last_checked_at: nowIso() })
        .eq('rada_nreg', opts.radaNreg);
      if (updErr) throw new Error(`Supabase update last_checked_at error: ${updErr.message}`);
    }
    const preview = {
      action: 'update',
      skipped: true,
      reason: 'content_hash_unchanged',
      rada_nreg: opts.radaNreg,
      content_hash: canonical.metadata.content_hash,
      expected_chunks: expectedChunks,
      r2_key: r2Key,
      existing: existingDoc,
    };
    await writeJson(run.reportPath, { phase: 'F.update.skipped', preview });
    await logLine(run, 'import:skip content_hash unchanged');
    return {
      rada_nreg: opts.radaNreg,
      title: canonical.metadata.title,
      content_hash: canonical.metadata.content_hash,
      r2_key: r2Key,
      expected_chunks: expectedChunks,
      qdrant: { acts: 0, chunks: 0 },
      skipped: true,
      run_dir: run.runDir,
    };
  }

  // Canonical preview (trim raw)
  const canonicalPreview: any = {
    version: canonical.version,
    schema_version: canonical.schema_version,
    metadata: canonical.metadata,
    content: {
      articles: canonical.content.articles.slice(0, 5),
      chunks: canonical.content.chunks.slice(0, 5),
      structure: canonical.content.structure,
    },
    raw: {
      rada_api_json: {
        nreg: canonical.metadata.rada_nreg,
        dokid: canonical.metadata.rada_dokid,
        nazva: canonical.metadata.title,
        datred: canonical.metadata.rada_datred,
      },
      rada_api_txt: txtData ? txtData.slice(0, 2000) : null,
    },
  };
  await writeJson(run.canonicalPreviewPath, canonicalPreview);

  // Dry-run: stop here (no writes, no AI, no embeddings)
  if (opts.dryRun) {
    const preview = {
      action: opts.mode,
      dry_run: true,
      rada_nreg: opts.radaNreg,
      title: canonical.metadata.title,
      content_hash: canonical.metadata.content_hash,
      previous_hash: canonical.metadata.previous_hash,
      r2_key: r2Key,
      expected_chunks: expectedChunks,
    };
    await writeJson(run.reportPath, { phase: 'F.import.dry_run', preview });
    await logLine(run, 'import:dry-run done');
    return {
      rada_nreg: opts.radaNreg,
      title: canonical.metadata.title,
      content_hash: canonical.metadata.content_hash,
      r2_key: r2Key,
      expected_chunks: expectedChunks,
      qdrant: { acts: 0, chunks: 0 },
      skipped: true,
      run_dir: run.runDir,
    };
  }

  // Create job row (якщо не resume)
  if (!actualJobId && !opts.dryRun) {
    const { data: jobRow, error: jobErr } = await supabase
      .from('legislation_import_jobs')
      .insert({
        status: 'running',
        total_count: 1,
        processed_count: 0,
        success_count: 0,
        error_count: 0,
        started_at: nowIso(),
        config: { action: opts.mode, rada_nreg: opts.radaNreg },
        progress_data: { stage: 'fetched' },
      })
      .select('id')
      .single();
    if (jobErr) throw new Error(`Supabase job insert error: ${jobErr.message}`);
    actualJobId = jobRow.id as string;
  }
  
  // Якщо dry-run або немає jobId, пропускаємо progress tracking
  if (opts.dryRun || !actualJobId) {
    // Продовжуємо без progress tracking для dry-run
  }

  try {
    // Update progress: canonical built (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'canonical_built',
        documentNreg: opts.radaNreg,
        contentHash: canonical.metadata.content_hash,
        expectedChunks: expectedChunks,
      });
    }
    // Upload canonical → R2 (before DB/Qdrant)
    const r2 = createR2Client();
    const bucket = getLegislationBucket();
    const canonicalJson = JSON.stringify(canonical);
    const uploadRes = await uploadCanonicalJsonToR2(r2, bucket, r2Key, canonicalJson, { skipIfExists: true });
    await logLine(run, `r2:uploaded=${String(uploadRes.uploaded)} size=${uploadRes.size}`);
    
    // Update progress: R2 uploaded (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'r2_uploaded',
      });
    }

    // PHASE 5: Валідація document_type перед фінальним upsert
    const { validateDocumentTypeConsistency } = await import('./documentTypeEnrichment.js');
    const validation = validateDocumentTypeConsistency(
      canonical.metadata.document_type_slug,
      canonical.metadata.title,
      null, // summary ще не згенеровано
      canonical.content.chunks?.[0]?.text?.substring(0, 200) || canonical.raw?.rada_api_txt?.substring(0, 200)
    );
    
    // Якщо CRITICAL validation fail → ставимо sync_health=red + sync_issue, але НЕ падаємо фатально
    if (validation.status === 'fail' && validation.issues.some(i => i.includes('CRITICAL') || i.includes('slug=law') || i.includes('slug=code'))) {
      await logLine(run, `validation:CRITICAL issues=${validation.issues.length} suggested_slug=${validation.suggested_slug || 'N/A'}`);
      console.warn(`⚠️  CRITICAL validation fail for ${opts.radaNreg}: ${validation.issues.join('; ')}`);
      // Якщо є suggested_slug → оновлюємо canonical.metadata
      if (validation.suggested_slug) {
        const { getDocumentTypeInfo } = await import('../documentTypes/documentTypes.js');
        canonical.metadata.document_type_slug = validation.suggested_slug;
        canonical.metadata.document_type = getDocumentTypeInfo(validation.suggested_slug).label_uk;
        await logLine(run, `validation:auto_fixed slug=${validation.suggested_slug}`);
      }
    }
    
    // AI enrichment (з кешуванням якщо content_hash не змінився)
    let enrichment: Awaited<ReturnType<typeof generateEnrichment>>;
    const contentHash = canonical.metadata.content_hash;
    
    // Перевіряємо чи вже є enrichment для цього content_hash
    const { data: cachedDoc } = await supabase
      .from('legislation_documents')
      .select('summary, keywords, topics, aliases, category')
      .eq('content_hash', contentHash)
      .not('summary', 'is', null)
      .limit(1)
      .maybeSingle();
    
    if (cachedDoc && cachedDoc.summary) {
      // Використовуємо кешований enrichment
      await logLine(run, `ai:enrichment=cached (content_hash=${contentHash.slice(0, 8)}...)`);
      const { getCategoryLabel } = await import('../taxonomy/taxonomy.js');
      enrichment = {
        summary: cachedDoc.summary,
        keywords: (cachedDoc.keywords || []) as string[],
        topics: (cachedDoc.topics || []) as string[],
        aliases: (cachedDoc.aliases || []) as string[],
        category: cachedDoc.category || canonical.metadata.category,
      };
    } else {
      // Генеруємо новий enrichment через AI
      await logLine(run, `ai:enrichment=generating...`);
      const { analyzeStruTypes } = await import('../canonical/contentUnits.js');
      const stru = jsonData?.stru || [];
      const struDistribution = analyzeStruTypes(stru);
      
      // Формуємо units для AI (якщо є в canonical, використовуємо їх)
      enrichment = await generateEnrichment({
        title: canonical.metadata.title,
        documentType: canonical.metadata.document_type,
        category: canonical.metadata.category,
        radaDatred: canonical.metadata.rada_datred,
        sourceUrl: canonical.metadata.source_url,
        articles: canonical.content.articles.map(a => ({ number: a.number, title: a.title, content: a.content })),
        units: canonical.content.chunks.length > 0 ? canonical.content.chunks.map((c, i) => ({
          unit_type: c.article_number ? 'article' : 'point',
          number: c.article_number || String(i),
          title: c.title || null,
          text: c.text,
        })).slice(0, 10) : undefined, // Перші 10 для preview
        struDistribution: {
          articles: struDistribution.articles,
          points: struDistribution.points,
          subpoints: struDistribution.subpoints,
          total: struDistribution.total,
        },
      });
      await logLine(run, `ai:enrichment=generated category=${enrichment.category}`);
    }
    
    await writeJson(run.enrichmentPath, enrichment);
    
    // Update progress: AI enrichment done (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'ai_enrichment_done',
      });
    }

    // Embeddings (батчевий з прогресивним оновленням для великих документів)
    const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
    if (!apiKey) throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');

    const chunkTexts = canonical.content.chunks.map(c => c.text);
    const totalChunks = chunkTexts.length;
    
    // Для великих документів (>100 chunks) робимо batch embedding з прогресом
    const embeddingBatchSize = totalChunks > 100 ? 32 : 3; // більший batch для великих документів
    const totalBatches = Math.ceil(totalChunks / embeddingBatchSize);
    
    // Update progress: embeddings started (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'embeddings_started',
        stageProgress: `0/${totalBatches}`,
      });
    }
    
    // Generate embeddings з progress callback
    const chunkEmbeddings = await generateEmbeddingsBatch(
      chunkTexts, 
      apiKey, 
      embeddingBatchSize,
      async (batchIndex, totalBatches, processed) => {
        // Оновлюємо прогрес після кожного batch (якщо job існує)
        if (actualJobId) {
          await updateJobProgress(supabase, {
            jobId: actualJobId,
            stage: 'embeddings_progress',
            stageProgress: `${batchIndex}/${totalBatches}`,
            processedChunks: processed,
          });
        }
        await logLine(run, `embeddings:progress=${batchIndex}/${totalBatches} processed=${processed}/${totalChunks}`);
      }
    );
    
    // Update progress: embeddings done (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'embeddings_done',
        processedChunks: totalChunks,
      });
    }
    
    // Acts embedding
    const actsText = buildActsEmbeddingText({ title: canonical.metadata.title, summary: enrichment.summary, keywords: enrichment.keywords });
    const actsEmbedding = await generateEmbedding(actsText, apiKey);

    // Act Group визначення
    const { determineActGroup } = await import('../canonical/actGrouping.js');
    const actGroup = determineActGroup({
      title: canonical.metadata.title,
      documentType: canonical.metadata.document_type,
      lawNumber: canonical.metadata.law_number || null,
    });
    
    // Supabase upsert (registry/control-plane)
    // КРИТИЧНО: category має бути ТІЛЬКИ taxonomy slug EN
    // Нормалізуємо enrichment.category (завжди повертає slug, fallback='other')
    const aiCategory = enrichment.category ? normalizeCategory(enrichment.category) : null;
    
    // Нормалізуємо canonical.metadata.category якщо AI не дав
    const canonicalCategory = canonical.metadata.category ? normalizeCategory(canonical.metadata.category) : null;
    
    // Використовуємо AI category якщо є, інакше canonical (тепер обидва нормалізовані)
    const finalCategory = aiCategory || canonicalCategory || 'other';
    
    // Storage category: парсимо з r2_key (стабільний, не змінюється)
    const storageCategory = (() => {
      if (existingDoc?.r2_key) {
        // Якщо документ вже існує — беремо з r2_key (backward compatibility)
        const match = existingDoc.r2_key.match(/legislation\/([^\/]+)\//);
        return match ? match[1] : null;
      }
      // Для нового документа — використовуємо R2 folder mapping
      return CATEGORY_TO_R2_FOLDER[finalCategory as TaxonomySlug] || 'other';
    })();
    
    // PHASE 15: document_number (універсальний номер)
    const documentNumber = canonical.metadata.document_number || 
                           canonical.metadata.rada_nreg; // fallback на nreg
    
    // PHASE 16: sync_health та legal_status (буде оновлено в verify)
    const syncHealth = (() => {
      // Буде оновлено після verify, поки що unknown
      return null;
    })();
    
    // PHASE 5: Фінальна валідація після AI summary generation
    const finalValidation = validateDocumentTypeConsistency(
      canonical.metadata.document_type_slug,
      canonical.metadata.title,
      enrichment.summary, // Тепер summary є
      canonical.content.chunks?.[0]?.text?.substring(0, 200) || canonical.raw?.rada_api_txt?.substring(0, 200)
    );
    
    // Якщо CRITICAL validation fail після summary → override slug
    if (finalValidation.status === 'fail' && finalValidation.suggested_slug) {
      const { getDocumentTypeInfo } = await import('../documentTypes/documentTypes.js');
      canonical.metadata.document_type_slug = finalValidation.suggested_slug;
      canonical.metadata.document_type = getDocumentTypeInfo(finalValidation.suggested_slug).label_uk;
      await logLine(run, `validation:final_override slug=${finalValidation.suggested_slug} reason=${finalValidation.issues.join('; ')}`);
    }
    
    // Визначаємо sync_health на основі validation
    let validationSyncHealth: 'green' | 'yellow' | 'red' | 'unknown' | null = null;
    let validationSyncIssue: string | null = null;
    if (finalValidation.status === 'fail' && finalValidation.issues.some(i => i.includes('CRITICAL'))) {
      validationSyncHealth = 'red';
      validationSyncIssue = `CRITICAL: ${finalValidation.issues.filter(i => i.includes('CRITICAL')).join('; ')}`;
    } else if (finalValidation.status === 'fail') {
      validationSyncHealth = 'yellow';
      validationSyncIssue = finalValidation.issues.join('; ');
    }
    
    const docUpsert = {
      rada_nreg: canonical.metadata.rada_nreg,
      rada_dokid: canonical.metadata.rada_dokid,
      title: canonical.metadata.title,
      document_type: canonical.metadata.document_type, // ТІЛЬКИ з taxonomy через getDocumentTypeInfo(slug)
      document_type_slug: canonical.metadata.document_type_slug || null, // PHASE 14
      category: finalCategory, // category тепер є taxonomy slug (не label)
      law_number: canonical.metadata.law_number,
      document_number: documentNumber, // PHASE 15
      rada_datred: canonical.metadata.rada_datred,
      content_hash: canonical.metadata.content_hash,
      previous_hash: canonical.metadata.previous_hash,
      r2_key: r2Key,
      source_url: canonical.metadata.source_url,
      articles_count: canonical.content.articles.length,
      chunks_count: expectedChunks,
      imported_at: canonical.metadata.imported_at,
      updated_at: canonical.metadata.updated_at,
      is_active: true,
      sync_status: 'synced',
      summary: enrichment.summary,
      keywords: enrichment.keywords,
      topics: enrichment.topics,
      aliases: enrichment.aliases,
      expected_chunks: expectedChunks,
      indexed_chunks: 0,
      indexed_content_hash: null,
      qdrant_status: 'pending',
      qdrant_indexed_at: null,
      last_checked_at: nowIso(),
      last_sync_error: null,
      // Act Group fields (nullable, backward compatible)
      // act_group_key = NULL для одиночних актів (порожній рядок → NULL в БД)
      act_group_key: actGroup.act_group_key || null,
      act_is_part: actGroup.act_is_part,
      act_part_label: actGroup.act_part_label,
      act_group_title: actGroup.act_group_title,
      // Storage category (R2 folder, стабільний)
      storage_category: storageCategory,
      // PHASE 16: Status indicators (буде оновлено в verify, але встановлюємо через validation)
      legal_status: null, // буде визначено з Rada metadata
      sync_health: validationSyncHealth, // встановлюємо через validation (PHASE 5)
      sync_issue: validationSyncIssue, // встановлюємо через validation (PHASE 5)
    };

    const { error: upsertErr } = await supabase.from('legislation_documents').upsert(docUpsert, { onConflict: 'rada_nreg' });
    if (upsertErr) throw new Error(`Supabase upsert document error: ${upsertErr.message}`);

    // Qdrant upsert
    const qdrantClient = new QdrantRagClient();
    await qdrantClient.upsertAct(
      {
        rada_nreg: canonical.metadata.rada_nreg,
        content_hash: canonical.metadata.content_hash,
        previous_hash: canonical.metadata.previous_hash || null,
        title: canonical.metadata.title,
        category: finalCategory, // category тепер є taxonomy slug (не label)
        document_type: canonical.metadata.document_type,
        document_type_slug: canonical.metadata.document_type_slug || null, // PHASE 14
        rada_datred: toDatredDatetime(canonical.metadata.rada_datred),
        source_url: canonical.metadata.source_url,
        r2_key: r2Key,
        summary: enrichment.summary,
        keywords: enrichment.keywords,
        topics: enrichment.topics,
        aliases: enrichment.aliases,
        // Act Group
        act_group_key: actGroup.act_group_key,
        act_part_label: actGroup.act_part_label,
      },
      actsEmbedding.embedding
    );

    const chunkPoints = canonical.content.chunks.map((chunk, i) => ({
      payload: {
        rada_nreg: canonical.metadata.rada_nreg,
        content_hash: canonical.metadata.content_hash,
        chunk_index: chunk.chunk_index,
        article_number: chunk.article_number || null,
        token_count: typeof chunk.token_count === 'number' ? chunk.token_count : null,
        r2_key: r2Key,
        json_path: `$.content.chunks[${chunk.chunk_index}].text`,
        category: finalCategory, // category тепер є taxonomy slug (не label)
        document_type: canonical.metadata.document_type,
        document_type_slug: canonical.metadata.document_type_slug || null, // PHASE 14
        rada_datred: toDatredDatetime(canonical.metadata.rada_datred),
        title: canonical.metadata.title,
        source_url: canonical.metadata.source_url,
        previous_hash: canonical.metadata.previous_hash || null,
        // Act Group
        act_group_key: actGroup.act_group_key,
        act_part_label: actGroup.act_part_label,
      },
      vector: chunkEmbeddings[i].embedding,
    }));

    // Update progress: Qdrant upsert started (якщо job існує)
    const qdrantBatchSize = 100;
    const qdrantTotalBatches = Math.ceil(chunkPoints.length / qdrantBatchSize);
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'qdrant_upsert_started',
        stageProgress: `0/${qdrantTotalBatches}`,
      });
    }
    
    // Upsert chunks з progress callback
    await qdrantClient.upsertChunks(chunkPoints, async (batchIndex, totalBatches) => {
      if (actualJobId) {
        await updateJobProgress(supabase, {
          jobId: actualJobId,
          stage: 'qdrant_upsert_progress',
          stageProgress: `${batchIndex}/${totalBatches}`,
          processedChunks: Math.min(batchIndex * qdrantBatchSize, chunkPoints.length),
        });
      }
      await logLine(run, `qdrant:upsert_progress=${batchIndex}/${totalBatches}`);
    });
    
    // Update progress: Qdrant upsert done (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'qdrant_upsert_done',
        processedChunks: chunkPoints.length,
      });
    }

    // Verify Qdrant counts
    const qCounts = await qdrantClient.countDocument(canonical.metadata.rada_nreg, canonical.metadata.content_hash);
    if (qCounts.acts !== 1) {
      throw new Error(`Qdrant verify failed: acts count expected 1, got ${qCounts.acts}`);
    }
    if (qCounts.chunks !== expectedChunks) {
      throw new Error(`Qdrant verify failed: chunks count expected ${expectedChunks}, got ${qCounts.chunks}`);
    }

    // Update Supabase post-verify
    const { error: postErr } = await supabase
      .from('legislation_documents')
      .update({
        indexed_chunks: expectedChunks,
        indexed_content_hash: canonical.metadata.content_hash,
        qdrant_status: 'indexed',
        qdrant_indexed_at: nowIso(),
        last_sync_error: null,
      })
      .eq('rada_nreg', canonical.metadata.rada_nreg);
    if (postErr) throw new Error(`Supabase post-verify update error: ${postErr.message}`);
    
    // Update progress: Supabase updated (якщо job існує)
    if (actualJobId) {
      await updateJobProgress(supabase, {
        jobId: actualJobId,
        stage: 'supabase_updated',
        processedChunks: expectedChunks,
      });
      
      // Complete job
      await completeJob(supabase, actualJobId);
      await logLine(run, `job:completed id=${actualJobId}`);
    }

    const result: ImportResult = {
      rada_nreg: canonical.metadata.rada_nreg,
      title: canonical.metadata.title,
      content_hash: canonical.metadata.content_hash,
      r2_key: r2Key,
      expected_chunks: expectedChunks,
      qdrant: qCounts,
      run_dir: run.runDir,
    };

    await writeJson(run.reportPath, { phase: 'F.import.completed', result });
    await logLine(run, 'import:done status=completed');

    // Job уже помічений як completed через completeJob() вище
    // Але якщо actualJobId не існував (dry-run), не оновлюємо
    if (!actualJobId) {
      // Для dry-run не створюємо job
    }

    return result;
  } catch (e: any) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    
    // Fail job on error (якщо job існує)
    if (actualJobId) {
      await failJob(supabase, actualJobId, errorMessage);
      await logLine(run, `job:failed id=${actualJobId} error=${errorMessage}`);
    }
    
    await logLine(run, `import:error ${errorMessage}`);

    // Mark doc as error (best-effort)
    await supabase
      .from('legislation_documents')
      .update({ qdrant_status: 'error', last_sync_error: errorMessage })
      .eq('rada_nreg', opts.radaNreg);

    throw e;
  }
}

