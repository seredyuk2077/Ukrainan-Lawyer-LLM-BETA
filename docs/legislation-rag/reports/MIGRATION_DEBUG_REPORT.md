# Migration Debug Report

**Date:** 2025-01-XX  
**Purpose:** Diagnose and fix the failed legislation migration  
**Status:** 🔴 **CRITICAL ISSUE IDENTIFIED**

---

## Executive Summary

**ROOT CAUSE IDENTIFIED:** Both MCP servers (`supabase-core` and `supabase-legislation`) are pointing to the **SAME Supabase project**, which is why the migration appeared to succeed but no data was actually migrated to a separate project.

**Evidence:**
- Both MCP servers return identical project URL: `https://lhltmmzwvikdgxxakbcl.supabase.co`
- Both databases have identical table structures
- Both databases have identical row counts (see below)

---

## Step 0: Hard Verification (Current State)

### A) supabase-core MCP Verification

**Project URL:** `https://lhltmmzwvikdgxxakbcl.supabase.co`  
**Database:** `postgres`  
**User:** `postgres`  
**PostgreSQL Version:** `17.6 on aarch64-unknown-linux-gnu`

**Tables in public schema:**
- ✅ `legal_laws` - **47 rows**
- ✅ `legal_articles` - **6,642 rows**
- ✅ `legal_documents_storage` - **26 rows**
- ✅ `legal_consultations` - **2 rows**
- ✅ `legal_templates` - **2 rows**
- ✅ `response_cache` - **12 rows**
- `chat_sessions` - 43 rows (not for migration)
- `chat_messages` - 18 rows (not for migration)
- `app_ee0d6434e4_chat_sessions` - 0 rows (not for migration)
- `app_ee0d6434e4_chat_messages` - 0 rows (not for migration)
- `response_validations` - 0 rows (not for migration)

**Row Counts (Verified):**
```sql
legal_laws:              47 rows
legal_articles:        6,642 rows
legal_documents_storage: 26 rows
legal_consultations:       2 rows
legal_templates:          2 rows
response_cache:          12 rows
```

### B) supabase-legislation MCP Verification

**Project URL:** `https://lhltmmzwvikdgxxakbcl.supabase.co` ⚠️ **SAME AS CORE**  
**Database:** `postgres`  
**User:** `postgres`  
**PostgreSQL Version:** `17.6 on aarch64-unknown-linux-gnu` (identical)

**Tables in public schema:**
- ✅ `legal_laws` - **47 rows** (SAME AS CORE)
- ✅ `legal_articles` - **6,642 rows** (SAME AS CORE)
- ✅ `legal_documents_storage` - **26 rows** (SAME AS CORE)
- ✅ `legal_consultations` - **2 rows** (SAME AS CORE)
- ✅ `legal_templates` - **2 rows** (SAME AS CORE)
- ✅ `response_cache` - **12 rows** (SAME AS CORE)
- All other tables identical to core

**Row Counts (Verified):**
```sql
legal_laws:              47 rows  ← IDENTICAL TO CORE
legal_articles:        6,642 rows  ← IDENTICAL TO CORE
legal_documents_storage: 26 rows  ← IDENTICAL TO CORE
legal_consultations:       2 rows  ← IDENTICAL TO CORE
legal_templates:          2 rows  ← IDENTICAL TO CORE
response_cache:          12 rows  ← IDENTICAL TO CORE
```

**Conclusion:** Both MCP servers are querying the **exact same database**. No migration occurred because there is no separate legislation project.

---

## Step 1: Diagnosis - Why MCP Migration Did Nothing

### A) Wrong project_ref / Wrong MCP Target ✅ CONFIRMED

**Issue:** The MCP server configuration for `supabase-legislation` is pointing to the same project as `supabase-core`.

**Evidence:**
1. Both `get_project_url()` calls return: `https://lhltmmzwvikdgxxakbcl.supabase.co`
2. Both databases return identical `current_database()`, `current_user`, and `version()`
3. Both databases have identical table structures and row counts

**Root Cause:** MCP server configuration in `~/.cursor/mcp.json` has both servers configured with the same project reference/URL.

**Fix Required:**
1. Identify the correct Supabase project URL for the legislation project
2. Update `~/.cursor/mcp.json` to point `supabase-legislation` MCP to the correct project
3. Verify the fix by checking project URLs are different

### B) MCP Permissions / Role Limitation ✅ TESTED

**Test:** Attempted to create a test table via MCP DDL:
```sql
CREATE TABLE IF NOT EXISTS _migration_test_table (id INTEGER PRIMARY KEY, test_value TEXT);
```

**Result:** ✅ **SUCCESS** - DDL operations work via MCP. The MCP has sufficient permissions to create tables, indexes, functions, and triggers.

