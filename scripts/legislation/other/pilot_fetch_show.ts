#!/usr/bin/env node

/**
 * STEP 1: Pilot Fetch Show — детальний аналіз API формату документа
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=254к/96-вр
 *   pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=435-15
 * 
 * Мета:
 * - Отримати повний JSON документ через /laws/show/{nreg}.json
 * - Перевірити наявність всіх полів (nazva, nreg, dokid, datred, stru, text/content)
 * - Якщо text/content/stru пусті — fallback на .txt
 * - Зберегти raw у tmp/rada_raw/{nreg}.json + tmp/rada_raw/{nreg}.txt
 * - Вивести детальний звіт про структуру
 */

import { RadaClient } from './radaClient.js';
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
  pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=<nreg>

Приклади:
  pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=254к/96-вр
  pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=435-15

Опис:
  Детальний аналіз API формату документа з rada.gov.ua.
  Зберігає raw JSON та TXT (якщо потрібно) в tmp/rada_raw/.
  Виводить звіт про структуру документа.
      `);
      process.exit(0);
    }
  }

  return { nreg };
}

/**
 * Аналізує структуру stru масиву
 */
function analyzeStru(stru: any[]): {
  totalCount: number;
  types: Record<string, number>;
  typeExamples: Record<string, any>;
  hasHierarchy: boolean;
} {
  const types: Record<string, number> = {};
  const typeExamples: Record<string, any> = {};
  let hasHierarchy = false;

  for (const item of stru) {
    const typ = item?.typ || item?.type || 'UNKNOWN';
    const typn = item?.typn || item?.typeName || null;
    
    // Рахуємо типи
    const typeKey = typn ? `${typ} (${typn})` : typ;
    types[typeKey] = (types[typeKey] || 0) + 1;
    
    // Зберігаємо приклад для кожного типу
    if (!typeExamples[typeKey]) {
      typeExamples[typeKey] = {
        typ,
        typn,
        stru: item?.stru || item?.number || null,
        hasText: !!(item?.text || item?.content),
        textLength: (item?.text || item?.content || '').length,
        hasChildren: Array.isArray(item?.children) && item.children.length > 0,
      };
    }

    // Перевіряємо ієрархію
    if (item?.children && Array.isArray(item.children) && item.children.length > 0) {
      hasHierarchy = true;
    }
  }

  return {
    totalCount: stru.length,
    types,
    typeExamples,
    hasHierarchy,
  };
}

/**
 * Витягує всі поля з JSON відповіді
 */
function extractAllFields(jsonData: any): {
  present: string[];
  missing: string[];
  structure: {
    hasStru: boolean;
    struCount?: number;
    struAnalysis?: ReturnType<typeof analyzeStru>;
    hasText: boolean;
    hasContent: boolean;
    textLength: number;
  };
} {
  const present: string[] = [];
  const missing: string[] = [];

  // Перевіряємо основні поля
  const fields = ['nreg', 'nazva', 'dokid', 'datred', 'stru', 'text', 'content'];
  
  for (const field of fields) {
    const value = jsonData?.[field] || jsonData?.meta?.[field] || jsonData?.metadata?.[field];
    if (value !== undefined && value !== null) {
      present.push(field);
    } else {
      missing.push(field);
    }
  }

  // Аналізуємо структуру
  const stru = jsonData?.stru || jsonData?.meta?.stru || jsonData?.structure || null;
  const hasStru = Array.isArray(stru) && stru.length > 0;
  const struCount = hasStru ? stru.length : undefined;
  const struAnalysis = hasStru ? analyzeStru(stru) : undefined;

  const hasText = !!(jsonData?.text || jsonData?.meta?.text);
  const hasContent = !!(jsonData?.content || jsonData?.meta?.content);
  
  // Довжина тексту (наближена)
  const textLength = JSON.stringify(jsonData).length;

  return {
    present,
    missing,
    structure: {
      hasStru,
      struCount,
      struAnalysis,
      hasText,
      hasContent,
      textLength,
    },
  };
}

/**
 * Головна функція
 */
async function main() {
  console.log('🔍 STEP 1: Pilot Fetch Show — Аналіз API формату\n');

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
    console.error('   Використання: pnpm tsx scripts/legislation/pilot_fetch_show.ts --nreg=254к/96-вр');
    process.exit(1);
  }

  console.log(`📄 Документ: ${nreg}\n`);

  // Створюємо папку tmp якщо не існує
  if (!existsSync(PATHS.radaRaw)) {
    await mkdir(PATHS.radaRaw, { recursive: true });
  }

  const client = new RadaClient();

  try {
    // Завантажуємо JSON
    console.log('📥 Завантажуємо JSON...\n');
    let jsonData: any;
    let usedToken = false;
    
    try {
      jsonData = await client.fetchJson(nreg);
      usedToken = true;
    } catch (error) {
      console.error(`❌ Помилка завантаження JSON: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }

    // Аналізуємо поля
    const analysis = extractAllFields(jsonData);
    
    // Перевіряємо чи є контент (stru - це основне джерело структури)
    const hasContent = analysis.structure.hasStru;
    
    let txtData: string | undefined;
    
    // Якщо немає stru, завжди намагаємося завантажити TXT
    if (!hasContent) {
      console.log('⚠️  JSON не містить stru (структури), завантажуємо TXT...\n');
      
      try {
        txtData = await client.fetchTxt(nreg);
        console.log(`✅ TXT завантажено (${txtData.length} символів)\n`);
      } catch (error) {
        console.warn(`⚠️  Не вдалося завантажити TXT: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Зберігаємо raw дані
    const safeNreg = nregToSafeFilename(nreg);
    const jsonPath = `${PATHS.radaRaw}/${safeNreg}.json`;
    const txtPath = txtData ? `${PATHS.radaRaw}/${safeNreg}.txt` : null;
    
    await writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
    console.log(`💾 Збережено JSON: ${jsonPath}`);
    
    if (txtPath && txtData) {
      await writeFile(txtPath, txtData, 'utf-8');
      console.log(`💾 Збережено TXT: ${txtPath}`);
    }

    // Виводимо детальний звіт
    console.log('\n' + '='.repeat(70));
    console.log('📊 ЗВІТ ПРО API ФОРМАТ');
    console.log('='.repeat(70) + '\n');

    // Основні поля
    console.log('📋 Основні поля:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  ✅ Присутні: ${analysis.present.join(', ') || 'немає'}`);
    console.log(`  ❌ Відсутні: ${analysis.missing.join(', ') || 'немає'}`);
    console.log();

    // Метадані
    const nregValue = jsonData?.nreg || jsonData?.meta?.nreg || 'не знайдено';
    const nazvaValue = jsonData?.nazva || jsonData?.meta?.nazva || jsonData?.metadata?.nazva || 'не знайдено';
    const dokidValue = jsonData?.dokid || jsonData?.meta?.dokid || jsonData?.metadata?.dokid || null;
    
    let datredValue: string | null = null;
    const datredRaw = jsonData?.datred || jsonData?.meta?.datred || jsonData?.metadata?.datred;
    if (datredRaw) {
      const datredStr = String(datredRaw);
      if (datredStr.length === 8 && /^\d+$/.test(datredStr)) {
        datredValue = `${datredStr.substring(0, 4)}-${datredStr.substring(4, 6)}-${datredStr.substring(6, 8)}`;
      } else {
        datredValue = datredStr;
      }
    }

    console.log('📄 Метадані:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  NREG:     ${nregValue}`);
    console.log(`  Назва:    ${nazvaValue}`);
    if (dokidValue) {
      console.log(`  DOKID:    ${dokidValue}`);
    }
    if (datredValue) {
      console.log(`  Дата ред.: ${datredValue}`);
    }
    console.log();

    // Структура
    console.log('🏗️  Структура:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  Має stru:        ${analysis.structure.hasStru ? '✅ Так' : '❌ Ні'}`);
    if (analysis.structure.struCount !== undefined) {
      console.log(`  Елементів stru:  ${analysis.structure.struCount}`);
    }
    console.log(`  Має text:        ${analysis.structure.hasText ? '✅ Так' : '❌ Ні'}`);
    console.log(`  Має content:     ${analysis.structure.hasContent ? '✅ Так' : '❌ Ні'}`);
    console.log(`  Розмір JSON:      ~${Math.round(analysis.structure.textLength / 1024)} KB`);
    if (txtData) {
      console.log(`  Розмір TXT:       ~${Math.round(txtData.length / 1024)} KB`);
    }
    console.log();

    // Детальний аналіз stru
    if (analysis.structure.struAnalysis) {
      const struAnalysis = analysis.structure.struAnalysis;
      
      console.log('🔍 Детальний аналіз stru:');
      console.log('─────────────────────────────────────────────────────────────────');
      console.log(`  Всього елементів: ${struAnalysis.totalCount}`);
      console.log(`  Має ієрархію:     ${struAnalysis.hasHierarchy ? '✅ Так' : '❌ Ні'}`);
      console.log();
      
      console.log('  Типи елементів:');
      for (const [typeKey, count] of Object.entries(struAnalysis.types)) {
        console.log(`    ${typeKey}: ${count}`);
      }
      console.log();

      console.log('  Приклади типів:');
      for (const [typeKey, example] of Object.entries(struAnalysis.typeExamples)) {
        console.log(`    ${typeKey}:`);
        console.log(`      stru: ${example.stru || 'немає'}`);
        console.log(`      має текст: ${example.hasText ? '✅' : '❌'}`);
        if (example.hasText) {
          console.log(`      довжина тексту: ${example.textLength} символів`);
        }
        console.log(`      має children: ${example.hasChildren ? '✅' : '❌'}`);
      }
      console.log();
    }

    // Формат завантаження
    console.log('📦 Формат завантаження:');
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`  Формат:      ${txtData ? 'both (JSON + TXT)' : 'JSON only'}`);
    console.log(`  Використано токен: ${usedToken ? '✅ Так' : '❌ Ні'}`);
    console.log(`  Timestamp:   ${new Date().toISOString()}`);
    console.log();

    console.log('='.repeat(70));
    console.log('✅ Аналіз завершено!');
    console.log('='.repeat(70));
    console.log(`\n💾 Файли збережено:`);
    console.log(`   JSON: ${jsonPath}`);
    if (txtPath) {
      console.log(`   TXT:  ${txtPath}`);
    }
    console.log(`\n💡 Наступний крок: STEP 2 — побудова canonical формату`);

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

