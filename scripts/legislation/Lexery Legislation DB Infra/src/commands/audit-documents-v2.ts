/**
 * Audit Documents V2 — повний аудит документів з evidence
 * 
 * Збирає:
 * - Supabase: nreg, title, document_number, law_number, document_type_slug, document_type, category, sync_health, expected_chunks, indexed_chunks, qdrant_status
 * - Canonical: summary_prefix (перші 120 символів), snippet200 (перші 200 символів тексту), organs/typ
 * - Qdrant: для 1–2 chunks: payload fields + content_hash match
 * - Signals: prefix patterns, suffix patterns
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { extractSignals } from '../lib/signalExtractor.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';

interface AuditRecordV2 {
  // Supabase
  nreg: string;
  title: string;
  document_number: string | null;
  law_number: string | null;
  document_type_slug: string | null;
  document_type: string | null;
  category: string | null;
  sync_health: string | null;
  expected_chunks: number | null;
  indexed_chunks: number | null;
  qdrant_status: string | null;
  
  // Canonical
  summary_prefix: string | null;
  snippet200: string | null;
  canonical_typ: number | null;
  canonical_organs: any;
  
  // Qdrant
  qdrant_chunks_sample: Array<{
    chunk_index: number;
    content_hash: string;
    document_type_slug: string | null;
    category: string | null;
    article_number: string | null;
  }>;
  qdrant_content_hash_match: boolean;
  
  // Signals
  signals: {
    prefix_patterns: string[]; // ПОСТАНОВА, РОЗПОРЯДЖЕННЯ, УКАЗ, РІШЕННЯ, НАКАЗ, ДИРЕКТИВА, РЕГЛАМЕНТ, КОНВЕНЦІЯ
    suffix_patterns: string[]; // -РП, -РГ, z****-**, v******-**, va**p***-**, 995_*, 984_*, 380_*, **-**-п, **-**-р
    issuer_candidates: string[]; // CMU, VRU, PRESIDENT, CCU, NERC, EU_PARLIAMENT, etc.
    kind_candidates: string[]; // DECREE, RESOLUTION, ORDER, DIRECTIVE, REGULATION, etc.
  };
  
  // Predicted
  predicted_slug: string | null;
  predicted_reason: string | null;
  predicted_confidence: string | null;
  
  // Mismatch flags
  mismatch_flags: {
    ISSUER_MISMATCH: boolean;
    KIND_MISMATCH: boolean;
    EU_LAW_MISMATCH: boolean;
    DECREE_MISMATCH: boolean;
    AGENCY_AS_CMU: boolean;
  };
  
  severity: 'CRITICAL' | 'WARN' | 'OK';
}

/**
 * Витягує signals з snippet/title/document_number (legacy, для сумісності)
 */
function extractLegacySignals(params: {
  snippet: string | null;
  title: string;
  document_number: string | null;
}): { prefix_patterns: string[]; suffix_patterns: string[] } {
  const { snippet, title, document_number } = params;
  
  const prefixPatterns: string[] = [];
  const suffixPatterns: string[] = [];
  
  const combined = `${snippet || ''} ${title}`.toUpperCase();
  
  // Prefix patterns
  const prefixes = ['ПОСТАНОВА', 'РОЗПОРЯДЖЕННЯ', 'УКАЗ', 'РІШЕННЯ', 'НАКАЗ', 'ДИРЕКТИВА', 'РЕГЛАМЕНТ', 'КОНВЕНЦІЯ'];
  for (const prefix of prefixes) {
    if (combined.includes(prefix)) {
      prefixPatterns.push(prefix);
    }
  }
  
  // Suffix patterns
  if (document_number) {
    const normalized = document_number.replace(/[‐‑‒–—―−]/g, '-').toUpperCase().trim();
    
    // -РП, -РГ
    if (normalized.endsWith('-РП')) suffixPatterns.push('-РП');
    if (normalized.endsWith('-РГ')) suffixPatterns.push('-РГ');
    
    // z****-**, v******-**, va**p***-**
    if (/^z\d{4}-\d{2}/.test(normalized)) suffixPatterns.push('z****-**');
    if (/^v\d{6}-\d{2}/.test(normalized)) suffixPatterns.push('v******-**');
    if (/^va\d{2}p\d{3}-\d{2}/.test(normalized)) suffixPatterns.push('va**p***-**');
    
    // 995_*, 984_*, 380_*
    if (/^995_/.test(normalized)) suffixPatterns.push('995_*');
    if (/^984_/.test(normalized)) suffixPatterns.push('984_*');
    if (/^380_/.test(normalized)) suffixPatterns.push('380_*');
    
    // **-**-п, **-**-р
    if (/^\d+-\d+-п$/.test(normalized)) suffixPatterns.push('**-**-п');
    if (/^\d+-\d+-р$/.test(normalized)) suffixPatterns.push('**-**-р');
  }
  
  return { prefix_patterns: prefixPatterns, suffix_patterns: suffixPatterns };
}

