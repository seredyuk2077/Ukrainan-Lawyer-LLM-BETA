import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeLexeryRolloutReport,
  inferProjectRefFromUrl,
  maskUrl,
} from './check_lexery_db_rollout_path.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'lexery-rollout-check-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testInferProjectRefFromUrl(): void {
  assert(
    inferProjectRefFromUrl('https://bsiximytmpkjkzdlzzso.supabase.co') === 'bsiximytmpkjkzdlzzso',
    'project ref must be inferred from Supabase API URL'
  );
  assert(inferProjectRefFromUrl('not-a-url') === null, 'invalid URL should return null');
  console.log('[OK] inferProjectRefFromUrl');
}

function testMaskUrl(): void {
  const masked = maskUrl('https://bsiximytmpkjkzdlzzso.supabase.co');
  assert(masked.includes('http'), 'masked URL keeps protocol');
  assert(!masked.includes('bsiximytmpkjkzdlzzso.supabase.co'), 'masked URL must not reveal full host');
  console.log('[OK] maskUrl');
}

function testUnverifiedWhenOnlyOpaqueLocalLinkExists(): void {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.supabase'));
    writeFileSync(
      join(dir, '.supabase/config.json'),
      JSON.stringify({ db: { connection_string: 'postgresql://user:secret@aws-1-eu-west-1.pooler.supabase.com:6543/postgres' } })
    );
    const report = computeLexeryRolloutReport({
      cwd: dir,
      homeDir: dir,
      env: {
        SUPABASE_LEXERY_LEGAL_AGENT_DB_URL: 'https://bsiximytmpkjkzdlzzso.supabase.co',
      } as NodeJS.ProcessEnv,
    });
    assert(report.verdict === 'ROLLOUT_PATH_UNVERIFIED', 'opaque local link should be unverified');
  });
  console.log('[OK] opaque local linkage -> ROLLOUT_PATH_UNVERIFIED');
}

function testMismatchWhenProjectRefsDiffer(): void {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.supabase'));
    writeFileSync(
      join(dir, '.supabase/config.toml'),
      'project_id = "differentprojectref"\n'
    );
    const report = computeLexeryRolloutReport({
      cwd: dir,
      homeDir: dir,
      env: {
        SUPABASE_LEXERY_LEGAL_AGENT_DB_URL: 'https://bsiximytmpkjkzdlzzso.supabase.co',
      } as NodeJS.ProcessEnv,
    });
    assert(report.verdict === 'ROLLOUT_PATH_MISMATCH', 'different local linked project must be mismatch');
  });
  console.log('[OK] local linked project mismatch -> ROLLOUT_PATH_MISMATCH');
}

function testSupabaseTempLinkagePreferredWhenMatching(): void {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'supabase/.temp'), { recursive: true });
    mkdirSync(join(dir, '.supabase'));
    writeFileSync(join(dir, 'supabase/.temp/project-ref'), 'bsiximytmpkjkzdlzzso\n');
    writeFileSync(
      join(dir, 'supabase/.temp/pooler-url'),
      'postgresql://postgres.bsiximytmpkjkzdlzzso:[YOUR-PASSWORD]@aws-1-eu-central-1.pooler.supabase.com:6543/postgres\n'
    );
    writeFileSync(join(dir, '.supabase/config.toml'), 'project_id = "differentprojectref"\n');
    const report = computeLexeryRolloutReport({
      cwd: dir,
      homeDir: dir,
      env: {
        SUPABASE_LEXERY_LEGAL_AGENT_DB_URL: 'https://bsiximytmpkjkzdlzzso.supabase.co',
      } as NodeJS.ProcessEnv,
    });
    assert(report.verdict === 'ROLLOUT_PATH_OK', 'supabase/.temp linkage should take precedence when it matches');
    assert(
      report.local_supabase_linkage.linked_project_ref === 'bsiximytmpkjkzdlzzso',
      'project ref should come from supabase/.temp/project-ref'
    );
  });
  console.log('[OK] supabase/.temp linkage preferred over stale .supabase config');
}

function testMismatchWhenConnectionStringProjectRefDiffers(): void {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.supabase'));
    writeFileSync(
      join(dir, '.supabase/config.json'),
      JSON.stringify({
        db: {
          connection_string:
            'postgresql://postgres.otherprojectref:secret@aws-1-eu-west-1.supabase.com:5432/postgres',
        },
      })
    );
    const report = computeLexeryRolloutReport({
      cwd: dir,
      homeDir: dir,
      env: {
        SUPABASE_LEXERY_LEGAL_AGENT_DB_URL: 'https://bsiximytmpkjkzdlzzso.supabase.co',
      } as NodeJS.ProcessEnv,
    });
    assert(
      report.verdict === 'ROLLOUT_PATH_MISMATCH',
      'connection string inferred project mismatch must be detected'
    );
    assert(
      report.local_supabase_linkage.inferred_project_ref_from_connection_string === 'otherprojectref',
      'connection string project ref should be inferred from postgres.<ref> username'
    );
  });
  console.log('[OK] connection string inferred project mismatch -> ROLLOUT_PATH_MISMATCH');
}

function testNoDirectDbChannelWhenOnlyMcpMatches(): void {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.codex'));
    writeFileSync(
      join(dir, '.codex/config.toml'),
      '[mcp_servers.supabase-lexery-legal-agent-db]\nurl = "https://mcp.supabase.com/mcp?project_ref=bsiximytmpkjkzdlzzso"\n'
    );
    const report = computeLexeryRolloutReport({
      cwd: dir,
      homeDir: dir,
      env: {
        SUPABASE_LEXERY_LEGAL_AGENT_DB_URL: 'https://bsiximytmpkjkzdlzzso.supabase.co',
      } as NodeJS.ProcessEnv,
    });
    assert(report.verdict === 'NO_DIRECT_DB_CHANNEL', 'matching MCP without DB channel should remain no direct DB channel');
  });
  console.log('[OK] matching MCP only -> NO_DIRECT_DB_CHANNEL');
}

function main(): void {
  console.log('check_lexery_db_rollout_path unit tests\n');
  testInferProjectRefFromUrl();
  testMaskUrl();
  testUnverifiedWhenOnlyOpaqueLocalLinkExists();
  testMismatchWhenProjectRefsDiffer();
  testSupabaseTempLinkagePreferredWhenMatching();
  testMismatchWhenConnectionStringProjectRefDiffers();
  testNoDirectDbChannelWhenOnlyMcpMatches();
  console.log('\nAll rollout path unit tests passed.');
}

main();
