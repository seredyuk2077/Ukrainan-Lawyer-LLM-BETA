/**
 * Comprehensive RAG Sanity Test — комплексна перевірка retrieval для ККУ
 * 
 * Перевіряє:
 * - "умисне вбивство" → має повертати ст.115, не ст.116
 * - "кримінальна відповідальність" → має повертати ст.2
 * - "необхідна оборона" → має повертати ст.36
 * - "крадіжка" → має повертати ст.185
 * - "шахрайство" → має повертати ст.190
 */

import { resolve } from 'path';
import { workspaceRoot } from '../lib/config.js';
import { ragSanityArticle } from './rag-sanity-article.js';

interface ComprehensiveTestResult {
  test_name: string;
  nreg: string;
  expected_article: string;
  query: string;
  passed: boolean;
  top_result_article: string | null;
  has_correct_article_in_top3: boolean;
  shift_detected: boolean;
  details: string;
}

/**
 * Комплексний тест для ККУ
 */
export async function comprehensiveRAGSanityTest(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Comprehensive RAG Sanity Test — ККУ`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const testCases = [
    {
      name: 'Умисне вбивство',
      nreg: '2341-14',
      article: '115',
      query: 'умисне вбивство',
      description: 'Має повертати ст.115, не ст.116',
    },
    {
      name: 'Кримінальна відповідальність',
      nreg: '2341-14',
      article: '2',
      query: 'кримінальна відповідальність підстава',
      description: 'Має повертати ст.2',
    },
    {
      name: 'Необхідна оборона',
      nreg: '2341-14',
      article: '36',
      query: 'необхідна оборона',
      description: 'Має повертати ст.36',
    },
    {
      name: 'Крадіжка',
      nreg: '2341-14',
      article: '185',
      query: 'крадіжка',
      description: 'Має повертати ст.185',
    },
    {
      name: 'Шахрайство',
      nreg: '2341-14',
      article: '190',
      query: 'шахрайство',
      description: 'Має повертати ст.190',
    },
    {
      name: 'Вбивство за необережністю',
      nreg: '2341-14',
      article: '119',
      query: 'вбивство за необережністю',
      description: 'Має повертати ст.119, не ст.115',
    },
  ];
  
  const results: ComprehensiveTestResult[] = [];
  
  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`\n[${i + 1}/${testCases.length}] ${testCase.name} (ст.${testCase.article})`);
    console.log(`   Query: "${testCase.query}"`);
    console.log(`   Expected: ст.${testCase.article}`);
    
    try {
      const result = await ragSanityArticle({
        nreg: testCase.nreg,
        article: testCase.article,
        query: testCase.query,
        topK: 5,
      });
      
      // Перевірка: чи топ результат має правильну статтю
      const topResultArticle = result.top_result_article_number;
      const passed = topResultArticle === testCase.article;
      
      // Перевірка: чи є правильна стаття в top3
      const top3Articles = result.results.slice(0, 3).map(r => r.article_number || r.unit_number).filter(Boolean);
      const hasCorrectInTop3 = top3Articles.includes(testCase.article);
      
      // Перевірка на зсув
      let shiftDetected = false;
      let shiftDetails = '';
      if (!passed && topResultArticle) {
        const topNum = parseInt(topResultArticle || '0', 10);
        const expectedNum = parseInt(testCase.article || '0', 10);
        if (!isNaN(topNum) && !isNaN(expectedNum)) {
          if (Math.abs(topNum - expectedNum) === 1) {
            shiftDetected = true;
            shiftDetails = `OFF-BY-ONE: Top result is ст.${topResultArticle}, expected ст.${testCase.article}`;
          } else if (topNum !== expectedNum) {
            shiftDetails = `MISMATCH: Top result is ст.${topResultArticle}, expected ст.${testCase.article}`;
          }
        }
      }
      
      const testResult: ComprehensiveTestResult = {
        test_name: testCase.name,
        nreg: testCase.nreg,
        expected_article: testCase.article,
        query: testCase.query,
        passed,
        top_result_article: topResultArticle,
        has_correct_article_in_top3: hasCorrectInTop3,
        shift_detected: shiftDetected,
        details: shiftDetails || (passed ? 'OK' : `Top result: ст.${topResultArticle || 'NULL'}`),
      };
      
      results.push(testResult);
      
      // Виводимо результати
      console.log(`   Top result: ст.${topResultArticle || 'NULL'}`);
      console.log(`   Top 3 articles: ${top3Articles.join(', ')}`);
      
      if (passed) {
        console.log(`   ✅ PASSED`);
      } else if (hasCorrectInTop3) {
        console.log(`   ⚠️  PARTIAL: правильна стаття в top3, але не на першому місці`);
      } else if (shiftDetected) {
        console.log(`   ❌ FAILED: ${shiftDetails}`);
      } else {
        console.log(`   ❌ FAILED: ${testResult.details}`);
      }
      
      // Детальна інформація про топ результати
      console.log(`   Top results:`);
      for (let j = 0; j < Math.min(3, result.results.length); j++) {
        const r = result.results[j];
        const artNum = r.article_number || r.unit_number || 'NULL';
        console.log(`     [${j + 1}] ст.${artNum} (score=${r.score.toFixed(4)})`);
        console.log(`         ${r.text_preview.substring(0, 80)}...`);
      }
      
    } catch (e) {
      console.log(`   ❌ ERROR: ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        test_name: testCase.name,
        nreg: testCase.nreg,
        expected_article: testCase.article,
        query: testCase.query,
        passed: false,
        top_result_article: null,
        has_correct_article_in_top3: false,
        shift_detected: false,
        details: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  
  // Зберігаємо результати
  const fs = await import('fs/promises');
  const outputPath = resolve(workspaceRoot(), 'runs', 'audit', 'RAG_SANITY_COMPREHENSIVE.json');
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n✅ Comprehensive test results збережено: ${outputPath}`);
  
  // Генеруємо Markdown звіт
  const markdownFile = resolve(workspaceRoot(), 'runs', 'audit', 'RAG_SANITY_COMPREHENSIVE.md');
  const markdown = generateMarkdownReport(results);
  await fs.writeFile(markdownFile, markdown, 'utf-8');
  console.log(`✅ Comprehensive test report (Markdown) збережено: ${markdownFile}`);
  
  // Статистика
  const passed = results.filter(r => r.passed).length;
  const partial = results.filter(r => !r.passed && r.has_correct_article_in_top3).length;
  const failed = results.filter(r => !r.passed && !r.has_correct_article_in_top3).length;
  const withShift = results.filter(r => r.shift_detected).length;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`   Total tests: ${results.length}`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ⚠️  Partial (in top3): ${partial}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   🔴 With shift: ${withShift}`);
  
  if (withShift > 0) {
    console.log(`\n❌ CRITICAL: Знайдено ${withShift} тестів зі зсувом!`);
    results.filter(r => r.shift_detected).forEach(r => {
      console.log(`   - ${r.test_name}: ${r.details}`);
    });
  } else if (failed === 0) {
    console.log(`\n✅ Всі тести пройдені успішно!`);
  }
}

