/**
 * Script to apply legislation schema migration to the legislation Supabase project
 * 
 * This script uses the SUPABASE_LEGISLATION_URL and SUPABASE_LEGISLATION_SERVICE_ROLE_KEY
 * from .env.local to apply the schema migration SQL.
 * 
 * Usage:
 *   pnpm tsx scripts/apply_legislation_schema.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
dotenv.config({ path: '.env.local' });

const LEGISLATION_URL = process.env.SUPABASE_LEGISLATION_URL;
const LEGISLATION_KEY = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY;

if (!LEGISLATION_URL || !LEGISLATION_KEY) {
  throw new Error('Відсутні SUPABASE_LEGISLATION_URL або SUPABASE_LEGISLATION_SERVICE_ROLE_KEY');
}

// Extract project ID for logging
const getProjectId = (url: string): string => {
  const match = url.match(/https?:\/\/([^.]+)\.supabase\.co/);
  return match ? match[1] : 'unknown';
};

const legislationProjectId = getProjectId(LEGISLATION_URL);
console.log(`🔍 Applying schema to legislation project: ${legislationProjectId}`);

// Read the migration SQL file
const migrationPath = join(__dirname, '../supabase/migrations/20250110000000_migrate_legislation_schema.sql');
const migrationSQL = readFileSync(migrationPath, 'utf-8');

// Note: Supabase JS client doesn't support executing raw SQL directly
// This script provides instructions for manual application
console.log('\n⚠️  Supabase JS client cannot execute raw SQL directly.');
console.log('   Please apply the schema migration using one of these methods:\n');
console.log('   Option 1: Supabase Dashboard SQL Editor');
console.log(`   1. Go to: https://supabase.com/dashboard/project/${legislationProjectId}/sql`);
console.log('   2. Copy the contents of: supabase/migrations/20250110000000_migrate_legislation_schema.sql');
console.log('   3. Paste and execute in the SQL Editor\n');
console.log('   Option 2: Supabase CLI');
console.log('   supabase db push --project-ref ' + legislationProjectId + ' --file supabase/migrations/20250110000000_migrate_legislation_schema.sql\n');
console.log('   Option 3: psql (if you have direct database access)');
console.log(`   psql "postgresql://postgres:[PASSWORD]@db.${legislationProjectId}.supabase.co:5432/postgres" -f supabase/migrations/20250110000000_migrate_legislation_schema.sql\n`);

// Verify if tables already exist
const legislationClient = createClient(LEGISLATION_URL, LEGISLATION_KEY);

async function checkSchema() {
  console.log('🔍 Checking if schema already exists...\n');
  
  const requiredTables = ['legal_laws', 'legal_articles', 'legal_documents_storage'];
  const existingTables: string[] = [];
  const missingTables: string[] = [];
  
  for (const table of requiredTables) {
    try {
      const { error } = await legislationClient
        .from(table)
        .select('id', { count: 'exact', head: true });
      
      if (error && error.code === 'PGRST116') {
        missingTables.push(table);
      } else if (error) {
        console.error(`   ⚠️  Error checking ${table}:`, error.message);
      } else {
        existingTables.push(table);
      }
    } catch (err) {
      missingTables.push(table);
    }
  }
  
  if (existingTables.length > 0) {
    console.log(`   ✅ Existing tables: ${existingTables.join(', ')}`);
  }
  
  if (missingTables.length > 0) {
    console.log(`   ❌ Missing tables: ${missingTables.join(', ')}`);
    console.log('\n   Please apply the schema migration using one of the methods above.\n');
    process.exit(1);
  } else {
    console.log('   ✅ All required tables exist! Schema migration already applied.\n');
    process.exit(0);
  }
}

checkSchema().catch((error) => {
  console.error('❌ Error checking schema:', error);
  process.exit(1);
});

