/**
 * Audit Documents — ручний аудит документів для рефакторингу
 * 
 * Генерує структурований звіт для ручної перевірки документів
 */

import { resolve } from 'path';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createR2Client, getLegislationBucket } from '../lib/r2Client.js';
import { RadaClient } from '../lib/radaClient.js';

interface AuditRecord {
  internal_id: string;
  source_url: string;
  nreg_expected: string;
  nreg_imported: string;
  issuer_expected: string;
  issuer_imported: string;
  doc_type_expected: string;
  doc_type_imported: string;
  title_expected: string;
  title_imported: string;
  date_expected: string;
  date_imported: string;
  validity_expected: string;
  validity_imported: string;
  structure_expected: string;
  structure_imported: string;
  bug_class: string;
  root_cause_guess: string;
  fix_needed: string;
  after_fix_check: string;
}

/**
 * Отримує дані документа з Rada API для порівняння
 */
async function fetchRadaData(nreg: string): Promise<{
  source_url: string;
  title: string;
  doc_type: string;
  date: string;
  validity?: string;
  structure?: string;
}> {
  const rada = new RadaClient();
  
  try {
    const jsonData = await rada.fetchJson(nreg);
    
    const source_url = `https://zakon.rada.gov.ua/laws/show/${encodeURIComponent(nreg)}`;
    const title = jsonData?.nazva || jsonData?.meta?.nazva || '';
    const doc_type = jsonData?.typ || jsonData?.meta?.typ || '';
    const date = jsonData?.datred || jsonData?.meta?.datred || '';
    
    // Спробуємо витягти чинність (потрібно буде покращити)
    let validity: string | undefined;
    if (jsonData?.status) {
      validity = String(jsonData.status);
    }
    
    // Структура (перші 2-3 статті якщо є)
    let structure: string | undefined;
    if (jsonData?.stru && Array.isArray(jsonData.stru)) {
      const articles = jsonData.stru
        .filter((item: any) => item.typ === 'ST')
        .slice(0, 3)
        .map((item: any) => {
          const num = item.stru || item.number || '';
          const line = item.line || '';
          return `Стаття ${num}: ${line.substring(0, 50)}`;
        });
      if (articles.length > 0) {
        structure = articles.join(' | ');
      }
    }
    
    return {
      source_url,
      title,
      doc_type: String(doc_type),
      date: String(date),
      validity,
      structure,
    };
  } catch (e) {
    console.warn(`⚠️  Не вдалося отримати дані з Rada для ${nreg}: ${e}`);
    return {
      source_url: `https://zakon.rada.gov.ua/laws/show/${encodeURIComponent(nreg)}`,
      title: '',
      doc_type: '',
      date: '',
    };
  }
}

/**
 * Отримує дані документа з нашої БД
 */
async function fetchOurData(nreg: string): Promise<{
  nreg: string;
  title: string;
  doc_type: string;
  date: string;
  validity: string;
  structure: string;
}> {
  const supabase = createSupabaseAdminClient();
  
  const { data: doc } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .single();
  
  if (!doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // Отримуємо структуру з canonical (R2)
  let structure = '';
  try {
    if (doc.r2_key) {
      const r2 = createR2Client();
      const bucket = getLegislationBucket();
      const obj = await r2.getObject(bucket, doc.r2_key);
      const canonical = JSON.parse(await obj.Body.transformToString());
      
      if (canonical.content?.articles && canonical.content.articles.length > 0) {
        const articles = canonical.content.articles.slice(0, 3).map((art: any) => {
          return `Стаття ${art.number}: ${(art.title || '').substring(0, 50)}`;
        });
        structure = articles.join(' | ');
      }
    }
  } catch (e) {
    structure = '(недоступно)';
  }
  
  return {
    nreg: doc.rada_nreg,
    title: doc.title || '',
    doc_type: doc.document_type_slug || doc.document_type || '',
    date: doc.rada_datred ? String(doc.rada_datred) : '',
    validity: (doc as any).validity_status || 'unknown',
    structure,
  };
}

/**
 * Генерує audit record для одного документа
 */
async function auditOneDocument(nreg: string): Promise<AuditRecord> {
  const [radaData, ourData] = await Promise.all([
    fetchRadaData(nreg),
    fetchOurData(nreg),
  ]);
  
  // Визначаємо bug_class (поки порожнє, заповнюється вручну)
  const bug_class = '';
  const root_cause_guess = '';
  const fix_needed = '';
  const after_fix_check = '';
  
  return {
    internal_id: nreg,
    source_url: radaData.source_url,
    nreg_expected: nreg,
    nreg_imported: ourData.nreg,
    issuer_expected: '', // Потрібно витягти з Rada
    issuer_imported: '', // Потрібно витягти з нашої БД
    doc_type_expected: radaData.doc_type,
    doc_type_imported: ourData.doc_type,
    title_expected: radaData.title,
    title_imported: ourData.title,
    date_expected: radaData.date,
    date_imported: ourData.date,
    validity_expected: radaData.validity || '',
    validity_imported: ourData.validity,
    structure_expected: radaData.structure || '',
    structure_imported: ourData.structure,
    bug_class,
    root_cause_guess,
    fix_needed,
    after_fix_check,
  };
}

/**
 * Головна функція — генерує audit records для всіх документів
 */
export async function auditAllDocuments(options?: {
  limit?: number;
  outputFile?: string;
}): Promise<void> {
  const { limit, outputFile } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Audit Documents — Генерація Audit Records`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо всі документи
  let query = supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .order('updated_at', { ascending: false });
  
  if (limit) {
    query = query.limit(limit);
  }
  
  const { data: docs, error } = await query;
  
  if (error) {
    throw new Error(`Failed to fetch documents: ${error.message}`);
  }
  
  if (!docs || docs.length === 0) {
    console.log(`❌ Документи не знайдені\n`);
    return;
  }
  
  console.log(`📋 Знайдено ${docs.length} документів для аудиту\n`);
  
  const records: AuditRecord[] = [];
  
  // Аудит по одному документу
  for (let i = 0; i < docs.length; i++) {
    const nreg = docs[i].rada_nreg;
    console.log(`[${i + 1}/${docs.length}] Аудит ${nreg}...`);
    
    try {
      const record = await auditOneDocument(nreg);
      records.push(record);
      console.log(`   ✅ Завершено\n`);
    } catch (e) {
      console.log(`   ❌ Помилка: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  
  // Зберігаємо результати
  const outputPath = outputFile || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'runs', 'audit_records.json');
  const fs = await import('fs/promises');
  await fs.writeFile(outputPath, JSON.stringify(records, null, 2), 'utf-8');
  
  console.log(`\n✅ Audit records збережено: ${outputPath}`);
  console.log(`   Всього записів: ${records.length}\n`);
  
  // Статистика
  const withBugs = records.filter(r => r.bug_class).length;
  console.log(`📊 Статистика:`);
  console.log(`   Всього документів: ${records.length}`);
  console.log(`   З багами (позначено): ${withBugs}`);
  console.log(`   Без багів: ${records.length - withBugs}\n`);
}