/**
 * Генерує Markdown звіт
 */
function generateMarkdownReport(results: ComprehensiveTestResult[]): string {
  let md = `# Comprehensive RAG Sanity Test Report\n\n`;
  md += `**Дата:** ${new Date().toISOString()}\n\n`;
  md += `| Test | Query | Expected | Top Result | Status | Shift |\n`;
  md += `|------|-------|----------|------------|--------|-------|\n`;
  
  for (const result of results) {
    const status = result.passed ? '✅ PASS' : (result.has_correct_article_in_top3 ? '⚠️ PARTIAL' : '❌ FAIL');
    const shift = result.shift_detected ? '🔴 YES' : '✅ NO';
    md += `| ${result.test_name} | ${result.query} | ст.${result.expected_article} | ст.${result.top_result_article || 'NULL'} | ${status} | ${shift} |\n`;
  }
  
  md += `\n## Details\n\n`;
  for (const result of results) {
    md += `### ${result.test_name}\n\n`;
    md += `- **Query:** "${result.query}"\n`;
    md += `- **Expected:** ст.${result.expected_article}\n`;
    md += `- **Top Result:** ст.${result.top_result_article || 'NULL'}\n`;
    md += `- **Status:** ${result.passed ? '✅ PASS' : (result.has_correct_article_in_top3 ? '⚠️ PARTIAL' : '❌ FAIL')}\n`;
    if (result.shift_detected) {
      md += `- **⚠️ SHIFT DETECTED:** ${result.details}\n`;
    }
    md += `\n`;
  }
  
  return md;
}
