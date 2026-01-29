/**
 * One-off utility: patch canonical JSON metadata validity fields in R2
 * to match Supabase `legislation_documents` for a given rada_nreg.
 *
 * Why: older canonicals may have legacy validity fields (e.g. UNKNOWN / nulls)
 * while Supabase/Qdrant were backfilled to authoritative resolver.
 *
 * Usage:
 *   npx tsx scripts/legislation/commands/patch-canonical-validity.ts --nreg "n0019525-22"
 */
import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createR2Client, getLegislationBucket } from '../lib/r2Client.js';
import { uploadFileToR2 } from '../lib/r2Upload.js';

type ValidityStatus = 'in_force' | 'expired' | 'not_in_force' | 'suspended' | 'unknown';

async function patchOne(nreg: string): Promise<void> {
  const supabase = createSupabaseAdminClient();

  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg,r2_key,validity_status,source_status_text,source_status_location,status_note')
    .eq('rada_nreg', nreg)
    .single();
  if (error) throw new Error(`Supabase read error: ${error.message}`);
  if (!doc?.r2_key) throw new Error(`Missing r2_key for nreg=${nreg}`);

  const canonical = await getJsonFromR2(doc.r2_key);
  if (!canonical?.metadata) {
    throw new Error(`Canonical JSON missing metadata for key=${doc.r2_key}`);
  }

  const vStatus = String(doc.validity_status || 'unknown') as ValidityStatus;
  canonical.metadata.validity_status = vStatus;
  // keep dates in canonical (may be null); supabase columns may be dropped later
  canonical.metadata.valid_from = canonical.metadata.valid_from ?? null;
  canonical.metadata.valid_to = canonical.metadata.valid_to ?? null;
  canonical.metadata.status_note = String(doc.status_note || '');
  canonical.metadata.source_status_text = String(doc.source_status_text || '');
  canonical.metadata.source_status_location = String(doc.source_status_location || '');

  // Normalize legacy upper-case values if present
  if (typeof canonical.metadata.validity_status === 'string') {
    canonical.metadata.validity_status = canonical.metadata.validity_status.toLowerCase();
  }

  const tmpPath = join(tmpdir(), `canonical_patch_${encodeURIComponent(nreg)}.json`);
  await writeFile(tmpPath, JSON.stringify(canonical), 'utf-8');

  const client = createR2Client();
  const bucket = getLegislationBucket();
  await uploadFileToR2(client, bucket, doc.r2_key, tmpPath, { skipIfExists: false });

  console.log(`✅ Patched canonical validity: nreg=${nreg} key=${doc.r2_key}`);
}

async function main() {
  const program = new Command();
  program.requiredOption('--nreg <nreg>', 'rada_nreg to patch');
  program.parse();
  const opts = program.opts<{ nreg: string }>();
  await patchOne(opts.nreg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

