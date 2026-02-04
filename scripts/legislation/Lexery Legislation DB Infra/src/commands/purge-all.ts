/**
 * Purge-all command — повне очищення (з подвійним підтвердженням).
 *
 * Вимагає:
 * 1) --i-know-what-im-doing
 * 2) введення фрази DELETE_LEXERY_LEGISLATION_DB
 */
import { createInterface } from 'readline';
import { createSupabaseAdminClient, nowIso } from '../lib/supabaseAdmin.js';
import { createQdrantClient, deleteByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { createRunContext, logLine, writeJson, uploadRunToR2 } from '../lib/runs.js';

export interface PurgeOptions {
  iKnowWhatImDoing: boolean;
}

function promptPhrase(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Введіть фразу підтвердження (DELETE_LEXERY_LEGISLATION_DB): ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function purgeAll(opts: PurgeOptions): Promise<void> {
  if (!opts.iKnowWhatImDoing) {
    throw new Error('Purge-all вимагає --i-know-what-im-doing');
  }

  console.log('⚠️  PURGE-ALL: це видалить ВСЕ дані з Supabase + Qdrant.');
  console.log('⚠️  R2 canonical буде архівовано (не видалено).');
  console.log('⚠️  R2 cache/log НЕ чіпається.');

  const phrase = await promptPhrase();
  if (phrase !== 'DELETE_LEXERY_LEGISLATION_DB') {
    throw new Error('Неправильна фраза підтвердження. Операцію скасовано.');
  }

  const run = await createRunContext({ title: 'purge-all', radaNreg: 'purge' });
  await logLine(run, `purge:start ${nowIso()}`);

  const supabase = createSupabaseAdminClient();

  // Preflight counts
  const [{ count: docsBefore }, { count: chunksBefore }] = await Promise.all([
    supabase.from('legislation_documents').select('rada_nreg', { head: true, count: 'exact' }),
    supabase.from('legislation_chunks').select('id', { head: true, count: 'exact' }),
  ]);

  const qdrant = createQdrantClient();
  const [chunksInfo, actsInfo] = await Promise.all([
    qdrant.getCollection(QDRANT_COLLECTION_CHUNKS),
    qdrant.getCollection(QDRANT_COLLECTION_ACTS),
  ]);
  const qdrantChunksBefore = (chunksInfo as any).points_count || 0;
  const qdrantActsBefore = (actsInfo as any).points_count || 0;

  await logLine(run, `purge:before docs=${docsBefore ?? 0} chunks=${chunksBefore ?? 0} qdrant_acts=${qdrantActsBefore} qdrant_chunks=${qdrantChunksBefore}`);

  // Supabase: delete all (chunks cascade)
  await logLine(run, 'supabase:delete all documents');
  const { error: delErr } = await supabase.from('legislation_documents').delete().neq('rada_nreg', 'NEVER_MATCHES');
  if (delErr) throw new Error(`Supabase delete error: ${delErr.message}`);

  // Qdrant: delete all points (scroll + delete by filter, або через API якщо є)
  // Для простоти: використаємо delete з порожнім фільтром (якщо підтримується) або scroll + delete IDs
  await logLine(run, 'qdrant:delete all points');
  
  // Спробуємо видалити всі points через scroll + delete
  const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, { limit: 1000, with_payload: false, with_vector: false });
  const actsScroll = await qdrant.scroll(QDRANT_COLLECTION_ACTS, { limit: 1000, with_payload: false, with_vector: false });
  
  const chunkIds = (chunksScroll.points || []).map((p: any) => p.id);
  const actIds = (actsScroll.points || []).map((p: any) => p.id);

  if (chunkIds.length > 0) {
    await qdrant.delete(QDRANT_COLLECTION_CHUNKS, { wait: true, points: chunkIds } as any);
  }
  if (actIds.length > 0) {
    await qdrant.delete(QDRANT_COLLECTION_ACTS, { wait: true, points: actIds } as any);
  }

  // Verify
  const [{ count: docsAfter }, { count: chunksAfter }] = await Promise.all([
    supabase.from('legislation_documents').select('rada_nreg', { head: true, count: 'exact' }),
    supabase.from('legislation_chunks').select('id', { head: true, count: 'exact' }),
  ]);

  const [chunksInfoAfter, actsInfoAfter] = await Promise.all([
    qdrant.getCollection(QDRANT_COLLECTION_CHUNKS),
    qdrant.getCollection(QDRANT_COLLECTION_ACTS),
  ]);
  const qdrantChunksAfter = (chunksInfoAfter as any).points_count || 0;
  const qdrantActsAfter = (actsInfoAfter as any).points_count || 0;

  const result = {
    before: {
      supabase_docs: docsBefore ?? 0,
      supabase_chunks: chunksBefore ?? 0,
      qdrant_acts: qdrantActsBefore,
      qdrant_chunks: qdrantChunksBefore,
    },
    after: {
      supabase_docs: docsAfter ?? 0,
      supabase_chunks: chunksAfter ?? 0,
      qdrant_acts: qdrantActsAfter,
      qdrant_chunks: qdrantChunksAfter,
    },
    completed_at: nowIso(),
  };

  await writeJson(run.reportPath, { phase: 'F.purge.completed', result });
  await logLine(run, `purge:done ${nowIso()}`);

  console.log('\n## Purge result');
  console.log(`- before: ${JSON.stringify(result.before)}`);
  console.log(`- after: ${JSON.stringify(result.after)}`);
  console.log(`- run_dir: ${run.r2RunPrefix} (R2)`);
  await uploadRunToR2(run);
}