/**
 * Отримує sample chunks з Qdrant
 */
async function getQdrantChunksSample(nreg: string, limit: number = 2): Promise<Array<{
  chunk_index: number;
  content_hash: string;
  document_type_slug: string | null;
  category: string | null;
  article_number: string | null;
}>> {
  try {
    const client = createQdrantClient();
    
    const scrollRes = await client.scroll(QDRANT_COLLECTION_CHUNKS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: nreg } }],
      },
      limit,
      with_payload: true,
    } as any);
    
    const points = (scrollRes as any).points || [];
    
    return points.map((point: any) => ({
      chunk_index: typeof point.payload?.chunk_index === 'number' ? point.payload.chunk_index : -1,
      content_hash: point.payload?.content_hash || '',
      document_type_slug: point.payload?.document_type_slug || null,
      category: point.payload?.category || null,
      article_number: point.payload?.article_number || null,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Генерує audit record для одного документа
 */
async function auditOneDocumentV2(nreg: string): Promise<AuditRecordV2> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // Отримуємо canonical з R2
  let summaryPrefix: string | null = null;
  let snippet200: string | null = null;
  let canonicalTyp: number | null = null;
  let canonicalOrgans: any = null;
  
  try {
    if (doc.r2_key) {
      const canonical = await getJsonFromR2(doc.r2_key);
      
      // summary_prefix (перші 120 символів)
      const summary = canonical.ai_enrichment?.summary || (doc.summary as string | null) || null;
      if (summary) {
        summaryPrefix = summary.substring(0, 120);
      }
      
      // snippet200 (перші 400 символів тексту для кращого виявлення декретів/НКРЕКП)
      // ВАЖЛИВО: для декретів та НКРЕКП потрібно брати raw.rada_api_txt, бо chunks можуть не містити заголовок
      if (canonical.raw?.rada_api_txt) {
        snippet200 = canonical.raw.rada_api_txt.substring(0, 400);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet200 = canonical.content.chunks[0].text.substring(0, 400);
      }
      
      // typ, organs
      if (canonical.raw?.rada_api_json) {
        canonicalTyp = canonical.raw.rada_api_json.typ || null;
        canonicalOrgans = canonical.raw.rada_api_json.organs || null;
      }
    }
  } catch (e) {
    // Пропускаємо якщо не вдалося прочитати R2
  }
  
  // Отримуємо Qdrant chunks sample
  const qdrantChunksSample = await getQdrantChunksSample(nreg, 2);
  
  // Витягуємо raw_txt для priority ladder
  let rawTxtPrefix: string | null = null;
  try {
    if (doc.r2_key) {
      const canonical = await getJsonFromR2(doc.r2_key);
      if (canonical.raw?.rada_api_txt) {
        rawTxtPrefix = canonical.raw.rada_api_txt.substring(0, 800);
      }
    }
  } catch (e) {
    // Пропускаємо якщо не вдалося прочитати R2
  }
  
  // Витягуємо issuer/kind signals (з raw_txt для priority ladder)
  const extractedSignals = extractSignals({
    title: doc.title,
    snippet: snippet200,
    summary: summaryPrefix,
    organs: canonicalOrgans,
    raw_txt: rawTxtPrefix,  // Додано для priority ladder
  });
  
  // Отримуємо predicted slug через enrichDocumentType
  let predictedSlug: string | null = null;
  let predictedReason: string | null = null;
  let predictedConfidence: string | null = null;
  
  try {
    const enrichment = await enrichDocumentType({
      title: doc.title,
      typ: canonicalTyp,
      typn: null,
      organs: canonicalOrgans,
      summary: summaryPrefix,
      snippet: snippet200,
      raw_txt: rawTxtPrefix,  // PRIORITY LADDER: raw_txt має пріоритет
      document_number: (doc as any).document_number || doc.rada_nreg || null,
    });
    predictedSlug = enrichment.slug;
    predictedReason = enrichment.rationale || null;
    predictedConfidence = enrichment.confidence;
  } catch (e) {
    // Пропускаємо якщо не вдалося
  }
  
  // Визначаємо mismatch flags
  const mismatchFlags = {
    ISSUER_MISMATCH: false,
    KIND_MISMATCH: false,
    EU_LAW_MISMATCH: false,
    DECREE_MISMATCH: false,
    AGENCY_AS_CMU: false,
  };
  
  let severity: 'CRITICAL' | 'WARN' | 'OK' = 'OK';
  
  // Перевірка issuer mismatch
  if (extractedSignals.issuer_candidates.length > 0 && extractedSignals.issuer_candidates[0] !== 'OTHER') {
    const issuer = extractedSignals.issuer_candidates[0];
    if (doc.document_type_slug === 'cmu_resolution' && issuer !== 'CMU') {
      mismatchFlags.ISSUER_MISMATCH = true;
      mismatchFlags.AGENCY_AS_CMU = (issuer === 'NERC' || issuer === 'MINISTRY');
      severity = 'CRITICAL';
    }
    if (doc.document_type_slug === 'vr_resolution' && issuer !== 'VRU') {
      mismatchFlags.ISSUER_MISMATCH = true;
      severity = 'CRITICAL';
    }
  }
  
  // Перевірка EU law mismatch
  if ((doc.rada_nreg.startsWith('984_011-') || doc.rada_nreg.startsWith('984_006-')) &&
      doc.document_type_slug !== 'eu_directive' && doc.document_type_slug !== 'eu_regulation') {
    mismatchFlags.EU_LAW_MISMATCH = true;
    severity = 'CRITICAL';
  }
  
  // Перевірка decree mismatch
  if (extractedSignals.kind_candidates.includes('DECREE') &&
      extractedSignals.issuer_candidates.includes('CMU') &&
      doc.document_type_slug !== 'cmu_decree') {
    mismatchFlags.DECREE_MISMATCH = true;
    severity = 'CRITICAL';
  }
  
  // Перевірка kind mismatch
  if (extractedSignals.kind_candidates.length > 0) {
    const kind = extractedSignals.kind_candidates[0];
    if (kind === 'DIRECTIVE' && doc.document_type_slug !== 'eu_directive') {
      mismatchFlags.KIND_MISMATCH = true;
      severity = 'WARN';
    }
    if (kind === 'REGULATION' && doc.document_type_slug !== 'eu_regulation') {
      mismatchFlags.KIND_MISMATCH = true;
      severity = 'WARN';
    }
  }
  
  // Перевіряємо content_hash match
  const qdrantContentHashMatch = qdrantChunksSample.length > 0 && 
    qdrantChunksSample[0].content_hash === doc.content_hash;
  
  // Витягуємо legacy signals (prefix/suffix patterns)
  const legacySignals = extractLegacySignals({
    snippet: snippet200,
    title: doc.title || '',
    document_number: (doc as any).document_number || doc.rada_nreg || null,
  });
  
  // Об'єднуємо signals
  const combinedSignals = {
    prefix_patterns: legacySignals.prefix_patterns,
    suffix_patterns: legacySignals.suffix_patterns,
    issuer_candidates: extractedSignals.issuer_candidates,
    kind_candidates: extractedSignals.kind_candidates,
  };
  
  return {
    // Supabase
    nreg: doc.rada_nreg,
    title: doc.title || '',
    document_number: (doc as any).document_number || doc.rada_nreg || null,
    law_number: doc.law_number || null,
    document_type_slug: doc.document_type_slug || null,
    document_type: doc.document_type || null,
    category: doc.category || null,
    sync_health: doc.sync_health || null,
    expected_chunks: doc.expected_chunks || null,
    indexed_chunks: doc.indexed_chunks || null,
    qdrant_status: doc.qdrant_status || null,
    
    // Canonical
    summary_prefix: summaryPrefix,
    snippet200: snippet200,
    canonical_typ: canonicalTyp,
    canonical_organs: canonicalOrgans,
    
    // Qdrant
    qdrant_chunks_sample: qdrantChunksSample,
    qdrant_content_hash_match: qdrantContentHashMatch,
    
    // Signals
    signals: combinedSignals,
    
    // Predicted
    predicted_slug: predictedSlug,
    predicted_reason: predictedReason,
    predicted_confidence: predictedConfidence,
    
    // Mismatch flags
    mismatch_flags: mismatchFlags,
    
    // Severity
    severity,
  };
}

/**
 * Головна функція — генерує audit records для всіх документів
 */
export async function auditAllDocumentsV2(options?: {
  limit?: number;
  nregs?: string[];  // Додано для аудиту конкретних nreg
  outputFile?: string;
  outputMarkdown?: string;
}): Promise<void> {
  const { limit, nregs, outputFile, outputMarkdown } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Audit Documents V2 — Генерація Audit Records з Evidence`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  let docs: Array<{ rada_nreg: string }> = [];
  
  if (nregs && nregs.length > 0) {
    // Аудит конкретних nreg
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg')
      .in('rada_nreg', nregs)
      .order('rada_nreg');
    
    if (error) {
      throw new Error(`Failed to fetch documents: ${error.message}`);
    }
    
    docs = data || [];
  } else {
    // Отримуємо всі документи
    let query = supabase
      .from('legislation_documents')
      .select('rada_nreg')
      .order('rada_nreg');
    
    if (limit) {
      query = query.limit(limit);
    }
    
    const { data, error } = await query;
  
    if (error) {
      throw new Error(`Failed to fetch documents: ${error.message}`);
    }
    
    docs = data || [];
  }
  
  if (!docs || docs.length === 0) {
    console.log(`❌ Документи не знайдені\n`);
    return;
  }
  
  console.log(`📋 Знайдено ${docs.length} документів для аудиту\n`);
  
  const records: AuditRecordV2[] = [];
  
  // Аудит по одному документу
  for (let i = 0; i < docs.length; i++) {
    const nreg = docs[i].rada_nreg;
    process.stdout.write(`[${i + 1}/${docs.length}] Аудит ${nreg}... `);
    
    try {
      const record = await auditOneDocumentV2(nreg);
      records.push(record);
      console.log(`✅`);
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // Зберігаємо JSON
  if (outputFile) {
    const fs = await import('fs/promises');
    await fs.writeFile(outputFile, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`\n✅ Audit records (JSON) збережено: ${outputFile}`);
  }
  
  // Зберігаємо Markdown таблицю
  if (outputMarkdown) {
    const fs = await import('fs/promises');
    const markdown = generateMarkdownTable(records);
    await fs.writeFile(outputMarkdown, markdown, 'utf-8');
    console.log(`✅ Audit table (Markdown) збережено: ${outputMarkdown}`);
  }
  
  console.log(`\n📊 Статистика:`);
  console.log(`   Всього документів: ${records.length}`);
  console.log(`   З signals: ${records.filter(r => r.signals.prefix_patterns.length > 0 || r.signals.suffix_patterns.length > 0).length}`);
  console.log(`   Qdrant hash match: ${records.filter(r => r.qdrant_content_hash_match).length}/${records.length}\n`);
}

/**
 * Генерує Markdown таблицю з audit records
 */
function generateMarkdownTable(records: AuditRecordV2[]): string {
  let md = `# Audit Table — ${records.length} Documents\n\n`;
  md += `| NREG | Title | Doc Type | Predicted | Issuer | Kind | Severity | Mismatches |\n`;
  md += `|------|-------|----------|-----------|--------|------|----------|------------|\n`;
  
  // Сортуємо: CRITICAL спочатку
  const sortedRecords = [...records].sort((a, b) => {
    if (a.severity !== b.severity) {
      if (a.severity === 'CRITICAL') return -1;
      if (b.severity === 'CRITICAL') return 1;
      if (a.severity === 'WARN') return -1;
      if (b.severity === 'WARN') return 1;
    }
    return 0;
  });
  
  for (const record of sortedRecords) {
    const title = (record.title || '').substring(0, 50).replace(/\|/g, '\\|');
    const docType = record.document_type_slug || 'NULL';
    const predicted = record.predicted_slug || 'NULL';
    const issuer = record.signals.issuer_candidates[0] || 'OTHER';
    const kind = record.signals.kind_candidates[0] || 'NONE';
    const severity = record.severity;
    
    const mismatches: string[] = [];
    if (record.mismatch_flags.ISSUER_MISMATCH) mismatches.push('ISSUER');
    if (record.mismatch_flags.KIND_MISMATCH) mismatches.push('KIND');
    if (record.mismatch_flags.EU_LAW_MISMATCH) mismatches.push('EU_LAW');
    if (record.mismatch_flags.DECREE_MISMATCH) mismatches.push('DECREE');
    if (record.mismatch_flags.AGENCY_AS_CMU) mismatches.push('AGENCY_AS_CMU');
    const mismatchStr = mismatches.join(', ') || 'OK';
    
    const severityEmoji = severity === 'CRITICAL' ? '🔴' : (severity === 'WARN' ? '⚠️' : '✅');
    md += `| ${record.nreg} | ${title} | ${docType} | ${predicted} | ${issuer} | ${kind} | ${severityEmoji} ${severity} | ${mismatchStr} |\n`;
  }
  
  // Додаємо секцію з CRITICAL
  const criticalRecords = sortedRecords.filter(r => r.severity === 'CRITICAL');
  if (criticalRecords.length > 0) {
    md += `\n## CRITICAL Issues (${criticalRecords.length})\n\n`;
    md += `| NREG | Current | Predicted | Issue |\n`;
    md += `|------|---------|-----------|-------|\n`;
    for (const record of criticalRecords) {
      const mismatches: string[] = [];
      if (record.mismatch_flags.ISSUER_MISMATCH) mismatches.push('ISSUER');
      if (record.mismatch_flags.KIND_MISMATCH) mismatches.push('KIND');
      if (record.mismatch_flags.EU_LAW_MISMATCH) mismatches.push('EU_LAW');
      if (record.mismatch_flags.DECREE_MISMATCH) mismatches.push('DECREE');
      if (record.mismatch_flags.AGENCY_AS_CMU) mismatches.push('AGENCY_AS_CMU');
      md += `| ${record.nreg} | ${record.document_type_slug || 'NULL'} | ${record.predicted_slug || 'NULL'} | ${mismatches.join(', ')} |\n`;
    }
  }
  
  return md;
}
