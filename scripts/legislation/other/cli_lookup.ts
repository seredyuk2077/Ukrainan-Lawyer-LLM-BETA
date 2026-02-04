#!/usr/bin/env node

/**
 * CLI для швидкого lookup документів за назвою
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/cli_lookup.ts --query "Конституція України"
 *   pnpm tsx scripts/legislation/cli_lookup.ts --query "Цивільний кодекс" --limit 5
 *   pnpm tsx scripts/legislation/cli_lookup.ts --query "Конституція" --refresh
 */

import { resolveCandidates, getByNreg, ensureIndexFresh, getIndexStats } from './radaDocIndex.js';
import { validateConfig, logConfig } from './config.js';

/**
 * Парсить аргументи командного рядка
 */
function parseArgs(): { 
  query: string | null; 
  nreg: string | null;
  limit: number;
  refresh: boolean;
} {
  const args = process.argv.slice(2);
  let query: string | null = null;
  let nreg: string | null = null;
  let limit = 20;
  let refresh = false;

  for (const arg of args) {
    if (arg.startsWith('--query=')) {
      query = arg.substring('--query='.length);
    } else if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.substring('--limit='.length), 10) || 20;
    } else if (arg === '--refresh') {
      refresh = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/cli_lookup.ts --query="<запит>" [опції]
  pnpm tsx scripts/legislation/cli_lookup.ts --nreg="<nreg>"

Приклади:
  pnpm tsx scripts/legislation/cli_lookup.ts --query="Конституція України"
  pnpm tsx scripts/legislation/cli_lookup.ts --query="Цивільний кодекс" --limit=5
  pnpm tsx scripts/legislation/cli_lookup.ts --query="Конституція" --refresh
  pnpm tsx scripts/legislation/cli_lookup.ts --nreg="254к/96-ВР"

Параметри:
  --query    Текст для пошуку (обов'язково, якщо не вказано --nreg)
  --nreg     NREG документа для прямого пошуку
  --limit    Максимальна кількість результатів (за замовчуванням: 20)
  --refresh  Примусово оновити індекс (ігнорує кеш)
      `);
      process.exit(0);
    }
  }

  return { query, nreg, limit, refresh };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🔍 Швидкий lookup документів з каталогу ВРУ\n');

  // Валідація конфігурації
  const configCheck = validateConfig();
  if (!configCheck.valid) {
    console.error('❌ Помилки конфігурації:');
    configCheck.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  logConfig();
  console.log();

  // Парсинг аргументів
  const { query, nreg, limit, refresh } = parseArgs();
  
  if (!query && !nreg) {
    console.error('❌ Помилка: не вказано --query або --nreg');
    console.error('   Використання: pnpm tsx scripts/legislation/cli_lookup.ts --query="<запит>"');
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    // Забезпечуємо актуальність індексу
    if (refresh) {
      console.log('🔄 Примусове оновлення індексу...\n');
    }
    await ensureIndexFresh(refresh);

    // Отримуємо статистику
    const stats = await getIndexStats();
    if (stats) {
      console.log(`📊 Індекс: ${stats.entryCount.toLocaleString()} документів`);
      if (stats.cachedAt) {
        const cachedDate = new Date(stats.cachedAt);
        const ageHours = (Date.now() - cachedDate.getTime()) / (1000 * 60 * 60);
        console.log(`🕐 Кеш: ${cachedDate.toLocaleString('uk-UA')} (${ageHours.toFixed(1)} год тому)`);
      }
      console.log();
    }

    // Виконуємо пошук
    if (nreg) {
      // Прямий пошук за nreg
      console.log(`🔍 Пошук за NREG: ${nreg}\n`);
      
      const entry = await getByNreg(nreg);
      
      if (!entry) {
        console.log('❌ Документ не знайдено');
        process.exit(1);
      }
      
      console.log('✅ Знайдено:\n');
      console.log(`   NREG: ${entry.nreg}`);
      console.log(`   Назва: ${entry.title}`);
      if (entry.dokid) {
        console.log(`   DOKID: ${entry.dokid}`);
      }
      if (entry.datred) {
        console.log(`   Дата ред.: ${entry.datred}`);
      }
      if (entry.type) {
        console.log(`   Тип: ${entry.type}`);
      }
      if (entry.organ) {
        console.log(`   Орган: ${entry.organ}`);
      }
      if (entry.url) {
        console.log(`   URL: ${entry.url}`);
      }
    } else {
      // Пошук за запитом
      console.log(`🔍 Пошук: "${query}"\n`);
      
      const candidates = await resolveCandidates(query!, limit);
      
      if (candidates.length === 0) {
        console.log('❌ Документи не знайдено');
        console.log('\n💡 Спробуйте:');
        console.log('   - Змінити запит');
        console.log('   - Збільшити ліміт: --limit=50');
        console.log('   - Використати часткову назву');
        process.exit(1);
      }
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log(`✅ Знайдено ${candidates.length} кандидатів (за ${elapsed} сек):\n`);
      console.log('─────────────────────────────────────────────────────────────────');
      
      candidates.forEach((candidate, index) => {
        console.log(`\n${index + 1}. ${candidate.title}`);
        console.log(`   NREG: ${candidate.nreg}`);
        console.log(`   Score: ${candidate.score}/100`);
        if (candidate.dokid) {
          console.log(`   DOKID: ${candidate.dokid}`);
        }
        if (candidate.datred) {
          console.log(`   Дата ред.: ${candidate.datred}`);
        }
        if (candidate.type) {
          console.log(`   Тип: ${candidate.type}`);
        }
        if (candidate.organ) {
          console.log(`   Орган: ${candidate.organ}`);
        }
      });
      
      console.log('\n─────────────────────────────────────────────────────────────────');
      console.log(`\n💡 Використання найкращого результату:`);
      console.log(`   pnpm tsx scripts/legislation/pilot_fetch.ts --nreg="${candidates[0].nreg}"`);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n⏱️  Загальний час: ${totalElapsed} сек`);

  } catch (error) {
    console.error('\n❌ Помилка:');
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Запускаємо
main().catch(error => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

