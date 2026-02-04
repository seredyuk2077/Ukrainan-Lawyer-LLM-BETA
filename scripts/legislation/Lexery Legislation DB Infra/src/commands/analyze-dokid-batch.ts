#!/usr/bin/env node
/**
 * Аналіз документів за dokid для виявлення проблем з класифікацією
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';
import { extractIssuerSignals } from '../lib/signalExtractor.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { workspaceRoot } from '../lib/config.js';

interface DokidAnalysis {
  dokid: number;
  nreg: string | null;
  title: string | null;
  current_slug: string | null;
  current_label: string | null;
  canonical_typ: number | null;
  canonical_organs: any;
  snippet200: string | null;
  summary_prefix: string | null;
  raw_txt_prefix: string | null;
  issuer_signals: string[];
  predicted_slug: string | null;
  predicted_label: string | null;
  predicted_reason: string | null;
  mismatch: boolean;
  issue_type: string | null;
}

export async function analyzeDokidBatch(dokids: number[]): Promise<DokidAnalysis[]> {
  const supabase = createSupabaseAdminClient();
  const results: DokidAnalysis[] = [];

  for (const dokid of dokids) {
    try {
      // Шукаємо документ за rada_dokid в Supabase
      const { data: doc, error } = await supabase
        .from('legislation_documents')
        .select('rada_nreg, title, document_type_slug, document_type, r2_key')
        .eq('rada_dokid', dokid)
        .maybeSingle();
      
      if (error) {
        console.error(`Error fetching dokid ${dokid}: ${error.message}`);
        results.push({
          dokid,
          nreg: null,
          title: null,
          current_slug: null,
          current_label: null,
          canonical_typ: null,
          canonical_organs: null,
          snippet200: null,
          summary_prefix: null,
          raw_txt_prefix: null,
          issuer_signals: [],
          predicted_slug: null,
          predicted_label: null,
          predicted_reason: null,
          mismatch: false,
          issue_type: 'NOT_FOUND',
        });
        continue;
      }

      if (!doc || !doc.r2_key) {
        results.push({
          dokid,
          nreg: null,
          title: null,
          current_slug: null,
          current_label: null,
          canonical_typ: null,
          canonical_organs: null,
          snippet200: null,
          summary_prefix: null,
          raw_txt_prefix: null,
          issuer_signals: [],
          predicted_slug: null,
          predicted_label: null,
          predicted_reason: null,
          mismatch: false,
          issue_type: 'NOT_FOUND',
        });
        continue;
      }
      
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
      
      const summaryPrefix = summary ? summary.substring(0, 120) : null;
      
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
        dokid,
        nreg: doc.rada_nreg,
        title: doc.title,
        current_slug: doc.document_type_slug,
        current_label: doc.document_type,
        canonical_typ: jsonData?.typ || null,
        canonical_organs: jsonData?.organs || null,
        snippet200,
        summary_prefix: summaryPrefix,
        raw_txt_prefix: rawTxtPrefix,
        issuer_signals: issuerSignals,
        predicted_slug: enrichment.slug,
        predicted_label: enrichment.label_uk,
        predicted_reason: enrichment.rationale || null,
        mismatch,
        issue_type: issueType,
      });
    } catch (e) {
      console.error(`Error analyzing dokid ${dokid}: ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        dokid,
        nreg: null,
        title: null,
        current_slug: null,
        current_label: null,
        canonical_typ: null,
        canonical_organs: null,
        snippet200: null,
        summary_prefix: null,
        raw_txt_prefix: null,
        issuer_signals: [],
        predicted_slug: null,
        predicted_label: null,
        predicted_reason: null,
        mismatch: false,
        issue_type: 'ERROR',
      });
    }
  }
  
  return results;
}

// CLI команда
export async function analyzeDokidBatchCLI(dokids: number[]): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Аналіз документів за dokid`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const results = await analyzeDokidBatch(dokids);
  
  // Зберігаємо результати
  const outputPath = resolve(workspaceRoot(), 'runs', 'audit', 'DOKID_BATCH_ANALYSIS.json');
  await writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  
  // Виводимо таблицю
  console.log(`\n📊 Результати аналізу:\n`);
  console.log(`| dokid | nreg | current_slug | predicted_slug | mismatch | issue_type |`);
  console.log(`|-------|------|--------------|----------------|----------|------------|`);
  
  for (const r of results) {
    const mismatchMark = r.mismatch ? '❌' : '✅';
    console.log(`| ${r.dokid} | ${r.nreg || 'N/A'} | ${r.current_slug || 'N/A'} | ${r.predicted_slug || 'N/A'} | ${mismatchMark} | ${r.issue_type || 'OK'} |`);
  }
  
  const mismatches = results.filter(r => r.mismatch);
  console.log(`\n📈 Статистика:`);
  console.log(`   Всього: ${results.length}`);
  console.log(`   Знайдено: ${results.filter(r => r.nreg).length}`);
  console.log(`   Mismatches: ${mismatches.length}`);
  console.log(`   VR_RESOLUTION_MISMATCH: ${mismatches.filter(r => r.issue_type === 'VR_RESOLUTION_MISMATCH').length}`);
  console.log(`   CMU_RESOLUTION_MISMATCH: ${mismatches.filter(r => r.issue_type === 'CMU_RESOLUTION_MISMATCH').length}`);
  
  console.log(`\n✅ Результати збережено: ${outputPath}`);
}
