/**
 * Targeted Document Type Backfill — виправлення конкретних відомих кейсів
 * 
 * Використовується для виправлення:
 * - Декретів КМУ (13-93, 35-93, 7-93)
 * - EU Directives/Regulations (984_011-xx, 984_006-xx)
 * - НКРЕКП (v0310874-18)
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { getDocumentTypeInfo } from '../documentTypes/documentTypes.js';

interface TargetedBackfillResult {
  nreg: string;
  old_slug: string | null;
  new_slug: string;
  old_type: string | null;
  new_type: string;
  updated: boolean;
  error?: string;
}

/**
 * Targeted backfill для конкретного nreg
 */
async function backfillOneDocument(nreg: string, dryRun: boolean = false): Promise<TargetedBackfillResult> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо документ
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    return {
      nreg,
      old_slug: null,
      new_slug: '',
      old_type: null,
      new_type: '',
      updated: false,
      error: `Document not found: ${error?.message || 'unknown'}`,
    };
  }
  
  // Отримуємо canonical з R2
  let jsonData: any = null;
  let summary: string | null = null;
  let snippet: string | null = null;
  let rawTxt: string | null = null;  // ВАЖЛИВО: оголошуємо на рівні функції для scope
  
  try {
    if (doc.r2_key) {
      const canonical = await getJsonFromR2(doc.r2_key);
      jsonData = canonical.raw?.rada_api_json || null;
      summary = canonical.ai_enrichment?.summary || (doc.summary as string | null) || null;
      
      // ВАЖЛИВО: для декретів та НКРЕКП потрібно брати raw.rada_api_txt (priority ladder)
      if (canonical.raw?.rada_api_txt) {
        rawTxt = canonical.raw.rada_api_txt.substring(0, 800);
        snippet = canonical.raw.rada_api_txt.substring(0, 600);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet = canonical.content.chunks[0].text.substring(0, 600);
      }
    }
  } catch (e) {
    return {
      nreg,
      old_slug: doc.document_type_slug || null,
      new_slug: doc.document_type_slug || '',
      old_type: doc.document_type || null,
      new_type: doc.document_type || '',
      updated: false,
      error: `Failed to read R2: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  
  // Використовуємо enrichDocumentType (з raw_txt для priority ladder)
  const enrichment = await enrichDocumentType({
    title: doc.title,
    typ: jsonData?.typ || null,
    typn: jsonData?.typn || null,
    organs: jsonData?.organs || null,
    stru: jsonData?.stru || null,
    summary: summary,
    snippet: snippet,
    document_number: (doc as any).document_number || doc.rada_nreg || null,
    raw_txt: rawTxt || null,  // Додано для priority ladder
  });
  
  const newSlug = enrichment.slug;
  const newType = enrichment.label_uk;
  const oldSlug = doc.document_type_slug;
  const oldType = doc.document_type;
  
  // Перевіряємо чи потрібно оновлювати
  if (oldSlug === newSlug && oldType === newType) {
    return {
      nreg,
      old_slug: oldSlug,
      new_slug: newSlug,
      old_type: oldType,
      new_type: newType,
      updated: false,
    };
  }
  
  // Оновлюємо Supabase
  if (!dryRun) {
    const { error: updateError } = await supabase
      .from('legislation_documents')
      .update({
        document_type_slug: newSlug,
        document_type: newType,
      })
      .eq('rada_nreg', nreg);
    
    if (updateError) {
      return {
        nreg,
        old_slug: oldSlug,
        new_slug: newSlug,
        old_type: oldType,
        new_type: newType,
        updated: false,
        error: `Supabase update error: ${updateError.message}`,
      };
    }
  }
  
  return {
    nreg,
    old_slug: oldSlug,
    new_slug: newSlug,
    old_type: oldType,
    new_type: newType,
    updated: !dryRun,
  };
}

/**
 * Головна функція — targeted backfill для відомих кейсів
 */
export async function targetedDocTypeBackfill(options?: {
  dryRun?: boolean;
  nregs?: string[];
}): Promise<void> {
  const { dryRun = false, nregs } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Targeted Document Type Backfill${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Відомі проблемні кейси
  const knownCases = nregs || [
    // Декрети КМУ
    '13-93',
    '35-93',
    '7-93',
    // EU Directives
    '984_011-01',
    '984_011-12',
    // EU Regulations
    '984_011-07',
    '984_006-03',
    // НКРЕКП
    'v0310874-18',
  ];
  
  console.log(`📋 Processing ${knownCases.length} known cases...\n`);
  
  const results: TargetedBackfillResult[] = [];
  
  for (let i = 0; i < knownCases.length; i++) {
    const nreg = knownCases[i];
    process.stdout.write(`[${i + 1}/${knownCases.length}] ${nreg}... `);
    
    try {
      const result = await backfillOneDocument(nreg, dryRun);
      results.push(result);
      
      if (result.error) {
        console.log(`❌ ${result.error}`);
      } else if (result.updated || (dryRun && result.old_slug !== result.new_slug)) {
        console.log(`✅ ${result.old_slug || 'NULL'} → ${result.new_slug}`);
      } else {
        console.log(`⏭️  unchanged`);
      }
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        nreg,
        old_slug: null,
        new_slug: '',
        old_type: null,
        new_type: '',
        updated: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  
  // Статистика
  const updated = results.filter(r => r.updated).length;
  const unchanged = results.filter(r => !r.updated && !r.error).length;
  const errors = results.filter(r => r.error).length;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`   Total: ${results.length}`);
  console.log(`   ${dryRun ? '[DRY RUN] Would update' : 'Updated'}: ${updated}`);
  console.log(`   Unchanged: ${unchanged}`);
  console.log(`   Errors: ${errors}\n`);
  
  // Зберігаємо результати
  const fs = await import('fs/promises');
  const outputPath = 'scripts/legislation/runs/audit/TARGETED_BACKFILL_RESULTS.json';
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`✅ Targeted backfill results збережено: ${outputPath}`);
}
