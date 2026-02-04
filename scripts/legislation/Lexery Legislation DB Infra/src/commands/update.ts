/**
 * Update command — reindex only if content_hash changed (unless --force).
 */
import { importOne } from '../lib/importer.js';

export async function updateDocument(radaNreg: string, opts: { force?: boolean; resume?: boolean }): Promise<void> {
  const res = await importOne({
    mode: 'update',
    radaNreg,
    force: Boolean(opts.force),
    resume: Boolean(opts.resume),
    dryRun: false,
  });

  console.log('\n## Update result');
  console.log(`- rada_nreg: ${res.rada_nreg}`);
  console.log(`- skipped: ${String(Boolean(res.skipped))}`);
  console.log(`- content_hash: ${res.content_hash}`);
  console.log(`- r2_key: ${res.r2_key}`);
  console.log(`- expected_chunks: ${res.expected_chunks}`);
  console.log(`- qdrant: acts=${res.qdrant.acts} chunks=${res.qdrant.chunks}`);
  console.log(`- run_dir: ${res.run_dir}`);
}