**Conclusion:** Permissions are not the issue. The problem is purely the wrong project target.

### C) Schema Not Applied ✅ VERIFIED

**Migration SQL File Exists:**
- ✅ `supabase/migrations/20250110000000_migrate_legislation_schema.sql` exists (630 lines)
- ✅ Contains complete schema: tables, indexes, functions, triggers

**Migration Script Exists:**
- ✅ `scripts/migrate_legislation_data.ts` exists (305 lines)
- ✅ Expects environment variables: `SUPABASE_LEGISLATION_URL` and `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY`

**Issue:** The migration script was likely never executed, OR it was executed but pointed to the wrong project (same as core) due to incorrect environment variables.

### D) Wrong Environment Variables ✅ LIKELY CAUSE

**Expected Environment Variables:**
- `SUPABASE_CORE_URL` or `VITE_SUPABASE_URL`
- `SUPABASE_CORE_SERVICE_ROLE_KEY`
- `SUPABASE_LEGISLATION_URL` ← **Must be different from core**
- `SUPABASE_LEGISLATION_SERVICE_ROLE_KEY` ← **Must be different from core**

**Issue:** If `SUPABASE_LEGISLATION_URL` was set to the same value as `SUPABASE_CORE_URL`, the migration script would have copied data from core to core (no-op).

**Verification Needed:**
- Check `.env.local` or environment configuration
- Ensure `SUPABASE_LEGISLATION_URL` points to a **different** Supabase project

### E) Errors Were Swallowed ✅ POSSIBLE

**Migration Script Error Handling:**
- The script uses try/catch and logs errors
- However, if both URLs pointed to the same project, the script would succeed (copying data to itself)
- No error would be thrown, making it appear successful

---

## Step 2: Implementation Plan

### Option 1: Fix MCP Configuration (Recommended)

**Prerequisites:**
1. Identify the correct Supabase project for legislation
2. Get the project URL and service role key for that project
3. Update `~/.cursor/mcp.json` to point `supabase-legislation` MCP to the correct project

**Steps:**
1. Fix MCP configuration
2. Verify both MCPs point to different projects
3. Apply schema migration via MCP SQL
4. Run data migration script with correct environment variables
5. Verify migration success

### Option 2: Use Migration Script Directly (If MCP Cannot Be Fixed)

**Prerequisites:**
1. Set correct environment variables in `.env.local`:
   ```
   SUPABASE_CORE_URL=https://lhltmmzwvikdgxxakbcl.supabase.co
   SUPABASE_CORE_SERVICE_ROLE_KEY=<core-service-key>
   SUPABASE_LEGISLATION_URL=<DIFFERENT-legislation-project-url>
   SUPABASE_LEGISLATION_SERVICE_ROLE_KEY=<legislation-service-key>
   ```

2. Ensure the legislation project exists and is accessible

**Steps:**
1. Apply schema migration SQL to legislation project (via Supabase Dashboard SQL Editor or CLI)
2. Run migration script: `pnpm tsx scripts/migrate_legislation_data.ts`
3. Verify migration success

---

## Step 3: Required Actions

### Immediate Actions:

1. **Identify Legislation Project:**
   - Check Supabase Dashboard for a separate project
   - If it doesn't exist, create a new Supabase project for legislation
   - Note the project URL and service role key

2. **Fix MCP Configuration:**
   - Edit `~/.cursor/mcp.json`
   - Update `supabase-legislation` MCP server configuration with correct project reference
   - Verify fix by checking project URLs are different

3. **Verify Environment Variables:**
   - Check `.env.local` or environment configuration
   - Ensure `SUPABASE_LEGISLATION_URL` is set and different from core

4. **Apply Schema Migration:**
   - Use MCP `apply_migration` or execute SQL file directly
   - Verify tables are created in legislation project

5. **Run Data Migration:**
   - Execute `scripts/migrate_legislation_data.ts`
   - Monitor for errors
   - Verify row counts match

6. **Post-Migration Verification:**
   - Compare row counts between core and legislation
   - Sample random IDs to verify data integrity
   - Test application functionality

---

## Step 4: Migration Script Improvements

### Current Script Issues:
- No validation that core and legislation URLs are different
- No explicit logging of which project it's connecting to (without secrets)
- Could silently succeed if pointing to same project

### Recommended Improvements:

1. **Add URL Validation:**
   ```typescript
   if (CORE_URL === LEGISLATION_URL) {
     throw new Error('SUPABASE_CORE_URL and SUPABASE_LEGISLATION_URL must be different!');
   }
   ```

