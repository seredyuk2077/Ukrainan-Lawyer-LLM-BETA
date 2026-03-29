#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { RadaClient } from '../../../legislation/Lexery Legislation DB Infra/src/lib/radaClient.js';
import { createSupabaseAdminClient } from '../../../legislation/Lexery Legislation DB Infra/src/lib/supabaseAdmin.js';
import { normalizeStructuredActIdentifier } from '../../lib/structured-act-identifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

type CandidateMode = 'all' | 'law-like' | 'substantive-law';

interface CandidateRecord {
  rada_nreg: string;
  title: string;
  typ: string | null;
  typn: string | null;
  organs: string | null;
  document_number: string | null;
  law_like: boolean;
}

function normalizeNregForComparison(value: string | null | undefined): string {
  const raw = String(value ?? '').normalize('NFC').trim();
  if (!raw) return '';
  const normalized = normalizeStructuredActIdentifier(raw);
  return normalized || raw.toLowerCase();
}

function getArgValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.findIndex((arg) => arg === name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return null;
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLawLikeTitle(title: string | null): boolean {
  if (!title) return false;
  const normalized = title.trim();
  if (!/^Про /i.test(normalized)) return false;
  return !/(розпорядження|указ|постанова|наказ|рішення|конвенц|протокол|угода|пакт)/i.test(normalized);
}

function looksSubstantiveLawTitle(title: string | null): boolean {
  if (!looksLawLikeTitle(title)) return false;
  return !/^Про\s+(ратифікацію|внесення змін|відзначення|День\b|призначення\b)/i.test(title ?? '');
}

function isPrimaryLawLikeNreg(radaNreg: string): boolean {
  const normalized = radaNreg.trim().toLowerCase();
  return /^\d+-\d+(-вр)?$/i.test(normalized) || /^\d+\/\d+-вр$/i.test(normalized);
}

function shouldSkipLawLikeByNreg(radaNreg: string): boolean {
  const normalized = radaNreg.trim().toLowerCase();
  if (!isPrimaryLawLikeNreg(normalized)) return true;
  return (
    normalized.startsWith('n') ||
    normalized.startsWith('nb') ||
    normalized.startsWith('v0') ||
    normalized.includes('_') ||
    normalized.endsWith('-рп') ||
    normalized.endsWith('-рг') ||
    normalized.endsWith('-п') ||
    normalized.endsWith('-р') ||
    normalized.endsWith('/2025') ||
    normalized.endsWith('/2026')
  );
}

function isLawLikeCandidate(candidate: CandidateRecord): boolean {
  const joined = [candidate.typ, candidate.typn, candidate.title].filter(Boolean).join(' ').toLowerCase();
  if (joined.includes('закон')) return true;
  if (!isPrimaryLawLikeNreg(candidate.rada_nreg)) return false;
  return looksLawLikeTitle(candidate.title);
}

function matchesMode(candidate: CandidateRecord, mode: CandidateMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'law-like') return isLawLikeCandidate(candidate);
  return isLawLikeCandidate(candidate) && looksSubstantiveLawTitle(candidate.title);
}

async function main(): Promise<void> {
  const limit = Number(getArgValue('--limit') ?? '10') || 10;
  const scanLimit = Number(getArgValue('--scan-limit') ?? '500') || 500;
  const mode = (getArgValue('--mode') ?? 'law-like') as CandidateMode;
  const outputPath = getArgValue('--output');

  if (!['all', 'law-like', 'substantive-law'].includes(mode)) {
    throw new Error(`Unsupported --mode ${mode}`);
  }

  const supabase = createSupabaseAdminClient();
  const rada = new RadaClient();

  const { data: existingDocs, error } = await supabase.from('legislation_documents').select('rada_nreg');
  if (error) {
    throw error;
  }

  const existingNregs = new Set(
    (existingDocs ?? [])
      .map((row) => normalizeNregForComparison(row.rada_nreg))
      .filter(Boolean)
  );
  const feed = (await rada.fetchRTxt())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, scanLimit);

  const seenNregs = new Set<string>();
  const results: CandidateRecord[] = [];

  for (const line of feed) {
    if (results.length >= limit) break;
    const [radaNreg, ...rest] = line.split(/\s+/);
    const feedTitle = normalizeNullableText(rest.join(' '));
    const normalizedRadaNreg = normalizeNregForComparison(radaNreg);
    if (!radaNreg || seenNregs.has(normalizedRadaNreg) || existingNregs.has(normalizedRadaNreg)) continue;
    if (mode !== 'all' && shouldSkipLawLikeByNreg(radaNreg)) continue;
    if (mode === 'law-like' && feedTitle && !looksLawLikeTitle(feedTitle)) continue;
    if (mode === 'substantive-law' && feedTitle && !looksSubstantiveLawTitle(feedTitle)) continue;
    if (normalizedRadaNreg) {
      seenNregs.add(normalizedRadaNreg);
    }

    try {
      const json = await rada.fetchJson(radaNreg);
      const title = normalizeNullableText(json?.nazva);
      if (!title) continue;

      const candidate: CandidateRecord = {
        rada_nreg: radaNreg,
        title,
        typ: normalizeNullableText(json?.typ),
        typn: normalizeNullableText(json?.typn),
        organs: normalizeNullableText(json?.organs),
        document_number: normalizeNullableText(json?.n_vlas),
        law_like: false,
      };
      candidate.law_like = isLawLikeCandidate(candidate);

      if (!matchesMode(candidate, mode)) continue;
      results.push(candidate);
    } catch {
      // Ignore broken feed entries or transient JSON failures; this tool is only for candidate mining.
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode,
    limit,
    scan_limit: scanLimit,
    results,
  };

  if (outputPath) {
    writeFileSync(resolve(process.cwd(), outputPath), JSON.stringify(payload, null, 2), 'utf8');
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
