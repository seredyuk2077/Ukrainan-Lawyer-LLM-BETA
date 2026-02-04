#!/usr/bin/env node

/**
 * STEP 5: Pilot Import Constitution — імпорт Конституції в Supabase Legislation RAG
 * 
 * Використання:
 *   pnpm tsx scripts/legislation/pilot_import_constitution.ts --nreg=254к/96-вр
 * 
 * Мета:
 * - Читає canonical JSON для Конституції
 * - Вставляє метадані в legislation_documents
 * - ПРИМІТКА: Вставка chunks поки не реалізована (потребує chunking + embeddings + R2)
 * - Перевіряє counts
 * 
 * Примітка: використовує MCP для вставки даних (не потребує env змінних)
 */

import { readFile } from 'fs/promises';
import { validateConfig, logConfig, PATHS } from './config.js';
import { nregToSafeFilename } from './utils/nreg.js';
import { CanonicalDocument } from './canonical/buildCanonical.js';
import { createLegislationSupabaseClient, importCanonicalDocument } from './canonical/dbImport.js';

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
  pnpm tsx scripts/legislation/pilot_import_constitution.ts --nreg=254к/96-вр

Аргументи:
  --nreg=<nreg>  NREG документу для імпорту
  --help, -h      Показати цю довідку
      `);
      process.exit(0);
    }
  }

  return { nreg };
}

/**
 * Генерує SQL для імпорту canonical документу
 */
function generateImportSQL(canonical: CanonicalDocument): string {
  // Екрануємо одинарні лапки для SQL
  const escapeSQL = (str: string) => str.replace(/'/g, "''");
  
  // SQL для вставки документа
  const docSQL = `
