#!/usr/bin/env node
/**
 * Аудит всіх постанов (cmu_resolution, vr_resolution) для виявлення проблем
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { extractIssuerSignals } from '../lib/signalExtractor.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';

interface ResolutionAudit {
  nreg: string;
  title: string;
  current_slug: string;
  current_label: string;
  canonical_typ: number | null;
  canonical_organs: any;
  snippet200: string | null;
  raw_txt_prefix: string | null;
  issuer_signals: string[];
  predicted_slug: string | null;
  predicted_label: string | null;
  predicted_reason: string | null;
  mismatch: boolean;
  issue_type: string | null;
}

export async function auditResolutions(): Promise<ResolutionAudit[]> {
  const supabase = createSupabaseAdminClient();
  const results: ResolutionAudit[] = [];

  // Отримуємо всі документи з cmu_resolution або vr_resolution
  const { data: docs, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, document_type_slug, document_type, r2_key')
    .in('document_type_slug', ['cmu_resolution', 'vr_resolution'])
    .limit(500); // Обмежуємо для початку

  if (error) {
    throw new Error(`Error fetching documents: ${error.message}`);
  }

  console.log(`\n📋 Знайдено ${docs?.length || 0} документів для аудиту\n`);

  for (const doc of docs || []) {
    if (!doc.r2_key) continue;

    try {
      // Отримуємо canonical з R2
      const canonical = await getJsonFromR2(doc.r2_key);
      const jsonData = canonical.raw?.rada_api_json || null;
      const summary = canonical.ai_enrichment?.summary || null;
      let snippet200: string | null = null;
      let rawTxtPrefix: string | null = null;

      if (canonical.raw?.rada_api_txt) {
        rawTxtPrefix = canonical.raw.rada_api_txt.substring(0, 800);
        snippet200 = canonical.raw.rada_api_txt.substring(0, 400);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet200 = canonical.content.chunks[0].text.substring(0, 400);
      }

      // Отримуємо predicted через enrichDocumentType
      const enrichment = await enrichDocumentType({
        title: doc.title,
        typ: jsonData?.typ || null,
        typn: jsonData?.typn || null,
        organs: jsonData?.organs || null,
        stru: jsonData?.stru || null,
        summary: summary,
        snippet: snippet200,
        document_number: doc.rada_nreg || null,
        raw_txt: rawTxtPrefix,
      });

      // Отримуємо issuer signals
      const issuerSignals = extractIssuerSignals({
        title: doc.title,
        snippet: snippet200,
        summary: summary,
        organs: jsonData?.organs || null,
        raw_txt: rawTxtPrefix,
      });

      const mismatch = doc.document_type_slug !== enrichment.slug;
      let issueType: string | null = null;

      if (mismatch) {
        if (doc.document_type_slug === 'vr_resolution' && enrichment.slug !== 'vr_resolution') {
          issueType = 'VR_RESOLUTION_MISMATCH';
        } else if (doc.document_type_slug === 'cmu_resolution' && enrichment.slug !== 'cmu_resolution') {
          issueType = 'CMU_RESOLUTION_MISMATCH';
        } else {
          issueType = 'GENERAL_MISMATCH';
        }
      }

      results.push({
        nreg: doc.rada_nreg,
        title: doc.title,
        current_slug: doc.document_type_slug,
        current_label: doc.document_type,
        canonical_typ: jsonData?.typ || null,
        canonical_organs: jsonData?.organs || null,
        snippet200,
        raw_txt_prefix: rawTxtPrefix,
        issuer_signals: issuerSignals,
        predicted_slug: enrichment.slug,
        predicted_label: enrichment.label_uk,
        predicted_reason: enrichment.rationale || null,
        mismatch,
        issue_type: issueType,
      });

      if (mismatch) {
        console.log(`❌ ${doc.rada_nreg}: ${doc.document_type_slug} → ${enrichment.slug}`);
      }
    } catch (e) {
      console.error(`Error processing ${doc.rada_nreg}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return results;
}

// CLI команда
export async function auditResolutionsCLI(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Аудит постанов (cmu_resolution, vr_resolution)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);

  const results = await auditResolutions();

  // Зберігаємо результати
  const outputPath = resolve(process.cwd(), 'scripts/legislation/runs/audit/RESOLUTIONS_AUDIT.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');

  // Статистика
  const mismatches = results.filter(r => r.mismatch);
  const vrMismatches = mismatches.filter(r => r.issue_type === 'VR_RESOLUTION_MISMATCH');
  const cmuMismatches = mismatches.filter(r => r.issue_type === 'CMU_RESOLUTION_MISMATCH');

  console.log(`\n📊 Статистика:`);
  console.log(`   Всього перевірено: ${results.length}`);
  console.log(`   Mismatches: ${mismatches.length}`);
  console.log(`   VR_RESOLUTION_MISMATCH: ${vrMismatches.length}`);
  console.log(`   CMU_RESOLUTION_MISMATCH: ${cmuMismatches.length}`);

  // Список проблемних документів
  if (mismatches.length > 0) {
    console.log(`\n❌ Проблемні документи:\n`);
    for (const r of mismatches.slice(0, 20)) {
      console.log(`   ${r.nreg}: ${r.current_slug} → ${r.predicted_slug} (${r.issue_type})`);
    }
    if (mismatches.length > 20) {
      console.log(`   ... і ще ${mismatches.length - 20} документів`);
    }
  }

  console.log(`\n✅ Результати збережено: ${outputPath}`);
}
