/**
 * Add command — import one document (canonical → R2 → AI → Qdrant → Supabase).
 */
import { importOne } from '../lib/importer.js';

export async function addDocument(
  radaNreg: string,
  opts: { category?: string; dryRun?: boolean; resume?: boolean }
): Promise<void> {
  const res = await importOne({
    mode: 'add',
    radaNreg,
    categoryOverride: opts.category,
    dryRun: Boolean(opts.dryRun),
    resume: Boolean(opts.resume),
  });

  console.log('\n## Add result');
  console.log(`- rada_nreg: ${res.rada_nreg}`);
  console.log(`- title: ${res.title}`);
  console.log(`- content_hash: ${res.content_hash}`);
  console.log(`- r2_key: ${res.r2_key}`);
  console.log(`- expected_chunks: ${res.expected_chunks}`);
  console.log(`- qdrant: acts=${res.qdrant.acts} chunks=${res.qdrant.chunks}`);
  console.log(`- run_dir: ${res.run_dir}`);
}

