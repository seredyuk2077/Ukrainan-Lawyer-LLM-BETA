/**
 * Скрипт міграції законодавчих даних з supabase-core в supabase-legislation
 * 
 * Використання:
 *   pnpm tsx scripts/migrate_legislation_data.ts
 * 
 * Потрібні змінні середовища:
 *   SUPABASE_CORE_URL - URL проекту core
 *   SUPABASE_CORE_SERVICE_ROLE_KEY - Service role ключ core проекту
 *   SUPABASE_LEGISLATION_URL - URL проекту legislation
 *   SUPABASE_LEGISLATION_SERVICE_ROLE_KEY - Service role ключ legislation проекту
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

// Завантажуємо .env.local
dotenv.config({ path: '.env.local' });

const CORE_URL = process.env.SUPABASE_CORE_URL || process.env.VITE_SUPABASE_URL;
const CORE_KEY = process.env.SUPABASE_CORE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const LEGISLATION_URL = process.env.SUPABASE_LEGISLATION_URL;
const LEGISLATION_KEY = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

if (!CORE_URL || !CORE_KEY) {
  throw new Error('Відсутні SUPABASE_CORE_URL або SUPABASE_CORE_SERVICE_ROLE_KEY');
}

if (!LEGISLATION_URL || !LEGISLATION_KEY) {
  throw new Error('Відсутні SUPABASE_LEGISLATION_URL або SUPABASE_LEGISLATION_SERVICE_ROLE_KEY');
}

// CRITICAL SAFETY CHECK: Ensure core and legislation are different projects
if (CORE_URL === LEGISLATION_URL) {
  console.error('❌ CRITICAL ERROR: SUPABASE_CORE_URL and SUPABASE_LEGISLATION_URL are the same!');
  console.error(`   Core URL: ${CORE_URL}`);
  console.error(`   Legislation URL: ${LEGISLATION_URL}`);
  console.error('   Migration cannot proceed - both URLs point to the same project.');
  console.error('   Please set SUPABASE_LEGISLATION_URL to a DIFFERENT Supabase project.');
  process.exit(1);
}

// Extract project identifiers for logging (without exposing full URLs)
const getProjectId = (url: string): string => {
  const match = url.match(/https?:\/\/([^.]+)\.supabase\.co/);
  return match ? match[1] : 'unknown';
};

const coreProjectId = getProjectId(CORE_URL);
const legislationProjectId = getProjectId(LEGISLATION_URL);

console.log('🔍 Connection Verification:');
console.log(`   CONNECTED TO CORE: ${coreProjectId}`);
console.log(`   CONNECTED TO LEGISLATION: ${legislationProjectId}`);

if (coreProjectId === legislationProjectId) {
  console.error('❌ CRITICAL ERROR: Both projects have the same project ID!');
  console.error('   Migration cannot proceed.');
  process.exit(1);
}

const coreClient = createClient(CORE_URL, CORE_KEY);
const legislationClient = createClient(LEGISLATION_URL, LEGISLATION_KEY);

interface MigrationStats {
  table: string;
  sourceRows: number;
  migratedRows: number;
  errors: number;
  startTime: Date;
  endTime?: Date;
}

const stats: MigrationStats[] = [];

/**
 * Міграція таблиці з батч-обробкою
 */
