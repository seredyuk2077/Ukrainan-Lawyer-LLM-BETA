/**
 * Check Snippet — перевірка snippet для конкретного документа
 */

import { getJsonFromR2 } from '../lib/r2Json.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';

async function checkSnippet(nreg: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  const { data: doc } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, r2_key')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (!doc || !doc.r2_key) {
    console.log(`Document not found or no r2_key: ${nreg}`);
    return;
  }
  
  const canonical = await getJsonFromR2(doc.r2_key);
  
  console.log(`\n📋 ${nreg}: ${doc.title}`);
  console.log(`\nRaw TXT (first 600 chars):`);
  console.log(canonical.raw?.rada_api_txt?.substring(0, 600) || 'N/A');
  
  console.log(`\nFirst chunk text (first 400 chars):`);
  console.log(canonical.content?.chunks?.[0]?.text?.substring(0, 400) || 'N/A');
}

const nreg = process.argv[2];
if (nreg) {
  checkSnippet(nreg).catch(console.error);
} else {
  console.log('Usage: pnpm tsx scripts/legislation/commands/check-snippet.ts <nreg>');
}