-- Вставка документа: ${canonical.metadata.rada_nreg}
INSERT INTO legislation_documents (
  rada_nreg, rada_dokid, title, document_type, category, law_number,
  rada_datred, content_hash, previous_hash, r2_key, source_url,
  articles_count, imported_at, updated_at, is_active, sync_status,
  keywords, topics
) VALUES (
  '${escapeSQL(canonical.metadata.rada_nreg)}',
  ${canonical.metadata.rada_dokid || 'NULL'},
  '${escapeSQL(canonical.metadata.title)}',
  '${escapeSQL(canonical.metadata.document_type)}',
  '${escapeSQL(canonical.metadata.category)}',
  ${canonical.metadata.law_number ? `'${escapeSQL(canonical.metadata.law_number)}'` : 'NULL'},
  '${canonical.metadata.rada_datred}',
  '${canonical.metadata.content_hash}',
  ${canonical.metadata.previous_hash ? `'${canonical.metadata.previous_hash}'` : 'NULL'},
  ${canonical.metadata.r2_key ? `'${escapeSQL(canonical.metadata.r2_key)}'` : 'NULL'},
  '${escapeSQL(canonical.metadata.source_url)}',
  ${canonical.content.articles.length},
  '${canonical.metadata.imported_at}',
  '${canonical.metadata.updated_at}',
  true,
  'synced',
  '${JSON.stringify(canonical.ai_enrichment?.keywords || [])}',
  '${JSON.stringify(canonical.ai_enrichment?.topics || [])}'
)
ON CONFLICT (rada_nreg) DO UPDATE SET
  rada_dokid = EXCLUDED.rada_dokid,
  title = EXCLUDED.title,
  document_type = EXCLUDED.document_type,
  category = EXCLUDED.category,
  law_number = EXCLUDED.law_number,
  rada_datred = EXCLUDED.rada_datred,
  content_hash = EXCLUDED.content_hash,
  previous_hash = EXCLUDED.previous_hash,
  r2_key = EXCLUDED.r2_key,
  source_url = EXCLUDED.source_url,
  articles_count = EXCLUDED.articles_count,
  updated_at = EXCLUDED.updated_at,
  sync_status = EXCLUDED.sync_status,
  keywords = EXCLUDED.keywords,
  topics = EXCLUDED.topics;
  `;

  // ПРИМІТКА: SQL для вставки chunks поки не генерується
  // Це потребує:
  // 1. Chunking логіки (розбиття тексту на семантичні чанки)
  // 2. Генерації embeddings через OpenAI API
  // 3. Завантаження canonical JSON в R2
  // 4. Формування r2_key та json_path для кожного чанку
  //
  // Приклад структури для майбутньої реалізації:
  // INSERT INTO legislation_chunks (document_nreg, r2_key, json_path, chunk_index, embedding, article_number, token_count)
  // VALUES
  //   ('nreg', 'civil/435-15.json', 'articles[0].content', 0, '[vector]', '1', 512),
  //   ...
  
  return docSQL + '\n\n-- ПРИМІТКА: Вставка chunks поки не реалізована (потребує chunking + embeddings + R2)';
}

/**
 * Основна функція
 */
async function main() {
  const { nreg } = parseArgs();

  if (!nreg) {
    console.error('❌ Помилка: не вказано nreg. Використайте --nreg=254к/96-вр');
    process.exit(1);
  }

  // Валідація конфігурації
  validateConfig();
  logConfig();

  console.log(`\n📋 Імпорт Конституції (nreg: ${nreg})\n`);

  // Читаємо canonical JSON
  const safeFilename = nregToSafeFilename(nreg);
  const canonicalPath = `${PATHS.canonical}/${safeFilename}.canonical.json`;

  console.log(`📖 Читаю canonical JSON: ${canonicalPath}`);

  let canonical: CanonicalDocument;
  try {
    const canonicalContent = await readFile(canonicalPath, 'utf-8');
    canonical = JSON.parse(canonicalContent);
    console.log(`✅ Canonical JSON прочитано\n`);
  } catch (error) {
    console.error(`❌ Помилка читання canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`\n💡 Спочатку створіть canonical JSON:`);
    console.error(`   pnpm tsx scripts/legislation/pilot_build_canonical.ts --nreg="${nreg}"`);
    process.exit(1);
  }

  // Виводимо інформацію про документ
  console.log('📊 Інформація про документ:');
  console.log(`   NREG: ${canonical.metadata.rada_nreg}`);
  console.log(`   Назва: ${canonical.metadata.title}`);
  console.log(`   Тип: ${canonical.metadata.document_type}`);
  console.log(`   Категорія: ${canonical.metadata.category}`);
  console.log(`   Статей: ${canonical.content.articles.length}`);
  console.log(`   Content hash: ${canonical.metadata.content_hash}`);
  console.log(`   R2 key: ${canonical.metadata.r2_key || 'не вказано'}\n`);

  // Спробуємо використати Supabase клієнт, якщо доступні env змінні
  try {
    const supabase = createLegislationSupabaseClient();
    console.log('✅ Supabase клієнт створено, виконую імпорт...\n');
    
    const result = await importCanonicalDocument(supabase, canonical);
    
    if (result.errors.length > 0) {
      console.error('\n⚠️  Помилки під час імпорту:');
      result.errors.forEach(err => console.error(`   - ${err}`));
    }
    
    if (result.documentInserted) {
      console.log(`\n✅ Імпорт метаданих завершено успішно!`);
      console.log(`   Документ: ${result.documentInserted ? '✅' : '❌'}`);
      console.log(`   Чанків вставлено: ${result.chunksInserted} (поки не реалізовано)`);
      console.log(`\n⚠️  ПРИМІТКА: Вставка chunks поки не реалізована.`);
      console.log(`   Потрібно: chunking + embeddings + R2 upload`);
    } else {
      console.log('\n⚠️  Імпорт завершено з помилками. Перевірте вивід вище.');
    }
  } catch (error) {
    // Якщо env змінні не встановлені, виводимо SQL для ручного виконання
    if (error instanceof Error && error.message.includes('Відсутні змінні оточення')) {
      console.log('⚠️  Supabase клієнт недоступний (відсутні env змінні)');
      console.log('   Генерую SQL команди для ручного виконання...\n');
      
      const importSQL = generateImportSQL(canonical);
      
      console.log('\n📝 SQL команди для імпорту:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(importSQL);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      console.log('💡 Виконайте SQL команди через:');
      console.log('   1. MCP: використайте mcp_supabase-legislation_RAG_execute_sql');
      console.log('   2. Supabase Dashboard: SQL Editor');
      console.log('   3. Supabase CLI: supabase db execute\n');
      
      console.log('💡 Альтернатива: встановіть env змінні для автоматичного імпорту:');
      console.log('   export SUPABASE_LEGISLATION_RAG_URL="https://pitabqxhkfvawkasrcyn.supabase.co"');
      console.log('   export SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY="your-key"\n');
    } else {
      throw error;
    }
  }
}

main().catch((error) => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