2. **Add Connection Logging (without secrets):**
   ```typescript
   console.log('CONNECTED TO CORE: ' + CORE_URL.replace(/https?:\/\/([^.]+)\..*/, '$1'));
   console.log('CONNECTED TO LEGISLATION: ' + LEGISLATION_URL.replace(/https?:\/\/([^.]+)\..*/, '$1'));
   ```

3. **Add Pre-Migration Checks:**
   - Verify legislation project has no existing data (or prompt for confirmation)
   - Verify schema exists before data migration
   - Exit non-zero on any failure

---

## Evidence Summary

| Check | supabase-core | supabase-legislation | Status |
|-------|---------------|---------------------|--------|
| Project URL | `lhltmmzwvikdgxxakbcl.supabase.co` | `lhltmmzwvikdgxxakbcl.supabase.co` | ❌ **SAME** |
| Database Name | `postgres` | `postgres` | ❌ **SAME** |
| legal_laws rows | 47 | 47 | ❌ **SAME** |
| legal_articles rows | 6,642 | 6,642 | ❌ **SAME** |
| legal_documents_storage rows | 26 | 26 | ❌ **SAME** |
| DDL Permissions | ✅ Works | ✅ Works | ✅ OK |
| Schema Migration File | ✅ Exists | ❌ Not Applied | ⚠️ **NEEDS ACTION** |
| Data Migration Script | ✅ Exists | ❌ Not Executed | ⚠️ **NEEDS ACTION** |

---

## Next Steps

### Immediate Actions Required:

1. **Identify or Create Legislation Project:**
   - Check Supabase Dashboard: https://supabase.com/dashboard
   - Look for a project named "legislation" or similar
   - If it doesn't exist, create a new Supabase project for legislation data
   - Note the project URL (format: `https://<project-ref>.supabase.co`)
   - Get the service role key from Project Settings → API

2. **Fix MCP Configuration:**
   - Edit `~/.cursor/mcp.json`
   - Find the `supabase-legislation` MCP server configuration
   - Update it to point to the correct legislation project
   - Verify by checking that `get_project_url()` returns different URLs for core vs legislation

3. **Set Environment Variables:**
   - Create or update `.env.local` in the project root:
     ```
     SUPABASE_CORE_URL=https://lhltmmzwvikdgxxakbcl.supabase.co
     SUPABASE_CORE_SERVICE_ROLE_KEY=<your-core-service-key>
     SUPABASE_LEGISLATION_URL=https://<legislation-project-ref>.supabase.co
     SUPABASE_LEGISLATION_SERVICE_ROLE_KEY=<your-legislation-service-key>
     ```
   - **CRITICAL:** Ensure `SUPABASE_LEGISLATION_URL` is DIFFERENT from `SUPABASE_CORE_URL`

4. **Apply Schema Migration:**
   - Option A (via MCP, after fixing config):
     ```bash
     # After MCP config is fixed, the schema can be applied via MCP apply_migration
     ```
   - Option B (via Supabase Dashboard):
     - Go to SQL Editor in the legislation project
     - Copy contents of `supabase/migrations/20250110000000_migrate_legislation_schema.sql`
     - Execute the SQL
   - Option C (via Supabase CLI):
     ```bash
     supabase db push --project-ref <legislation-project-ref> --file supabase/migrations/20250110000000_migrate_legislation_schema.sql
     ```

5. **Run Data Migration:**
   ```bash
   pnpm tsx scripts/migrate_legislation_data.ts
   ```
   - The improved script will:
     - Verify core and legislation URLs are different
     - Check that schema exists in legislation project
     - Migrate data with progress logging
     - Validate row counts and sample data

6. **Verify Success:**
   - Use MCP to list tables in legislation project
   - Verify row counts match core
   - Sample random IDs to verify data integrity

---

## Migration Script Improvements Made

The migration script (`scripts/migrate_legislation_data.ts`) has been improved with:

1. ✅ **URL Validation:** Fails immediately if core and legislation URLs are the same
2. ✅ **Project ID Logging:** Shows which projects are connected (without exposing secrets)
3. ✅ **Schema Verification:** Checks that required tables exist before data migration
4. ✅ **Better Error Messages:** Clear instructions when validation fails

---

## Conclusion

The migration failed because both MCP servers are configured to point to the same Supabase project (`lhltmmzwvikdgxxakbcl.supabase.co`). 

**Current State:**
- ✅ Schema migration SQL file exists and is correct
- ✅ Data migration script exists and has been improved with safety checks
- ✅ Extensions are installed in the current project
- ✅ Tables exist in the current project (but this is the "core" project, not a separate legislation project)
- ❌ MCP configuration points both servers to the same project
- ❌ No separate legislation project has been identified/created

**Required Actions:**
1. Create or identify the legislation Supabase project
2. Fix MCP configuration to point to the correct project
3. Set environment variables with correct legislation project URL
4. Apply schema migration to legislation project
5. Run data migration script

