#!/usr/bin/env node

/**
 * Pilot fetch — тестовий скрипт для завантаження одного документа
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=<nreg>
 * 
 * Приклад:
 *   pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=254к/96-вр
 */

import { RadaClient } from './radaClient.js';
import { validateConfig, logConfig, PATHS } from './config.js';
import { searchDocIndex } from './docIndex.js';
import { createRawFetchResult, RawFetchResult } from './utils/rawFetch.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Парсить аргументи командного рядка
 */
function parseArgs(): { nreg: string | null; title: string | null } {
  const args = process.argv.slice(2);
  let nreg: string | null = null;
  let title: string | null = null;

  for (const arg of args) {
    if (arg.startsWith('--nreg=')) {
      nreg = arg.substring('--nreg='.length);
    } else if (arg.startsWith('--title=')) {
      title = arg.substring('--title='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Використання:
  pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=<nreg>
  pnpm tsx scripts/legislation/pilot_fetch.ts --title="<назва>"

Приклади:
  pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=254к/96-ВР
  pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=435-15
  pnpm tsx scripts/legislation/pilot_fetch.ts --title="Конституція України"

Опис:
  Завантажує документ з rada.gov.ua API та зберігає raw відповідь в tmp/rada_raw/
  Якщо вказано --title, спочатку шукає nreg в індексі документів.
      `);
      process.exit(0);
    }
  }

  return { nreg, title };
}

/**
 * Витягує базові метадані з JSON відповіді
 */
function extractMetadata(jsonData: any): {
  nreg: string | null;
  dokid: number | null;
  title: string | null;
  datred: string | null;
  hasStru: boolean;
  textLength: number;
} {
  // API має нестабільну структуру, тому перевіряємо різні варіанти
  const nreg = jsonData?.nreg || jsonData?.meta?.nreg || jsonData?.metadata?.nreg || null;
  const dokid = jsonData?.dokid || jsonData?.meta?.dokid || jsonData?.metadata?.dokid || null;
  
  // Назва може бути в різних місцях
  const title = 
    jsonData?.nazva || 
    jsonData?.meta?.doc?.title || 
    jsonData?.metadata?.nazva || 
    jsonData?.title || 
    null;

  // Дата редакції
  let datred: string | null = null;
  const datredRaw = jsonData?.datred || jsonData?.meta?.datred || jsonData?.metadata?.datred;
  if (datredRaw) {
    // Може бути number (YYYYMMDD) або string
    const datredStr = String(datredRaw);
    if (datredStr.length === 8 && /^\d+$/.test(datredStr)) {
      // Форматуємо YYYYMMDD -> YYYY-MM-DD
      datred = `${datredStr.substring(0, 4)}-${datredStr.substring(4, 6)}-${datredStr.substring(6, 8)}`;
    } else {
      datred = datredStr;
    }
  }

  // Перевіряємо наявність структури
  const stru = jsonData?.stru || jsonData?.meta?.stru || jsonData?.structure || null;
  const hasStru = Array.isArray(stru) && stru.length > 0;

  // Довжина тексту (наближена)
  const textLength = JSON.stringify(jsonData).length;

  return {
    nreg,
    dokid,
    title,
    datred,
    hasStru,
    textLength,
  };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🚀 Pilot Fetch — Тестовий завантаження документа\n');

  // Валідація конфігурації
  const configCheck = validateConfig();
  if (!configCheck.valid) {
    console.error('❌ Помилки конфігурації:');
    configCheck.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  logConfig();

  // Парсинг аргументів
  const { nreg: providedNreg, title } = parseArgs();
  
  let nreg: string | null = providedNreg;

  // Якщо вказано title, шукаємо nreg
  if (title && !nreg) {
    console.log(`🔍 Шукаємо nreg за назвою: "${title}"\n`);
    try {
      const results = await searchDocIndex(title, 1);
      if (results.length === 0) {
        console.error(`❌ Документ не знайдено за назвою: "${title}"`);
        console.error('   Спробуйте використати --nreg напряму або іншу назву');
        process.exit(1);
      }
      nreg = results[0].nreg;
      console.log(`✅ Знайдено: ${results[0].title}`);
      console.log(`   NREG: ${nreg}\n`);
    } catch (error) {
      console.error('❌ Помилка пошуку:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (!nreg) {
    console.error('❌ Помилка: не вказано --nreg або --title');
    console.error('   Використання: pnpm tsx scripts/legislation/pilot_fetch.ts --nreg=<nreg>');
    console.error('   Або: pnpm tsx scripts/legislation/pilot_fetch.ts --title="<назва>"');
    process.exit(1);
  }

  console.log(`📄 Документ: ${nreg}\n`);

  // Створюємо папку tmp якщо не існує
  if (!existsSync(PATHS.tmp)) {
    await mkdir(PATHS.tmp, { recursive: true });
  }

  const client = new RadaClient();

  try {
    // Завантажуємо JSON
    let jsonData: any;
    let usedToken = false;
    try {
      jsonData = await client.fetchJson(nreg);
      usedToken = true; // fetchJson використовує токен якщо доступний
    } catch (error) {
      console.error(`❌ Помилка завантаження JSON: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    // Витягуємо метадані
    const metadata = extractMetadata(jsonData);
    
    if (!metadata.nreg || !metadata.title || !metadata.datred) {
      console.error('❌ Критичні метадані відсутні в JSON відповіді');
      console.error(`   NREG: ${metadata.nreg || 'відсутній'}`);
      console.error(`   Title: ${metadata.title || 'відсутній'}`);
      console.error(`   Datred: ${metadata.datred || 'відсутній'}`);
      process.exit(1);
    }

    // Перевіряємо чи є контент
    const hasContent = metadata.hasStru || metadata.textLength > 1000;
    let txtData: string | undefined;
    
    if (!hasContent) {
      console.log('⚠️  JSON не містить структури, спробуємо завантажити TXT...\n');
      
      try {
        txtData = await client.fetchTxt(nreg);
        await client.saveRaw(nreg, txtData, 'txt');
        console.log(`✅ TXT завантажено (${txtData.length} символів)`);
      } catch (error) {
        console.warn(`⚠️  Не вдалося завантажити TXT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Створюємо детермінований RAW результат
    const rawResult = createRawFetchResult({
      nreg: metadata.nreg!,
      dokid: metadata.dokid || undefined,
      title: metadata.title!,
      datred: metadata.datred!,
      jsonData,
      txtData,
      usedToken,
    });

    // Зберігаємо сирі дані
    const savedJsonPath = await client.saveRaw(nreg, jsonData, 'json');
    
    // Зберігаємо детермінований RAW результат
    const safeNreg = nregToSafeFilename(metadata.nreg!);
    const rawResultPath = `${PATHS.tmp}/rada_raw/${safeNreg}.raw.json`;
    await writeFile(rawResultPath, JSON.stringify(rawResult, null, 2), 'utf-8');
    
    // Виводимо звіт
    console.log('\n📊 Звіт про документ:');
    console.log('─────────────────────────────────────────');
    console.log(`  NREG:        ${rawResult.identifiers.nreg}`);
    if (rawResult.identifiers.dokid) {
      console.log(`  DOKID:       ${rawResult.identifiers.dokid}`);
    }
    console.log(`  Назва:       ${rawResult.metadata.title}`);
    console.log(`  Дата ред.:   ${rawResult.metadata.datred}`);
    console.log(`  Source URL:  ${rawResult.metadata.sourceUrl}`);
    console.log(`  Має структуру: ${rawResult.structure.hasStru ? '✅ Так' : '❌ Ні'}`);
    if (rawResult.structure.struCount) {
      console.log(`  Структурних елементів: ${rawResult.structure.struCount}`);
    }
    console.log(`  Розмір JSON: ~${Math.round(rawResult.stats.jsonSize / 1024)} KB`);
    if (rawResult.stats.txtSize) {
      console.log(`  Розмір TXT:  ~${Math.round(rawResult.stats.txtSize / 1024)} KB`);
    }
    console.log(`  Формат:      ${rawResult.fetch.format}`);
    console.log('─────────────────────────────────────────\n');
    
    console.log('✅ Готово!');
    console.log(`   Raw JSON: ${savedJsonPath}`);
    console.log(`   Raw Result: ${rawResultPath}`);
    console.log('\n💡 Наступний крок: перевірте raw результат та запустіть парсер для canonical формату');

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

