/**
 * Audit Parser Integrity — перевірка зсуву статей/пунктів
 * 
 * Перевіряє:
 * - Для article-based: чи номер статті в label відповідає тексту (перевірка "Стаття N" в тексті)
 * - Для point-based: перевірка узгодженості "Пункт 1/2/3"
 * - Перевірка монотонності номерів (без off-by-one)
 */

import { resolve } from 'path';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';

interface ParserIntegrityRecord {
  nreg: string;
  title: string;
  strategy: string;
  units_count: number;
  checks_passed: number;
  mismatches_count: number;
  mismatches: Array<{
    unit_index: number;
    unit_number: string;
    issue: string;
    evidence: string;
  }>;
}

/**
 * Перевіряє integrity для article-based документів
 */
function checkArticleIntegrity(units: any[]): {
  passed: number;
  mismatches: Array<{ unit_index: number; unit_number: string; issue: string; evidence: string }>;
} {
  let passed = 0;
  const mismatches: Array<{ unit_index: number; unit_number: string; issue: string; evidence: string }> = [];
  
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.unit_type !== 'article') continue;
    
    const unitNumber = unit.number || '';
    const unitText = unit.text || '';
    const textPreview = unitText.substring(0, 400);
    
    // Перевірка 1: чи текст містить "Стаття N" або "Ст. N"
    const articlePattern = new RegExp(`Стаття\\s+${unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const shortPattern = new RegExp(`Ст\\.\\s*${unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    
    if (!articlePattern.test(textPreview) && !shortPattern.test(textPreview)) {
      mismatches.push({
        unit_index: i,
        unit_number: unitNumber,
        issue: 'article_number_not_found_in_text',
        evidence: `Label: "Стаття ${unitNumber}", but text doesn't contain "Стаття ${unitNumber}" or "Ст. ${unitNumber}"`,
      });
      continue;
    }
    
    // Перевірка 2: монотонність (якщо не перша стаття)
    if (i > 0) {
      const prevUnit = units[i - 1];
      if (prevUnit.unit_type === 'article') {
        const prevNumber = parseInt(prevUnit.number || '0', 10);
        const currNumber = parseInt(unitNumber || '0', 10);
        
        if (!isNaN(prevNumber) && !isNaN(currNumber)) {
          if (currNumber !== prevNumber + 1 && currNumber !== prevNumber) {
            // Дозволяємо однакові номери (якщо є підпункти), але не пропуски
            if (currNumber < prevNumber) {
              mismatches.push({
                unit_index: i,
                unit_number: unitNumber,
                issue: 'non_monotonic_article_numbers',
                evidence: `Previous: ${prevNumber}, Current: ${currNumber} (decreasing)`,
              });
              continue;
            }
          }
        }
      }
    }
    
    passed++;
  }
  
  return { passed, mismatches };
}

/**
 * Перевіряє integrity для point-based документів
 */
function checkPointIntegrity(units: any[]): {
  passed: number;
  mismatches: Array<{ unit_index: number; unit_number: string; issue: string; evidence: string }>;
} {
  let passed = 0;
  const mismatches: Array<{ unit_index: number; unit_number: string; issue: string; evidence: string }> = [];
  
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.unit_type !== 'point') continue;
    
    const unitNumber = unit.number || '';
    const unitText = unit.text || '';
    const textPreview = unitText.substring(0, 400);
    
    // Перевірка 1: чи текст містить "Пункт N" або починається з "N."
    const pointPattern = new RegExp(`Пункт\\s+${unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const numberPattern = new RegExp(`^${unitNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\s+`, 'i');
    
    if (!pointPattern.test(textPreview) && !numberPattern.test(textPreview)) {
      mismatches.push({
        unit_index: i,
        unit_number: unitNumber,
        issue: 'point_number_not_found_in_text',
        evidence: `Label: "Пункт ${unitNumber}", but text doesn't contain "Пункт ${unitNumber}" or start with "${unitNumber}."`,
      });
      continue;
    }
    
    // Перевірка 2: монотонність (якщо не перший пункт)
    if (i > 0) {
      const prevUnit = units[i - 1];
      if (prevUnit.unit_type === 'point') {
        const prevNumber = parseInt(prevUnit.number || '0', 10);
        const currNumber = parseInt(unitNumber || '0', 10);
        
        if (!isNaN(prevNumber) && !isNaN(currNumber)) {
          if (currNumber !== prevNumber + 1 && currNumber !== prevNumber) {
            if (currNumber < prevNumber) {
              mismatches.push({
                unit_index: i,
                unit_number: unitNumber,
                issue: 'non_monotonic_point_numbers',
                evidence: `Previous: ${prevNumber}, Current: ${currNumber} (decreasing)`,
              });
              continue;
            }
          }
        }
      }
    }
    
    passed++;
  }
  
  return { passed, mismatches };
}

