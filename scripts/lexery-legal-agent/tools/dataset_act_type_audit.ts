#!/usr/bin/env node
/**
 * Phase 1.1 — Act-type audit snapshot: deterministic 20 acts from legislation_documents (read-only).
 * Distribution: ≥5 PRIMARY_LAW, ≥5 SECONDARY_ORDER, ≥2 presidential, ≥2 international, ≥2 KSU, rest special.
 * Output: _datasets/act_type_audit_snapshot.json, _reports/act_type_audit_snapshot.md
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { config } from '../lib/config.js';
import { classifyActKind, type ActKind } from '../retrieval/selected-acts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const LEGISLATION_TABLE = 'legislation_documents';

function getClient(): SupabaseClient | null {
  const url = config.supabaseLegislationUrl?.trim();
  const key = config.supabaseLegislationServiceKey?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function arrSize(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function takeStrings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string' && (x as string).trim().length > 0)
    .slice(0, max)
    .map((x) => (x as string).trim());
}

function isPresidential(title: string): boolean {
  return /указ|розпорядження\s+президента|президента\s+україни/i.test(title);
}

function isInternational(title: string): boolean {
  return /конвенція|договір|ратифікація|міжнародн/i.test(title);
}

function isKsu(title: string): boolean {
  return /рішення\s+ксу|конституційного\s+суду|окрема\s+думка/i.test(title);
}

interface DocRow {
  rada_nreg: string;
  title: string | null;
  document_type: string | null;
  category: string | null;
  aliases: unknown;
  keywords: unknown;
  topics: unknown;
  storage_category: string | null;
  indexed_chunks: number | null;
}

export interface AuditActEntry {
  rada_nreg: string;
  title: string;
  document_type: string | null;
  category: string | null;
  act_kind: ActKind;
  aliases_count: number;
  keywords_count: number;
  topics_count: number;
  /** First 5 aliases for case generator (no word→act map). */
  aliases_sample: string[];
  topics_sample: string[];
  keywords_sample: string[];
  storage_category: string | null;
  indexed_chunks: number | null;
  tags: string[];
}

async function main(): Promise<void> {
  const client = getClient();
  if (!client) {
    console.error('[dataset_act_type_audit] SUPABASE_LEGISLATION_URL and key required');
    process.exit(1);
  }

  const { data, error } = await client
    .from(LEGISLATION_TABLE)
    .select('rada_nreg, title, document_type, category, aliases, keywords, topics, storage_category, indexed_chunks')
    .eq('qdrant_status', 'indexed');

  if (error) {
    console.error('[dataset_act_type_audit]', error.message);
    process.exit(1);
  }

  const rows = (Array.isArray(data) ? data : []) as DocRow[];
  const withKind = rows
    .filter((r) => r.rada_nreg?.trim())
    .map((r) => {
      const title = (r.title ?? '').trim();
      const act_kind = classifyActKind(title, r.document_type ?? undefined, r.category ?? undefined);
      const tags: string[] = [];
      if (isPresidential(title)) tags.push('presidential');
      if (isInternational(title)) tags.push('international');
      if (isKsu(title)) tags.push('ksu');
      return {
        rada_nreg: r.rada_nreg.trim(),
        title: title || r.rada_nreg,
        document_type: r.document_type ?? null,
        category: r.category ?? null,
        act_kind,
        aliases_count: arrSize(r.aliases),
        keywords_count: arrSize(r.keywords),
        topics_count: arrSize(r.topics),
        aliases_sample: takeStrings(r.aliases, 5),
        topics_sample: takeStrings(r.topics, 5),
        keywords_sample: takeStrings(r.keywords, 5),
        storage_category: r.storage_category ?? null,
        indexed_chunks: r.indexed_chunks ?? null,
        tags,
      };
    });

  const kindOrder: ActKind[] = ['PRIMARY_LAW', 'SECONDARY_ORDER', 'CASELAW_OPINION', 'UNKNOWN'];
  const byKind = new Map<ActKind, typeof withKind>();
  for (const k of kindOrder) byKind.set(k, []);
  for (const a of withKind) byKind.get(a.act_kind)!.push(a);

  for (const arr of byKind.values()) {
    arr.sort((a, b) => a.title.localeCompare(b.title) || a.rada_nreg.localeCompare(b.rada_nreg));
  }

  const primary = byKind.get('PRIMARY_LAW')!;
  const secondary = byKind.get('SECONDARY_ORDER')!;
  const caselaw = byKind.get('CASELAW_OPINION')!;
  const unknown = byKind.get('UNKNOWN')!;

  const allTagged = withKind.filter((a) => a.tags.length > 0);
  const presidential = allTagged.filter((a) => a.tags.includes('presidential'));
  const international = allTagged.filter((a) => a.tags.includes('international'));
  const ksu = allTagged.filter((a) => a.tags.includes('ksu'));

  const picked: AuditActEntry[] = [];
  const used = new Set<string>();

  function take(list: typeof withKind, n: number): void {
    for (const a of list) {
      if (picked.length >= 20) break;
      if (used.has(a.rada_nreg)) continue;
      used.add(a.rada_nreg);
      picked.push(a);
      if (picked.length >= n) break;
    }
  }

  take(primary, 5);
  take(secondary, 5);
  take(presidential, 2);
  take(international, 2);
  take(ksu, 2);
  const rest = [...caselaw, ...unknown, ...primary, ...secondary].filter((a) => !used.has(a.rada_nreg));
  rest.sort((a, b) => a.title.localeCompare(b.title) || a.rada_nreg.localeCompare(b.rada_nreg));
  take(rest, 20);

  const snapshot = picked.slice(0, 20);
  const datasetsDir = resolve(__dirname, '_datasets');
  const reportsDir = resolve(__dirname, '_reports');
  mkdirSync(datasetsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  writeFileSync(
    resolve(datasetsDir, 'act_type_audit_snapshot.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), acts: snapshot }, null, 2),
    'utf8'
  );

  const mdRows = snapshot.map(
    (a, i) =>
      `| ${i + 1} | ${a.rada_nreg} | ${a.act_kind} | ${(a.category ?? '-').slice(0, 20)} | ${a.title.slice(0, 60).replace(/\|/g, ' ')}... |`
  );
  const md = `# Act-type audit snapshot (20 acts)

Generated: ${new Date().toISOString()}

| # | rada_nreg | act_kind | category | title (short) |
|---|-----------|----------|----------|---------------|
${mdRows.join('\n')}
`;
  writeFileSync(resolve(reportsDir, 'act_type_audit_snapshot.md'), md, 'utf8');

  console.log('[dataset_act_type_audit] wrote _datasets/act_type_audit_snapshot.json');
  console.log('[dataset_act_type_audit] wrote _reports/act_type_audit_snapshot.md');
  console.log('[dataset_act_type_audit] PRIMARY_LAW=', snapshot.filter((a) => a.act_kind === 'PRIMARY_LAW').length);
  console.log('[dataset_act_type_audit] SECONDARY_ORDER=', snapshot.filter((a) => a.act_kind === 'SECONDARY_ORDER').length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
