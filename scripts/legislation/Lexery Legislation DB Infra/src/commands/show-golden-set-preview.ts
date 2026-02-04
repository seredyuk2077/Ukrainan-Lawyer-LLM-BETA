/**
 * Show Golden Set Preview — PHASE 2.5
 * 
 * Виводить preview-evidence таблицю з golden_diversity_set.json
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';

export async function showGoldenSetPreview(inputFile?: string): Promise<void> {
  const inputPath = inputFile || resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'runs', 'diverse', 'golden_diversity_set.json');
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Golden Set Preview — PHASE 2.5`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const content = await readFile(inputPath, 'utf-8');
  const data = JSON.parse(content);
  const candidates = data.candidates || [];
  
  if (candidates.length === 0) {
    console.log('❌ Golden set порожній\n');
    return;
  }
  
  console.log(`📊 Total: ${candidates.length} кандидатів\n`);
  
  // Таблиця preview
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Preview Table (30 кандидатів)');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('NREG | Title (prefix) | Predicted Slug | Organ | Prefix Class | Summary Prefix (80) | Snippet15 | Reason');
  console.log('-----|----------------|----------------|-------|--------------|---------------------|-----------|-------');
  
  for (const candidate of candidates.slice(0, 30)) {
    const titlePrefix = (candidate.title || '').substring(0, 40).padEnd(40);
    const summaryPrefix = ((candidate.summary_prefix || '') as string).substring(0, 80).padEnd(80);
    const snippet15 = (candidate.snippet15 || '') as string;
    const reason = candidate.selection_reason || '';
    
    console.log(
      `${(candidate.nreg || '').padEnd(10)} | ${titlePrefix} | ${(candidate.predicted_slug || '').padEnd(15)} | ${((candidate.organ_signal || 'OTHER') as string).padEnd(5)} | ${((candidate.prefix_class || 'ІНШЕ') as string).padEnd(13)} | ${summaryPrefix} | ${snippet15.padEnd(9)} | ${reason}`
    );
  }
  
  // Генеруємо golden_preview.md
  const previewPath = resolve(process.env.LEXERY_LEGISLATION_WORKSPACE_ROOT || process.cwd(), 'runs', 'diverse', 'golden_preview.md');
  const previewContent = `# Golden Diversity Set Preview

**Дата:** ${new Date().toISOString()}  
**Total:** ${candidates.length} кандидатів

## Preview Table (30 кандидатів)

| NREG | Title | Predicted Slug | Organ | Prefix Class | Summary Prefix (80) | Snippet15 | Reason |
|------|-------|----------------|-------|--------------|---------------------|-----------|--------|
${candidates.slice(0, 30).map(c => {
  const title = (c.title || '').replace(/\|/g, '\\|');
  const summary = ((c.summary_prefix || '') as string).substring(0, 80).replace(/\|/g, '\\|');
  const snippet = (c.snippet15 || '').replace(/\|/g, '\\|');
  const reason = (c.selection_reason || '').replace(/\|/g, '\\|');
  return `| ${c.nreg || ''} | ${title} | ${c.predicted_slug || ''} | ${c.organ_signal || 'OTHER'} | ${c.prefix_class || 'ІНШЕ'} | ${summary} | ${snippet} | ${reason} |`;
}).join('\n')}

## Distribution

### Predicted Slugs (top 15)
${Object.entries(summary.predicted_slugs || {})
  .sort(([, a], [, b]) => (b as number) - (a as number))
  .slice(0, 15)
  .map(([slug, count]) => `- ${slug}: ${count}`)
  .join('\n')}

### Prefix Classes
${Object.entries(summary.prefix_classes || {})
  .map(([prefix, count]) => `- ${prefix}: ${count}`)
  .join('\n')}

### Organ Signals
${Object.entries(summary.organ_signals || {})
  .map(([organ, count]) => `- ${organ}: ${count}`)
  .join('\n')}

### CMU %
${(() => {
  const cmuCount = Object.entries(summary.predicted_slugs || {})
    .filter(([slug]) => slug.startsWith('cmu_'))
    .reduce((sum, [, count]) => sum + (count as number), 0);
  const cmuPercent = candidates.length > 0 ? ((cmuCount / candidates.length) * 100).toFixed(1) : '0.0';
  return `CMU: ${cmuCount}/${candidates.length} (${cmuPercent}%)`;
})()}
`;
  
  await writeFile(previewPath, previewContent, 'utf-8');
  console.log(`\n💾 Збережено preview: ${previewPath}\n`);
  
  if (candidates.length > 30) {
    console.log(`\n... і ще ${candidates.length - 30} кандидатів\n`);
  }
  
  // Distribution
  const summary = data.summary || {};
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Distribution');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  console.log('📊 Predicted Slugs (top 10):');
  const slugs = summary.predicted_slugs || {};
  const topSlugs = Object.entries(slugs)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 10);
  for (const [slug, count] of topSlugs) {
    console.log(`   ${slug}: ${count}`);
  }
  
  console.log('\n📊 Prefix Classes:');
  const prefixClasses = summary.prefix_classes || {};
  for (const [prefix, count] of Object.entries(prefixClasses)) {
    console.log(`   ${prefix}: ${count}`);
  }
  
  console.log('\n📊 Organ Signals:');
  const organSignals = summary.organ_signals || {};
  for (const [organ, count] of Object.entries(organSignals)) {
    console.log(`   ${organ}: ${count}`);
  }
  
  // CMU %
  const cmuCount = Object.entries(slugs)
    .filter(([slug]) => slug.startsWith('cmu_'))
    .reduce((sum, [, count]) => sum + (count as number), 0);
  const cmuPercent = candidates.length > 0 ? ((cmuCount / candidates.length) * 100).toFixed(1) : '0.0';
  console.log(`\n📊 CMU %: ${cmuCount}/${candidates.length} (${cmuPercent}%)`);
  
  if (parseFloat(cmuPercent) > 20) {
    console.log(`   ⚠️  WARN: CMU домінує ${cmuPercent}% (ціль < 20%)`);
  } else {
    console.log(`   ✅ OK: CMU ${cmuPercent}% < 20%`);
  }
  
  console.log('');
}