**Critical:** The migration script will now fail fast with a clear error if both URLs point to the same project, preventing silent failures.

---

## Summary: What Was Wrong, What Was Fixed, How to Re-run

### What Was Wrong:

1. **Root Cause:** Both MCP servers (`supabase-core` and `supabase-legislation`) were configured to point to the same Supabase project (`lhltmmzwvikdgxxakbcl.supabase.co`). This meant:
   - Any "migration" operations were actually operating on the same database
   - No data was copied to a separate legislation project
   - The migration appeared to succeed but nothing actually happened

2. **Secondary Issues:**
   - Migration script had no validation to detect same-project scenario
   - No schema verification before data migration
   - Silent failures possible if environment variables pointed to same project

### What Was Fixed:

1. **Migration Script Improvements:**
   - ✅ Added URL validation that fails immediately if core and legislation URLs are identical
   - ✅ Added project ID logging (shows which projects without exposing secrets)
   - ✅ Added schema verification before data migration
   - ✅ Better error messages with clear instructions

2. **Documentation:**
   - ✅ Created comprehensive debug report with evidence
   - ✅ Documented exact row counts from both projects
   - ✅ Provided clear action plan for fixing MCP configuration
   - ✅ Listed all required steps for successful migration

### How to Re-run the Migration:

**Prerequisites:**
1. Create or identify the legislation Supabase project
2. Fix MCP configuration in `~/.cursor/mcp.json`
3. Set environment variables in `.env.local`

**Steps:**

1. **Verify MCP Configuration:**
   ```bash
   # Both MCPs should return different project URLs
   # Use MCP tools to verify:
   # - supabase-core should point to: lhltmmzwvikdgxxakbcl.supabase.co
   # - supabase-legislation should point to: <different-project>.supabase.co
   ```

2. **Set Environment Variables:**
   ```bash
   # In .env.local:
   SUPABASE_CORE_URL=https://lhltmmzwvikdgxxakbcl.supabase.co
   SUPABASE_CORE_SERVICE_ROLE_KEY=<core-service-key>
   SUPABASE_LEGISLATION_URL=https://<legislation-project>.supabase.co
   SUPABASE_LEGISLATION_SERVICE_ROLE_KEY=<legislation-service-key>
   ```

3. **Apply Schema Migration:**
   - Via Supabase Dashboard SQL Editor (recommended for first-time setup)
   - Or via MCP `apply_migration` after config is fixed
   - SQL file: `supabase/migrations/20250110000000_migrate_legislation_schema.sql`

4. **Run Data Migration:**
   ```bash
   pnpm tsx scripts/migrate_legislation_data.ts
   ```
   
   The script will:
   - ✅ Verify URLs are different (fail fast if same)
   - ✅ Check schema exists in legislation project
   - ✅ Migrate data in dependency order
   - ✅ Validate row counts
   - ✅ Sample random IDs for integrity check

5. **Verify Success:**
   ```bash
   # Use MCP to verify:
   # - List tables in legislation project
   # - Check row counts match core
   # - Sample random records
   ```

**Expected Results:**
- `legal_laws`: 47 rows
- `legal_articles`: 6,642 rows
- `legal_documents_storage`: 26 rows
- `legal_consultations`: 2 rows
- `legal_templates`: 2 rows
- `response_cache`: 12 rows (optional)

**If Migration Fails:**
- Check error messages (improved script provides clear guidance)
- Verify MCP configuration points to different projects
- Verify environment variables are set correctly
- Verify schema exists in legislation project
- Check service role keys have correct permissions

---

## Files Modified/Created

1. **MIGRATION_DEBUG_REPORT.md** (NEW) - Comprehensive diagnosis and action plan
2. **scripts/migrate_legislation_data.ts** (IMPROVED) - Added safety checks and validation
3. **supabase/migrations/20250110000000_migrate_legislation_schema.sql** (EXISTS) - Schema migration SQL

---

**Status:** ✅ Diagnosis complete, script improved. 

**UPDATE:** Environment variables are correctly configured:
- Core: `lhltmmzwvikdgxxakbcl.supabase.co` ✅
- Legislation: `pitabqxhkfvawkasrcyn.supabase.co` ✅ (different project)

**Current Issue:** PostgREST schema cache error (PGRST205) when writing to legislation project. Tables exist (schema check passes), but PostgREST cannot find them in its cache.

**Solution:** Refresh PostgREST schema cache via Supabase Dashboard:
1. Go to: https://supabase.com/dashboard/project/pitabqxhkfvawkasrcyn/api/rest
2. Click "Reload schema" or wait 1-2 minutes for automatic cache refresh
3. Then re-run migration script: `pnpm tsx scripts/migrate_legislation_data.ts`

