/**
 * Audit Script — автоматичний ручний аудит документів
 * 
 * PHASE 5: Gate A ручний аудит 40 документів з реальними вердиктами
 */

import { createSupabaseAdminClient } from './lib/supabaseAdmin.js';
import { RadaClient } from './radaClient.js';

interface AuditResult {
  nreg: string;
  title_prefix: string;
  summary_prefix: string;
  snippet200_prefix: string;
  document_type_slug: string;
  document_type: string;
  category: string;
  doc_number: string;
  chunks: string;
  health: string;
  verdict: 'OK' | 'SUSPICIOUS';
  issues?: string[];
}

async function auditDocument(nreg: string): Promise<AuditResult> {
  const supabase = createSupabaseAdminClient();
  
  const { data: doc } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();
  
  if (!doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // Отримати snippet200 з canonical (R2)
  let snippet200 = '';
  try {
    const { createR2Client, getLegislationBucket } = await import('./lib/r2Client.js');
    const r2 = createR2Client();
    const bucket = getLegislationBucket();
    const key = doc.r2_key;
    
    if (key) {
      const obj = await r2.getObject(bucket, key);
      const canonical = JSON.parse(await obj.Body.transformToString());
      const txt = canonical.txt || '';
      snippet200 = txt.substring(0, 200);
    }
  } catch (e) {
    snippet200 = '(недоступно)';
  }
  
  // Сигнали
  const titleLower = (doc.title || '').toLowerCase();
  const summaryLower = (doc.summary || '').toLowerCase();
  const snippetLower = snippet200.toLowerCase();
  
  // Правила валідації
  const issues: string[] = [];
  
  // Правило 1: ЦВК
  if ((summaryLower.includes('центральна виборча') || summaryLower.includes('цвк') || titleLower.includes('цвк')) && 
      doc.document_type_slug !== 'cec_resolution') {
    issues.push('ЦВК сигнал → має бути cec_resolution');
  }
  
  // Правило 2: РНБО
  if ((snippetLower.includes('рада національної безпеки') || snippetLower.includes('рнбо') || titleLower.includes('рнбо') || summaryLower.includes('рнбо')) && 
      (snippetLower.includes('рішення') || titleLower.includes('рішення') || summaryLower.includes('рішення')) && 
      doc.document_type_slug !== 'rnbo_decision') {
    issues.push('РНБО рішення сигнал → має бути rnbo_decision');
  }
  
  // Правило 3: Голова ВРУ
  if ((titleLower.includes('голова вр') || titleLower.includes('голови вр') || (doc.document_number && doc.document_number.endsWith('-рг'))) && 
      doc.document_type_slug !== 'vr_speaker_order') {
    issues.push('Голова ВРУ сигнал → має бути vr_speaker_order');
  }
  
  // Правило 4: НБУ повідомлення
  if ((titleLower.includes('повідомлення нбу') || summaryLower.includes('повідомлення нбу')) && 
      doc.document_type_slug !== 'nbu_letter') {
    issues.push('Повідомлення НБУ сигнал → має бути nbu_letter');
  }
  
  // Правило 5: НБУ постанова правління
  if ((titleLower.includes('постанова правління нбу') || summaryLower.includes('постанова правління нбу')) && 
      doc.document_type_slug !== 'nbu_resolution') {
    issues.push('Постанова правління НБУ сигнал → має бути nbu_resolution');
  }
  
  // Правило 6: Указ Президента
  if ((titleLower.includes('указ') && (titleLower.includes('президент') || summaryLower.includes('президент'))) && 
      doc.document_type_slug !== 'presidential_decree') {
    issues.push('Указ Президента сигнал → має бути presidential_decree');
  }
  
  // Правило 7: Розпорядження КМУ
  if ((titleLower.includes('розпорядження') && (titleLower.includes('кму') || titleLower.includes('кабінет') || summaryLower.includes('кму'))) && 
      doc.document_type_slug !== 'cmu_order') {
    issues.push('Розпорядження КМУ сигнал → має бути cmu_order');
  }
  
  const verdict = issues.length > 0 ? 'SUSPICIOUS' : 'OK';
  
  return {
    nreg,
    title_prefix: doc.title?.substring(0, 80) || '',
    summary_prefix: doc.summary?.substring(0, 80) || '',
    snippet200_prefix: snippet200.substring(0, 80),
    document_type_slug: doc.document_type_slug || '',
    document_type: doc.document_type || '',
    category: doc.category || '',
    doc_number: doc.document_number || doc.law_number || nreg,
    chunks: `${doc.expected_chunks}/${doc.indexed_chunks}`,
    health: doc.sync_health || 'null',
    verdict,
    issues: issues.length > 0 ? issues : undefined
  };
}

export async function auditGateA(): Promise<{ results1: AuditResult[]; results2: AuditResult[]; suspicious: AuditResult[] }> {
  const supabase = createSupabaseAdminClient();
  
  // Round 1: складні
  const { data: round1 } = await supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .or('document_type_slug.in.(rnbo_decision,cec_resolution,nbu_letter,nbu_resolution,presidential_decree,vr_speaker_order,convention),category.in.(defense_mobilization,national_security)')
    .limit(20);
  
  const round1Nregs = (round1 || []).map(d => d.rada_nreg);
  
  // Round 2: рандомні (не перетинаються з раундом 1)
  const { data: allDocs } = await supabase
    .from('legislation_documents')
    .select('rada_nreg');
  
  const round2Nregs = (allDocs || [])
    .filter(d => !round1Nregs.includes(d.rada_nreg))
    .sort(() => 0.5 - Math.random())
    .slice(0, 20)
    .map(d => d.rada_nreg);
  
  console.log(`\n📋 Round 1: ${round1Nregs.length} документів`);
  console.log(`📋 Round 2: ${round2Nregs.length} документів\n`);
  
  const results1: AuditResult[] = [];
  for (const nreg of round1Nregs) {
    const result = await auditDocument(nreg);
    results1.push(result);
    if (result.verdict === 'SUSPICIOUS') {
      console.log(`  ⚠️  SUSPICIOUS: ${nreg} - ${result.issues?.join(', ')}`);
    }
  }
  
  const results2: AuditResult[] = [];
  for (const nreg of round2Nregs) {
    const result = await auditDocument(nreg);
    results2.push(result);
    if (result.verdict === 'SUSPICIOUS') {
      console.log(`  ⚠️  SUSPICIOUS: ${nreg} - ${result.issues?.join(', ')}`);
    }
  }
  
  const suspicious = [...results1, ...results2].filter(r => r.verdict === 'SUSPICIOUS');
  
  console.log(`\n📊 Підсумок:`);
  console.log(`  Round 1: OK=${results1.length - results1.filter(r => r.verdict === 'SUSPICIOUS').length}, SUSPICIOUS=${results1.filter(r => r.verdict === 'SUSPICIOUS').length}`);
  console.log(`  Round 2: OK=${results2.length - results2.filter(r => r.verdict === 'SUSPICIOUS').length}, SUSPICIOUS=${results2.filter(r => r.verdict === 'SUSPICIOUS').length}`);
  console.log(`  Total SUSPICIOUS: ${suspicious.length}`);
  
  return { results1, results2, suspicious };
}
