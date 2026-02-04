/**
 * Remove command — видалення документу з усієї інфраструктури (Qdrant → R2 → Supabase).
 *
 * Без --confirm: тільки preflight preview, без змін.
 * Ідемпотентний: повторний запуск на вже видаленому документі — OK.
 * Не використовує legislation_chunks (чанки в Qdrant).
 */
import { createSupabaseAdminClient, nowIso } from '../lib/supabaseAdmin.js';
import { createRunContext, logLine, writeJson, uploadRunToR2 } from '../lib/runs.js';
import { getR2AdminClient, headObject, copyObject, deleteObject } from '../lib/r2Admin.js';
import { isCanonicalKey } from '../lib/r2Guardrails.js';
import { createQdrantClient, countByNreg, deleteByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

export interface RemoveOptions {
  confirm: boolean;
}

export async function removeDocument(radaNreg: string, opts: RemoveOptions): Promise<void> {
  const supabase = createSupabaseAdminClient();

  // Preflight: тільки legislation_documents (legislation_chunks не існує — чанки в Qdrant)
  const { data: doc, error: docErr } = await supabase
    .from('legislation_documents')
    .select('rada_nreg,title,content_hash,r2_key,expected_chunks,rada_datred')
    .eq('rada_nreg', radaNreg)
    .maybeSingle();

  if (docErr) throw new Error(`Supabase select error: ${docErr.message}`);

  const title = doc?.title ?? '(unknown-title)';
  const r2Key = doc?.r2_key ?? null;
  const contentHash = doc?.content_hash ?? null;
  const expectedChunks = doc?.expected_chunks ?? 0;

  const run = await createRunContext({ title, radaNreg });
  await logLine(run, `remove:start ${nowIso()} nreg=${radaNreg}`);

  const qdrant = createQdrantClient();
  const qdrantChunksCount = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
  const qdrantActsCount = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);

  const { client: r2, bucket } = getR2AdminClient();
  const r2Head = r2Key ? await headObject(r2, bucket, r2Key) : { exists: false as const };

  const preview = {
    action: 'remove',
    confirm: opts.confirm,
    target: { rada_nreg: radaNreg },
    supabase: {
      document_found: Boolean(doc),
      document: doc
        ? { rada_nreg: doc.rada_nreg, title: doc.title, content_hash: doc.content_hash, r2_key: doc.r2_key, expected_chunks: doc.expected_chunks, rada_datred: doc.rada_datred }
        : null,
    },
    qdrant: { chunks_count_by_nreg: qdrantChunksCount, acts_count_by_nreg: qdrantActsCount },
    r2: {
      canonical_key: r2Key,
      canonical_is_canonical_key: r2Key ? isCanonicalKey(r2Key) : false,
      head: r2Head,
    },
    timestamps: { preview_at: nowIso() },
  };

  await writeJson(run.reportPath, { phase: 'E.remove.preview', preview });
  await logLine(run, `remove:preview done confirm=${String(opts.confirm)}`);

  console.log('## Remove preview');
  console.log(`- rada_nreg: ${radaNreg}`);
  console.log(`- supabase.document_found: ${String(Boolean(doc))}`);
  if (doc) {
    console.log(`- title: ${doc.title}`);
    console.log(`- content_hash: ${doc.content_hash}`);
    console.log(`- r2_key: ${doc.r2_key}`);
    console.log(`- expected_chunks: ${String(doc.expected_chunks)}`);
  }
  console.log(`- qdrant.counts_by_nreg: acts=${qdrantActsCount} chunks=${qdrantChunksCount}`);
  console.log(`- r2.canonical.exists: ${String(Boolean(r2Head.exists))}`);
  if (r2Head.exists) {
    console.log(`- r2.canonical.size: ${String(r2Head.size)}`);
    console.log(`- r2.canonical.lastModified: ${String(r2Head.lastModified)}`);
  }
  console.log(`- run_dir: ${run.r2RunPrefix} (R2)`);

  if (!opts.confirm) {
    await logLine(run, 'remove:dry-run (no changes applied)');
    console.log('\nDry-run only. Re-run with `--confirm` to apply removal.');
    await uploadRunToR2(run);
    return;
  }

  // Без доку: best-effort Qdrant delete по nreg, далі нічого не робимо (ідемпотентність)
  if (!doc) {
    await logLine(run, 'remove:no-document best-effort qdrant delete');
    try {
      await deleteByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
      await deleteByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
      await logLine(run, 'qdrant:delete best-effort done (no doc)');
    } catch (e: any) {
      await logLine(run, `qdrant:delete best-effort error ${e?.message ?? String(e)}`);
    }
    console.log('\nNo document in Supabase. Qdrant delete-by-nreg attempted (best-effort). Nothing else to remove.');
    await uploadRunToR2(run);
    return;
  }

  const { data: jobRow, error: jobInsErr } = await supabase
    .from('legislation_import_jobs')
    .insert({
      status: 'running',
      total_count: 1,
      processed_count: 0,
      success_count: 0,
      error_count: 0,
      started_at: nowIso(),
      config: { action: 'remove', rada_nreg: radaNreg },
      progress_data: { preview },
    })
    .select('id')
    .single();
  if (jobInsErr) throw new Error(`Supabase job insert error: ${jobInsErr.message}`);

  const jobId = jobRow.id as string;
  await logLine(run, `remove:job started id=${jobId}`);

  const errors: string[] = [];
  let qdrantChunksDeleted = false;
  let qdrantActsDeleted = false;
  let r2Status: 'deleted' | 'already_missing' | 'skipped' = 'skipped';
  let supabaseStatus: 'deleted' | 'missing' | 'error' = 'missing';

  try {
    // 1) Qdrant: chunks → acts (delete-by-filter rada_nreg)
    try {
      await logLine(run, 'qdrant:delete chunks by nreg');
      await deleteByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
      qdrantChunksDeleted = true;
      await logLine(run, 'qdrant:delete chunks done');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      errors.push(`Qdrant delete chunks: ${msg}`);
      await logLine(run, `qdrant:delete chunks error ${msg}`);
    }

    try {
      await logLine(run, 'qdrant:delete acts by nreg');
      await deleteByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
      qdrantActsDeleted = true;
      await logLine(run, 'qdrant:delete acts done');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      errors.push(`Qdrant delete acts: ${msg}`);
      await logLine(run, `qdrant:delete acts error ${msg}`);
    }

    // 2) R2: archive (optional) + delete canonical; safe якщо key вже відсутній
    if (r2Key && isCanonicalKey(r2Key)) {
      if (r2Head.exists) {
        try {
          const parts = r2Key.split('/');
          const category = parts[1] || 'unknown';
          const file = parts.slice(2).join('/').replace(/\.json$/, '');
          const ts = nowIso().replace(/[:.]/g, '-');
          const archiveKey = `legislation/archive/${category}/${file}__${ts}.json`;
          await logLine(run, `r2:archive copy ${r2Key} -> ${archiveKey}`);
          await copyObject({ client: r2, bucket, sourceKey: r2Key, destKey: archiveKey });
          const archivedHead = await headObject(r2, bucket, archiveKey);
          if (!archivedHead.exists) throw new Error('R2 archive copy failed: archived not found');
          if (typeof r2Head.size === 'number' && typeof archivedHead.size === 'number' && r2Head.size !== archivedHead.size) {
            throw new Error(`R2 archive size mismatch: ${r2Head.size} vs ${archivedHead.size}`);
          }
          await logLine(run, `r2:archive verified size=${String(archivedHead.size)}`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          errors.push(`R2 archive: ${msg}`);
          await logLine(run, `r2:archive error ${msg}`);
        }

        try {
          await logLine(run, `r2:delete ${r2Key}`);
          await deleteObject(r2, bucket, r2Key);
          r2Status = 'deleted';
          await logLine(run, 'r2:delete done');
        } catch (e: any) {
          const is404 = e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
          if (is404) {
            r2Status = 'already_missing';
            await logLine(run, 'r2:delete already_missing (404)');
          } else {
            errors.push(`R2 delete: ${e?.message ?? String(e)}`);
            await logLine(run, `r2:delete error ${e?.message ?? String(e)}`);
          }
        }
      } else {
        r2Status = 'already_missing';
        await logLine(run, `r2:canonical missing, skip delete (key=${r2Key})`);
      }
    } else if (r2Key) {
      await logLine(run, `r2:refuse non-canonical key ${r2Key}`);
    } else {
      await logLine(run, 'r2:no key, skip');
    }

    // 3) Supabase: тільки legislation_documents (legislation_chunks не чіпаємо)
    try {
      await logLine(run, 'supabase:delete document');
      const { error: delDocErr } = await supabase.from('legislation_documents').delete().eq('rada_nreg', radaNreg);
      if (delDocErr) {
        errors.push(`Supabase delete document: ${delDocErr.message}`);
        await logLine(run, `supabase:delete error ${delDocErr.message}`);
      } else {
        supabaseStatus = 'deleted';
        await logLine(run, 'supabase:delete done');
      }
    } catch (e: any) {
      errors.push(`Supabase delete: ${e?.message ?? String(e)}`);
      await logLine(run, `supabase:delete error ${e?.message ?? String(e)}`);
      supabaseStatus = 'error';
    }

    const { count: docsAfterVal } = await supabase
      .from('legislation_documents')
      .select('rada_nreg', { head: true, count: 'exact' })
      .eq('rada_nreg', radaNreg);
    const docsAfter = supabaseStatus === 'deleted' ? 0 : (docsAfterVal ?? 0);
    const qAfterChunks = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
    const qAfterActs = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
    await logLine(run, `verify: docs_after=${docsAfter} qdrant_acts=${qAfterActs} qdrant_chunks=${qAfterChunks}`);

    const result = {
      action: 'remove',
      rada_nreg: radaNreg,
      before: { supabase_doc: true, expected_chunks: expectedChunks, qdrant_acts: qdrantActsCount, qdrant_chunks: qdrantChunksCount, r2: r2Head },
      after: { supabase_docs: docsAfter, qdrant_acts: qAfterActs, qdrant_chunks: qAfterChunks },
      summary: {
        qdrant: { chunks_deleted: qdrantChunksDeleted, acts_deleted: qdrantActsDeleted },
        r2: r2Status,
        supabase: supabaseStatus,
      },
      completed_at: nowIso(),
    };

    await writeJson(run.reportPath, { phase: 'E.remove.completed', preview, result });

    console.log('\n## Remove summary');
    console.log(`- Qdrant: chunks_deleted=${qdrantChunksDeleted} acts_deleted=${qdrantActsDeleted}`);
    console.log(`- R2: ${r2Status}`);
    console.log(`- Supabase: ${supabaseStatus}`);

    if (errors.length > 0) {
      await logLine(run, `remove:done with errors ${errors.join('; ')}`);
      await supabase
        .from('legislation_import_jobs')
        .update({
          status: 'failed',
          processed_count: 1,
          success_count: 0,
          error_count: 1,
          completed_at: nowIso(),
          error_message: errors.join('; '),
          progress_data: { preview, result },
        })
        .eq('id', jobId);
      throw new Error(`Remove completed with errors: ${errors.join('; ')}`);
    }

    await supabase
      .from('legislation_import_jobs')
      .update({
        status: 'completed',
        processed_count: 1,
        success_count: 1,
        error_count: 0,
        completed_at: nowIso(),
        progress_data: { preview, result },
      })
      .eq('id', jobId);
    await logLine(run, 'remove:done status=completed');
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLine(run, `remove:error ${msg}`);
    await supabase
      .from('legislation_import_jobs')
      .update({
        status: 'failed',
        processed_count: 1,
        success_count: 0,
        error_count: 1,
        completed_at: nowIso(),
        error_message: msg,
      })
      .eq('id', jobId);
    throw e;
  } finally {
    await uploadRunToR2(run);
  }
}
