/**
 * Corpus test command — batch import з report generation
 * 
 * PHASE 7: Corpus Tests + Batch Report Generator
 */
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { importOne } from '../lib/importer.js';
import { workspaceRoot } from '../lib/config.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, countByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

interface CorpusTestResult {
  nreg: string;
  title?: string;
  document_type?: string;
  strategy?: string;
  expected_chunks?: number;
  indexed_chunks?: number;
  category?: string;
  qdrant_status?: string;
  errors: string[];
  time_seconds?: number;
}

interface CorpusReport {
  timestamp: string;
  total_documents: number;
  successful: number;
  failed: number;
  warnings: number;
  results: CorpusTestResult[];
  summary: {
    other_category_count: number;
    other_category_docs: string[];
    zero_chunks_count: number;
    zero_chunks_docs: string[];
    avg_time_seconds: number;
  };
}

const IMPORTANT_DOCUMENT_TYPES = [
  'Постанова', 'Постанова КМУ', 'Постанова ВР',
  'Наказ', 'Указ', 'Розпорядження', 'Рішення',
  'Положення', 'Правила', 'Інструкція',
  'Закон', 'Кодекс',
];

export async function testCorpus(opts: {
  file: string;
  concurrency?: number;
  report?: boolean;
  resume?: boolean;
}): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('PHASE 7: Corpus Tests + Batch Report Generator');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Read corpus file
  const content = await readFile(opts.file, 'utf-8');
  const nregs = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .filter(Boolean);
  
  console.log(`Found ${nregs.length} nregs in corpus file\n`);
  
  const results: CorpusTestResult[] = [];
  const concurrency = opts.concurrency || 2;
  
  // Process in batches
  for (let i = 0; i < nregs.length; i += concurrency) {
    const batch = nregs.slice(i, i + concurrency);
    console.log(`\nProcessing batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(nregs.length / concurrency)} (${batch.length} docs)...`);
    
    const batchPromises = batch.map(async (nreg) => {
      const startTime = Date.now();
      const result: CorpusTestResult = {
        nreg,
        errors: [],
      };
      
      try {
        console.log(`  [${nreg}] Starting import...`);
        const importResult = await importOne({
          mode: 'add',
          radaNreg: nreg,
          resume: opts.resume || false,
          dryRun: false,
        });
        
        result.time_seconds = (Date.now() - startTime) / 1000;
        result.title = importResult.title;
        result.expected_chunks = importResult.expected_chunks;
        
        // Fetch from Supabase for full details
        const supabase = createSupabaseAdminClient();
        const { data: doc } = await supabase
          .from('legislation_documents')
          .select('document_type,category,qdrant_status,indexed_chunks')
          .eq('rada_nreg', nreg)
          .maybeSingle();
        
        if (doc) {
          result.document_type = doc.document_type || undefined;
          result.category = doc.category || undefined;
          result.qdrant_status = doc.qdrant_status || undefined;
          result.indexed_chunks = doc.indexed_chunks || undefined;
        }
        
        // Get parsing strategy from R2 canonical
        try {
          const { getJsonFromR2 } = await import('../lib/r2Json.js');
          const r2Key = importResult.r2_key;
          if (r2Key) {
            const canonical = await getJsonFromR2(r2Key);
            result.strategy = canonical?.content?.structure?.parsing_strategy || undefined;
          }
        } catch (e) {
          // Ignore R2 read errors
        }
        
        console.log(`  [${nreg}] ✅ Completed: ${result.expected_chunks} chunks, category=${result.category}, status=${result.qdrant_status}`);
        
      } catch (e: any) {
        result.errors.push(e.message);
        result.time_seconds = (Date.now() - startTime) / 1000;
        console.log(`  [${nreg}] ❌ Failed: ${e.message}`);
      }
      
      return result;
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }
  
  // Generate report
  const successful = results.filter(r => r.errors.length === 0 && r.qdrant_status === 'indexed').length;
  const failed = results.filter(r => r.errors.length > 0 || r.qdrant_status !== 'indexed').length;
  
  const otherCategoryDocs = results.filter(r => 
    r.category === 'other' && 
    r.document_type && 
    IMPORTANT_DOCUMENT_TYPES.some(type => r.document_type!.includes(type))
  );
  
  const zeroChunksDocs = results.filter(r => 
    (r.expected_chunks === 0 || r.indexed_chunks === 0) &&
    r.document_type &&
    IMPORTANT_DOCUMENT_TYPES.some(type => r.document_type!.includes(type))
  );
  
  const avgTime = results
    .filter(r => r.time_seconds !== undefined)
    .reduce((sum, r) => sum + (r.time_seconds || 0), 0) / results.length;
  
  const report: CorpusReport = {
    timestamp: new Date().toISOString(),
    total_documents: results.length,
    successful,
    failed,
    warnings: otherCategoryDocs.length + zeroChunksDocs.length,
    results,
    summary: {
      other_category_count: otherCategoryDocs.length,
      other_category_docs: otherCategoryDocs.map(r => r.nreg),
      zero_chunks_count: zeroChunksDocs.length,
      zero_chunks_docs: zeroChunksDocs.map(r => r.nreg),
      avg_time_seconds: avgTime,
    },
  };
  
  // Save JSON report
  if (opts.report) {
    const reportPath = resolve(workspaceRoot(), 'runs', `corpus_report_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    await import('fs/promises').then(fs => fs.writeFile(reportPath, JSON.stringify(report, null, 2)));
    console.log(`\nJSON report saved: ${reportPath}`);
  }
  
  // Print Markdown report
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Corpus Import Report');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  console.log('## Summary');
  console.log(`- Total documents: ${report.total_documents}`);
  console.log(`- Successful: ${report.successful}`);
  console.log(`- Failed: ${report.failed}`);
  console.log(`- Warnings: ${report.warnings}`);
  console.log(`- Avg time per doc: ${report.summary.avg_time_seconds.toFixed(2)}s`);
  
  if (report.summary.other_category_count > 0) {
    console.log(`\n⚠️  WARNING: ${report.summary.other_category_count} important documents have category=other:`);
    report.summary.other_category_docs.forEach(nreg => {
      const doc = results.find(r => r.nreg === nreg);
      console.log(`  - ${nreg}: ${doc?.document_type || 'unknown'} (${doc?.title || 'no title'})`);
    });
  }
  
  if (report.summary.zero_chunks_count > 0) {
    console.log(`\n❌ FAIL: ${report.summary.zero_chunks_count} important documents have 0 chunks:`);
    report.summary.zero_chunks_docs.forEach(nreg => {
      const doc = results.find(r => r.nreg === nreg);
      console.log(`  - ${nreg}: ${doc?.document_type || 'unknown'} (${doc?.title || 'no title'})`);
    });
  }
  
  console.log('\n## Detailed Results\n');
  console.log('| nreg | doc_type | strategy | expected | indexed | category | status | time | errors |');
  console.log('|------|----------|----------|----------|---------|----------|--------|------|--------|');
  
  for (const r of results) {
    const status = r.qdrant_status === 'indexed' ? '✅' : r.errors.length > 0 ? '❌' : '⚠️';
    const errors = r.errors.length > 0 ? r.errors[0].slice(0, 30) + '...' : '';
    console.log(`| ${r.nreg} | ${r.document_type || 'N/A'} | ${r.strategy || 'N/A'} | ${r.expected_chunks || 0} | ${r.indexed_chunks || 0} | ${r.category || 'N/A'} | ${status} | ${r.time_seconds?.toFixed(1) || 'N/A'}s | ${errors} |`);
  }
  
  // Save Markdown report
  if (opts.report) {
    const mdReport = generateMarkdownReport(report);
    const mdPath = resolve(workspaceRoot(), 'runs', `corpus_report_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
    await import('fs/promises').then(fs => fs.writeFile(mdPath, mdReport));
    console.log(`\nMarkdown report saved: ${mdPath}`);
  }
}

function generateMarkdownReport(report: CorpusReport): string {
  let md = `# Corpus Import Report\n\n`;
  md += `**Timestamp:** ${report.timestamp}\n\n`;
  md += `## Summary\n\n`;
  md += `- **Total documents:** ${report.total_documents}\n`;
  md += `- **Successful:** ${report.successful}\n`;
  md += `- **Failed:** ${report.failed}\n`;
  md += `- **Warnings:** ${report.warnings}\n`;
  md += `- **Avg time per doc:** ${report.summary.avg_time_seconds.toFixed(2)}s\n\n`;
  
  if (report.summary.other_category_count > 0) {
    md += `## ⚠️ Warnings: Other Category\n\n`;
    md += `${report.summary.other_category_count} important documents have category=other:\n\n`;
    report.summary.other_category_docs.forEach(nreg => {
      const doc = report.results.find(r => r.nreg === nreg);
      md += `- **${nreg}**: ${doc?.document_type || 'unknown'} - ${doc?.title || 'no title'}\n`;
    });
    md += '\n';
  }
  
  if (report.summary.zero_chunks_count > 0) {
    md += `## ❌ Failures: Zero Chunks\n\n`;
    md += `${report.summary.zero_chunks_count} important documents have 0 chunks:\n\n`;
    report.summary.zero_chunks_docs.forEach(nreg => {
      const doc = report.results.find(r => r.nreg === nreg);
      md += `- **${nreg}**: ${doc?.document_type || 'unknown'} - ${doc?.title || 'no title'}\n`;
    });
    md += '\n';
  }
  
  md += `## Detailed Results\n\n`;
  md += `| nreg | doc_type | strategy | expected | indexed | category | status | time | errors |\n`;
  md += `|------|----------|----------|----------|---------|----------|--------|------|--------|\n`;
  
  for (const r of report.results) {
    const status = r.qdrant_status === 'indexed' ? '✅' : r.errors.length > 0 ? '❌' : '⚠️';
    const errors = r.errors.length > 0 ? r.errors[0].slice(0, 30) + '...' : '';
    md += `| ${r.nreg} | ${r.document_type || 'N/A'} | ${r.strategy || 'N/A'} | ${r.expected_chunks || 0} | ${r.indexed_chunks || 0} | ${r.category || 'N/A'} | ${status} | ${r.time_seconds?.toFixed(1) || 'N/A'}s | ${errors} |\n`;
  }
  
  return md;
}
