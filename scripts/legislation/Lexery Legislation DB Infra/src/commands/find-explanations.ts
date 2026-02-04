#!/usr/bin/env node
/**
 * Знайти всі документи з роз'ясненнями (typ=12 або містить "РОЗ'ЯСНЕННЯ")
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

interface ExplanationDoc {
  nreg: string;
  title: string;
  current_slug: string;
  current_label: string;
  canonical_typ: number | null;
  snippet200: string | null;
  raw_txt_prefix: string | null;
  predicted_slug: string | null;
  predicted_label: string | null;
  mismatch: boolean;
}

export async function findExplanations(): Promise<ExplanationDoc[]> {
  const supabase = createSupabaseAdminClient();
  const results: ExplanationDoc[] = [];

  // Отримуємо всі документи
  const { data: docs, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_type_slug, document_type, r2_key')
    .limit(500);

  if (error) {
    throw new Error(`Error fetching documents: ${error.message}`);
  }

  console.log(`\n📋 Перевіряю ${docs?.length || 0} документів на роз'яснення...\n`);

  for (const doc of docs || []) {
    if (!doc.r2_key) continue;

    try {
      const canonical = await getJsonFromR2(doc.r2_key);
      const jsonData = canonical.raw?.rada_api_json || null;
      let snippet200: string | null = null;
      let rawTxtPrefix: string | null = null;

      if (canonical.raw?.rada_api_txt) {
        rawTxtPrefix = canonical.raw.rada_api_txt.substring(0, 800);
        snippet200 = canonical.raw.rada_api_txt.substring(0, 400);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet200 = canonical.content.chunks[0].text.substring(0, 400);
      }

      // Перевіряємо чи це роз'яснення
      const isTyp12 = jsonData?.typ === 12;
      const hasRozjasnennya = (rawTxtPrefix || snippet200 || '').toUpperCase().includes('ЯСНЕННЯ') &&
                              ((rawTxtPrefix || snippet200 || '').toUpperCase().includes('РОЗ') ||
                               (rawTxtPrefix || snippet200 || '').toUpperCase().match(/Р\s+О\s+З/));

      if (isTyp12 || hasRozjasnennya) {
        const enrichment = await enrichDocumentType({
          title: doc.title,
          typ: jsonData?.typ || null,
          typn: jsonData?.typn || null,
          organs: jsonData?.organs || null,
          stru: jsonData?.stru || null,
          summary: canonical.ai_enrichment?.summary || null,
          snippet: snippet200,
          document_number: doc.rada_nreg || null,
          raw_txt: rawTxtPrefix,
        });

        const mismatch = doc.document_type_slug !== enrichment.slug;

        results.push({
          nreg: doc.rada_nreg,
          title: doc.title,
          current_slug: doc.document_type_slug,
          current_label: doc.document_type,
          canonical_typ: jsonData?.typ || null,
          snippet200,
          raw_txt_prefix: rawTxtPrefix,
          predicted_slug: enrichment.slug,
          predicted_label: enrichment.label_uk,
          mismatch,
        });

        if (mismatch) {
          console.log(`❌ ${doc.rada_nreg}: ${doc.document_type_slug} → ${enrichment.slug}`);
        }
      }
    } catch (e) {
      // Пропускаємо
    }
  }

  return results;
}

// CLI команда
export async function findExplanationsCLI(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Пошук документів з роз'ясненнями`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const results = await findExplanations();

  // Зберігаємо результати
  const outputPath = resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'runs', 'audit', 'EXPLANATIONS_FOUND.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  const mismatches = results.filter(r => r.mismatch);

  console.log(`\n📊 Статистика:`);
  console.log(`   Знайдено роз'яснень: ${results.length}`);
  console.log(`   Mismatches: ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log(`\n❌ Проблемні документи:\n`);
    for (const r of mismatches) {
      console.log(`   ${r.nreg}: ${r.current_slug} → ${r.predicted_slug}`);
    }
  }

  console.log(`\n✅ Результати збережено: ${outputPath}`);
}
