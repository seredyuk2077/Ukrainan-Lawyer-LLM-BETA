#!/usr/bin/env node

/**
 * CLI для пошуку nreg за назвою документа
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/find_nreg.ts --query "Конституція України"
 *   pnpm tsx scripts/legislation/find_nreg.ts --query "Цивільний кодекс" --limit 5
 */

import { searchDocIndex, findByExactTitle, ensureDocIndexLocal, getIndexSource } from './docIndex.js';
import { validateConfig, logConfig } from './config.js';
import type { DocumentIndexEntry } from './docIndex.js';

/**
 * Парсить аргументи командного рядка
 */
function parseArgs(): { 
  query: string | null; 
  limit: number; 
  exact: boolean;
  refreshIndex: boolean;
  source: 'opendata' | 'html' | 'tsv' | 'auto' | null;
} {
  const args = process.argv.slice(2);
  let query: string | null = null;
  let limit = 10;
  let exact = false;
  let refreshIndex = false;
  let source: 'opendata' | 'html' | 'tsv' | 'auto' | null = null;

  for (const arg of args) {
    if (arg.startsWith('--query=')) {
      query = arg.substring('--query='.length);
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.substring('--limit='.length), 10) || 10;
    } else if (arg === '--exact') {
      exact = true;
    } else if (arg === '--refresh-index') {
      refreshIndex = true;
    } else if (arg.startsWith('--source=')) {
      const sourceValue = arg.substring('--source='.length);
      if (sourceValue === 'opendata' || sourceValue === 'html' || sourceValue === 'tsv' || sourceValue === 'auto') {
        source = sourceValue;
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/find_nreg.ts --query="<запит>" [опції]

Приклади:
  pnpm tsx scripts/legislation/find_nreg.ts --query="Конституція України"
  pnpm tsx scripts/legislation/find_nreg.ts --query="Цивільний кодекс" --limit=5
  pnpm tsx scripts/legislation/find_nreg.ts --query="Конституція" --exact
  pnpm tsx scripts/legislation/find_nreg.ts --query="Конституція" --refresh-index
  pnpm tsx scripts/legislation/find_nreg.ts --query="Конституція" --source=opendata

Параметри:
  --query          Текст для пошуку (обов'язково)
  --limit          Максимальна кількість результатів (за замовчуванням: 10)
  --exact          Шукати тільки точний збіг назви
  --refresh-index  Примусово оновити індекс (ігнорує кеш)
  --source         Джерело індексу: opendata, html, tsv, auto (за замовчуванням: auto)
      `);
      process.exit(0);
    }
  }

  return { query, limit, exact, refreshIndex, source };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🔍 Пошук документів в індексі rada.gov.ua\n');

  // Валідація конфігурації
  const configCheck = validateConfig();
  if (!configCheck.valid) {
    console.error('❌ Помилки конфігурації:');
    configCheck.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  logConfig();

  // Парсинг аргументів
  const { query, limit, exact, refreshIndex, source } = parseArgs();
  if (!query) {
    console.error('❌ Помилка: не вказано --query');
    console.error('   Використання: pnpm tsx scripts/legislation/find_nreg.ts --query="<запит>"');
    process.exit(1);
  }

  console.log(`📝 Запит: "${query}"`);
  if (exact) {
    console.log('🎯 Режим: точний збіг');
  } else {
    console.log(`📊 Ліміт результатів: ${limit}`);
  }
  if (refreshIndex) {
    console.log('🔄 Режим: примусове оновлення індексу');
  }
  if (source) {
    console.log(`📡 Джерело: ${source}`);
  }
  console.log();

  try {
    // Забезпечуємо наявність індексу
    await ensureDocIndexLocal(refreshIndex);

    // Отримуємо інформацію про джерело
    const indexInfo = await getIndexSource();
    if (indexInfo) {
      const sourceNames: Record<string, string> = {
        opendata: 'Open Data Portal',
        html_all: 'HTML парсинг',
        tsv_recent: 'TSV (оновлені)',
      };
      console.log(`📋 Джерело індексу: ${sourceNames[indexInfo.source] || indexInfo.source}`);
      console.log(`📊 Кількість документів: ${indexInfo.entryCount.toLocaleString()}`);
      if (indexInfo.downloadedAt) {
        console.log(`🕐 Завантажено: ${new Date(indexInfo.downloadedAt).toLocaleString('uk-UA')}`);
      }
      console.log();
    }

    let results;

    if (exact) {
      const result = await findByExactTitle(query);
      results = result ? [result] : [];
    } else {
      results = await searchDocIndex(query, limit);
    }

    if (results.length === 0) {
      console.log('❌ Документи не знайдено');
      console.log('\n💡 Спробуйте:');
      console.log('   - Змінити запит');
      console.log('   - Збільшити ліміт: --limit=20');
      console.log('   - Використати часткову назву');
      process.exit(1);
    }

    console.log(`✅ Знайдено ${results.length} документ${results.length === 1 ? '' : 'ів'}:\n`);
    console.log('─────────────────────────────────────────────────────────────────');

    results.forEach((doc, index) => {
      const entry = doc as DocumentIndexEntry & { score?: number };
      console.log(`\n${index + 1}. ${entry.title}`);
      console.log(`   NREG: ${entry.nreg}`);
      if (entry.dokid) {
        console.log(`   DOKID: ${entry.dokid}`);
      }
      if (entry.type) {
        console.log(`   Тип: ${entry.type}`);
      }
      if (entry.datred) {
        console.log(`   Дата ред.: ${entry.datred}`);
      }
      if (!exact && 'score' in doc && typeof doc.score === 'number') {
        console.log(`   Оцінка: ${doc.score.toFixed(1)}`);
      }
    });

    console.log('\n─────────────────────────────────────────────────────────────────');
    console.log(`\n💡 Використання найкращого результату:`);
    console.log(`   pnpm tsx scripts/legislation/pilot_fetch.ts --nreg="${results[0].nreg}"`);
    
    if (indexInfo) {
      console.log(`\n📋 Джерело індексу: ${indexInfo.source}`);
    }

  } catch (error) {
    console.error('\n❌ Помилка:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Запускаємо
main().catch(error => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

