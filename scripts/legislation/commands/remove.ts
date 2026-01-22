/**
 * Remove command — safe removal (with archive-first for canonical).
 *
 * Без --confirm: тільки preflight preview + report, без змін.
 */
import { createSupabaseAdminClient, nowIso } from '../lib/supabaseAdmin.js';
import { createRunContext, logLine, writeJson } from '../lib/runs.js';
import { getR2AdminClient, headObject, copyObject, deleteObject } from '../lib/r2Admin.js';
import { isCanonicalKey } from '../lib/r2Guardrails.js';
import { createQdrantClient, countByNreg, deleteByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

export interface RemoveOptions {
  confirm: boolean;
}

export async function removeDocument(radaNreg: string, opts: RemoveOptions): Promise<void> {
  const supabase = createSupabaseAdminClient();

  // Preflight (Supabase doc)
  const { data: doc, error: docErr } = await supabase
    .from('legislation_documents')
    .select('rada_nreg,title,content_hash,r2_key,chunks_count,rada_datred')
    .eq('rada_nreg', radaNreg)
    .maybeSingle();

  if (docErr) throw new Error(`Supabase select error: ${docErr.message}`);

  const title = doc?.title || '(unknown-title)';
  const r2Key = doc?.r2_key || null;
  const contentHash = doc?.content_hash || null;

  const run = await createRunContext({ title, radaNreg });
  await logLine(run, `remove:start ${nowIso()} nreg=${radaNreg}`);

  // Preflight (Supabase chunks count)
  const { count: chunksCount, error: chunksCountErr } = await supabase
    .from('legislation_chunks')
    .select('id', { head: true, count: 'exact' })
    .eq('document_nreg', radaNreg);
  if (chunksCountErr) throw new Error(`Supabase chunks count error: ${chunksCountErr.message}`);

  // Preflight (Qdrant counts by nreg)
  const qdrant = createQdrantClient();
  const qdrantChunksCount = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
  const qdrantActsCount = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);

  // Preflight (R2 head)
  const { client: r2, bucket } = getR2AdminClient();
  const r2Head = r2Key ? await headObject(r2, bucket, r2Key) : { exists: false as const };

  const preview = {
    action: 'remove',
    confirm: opts.confirm,
    target: { rada_nreg: radaNreg },
    supabase: {
      document_found: Boolean(doc),
      document: doc
        ? {
            rada_nreg: doc.rada_nreg,
            title: doc.title,
            content_hash: doc.content_hash,
            r2_key: doc.r2_key,
            chunks_count: doc.chunks_count,
            rada_datred: doc.rada_datred,
          }
        : null,
      chunks_count: chunksCount ?? 0,
    },
    qdrant: {
      chunks_count_by_nreg: qdrantChunksCount,
      acts_count_by_nreg: qdrantActsCount,
    },
    r2: {
      canonical_key: r2Key,
      canonical_is_canonical_key: r2Key ? isCanonicalKey(r2Key) : false,
      head: r2Head,
    },
    timestamps: { preview_at: nowIso() },
  };

  await writeJson(run.reportPath, { phase: 'E.remove.preview', preview });
  await logLine(run, `remove:preview done confirm=${String(opts.confirm)}`);

  // Console preview (no secrets)
  console.log('## Remove preview');
  console.log(`- rada_nreg: ${radaNreg}`);
  console.log(`- supabase.document_found: ${String(Boolean(doc))}`);
  if (doc) {
    console.log(`- title: ${doc.title}`);
    console.log(`- content_hash: ${doc.content_hash}`);
    console.log(`- r2_key: ${doc.r2_key}`);
    console.log(`- chunks_count (doc): ${String(doc.chunks_count)}`);
  }
  console.log(`- supabase.chunks_count: ${String(chunksCount ?? 0)}`);
  console.log(`- qdrant.counts_by_nreg: acts=${qdrantActsCount} chunks=${qdrantChunksCount}`);
  console.log(`- r2.canonical.exists: ${String(Boolean(r2Head.exists))}`);
  if (r2Head.exists) {
    console.log(`- r2.canonical.size: ${String(r2Head.size)}`);
    console.log(`- r2.canonical.lastModified: ${String(r2Head.lastModified)}`);
  }
  console.log(`- run_dir: ${run.runDir}`);

  // Без --confirm: тільки preview
  if (!opts.confirm) {
    await logLine(run, 'remove:dry-run (no changes applied)');
    console.log('\nDry-run only. Re-run with `--confirm` to apply removal.');
    return;
  }

  // Job start
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

  try {
    // B) Archive canonical (preferred)
    if (r2Key && r2Head.exists) {
      if (!isCanonicalKey(r2Key)) {
        throw new Error(`Refusing to archive/delete non-canonical key: ${r2Key}`);
      }

      // archive key: legislation/archive/<category>/<encoded>__<timestamp>.json
      const parts = r2Key.split('/');
      const category = parts[1] || 'unknown';
      const file = parts.slice(2).join('/').replace(/\.json$/, '');
      const ts = nowIso().replace(/[:.]/g, '-');
      const archiveKey = `legislation/archive/${category}/${file}__${ts}.json`;

      await logLine(run, `r2:archive copy ${r2Key} -> ${archiveKey}`);
      await copyObject({ client: r2, bucket, sourceKey: r2Key, destKey: archiveKey });

      const archivedHead = await headObject(r2, bucket, archiveKey);
      if (!archivedHead.exists) {
        throw new Error('R2 archive copy failed: archived object not found after copy');
      }
      if (typeof r2Head.size === 'number' && typeof archivedHead.size === 'number' && r2Head.size !== archivedHead.size) {
        throw new Error(`R2 archive size mismatch: source=${r2Head.size} archived=${archivedHead.size}`);
      }

      await logLine(run, `r2:archive verified size=${String(archivedHead.size)}`);

      // delete original canonical
      await logLine(run, `r2:delete original ${r2Key}`);
      await deleteObject(r2, bucket, r2Key);

      const sourceAfter = await headObject(r2, bucket, r2Key);
      if (sourceAfter.exists) {
        throw new Error('R2 delete failed: original canonical still exists after delete');
      }

      await logLine(run, `r2:delete verified (original removed)`);
    } else {
      await logLine(run, `r2:canonical missing or unknown; continuing (key=${String(r2Key)})`);
    }

    // C) Supabase delete (safe: delete chunks first)
    await logLine(run, 'supabase:delete chunks');
    const { error: delChunksErr } = await supabase.from('legislation_chunks').delete().eq('document_nreg', radaNreg);
    if (delChunksErr) throw new Error(`Supabase delete chunks error: ${delChunksErr.message}`);

    await logLine(run, 'supabase:delete document');
    const { error: delDocErr } = await supabase.from('legislation_documents').delete().eq('rada_nreg', radaNreg);
    if (delDocErr) throw new Error(`Supabase delete document error: ${delDocErr.message}`);

    // Verify Supabase
    const { count: docsAfter, error: docsAfterErr } = await supabase
      .from('legislation_documents')
      .select('rada_nreg', { head: true, count: 'exact' })
      .eq('rada_nreg', radaNreg);
    if (docsAfterErr) throw new Error(`Supabase verify docs error: ${docsAfterErr.message}`);

    const { count: chunksAfter, error: chunksAfterErr } = await supabase
      .from('legislation_chunks')
      .select('id', { head: true, count: 'exact' })
      .eq('document_nreg', radaNreg);
    if (chunksAfterErr) throw new Error(`Supabase verify chunks error: ${chunksAfterErr.message}`);

    await logLine(run, `supabase:verify docs=${String(docsAfter ?? 0)} chunks=${String(chunksAfter ?? 0)}`);

    // D) Qdrant delete (by nreg, all versions)
    await logLine(run, 'qdrant:delete acts/chunks by nreg');
    await deleteByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
    await deleteByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);

    const qAfterChunks = await countByNreg(qdrant, QDRANT_COLLECTION_CHUNKS, radaNreg);
    const qAfterActs = await countByNreg(qdrant, QDRANT_COLLECTION_ACTS, radaNreg);
    await logLine(run, `qdrant:verify acts=${qAfterActs} chunks=${qAfterChunks}`);

    const result = {
      action: 'remove',
      rada_nreg: radaNreg,
      before: { supabase_doc: Boolean(doc), supabase_chunks: chunksCount ?? 0, qdrant_acts: qdrantActsCount, qdrant_chunks: qdrantChunksCount, r2: r2Head },
      after: { supabase_docs: docsAfter ?? 0, supabase_chunks: chunksAfter ?? 0, qdrant_acts: qAfterActs, qdrant_chunks: qAfterChunks },
      completed_at: nowIso(),
    };

    await writeJson(run.reportPath, { phase: 'E.remove.completed', preview, result });

    // Job completed
    const { error: jobUpdErr } = await supabase
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
    if (jobUpdErr) throw new Error(`Supabase job update error: ${jobUpdErr.message}`);

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
  }
}