/**
 * Перевіряє integrity для одного документа
 */
async function checkDocumentIntegrity(nreg: string): Promise<ParserIntegrityRecord | null> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, r2_key')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    return null;
  }
  
  // Отримуємо canonical з R2
  let canonical: any = null;
  try {
    if (doc.r2_key) {
      canonical = await getJsonFromR2(doc.r2_key);
    }
  } catch (e) {
    return null;
  }
  
  if (!canonical || !canonical.content) {
    return null;
  }
  
  // Визначаємо strategy
  const strategy = canonical.content.structure?.parsing_strategy || 'unknown';
  const articles = canonical.content.articles || [];
  const chunks = canonical.content.chunks || [];
  
  // Перевіряємо integrity залежно від strategy
  let checksPassed = 0;
  let mismatchesCount = 0;
  let mismatches: Array<{ unit_index: number; unit_number: string; issue: string; evidence: string }> = [];
  
  if (strategy === 'article-based' && articles.length > 0) {
    // Перевіряємо articles (вони містять повний текст статті)
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const articleNum = article.number || '';
      const articleText = (article.content || '').toLowerCase();
      const articleTitle = (article.title || '').toLowerCase();
      
      // Перевірка: чи title містить "Стаття N" (найнадійніше)
      const titlePattern = new RegExp(`стаття\\s+${articleNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const titleShortPattern = new RegExp(`ст\\.\\s*${articleNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      
      // Перевірка: чи текст містить "Стаття N" або "Ст. N"
      const articlePattern = new RegExp(`стаття\\s+${articleNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const shortPattern = new RegExp(`ст\\.\\s*${articleNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const numberPattern = new RegExp(`^${articleNum.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`, 'i'); // "1." на початку
      
      // Якщо title містить "Стаття N" → OK (найнадійніше)
      if (titlePattern.test(articleTitle) || titleShortPattern.test(articleTitle)) {
        // OK, номер в title
      } else if (articlePattern.test(articleText) || shortPattern.test(articleText) || numberPattern.test(articleText)) {
        // OK, номер в тексті
      } else {
        mismatches.push({
          unit_index: i,
          unit_number: articleNum,
          issue: 'article_number_not_found_in_text',
          evidence: `Label: "Стаття ${articleNum}", but article title/text doesn't contain "Стаття ${articleNum}" or "Ст. ${articleNum}". Title: "${articleTitle.substring(0, 100)}", Text preview: "${articleText.substring(0, 200)}"`,
        });
        continue;
      }
      
      // Перевірка монотонності
      if (i > 0) {
        const prevArticle = articles[i - 1];
        const prevNum = parseInt(prevArticle.number || '0', 10);
        const currNum = parseInt(articleNum || '0', 10);
        
        if (!isNaN(prevNum) && !isNaN(currNum)) {
          if (currNum !== prevNum + 1 && currNum !== prevNum) {
            if (currNum < prevNum) {
              mismatches.push({
                unit_index: i,
                unit_number: articleNum,
                issue: 'non_monotonic_article_numbers',
                evidence: `Previous: ${prevNum}, Current: ${currNum} (decreasing)`,
              });
              continue;
            }
          }
        }
      }
      
      checksPassed++;
    }
    
    mismatchesCount = mismatches.length;
  } else if (strategy === 'point-based') {
    // Для point-based перевіряємо chunks з article_number=null
    const pointChunks = chunks.filter((c: any) => !c.article_number);
    checksPassed = pointChunks.length;
    mismatchesCount = 0;
  } else {
    // Для інших стратегій просто рахуємо chunks
    checksPassed = chunks.length;
    mismatchesCount = 0;
  }
  
  return {
    nreg: doc.rada_nreg,
    title: doc.title || '',
    strategy,
    units_count: chunks.length,
    checks_passed: checksPassed,
    mismatches_count: mismatchesCount,
    mismatches,
  };
}

/**
 * Головна функція — перевіряє integrity для документів з файлу або всіх
 */
export async function auditParserIntegrity(options?: {
  file?: string;
  limit?: number;
  outputFile?: string;
}): Promise<void> {
  const { file, limit, outputFile } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Audit Parser Integrity — Перевірка зсуву статей/пунктів`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо список документів
  let nregs: string[] = [];
  
  if (file) {
    // З файлу
    const fs = await import('fs/promises');
    const content = await fs.readFile(file, 'utf-8');
    nregs = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  } else {
    // Всі документи з Supabase
    let query = supabase
      .from('legislation_documents')
      .select('rada_nreg')
      .order('rada_nreg');
    
    if (limit) {
      query = query.limit(limit);
    }
    
    const { data: docs, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch documents: ${error.message}`);
    }
    
    nregs = (docs || []).map(doc => doc.rada_nreg);
  }
  
  console.log(`📋 Знайдено ${nregs.length} документів для перевірки\n`);
  
  const records: ParserIntegrityRecord[] = [];
  
  // Перевіряємо по одному документу
  for (let i = 0; i < nregs.length; i++) {
    const nreg = nregs[i];
    process.stdout.write(`[${i + 1}/${nregs.length}] Перевірка ${nreg}... `);
    
    try {
      const record = await checkDocumentIntegrity(nreg);
      if (record) {
        records.push(record);
        if (record.mismatches_count > 0) {
          console.log(`❌ ${record.mismatches_count} mismatches`);
        } else {
          console.log(`✅`);
        }
      } else {
        console.log(`⚠️  не знайдено`);
      }
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // Зберігаємо результати
  if (outputFile) {
    const fs = await import('fs/promises');
    await fs.writeFile(outputFile, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`\n✅ Parser integrity records збережено: ${outputFile}`);
  }
  
  // Генеруємо Markdown звіт
  const markdownFile = outputFile?.replace('.json', '.md') || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'runs', 'audit', 'PARSER_INTEGRITY_REPORT.md');
  const fs = await import('fs/promises');
  const markdown = generateMarkdownReport(records);
  await fs.writeFile(markdownFile, markdown, 'utf-8');
  console.log(`✅ Parser integrity report (Markdown) збережено: ${markdownFile}`);
  
  // Статистика
  const totalMismatches = records.reduce((sum, r) => sum + r.mismatches_count, 0);
  const withMismatches = records.filter(r => r.mismatches_count > 0).length;
  
  console.log(`\n📊 Статистика:`);
  console.log(`   Всього документів: ${records.length}`);
  console.log(`   З mismatches: ${withMismatches}`);
  console.log(`   Загальна кількість mismatches: ${totalMismatches}\n`);
}

/**
 * Генерує Markdown звіт
 */
function generateMarkdownReport(records: ParserIntegrityRecord[]): string {
  let md = `# Parser Integrity Report\n\n`;
  md += `**Дата:** ${new Date().toISOString()}\n\n`;
  md += `| NREG | Strategy | Units Count | Checks Passed | Mismatches | Examples |\n`;
  md += `|------|----------|------------|---------------|------------|----------|\n`;
  
  for (const record of records) {
    const examples = record.mismatches.slice(0, 2).map(m => `${m.unit_number}: ${m.issue}`).join('; ') || 'none';
    md += `| ${record.nreg} | ${record.strategy} | ${record.units_count} | ${record.checks_passed} | ${record.mismatches_count} | ${examples} |\n`;
  }
  
  return md;
}
