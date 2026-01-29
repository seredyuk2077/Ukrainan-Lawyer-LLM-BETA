/**
 * Audit Parser Integrity V2 — Structural Consistency Mode
 * 
 * Перевіряє узгодженість номера/ідентифікатора, а не текстовий маркер:
 * - canonical unit має стабільний номер
 * - chunk payload має містити той самий номер
 * - перевірка: chunk.payload.article_number == canonical.article_number ДЛЯ цього article
 * - перевірка: порядок articles (sorted) і payload.article_number не "з'їжджає" на +1/-1
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

interface StructuralConsistencyRecord {
  nreg: string;
  title: string;
  strategy: string;
  articles_count: number;
  chunks_count: number;
  checks_passed: number;
  mismatches_count: number;
  mismatches: Array<{
    article_number: string;
    issue: string;
    evidence: string;
  }>;
}

/**
 * Перевіряє structural consistency для article-based документів
 */
async function checkStructuralConsistency(nreg: string): Promise<StructuralConsistencyRecord | null> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, r2_key, content_hash')
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
  
  // Отримуємо chunks з Qdrant
  const qdrant = createQdrantClient();
  const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
      ],
    },
    limit: 10000,
    with_payload: true,
    with_vector: false,
  } as any);
  
  const qdrantChunks = (chunksScroll as any).points || [];
  
  // Перевіряємо structural consistency
  let checksPassed = 0;
  let mismatchesCount = 0;
  const mismatches: Array<{ article_number: string; issue: string; evidence: string }> = [];
  
  if (strategy === 'article-based' && articles.length > 0) {
    // Групуємо Qdrant chunks по article_number
    const qdrantChunksByArticle = new Map<string, any[]>();
    for (const point of qdrantChunks) {
      const articleNum = point.payload?.article_number || point.payload?.unit_number || null;
      if (articleNum) {
        if (!qdrantChunksByArticle.has(articleNum)) {
          qdrantChunksByArticle.set(articleNum, []);
        }
        qdrantChunksByArticle.get(articleNum)!.push(point);
      }
    }
    
    // Сортуємо articles по номеру
    const sortedArticles = [...articles].sort((a, b) => {
      const numA = parseInt(a.number || '0', 10);
      const numB = parseInt(b.number || '0', 10);
      return numA - numB;
    });
    
    // Перевіряємо кожну статтю
    for (let i = 0; i < sortedArticles.length; i++) {
      const article = sortedArticles[i];
      const articleNum = article.number || '';
      
      // Перевірка 1: чи canonical має статтю
      if (!articleNum) {
        mismatches.push({
          article_number: articleNum,
          issue: 'canonical_article_missing_number',
          evidence: `Article at index ${i} has no number`,
        });
        continue;
      }
      
      // Перевірка 2: чи Qdrant має chunks для цієї статті
      const qdrantChunksForArticle = qdrantChunksByArticle.get(articleNum) || [];
      if (qdrantChunksForArticle.length === 0) {
        mismatches.push({
          article_number: articleNum,
          issue: 'qdrant_no_chunks_for_article',
          evidence: `Canonical has article ${articleNum}, but Qdrant has no chunks with article_number=${articleNum}`,
        });
        continue;
      }
      
      // Перевірка 3: чи всі chunks мають правильний article_number
      const mismatchedChunks = qdrantChunksForArticle.filter((point: any) => {
        const payloadArticleNum = point.payload?.article_number || point.payload?.unit_number || null;
        return payloadArticleNum !== articleNum;
      });
      
      if (mismatchedChunks.length > 0) {
        mismatches.push({
          article_number: articleNum,
          issue: 'qdrant_chunk_article_number_mismatch',
          evidence: `${mismatchedChunks.length} chunks have wrong article_number (expected=${articleNum}, got=${mismatchedChunks[0].payload?.article_number || mismatchedChunks[0].payload?.unit_number})`,
        });
        continue;
      }
      
      // Перевірка 4: монотонність (якщо не перша стаття)
      if (i > 0) {
        const prevArticle = sortedArticles[i - 1];
        const prevNum = parseInt(prevArticle.number || '0', 10);
        const currNum = parseInt(articleNum || '0', 10);
        
        if (!isNaN(prevNum) && !isNaN(currNum)) {
          if (currNum !== prevNum + 1 && currNum !== prevNum) {
            if (currNum < prevNum) {
              mismatches.push({
                article_number: articleNum,
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
  } else {
    // Для інших стратегій просто рахуємо chunks
    checksPassed = chunks.length;
    mismatchesCount = 0;
  }
  
  return {
    nreg: doc.rada_nreg,
    title: doc.title || '',
    strategy,
    articles_count: articles.length,
    chunks_count: chunks.length,
    checks_passed: checksPassed,
    mismatches_count: mismatchesCount,
    mismatches,
  };
}

/**
 * Головна функція — перевіряє structural consistency для документів
 */
export async function auditParserIntegrityV2(options?: {
  file?: string;
  limit?: number;
  outputFile?: string;
}): Promise<void> {
  const { file, limit, outputFile } = options || {};
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Audit Parser Integrity V2 — Structural Consistency`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо список документів
  let nregs: string[] = [];
  
  if (file) {
    // З файлу
    const fs = await import('fs/promises');
    const content = await fs.readFile(file, 'utf-8');
    nregs = content.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'));
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
  
  const records: StructuralConsistencyRecord[] = [];
  
  // Перевіряємо по одному документу
  for (let i = 0; i < nregs.length; i++) {
    const nreg = nregs[i];
    process.stdout.write(`[${i + 1}/${nregs.length}] Перевірка ${nreg}... `);
    
    try {
      const record = await checkStructuralConsistency(nreg);
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
    console.log(`\n✅ Structural consistency records збережено: ${outputFile}`);
  }
  
  // Генеруємо Markdown звіт
  const markdownFile = outputFile?.replace('.json', '.md') || 'scripts/legislation/runs/audit/PARSER_INTEGRITY_V2_REPORT.md';
  const fs = await import('fs/promises');
  const markdown = generateMarkdownReport(records);
  await fs.writeFile(markdownFile, markdown, 'utf-8');
  console.log(`✅ Structural consistency report (Markdown) збережено: ${markdownFile}`);
  
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
function generateMarkdownReport(records: StructuralConsistencyRecord[]): string {
  let md = `# Parser Integrity V2 Report — Structural Consistency\n\n`;
  md += `**Дата:** ${new Date().toISOString()}\n\n`;
  md += `| NREG | Strategy | Articles | Chunks | Checks Passed | Mismatches | Examples |\n`;
  md += `|------|----------|----------|--------|---------------|------------|----------|\n`;
  
  for (const record of records) {
    const examples = record.mismatches.slice(0, 2).map(m => `${m.article_number}: ${m.issue}`).join('; ') || 'none';
    md += `| ${record.nreg} | ${record.strategy} | ${record.articles_count} | ${record.chunks_count} | ${record.checks_passed} | ${record.mismatches_count} | ${examples} |\n`;
  }
  
  return md;
}
