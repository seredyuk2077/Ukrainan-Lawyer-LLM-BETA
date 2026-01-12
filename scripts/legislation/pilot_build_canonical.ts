#!/usr/bin/env node

/**
 * STEP 2: Pilot Build Canonical — побудова canonical формату для Конституції
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pilot_build_canonical.ts --nreg=254к/96-вр
 */

import { buildCanonical, generateRagChunks } from './canonical/buildCanonical.js';
import { validateConfig, logConfig, PATHS } from './config.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Парсить аргументи командного рядка
 */
function parseArgs(): { nreg: string | null } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/pilot_build_canonical.ts --nreg=<nreg>

Приклади:
  pnpm tsx scripts/legislation/pilot_build_canonical.ts --nreg=254к/96-вр

Опис:
  Будує canonical JSON формат з raw даних (JSON + TXT).
  Зберігає результат в tmp/canonical/.
      `);
      process.exit(0);
    }
  }

  return { nreg };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🏗️  STEP 2: Pilot Build Canonical — Побудова canonical формату\n');

  // Валідація конфігурації
  const configCheck = validateConfig();
  if (!configCheck.valid) {
    console.error('❌ Помилки конфігурації:');
    configCheck.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  logConfig();

  // Парсинг аргументів
  const { nreg } = parseArgs();
  
  if (!nreg) {
    console.error('❌ Помилка: не вказано --nreg');
    console.error('   Використання: pnpm tsx scripts/legislation/pilot_build_canonical.ts --nreg=254к/96-вр');
    process.exit(1);
  }

  console.log(`📄 Документ: ${nreg}\n`);

  // Створюємо папку canonical якщо не існує
  if (!existsSync(PATHS.canonical)) {
    await mkdir(PATHS.canonical, { recursive: true });
  }

  try {
    // Формуємо шляхи до файлів
    const safeNreg = nregToSafeFilename(nreg);
    const jsonPath = `${PATHS.radaRaw}/${safeNreg}.json`;
    const txtPath = `${PATHS.radaRaw}/${safeNreg}.txt`;

    // Перевіряємо наявність файлів
    if (!existsSync(jsonPath)) {
      console.error(`❌ JSON файл не знайдено: ${jsonPath}`);
      console.error('   Спочатку запустіть: pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=' + nreg);
      process.exit(1);
    }

    if (!existsSync(txtPath)) {
      console.warn(`⚠️  TXT файл не знайдено: ${txtPath}`);
      console.warn('   Будуємо canonical тільки з JSON (може не містити статей)');
    }

    console.log('📥 Читаємо raw дані...');
    console.log(`   JSON: ${jsonPath}`);
    if (existsSync(txtPath)) {
      console.log(`   TXT:  ${txtPath}`);
    }
    console.log();

    // Будуємо canonical
    console.log('🔨 Будуємо canonical формат...\n');
    const canonical = await buildCanonical({
      jsonPath,
      txtPath: existsSync(txtPath) ? txtPath : undefined,
    });

    // Генеруємо RAG chunks
    console.log('📦 Генеруємо RAG chunks...\n');
    const chunks = generateRagChunks(canonical);

    // Зберігаємо canonical
    const canonicalPath = `${PATHS.canonical}/${safeNreg}.canonical.json`;
    await writeFile(canonicalPath, JSON.stringify(canonical, null, 2), 'utf-8');
    console.log(`💾 Збережено canonical: ${canonicalPath}`);

    // Виводимо статистику
    console.log('\n' + '='.repeat(70));
    console.log('📊 СТАТИСТИКА');
    console.log('='.repeat(70) + '\n');

    console.log('📄 Метадані:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  NREG:           ${canonical.metadata.rada_nreg}`);
    console.log(`  Назва:          ${canonical.metadata.title}`);
    console.log(`  Тип:            ${canonical.metadata.document_type}`);
    console.log(`  Категорія:      ${canonical.metadata.category}`);
    console.log(`  Дата ред.:      ${canonical.metadata.rada_datred}`);
    console.log(`  Content Hash:   ${canonical.metadata.content_hash.substring(0, 16)}...`);
    console.log();

    console.log('📚 Контент:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  Статей:         ${canonical.content.articles.length}`);
    console.log(`  RAG chunks:     ${chunks.length}`);
    console.log();

    if (canonical.content.articles.length > 0) {
      const firstArticle = canonical.content.articles[0];
      console.log('📝 Приклад першої статті:');
      console.log('─────────────────────────────────────────────────────────────────');
      console.log(`  Номер:         ${firstArticle.number}`);
      console.log(`  Назва:         ${firstArticle.title}`);
      console.log(`  Довжина:       ${firstArticle.content.length} символів`);
      if (firstArticle.parts && firstArticle.parts.length > 0) {
        console.log(`  Частин:        ${firstArticle.parts.length}`);
      }
      console.log();
    }

    if (chunks.length > 0) {
      const firstChunk = chunks[0];
      console.log('🔍 Приклад першого chunk:');
      console.log('─────────────────────────────────────────────────────────────────');
      console.log(`  Key:           ${firstChunk.key}`);
      console.log(`  Title:         ${firstChunk.title}`);
      console.log(`  Довжина:       ${firstChunk.content.length} символів`);
      console.log();
    }

    console.log('='.repeat(70));
    console.log('✅ Canonical формат успішно побудовано!');
    console.log('='.repeat(70));
    console.log(`\n💾 Файл: ${canonicalPath}`);
    console.log(`\n💡 Наступний крок: STEP 3 — Storage decision для R2`);

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