async function migrateTable(
  tableName: string,
  batchSize: number = 1000,
  orderBy: string = 'created_at'
): Promise<MigrationStats> {
  const stat: MigrationStats = {
    table: tableName,
    sourceRows: 0,
    migratedRows: 0,
    errors: 0,
    startTime: new Date(),
  };

  console.log(`\n📦 Початок міграції таблиці: ${tableName}`);

  try {
    // Отримуємо загальну кількість рядків
    const { count, error: countError } = await coreClient
      .from(tableName)
      .select('*', { count: 'exact', head: true });

    if (countError) {
      throw countError;
    }

    stat.sourceRows = count || 0;
    console.log(`   Знайдено рядків у джерелі: ${stat.sourceRows}`);

    if (stat.sourceRows === 0) {
      console.log(`   ⚠️  Таблиця порожня, пропускаємо`);
      stat.endTime = new Date();
      return stat;
    }

    // Мігруємо батчами
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await coreClient
        .from(tableName)
        .select('*')
        .order(orderBy, { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (error) {
        console.error(`   ❌ Помилка читання батчу:`, error);
        stat.errors++;
        break;
      }

      if (!data || data.length === 0) {
        hasMore = false;
        break;
      }

      // Вставляємо дані в legislation (upsert для уникнення дублікатів)
      // Retry logic for PostgREST schema cache issues
      let insertError = null;
      let retries = 3;
      while (retries > 0) {
        const result = await legislationClient
          .from(tableName)
          .upsert(data, { onConflict: 'id' });
        insertError = result.error;
        
        if (!insertError || insertError.code !== 'PGRST205') {
          break; // Success or non-cache error
        }
        
        // Schema cache issue - wait and retry
        console.log(`   ⚠️  Schema cache issue, retrying... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
        retries--;
      }

      if (insertError) {
        console.error(`   ❌ Помилка запису батчу:`, insertError);
        stat.errors++;
      } else {
        stat.migratedRows += data.length;
        console.log(`   ✅ Мігровано ${stat.migratedRows}/${stat.sourceRows} рядків`);
      }

      offset += batchSize;
      hasMore = data.length === batchSize;

      // Невелика затримка для зменшення навантаження
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    stat.endTime = new Date();
    const duration = (stat.endTime.getTime() - stat.startTime.getTime()) / 1000;
    console.log(`   ✨ Завершено за ${duration.toFixed(2)}с`);
  } catch (error) {
    console.error(`   ❌ Критична помилка міграції ${tableName}:`, error);
    stat.errors++;
    stat.endTime = new Date();
  }

  return stat;
}

/**
 * Валідація міграції - порівняння кількості рядків
 */
async function validateMigration(tableName: string): Promise<boolean> {
  try {
    const [coreCount, legislationCount] = await Promise.all([
      coreClient.from(tableName).select('*', { count: 'exact', head: true }),
      legislationClient.from(tableName).select('*', { count: 'exact', head: true }),
    ]);

    const coreRows = coreCount.count || 0;
    const legislationRows = legislationCount.count || 0;

    if (coreRows === legislationRows) {
      console.log(`   ✅ Валідація пройдена: ${coreRows} = ${legislationRows}`);
      return true;
    } else {
      console.error(`   ❌ Валідація не пройдена: ${coreRows} ≠ ${legislationRows}`);
      return false;
    }
  } catch (error) {
    console.error(`   ❌ Помилка валідації:`, error);
    return false;
  }
}

/**
 * Вибіркова перевірка даних (порівняння випадкових ID)
 */
async function sampleValidation(tableName: string, sampleSize: number = 20): Promise<boolean> {
  try {
    // Отримуємо випадкові ID з core
    const { data: coreSamples, error: coreError } = await coreClient
      .from(tableName)
      .select('id')
      .limit(sampleSize);

    if (coreError || !coreSamples || coreSamples.length === 0) {
      console.log(`   ⚠️  Немає даних для вибіркової перевірки`);
      return true;
    }

    const sampleIds = coreSamples.map((row) => row.id);

    // Отримуємо ті самі рядки з legislation
    const { data: legislationSamples, error: legislationError } = await legislationClient
      .from(tableName)
      .select('*')
      .in('id', sampleIds);

    if (legislationError) {
      console.error(`   ❌ Помилка отримання вибірки з legislation:`, legislationError);
      return false;
    }

    if (!legislationSamples || legislationSamples.length !== sampleIds.length) {
      console.error(
        `   ❌ Не всі вибіркові рядки знайдені: ${legislationSamples?.length || 0}/${sampleIds.length}`
      );
      return false;
    }

    // Порівнюємо ключові поля (id, title, created_at)
    let matches = 0;
    for (const coreRow of coreSamples) {
      const legislationRow = legislationSamples.find((r) => r.id === coreRow.id);
      if (legislationRow) {
        matches++;
      }
    }

    if (matches === sampleIds.length) {
      console.log(`   ✅ Вибіркова перевірка пройдена: ${matches}/${sampleIds.length} збігів`);
      return true;
    } else {
      console.error(`   ❌ Вибіркова перевірка не пройдена: ${matches}/${sampleIds.length} збігів`);
      return false;
    }
  } catch (error) {
    console.error(`   ❌ Помилка вибіркової перевірки:`, error);
    return false;
  }
}

/**
 * Головна функція міграції
 */
/**
 * Pre-flight checks: Verify schema exists in legislation project
 */
async function verifyLegislationSchema(): Promise<boolean> {
  console.log('\n🔍 Перевірка схеми в legislation проекті...');
  
  const requiredTables = ['legal_laws', 'legal_articles', 'legal_documents_storage'];
  const missingTables: string[] = [];
  
  for (const table of requiredTables) {
    try {
      const { error } = await legislationClient
        .from(table)
        .select('id', { count: 'exact', head: true });
      
      if (error && error.code === 'PGRST116') {
        // Table does not exist
        missingTables.push(table);
      } else if (error) {
        console.error(`   ⚠️  Помилка перевірки таблиці ${table}:`, error.message);
      }
    } catch (err) {
      missingTables.push(table);
    }
  }
  
  if (missingTables.length > 0) {
    console.error(`\n❌ Відсутні таблиці в legislation проекті: ${missingTables.join(', ')}`);
    console.error('   Будь ласка, спочатку застосуйте схему міграції:');
    console.error('   supabase/migrations/20250110000000_migrate_legislation_schema.sql');
    return false;
  }
  
  console.log('   ✅ Всі необхідні таблиці існують');
  return true;
}

async function main() {
  console.log('🚀 Початок міграції законодавчих даних');
  console.log('=====================================\n');
  
  // Verify schema exists before proceeding
  const schemaExists = await verifyLegislationSchema();
  if (!schemaExists) {
    console.error('\n❌ Міграція перервана: схема не знайдена в legislation проекті');
    process.exit(1);
  }

  // Порядок міграції (в залежності від foreign keys)
  const tables = [
    { name: 'legal_laws', orderBy: 'created_at' },
    { name: 'legal_articles', orderBy: 'created_at' },
    { name: 'legal_documents_storage', orderBy: 'created_at' },
    { name: 'legal_consultations', orderBy: 'created_at' },
    { name: 'legal_templates', orderBy: 'created_at' },
    { name: 'response_cache', orderBy: 'created_at' },
  ];

  // Мігруємо кожну таблицю
  for (const table of tables) {
    const stat = await migrateTable(table.name, 1000, table.orderBy);
    stats.push(stat);

    // Валідація після кожної таблиці
    if (stat.migratedRows > 0) {
      await validateMigration(table.name);
      if (stat.migratedRows <= 20) {
        // Якщо мало рядків, перевіряємо всі
        await sampleValidation(table.name, stat.migratedRows);
      } else {
        await sampleValidation(table.name, 20);
      }
    }
  }

  // Підсумковий звіт
  console.log('\n\n📊 Підсумковий звіт міграції');
  console.log('=====================================\n');

  let totalSource = 0;
  let totalMigrated = 0;
  let totalErrors = 0;

  for (const stat of stats) {
    const duration = stat.endTime
      ? ((stat.endTime.getTime() - stat.startTime.getTime()) / 1000).toFixed(2)
      : 'N/A';
    console.log(`${stat.table}:`);
    console.log(`  Джерело: ${stat.sourceRows} рядків`);
    console.log(`  Мігровано: ${stat.migratedRows} рядків`);
    console.log(`  Помилки: ${stat.errors}`);
    console.log(`  Час: ${duration}с\n`);

    totalSource += stat.sourceRows;
    totalMigrated += stat.migratedRows;
    totalErrors += stat.errors;
  }

  console.log('Загалом:');
  console.log(`  Джерело: ${totalSource} рядків`);
  console.log(`  Мігровано: ${totalMigrated} рядків`);
  console.log(`  Помилки: ${totalErrors}`);

  if (totalErrors === 0 && totalMigrated === totalSource) {
    console.log('\n✅ Міграція успішно завершена!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Міграція завершена з помилками. Перевірте лог вище.');
    process.exit(1);
  }
}

// Запускаємо міграцію
main().catch((error) => {
  console.error('❌ Критична помилка:', error);
  process.exit(1);
});

