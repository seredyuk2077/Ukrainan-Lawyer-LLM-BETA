#!/usr/bin/env node
/**
 * Operator/forensics: Lexery DB rollout path diagnostics.
 * Reports whether the current environment has a trustworthy rollout path for the
 * Lexery Legal Agent DB migration channel.
 *
 * Does NOT print secrets or full connection strings.
 *
 * Run:
 *   pnpm exec tsx scripts/lexery-legal-agent/tools/mm/check_lexery_db_rollout_path.ts
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(__dirname, '../../.env') });

const DOC_PROJECT_REF = 'bsiximytmpkjkzdlzzso';

export type RolloutVerdict =
  | 'ROLLOUT_PATH_OK'
  | 'ROLLOUT_PATH_MISMATCH'
  | 'ROLLOUT_PATH_UNVERIFIED'
  | 'NO_DIRECT_DB_CHANNEL'
  | 'NO_LEXERY_URL'
  | 'UNKNOWN';

export interface LocalSupabaseLinkage {
  source_file?: string;
  linked_project_ref?: string | null;
  inferred_project_ref_from_connection_string?: string | null;
  connection_string_present: boolean;
}

export interface LexeryRolloutReport {
  verdict: RolloutVerdict;
  lexery_url_present: boolean;
  lexery_url_masked: string;
  inferred_project_ref_from_url: string | null;
  documented_project_ref: string;
  local_supabase_linkage: LocalSupabaseLinkage;
  codex_mcp_project_ref: string | null;
  env_has_direct_postgres_dsn: boolean;
  recommendation: string;
}

export function maskUrl(url: string): string {
  if (!url || url.length < 12) return url ? '[masked]' : '';
  try {
    const u = new URL(url);
    const host = u.hostname;
    const first = host.split('.')[0] ?? '';
    if (first.length >= 4) {
      return `${u.protocol}//${first.slice(0, 4)}***.${host.slice(host.indexOf('.') + 1)}`;
    }
    return `${u.protocol}//***`;
  } catch {
    return '[masked]';
  }
}

export function inferProjectRefFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname;
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function hasDirectPostgresDsn(env: NodeJS.ProcessEnv): boolean {
  const keys = [
    'SUPABASE_DB_URL',
    'DATABASE_URL',
    'POSTGRES_URL',
    'SUPABASE_LEXERY_LEGAL_AGENT_DB_DB_URL',
  ];
  return keys.some((key) => {
    const value = env[key];
    return (
      typeof value === 'string' &&
      (value.startsWith('postgres://') || value.startsWith('postgresql://'))
    );
  });
}

export function readLocalSupabaseLinkage(cwd: string): LocalSupabaseLinkage {
  const inferRefFromConnectionString = (value: string | undefined): string | null => {
    if (!value) return null;
    try {
      const url = new URL(value);
      const user = decodeURIComponent(url.username || '');
      const userMatch = user.match(/^postgres\.([a-z0-9]+)$/i);
      if (userMatch?.[1]) return userMatch[1];
      const hostMatch = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
      if (hostMatch?.[1]) return hostMatch[1];
      return null;
    } catch {
      return null;
    }
  };

  const tempProjectRefPath = resolve(cwd, 'supabase/.temp/project-ref');
  const tempPoolerUrlPath = resolve(cwd, 'supabase/.temp/pooler-url');
  if (existsSync(tempProjectRefPath) || existsSync(tempPoolerUrlPath)) {
    try {
      const linkedProjectRef = existsSync(tempProjectRefPath)
        ? readFileSync(tempProjectRefPath, 'utf8').trim() || null
        : null;
      const poolerUrl = existsSync(tempPoolerUrlPath)
        ? readFileSync(tempPoolerUrlPath, 'utf8').trim() || undefined
        : undefined;
      return {
        source_file: existsSync(tempPoolerUrlPath)
          ? `${tempProjectRefPath} + ${tempPoolerUrlPath}`
          : tempProjectRefPath,
        linked_project_ref: linkedProjectRef,
        inferred_project_ref_from_connection_string: inferRefFromConnectionString(poolerUrl),
        connection_string_present: Boolean(poolerUrl),
      };
    } catch {
      return {
        source_file: tempProjectRefPath,
        linked_project_ref: null,
        inferred_project_ref_from_connection_string: null,
        connection_string_present: existsSync(tempPoolerUrlPath),
      };
    }
  }

  const jsonPath = resolve(cwd, '.supabase/config.json');
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
        project_id?: string;
        project_ref?: string;
        db?: { connection_string?: string };
      };
      const inferredRef = inferRefFromConnectionString(parsed.db?.connection_string);
      return {
        source_file: jsonPath,
        linked_project_ref: parsed.project_id ?? parsed.project_ref ?? inferredRef ?? null,
        inferred_project_ref_from_connection_string: inferredRef,
        connection_string_present: typeof parsed.db?.connection_string === 'string' && parsed.db.connection_string.length > 0,
      };
    } catch {
      return {
        source_file: jsonPath,
        linked_project_ref: null,
        inferred_project_ref_from_connection_string: null,
        connection_string_present: false,
      };
    }
  }

  const tomlPath = resolve(cwd, '.supabase/config.toml');
  if (existsSync(tomlPath)) {
    try {
      const raw = readFileSync(tomlPath, 'utf8');
      const match =
        raw.match(/project_id\s*=\s*["']([^"']+)["']/) ??
        raw.match(/project_ref\s*=\s*["']([^"']+)["']/);
      return {
        source_file: tomlPath,
        linked_project_ref: match?.[1] ?? null,
        inferred_project_ref_from_connection_string: null,
        connection_string_present: /connection_string\s*=/.test(raw),
      };
    } catch {
      return {
        source_file: tomlPath,
        linked_project_ref: null,
        inferred_project_ref_from_connection_string: null,
        connection_string_present: false,
      };
    }
  }

  return {
    linked_project_ref: null,
    inferred_project_ref_from_connection_string: null,
    connection_string_present: false,
  };
}

export function readCodexMcpProjectRef(homeDir: string | undefined): string | null {
  if (!homeDir) return null;
  const configPath = resolve(homeDir, '.codex/config.toml');
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    const blockMatch = raw.match(
      /\[mcp_servers\.supabase-lexery-legal-agent-db\][\s\S]*?url\s*=\s*"([^"]+)"/
    );
    if (!blockMatch) return null;
    const url = blockMatch[1];
    const refMatch = url.match(/project_ref=([a-z0-9]+)/i);
    return refMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function computeLexeryRolloutReport(params?: {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): LexeryRolloutReport {
  const cwd = params?.cwd ?? process.cwd();
  const homeDir = params?.homeDir ?? process.env.HOME;
  const env = params?.env ?? process.env;

  const lexeryUrl = env.SUPABASE_LEXERY_LEGAL_AGENT_DB_URL || env.SUPABASE_URL || '';
  const inferredRef = inferProjectRefFromUrl(lexeryUrl);
  const directDsn = hasDirectPostgresDsn(env);
  const localLinkage = readLocalSupabaseLinkage(cwd);
  const codexMcpRef = readCodexMcpProjectRef(homeDir);

  let verdict: RolloutVerdict = 'UNKNOWN';
  let recommendation = 'Inspect Supabase linkage and rollout channel before applying migrations.';

  if (!lexeryUrl) {
    verdict = 'NO_LEXERY_URL';
    recommendation =
      'Set SUPABASE_LEXERY_LEGAL_AGENT_DB_URL to the Lexery Legal Agent DB API URL before using this diagnostic.';
  } else if (
    inferredRef &&
    localLinkage.linked_project_ref &&
    localLinkage.linked_project_ref !== inferredRef
  ) {
    verdict = 'ROLLOUT_PATH_MISMATCH';
    recommendation =
      'Local .supabase linkage points to a different project than the Lexery DB URL. Do not trust repo-root "supabase db push" until linkage is corrected.';
  } else if (
    inferredRef &&
    localLinkage.linked_project_ref &&
    localLinkage.linked_project_ref === inferredRef
  ) {
    verdict = 'ROLLOUT_PATH_OK';
    recommendation =
      'Local Supabase linkage matches the Lexery DB URL project. Repo-local rollout path looks trustworthy.';
  } else if (directDsn) {
    verdict = 'ROLLOUT_PATH_OK';
    recommendation =
      'A direct Postgres DSN is present in env. A direct rollout channel exists, but confirm it targets the Lexery DB before writing.';
  } else if (localLinkage.connection_string_present) {
    verdict = 'ROLLOUT_PATH_UNVERIFIED';
    recommendation =
      'Local .supabase linkage exists but does not expose a verifiable project ref. Repo-root "supabase db push" is not trustworthy by default for the Lexery DB.';
  } else if (codexMcpRef && inferredRef && codexMcpRef === inferredRef) {
    verdict = 'NO_DIRECT_DB_CHANNEL';
    recommendation =
      'Codex MCP config references the correct Lexery project, but this environment does not expose a direct DB channel through CLI/env. Use the project-authorized rollout path with working auth.';
  } else {
    verdict = 'NO_DIRECT_DB_CHANNEL';
    recommendation =
      'Env exposes the Lexery API URL only. No verifiable direct DB channel is available from this workspace.';
  }

  return {
    verdict,
    lexery_url_present: Boolean(lexeryUrl),
    lexery_url_masked: maskUrl(lexeryUrl),
    inferred_project_ref_from_url: inferredRef,
    documented_project_ref: DOC_PROJECT_REF,
    local_supabase_linkage: localLinkage,
    codex_mcp_project_ref: codexMcpRef,
    env_has_direct_postgres_dsn: directDsn,
    recommendation,
  };
}

export function printLexeryRolloutReport(report: LexeryRolloutReport): void {
  console.log('--- Lexery DB rollout path check ---');
  console.log('Lexery API URL present:', report.lexery_url_present);
  console.log('Lexery API URL (masked):', report.lexery_url_masked);
  console.log('Inferred project ref from URL:', report.inferred_project_ref_from_url ?? '(none)');
  console.log('Documented Lexery project ref:', report.documented_project_ref);
  console.log(
    'Local .supabase linkage source:',
    report.local_supabase_linkage.source_file ?? '(none)'
  );
  console.log(
    'Local .supabase linked project ref:',
    report.local_supabase_linkage.linked_project_ref ?? '(none)'
  );
  console.log(
    'Local .supabase inferred project ref from connection string:',
    report.local_supabase_linkage.inferred_project_ref_from_connection_string ?? '(none)'
  );
  console.log(
    'Local .supabase connection string present:',
    report.local_supabase_linkage.connection_string_present
  );
  console.log('Codex MCP project ref:', report.codex_mcp_project_ref ?? '(none)');
  console.log('Env has direct Postgres DSN:', report.env_has_direct_postgres_dsn);
  console.log('Verdict:', report.verdict);
  console.log('Recommendation:', report.recommendation);
  console.log('---');
}

async function main(): Promise<void> {
  const report = computeLexeryRolloutReport();
  printLexeryRolloutReport(report);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
