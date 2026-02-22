#!/usr/bin/env node
/**
 * Phase 5 — Audit real runs (read-only Supabase) for retrieval quality invariants.
 * Output: _reports/audit_runs_retrieval_quality.md
 * - Coverage sanity: low_confidence → reason_codes; domain → evidence; reference_expansion
 * - Top bug patterns; top 10 runs for manual review
 */
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { config } from '../../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

const N_RUNS = parseInt(process.env.AUDIT_RUNS_N ?? '200', 10);
const OUT_REPORT = resolve(__dirname, '../_reports', 'audit_runs_retrieval_quality.md');

const EXPECTED_LOW_CONF_REASON_CODES = [
  'NO_STRONG_ACT_EVIDENCE',
  'OUT_OF_SCOPE',
  'LOW_EVIDENCE',
  'low_confidence_fallback',
  'ACT_SELECTION_LOW_CONFIDENCE',
  'COVERAGE_GUARD_FAILED',
  'SELECTED_ACTS_DIVERSITY_ENFORCED',
  'ORDER_DOMINANCE_BLOCKED',
  'DIVERSITY_GUARD_ENFORCED',
  'FAMILY_DOMINANT_OK',
  'COVERAGE_MISS_SELECTED_ACTS',
];

type RunRow = {
  id: string;
  run_id: string;
  query: string | null;
  query_profile: Record<string, unknown> | null;
  search_plan: Record<string, unknown> | null;
  retrieval_trace: Record<string, unknown> | null;
  gate_decision: Record<string, unknown> | null;
  created_at: string | null;
};

type Meta = {
  low_confidence?: boolean;
  reason_codes?: string[];
  selected_acts?: Array<{ rada_nreg?: string; act_title?: string; family?: string }>;
  chunks_evidence_top_acts?: Array<{ rada_nreg?: string }>;
  act_candidates_top?: Array<{ rada_nreg?: string }>;
  reference_expansion?: {
    attempted?: boolean;
    added_count?: number;
    skipped_reason_codes?: string[];
  };
  qdrant_calls_count_total?: number;
  domain_bootstrap?: { attempted?: boolean; used?: boolean; chosen_family_key?: string };
};

type BugPattern = 'domain_miss' | 'order_dominance' | 'missing_primary_law' | 'overconfidence_when_no_evidence' | 'ref_expansion_not_triggered' | 'low_conf_no_reason';

function getDomainHint(profile: Record<string, unknown> | null): string {
  if (!profile || typeof profile !== 'object') return '';
  const d = profile.domainHint ?? profile.domain_hint;
  return typeof d === 'string' ? d.trim().toLowerCase() : '';
}

function isDomainPresent(hint: string): boolean {
  return hint.length > 0 && !['unknown', 'general', ''].includes(hint);
}

async function run(): Promise<void> {
  const url = config.supabaseUrl?.trim();
  const key = config.supabaseServiceKey?.trim();
  if (!url || !key) {
    console.error('[audit_runs] SUPABASE_LEXERY_LEGAL_AGENT_DB_URL and SERVICE_KEY required');
    process.exit(1);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await client
      .from('runs')
      .select('id, run_id, query, query_profile, search_plan, retrieval_trace, gate_decision, created_at')
      .not('retrieval_trace', 'is', null)
      .order('created_at', { ascending: false })
      .limit(N_RUNS);

    if (error) {
      console.error('[audit_runs]', error.message);
      process.exit(1);
    }

    const rows = (data ?? []) as RunRow[];
    const patterns: Record<BugPattern, number> = {
      domain_miss: 0,
      order_dominance: 0,
      missing_primary_law: 0,
      overconfidence_when_no_evidence: 0,
      ref_expansion_not_triggered: 0,
      low_conf_no_reason: 0,
    };

    const issues: Array<{ run_id: string; query: string; patterns: BugPattern[]; meta: Meta; domainHint: string }> = [];

    for (const r of rows) {
      const rt = r.retrieval_trace as Record<string, unknown> | null;
      const meta = (rt?.meta ?? {}) as Meta;
      const domainHint = getDomainHint(r.query_profile);
      const lowConf = meta.low_confidence === true;
      const reasonCodes = meta.reason_codes ?? [];
      const selectedActs = meta.selected_acts ?? [];
      const chunksEvidence = meta.chunks_evidence_top_acts ?? [];
      const hits = (rt?.hits ?? []) as Array<{ source?: string }>;
      const hasRefHit = hits.some((h) => h.source === 'REFERENCE_EXPANSION');
      const refExp = meta.reference_expansion;

      const runPatterns: BugPattern[] = [];

      if (lowConf) {
        const hasReason = EXPECTED_LOW_CONF_REASON_CODES.some((c) => reasonCodes.includes(c));
        if (!hasReason) {
          patterns.low_conf_no_reason++;
          runPatterns.push('low_conf_no_reason');
        }
      }

      if (isDomainPresent(domainHint)) {
        const hasEvidence = selectedActs.length >= 1 || chunksEvidence.length >= 1;
        if (!hasEvidence) {
          patterns.domain_miss++;
          runPatterns.push('domain_miss');
        }
      }

      if (hasRefHit && refExp && refExp.attempted !== true) {
        patterns.ref_expansion_not_triggered++;
        runPatterns.push('ref_expansion_not_triggered');
      }

      if (!lowConf && selectedActs.length === 0 && chunksEvidence.length === 0 && (meta.act_candidates_top?.length ?? 0) === 0) {
        patterns.overconfidence_when_no_evidence++;
        runPatterns.push('overconfidence_when_no_evidence');
      }

      if (runPatterns.length > 0) {
        issues.push({
          run_id: r.run_id ?? r.id,
          query: (r.query ?? '').slice(0, 120),
          patterns: runPatterns,
          meta,
          domainHint,
        });
      }
    }

    const topRunsForReview = issues
      .slice()
      .sort((a, b) => b.patterns.length - a.patterns.length)
      .slice(0, 10);

    const md = `# Audit: retrieval quality on real runs

Generated: ${new Date().toISOString()}
Runs sampled: ${rows.length} (last N=${N_RUNS}, read-only)

## Invariants checked

- \`low_confidence=true\` → \`reason_codes\` contains one of: ${EXPECTED_LOW_CONF_REASON_CODES.join(', ')}
- \`domainHint\` present (not unknown/general) → at least one act in selected_acts or chunks_evidence
- Reference in top hits → \`reference_expansion.attempted\` true
- No evidence but \`low_confidence=false\` → overconfidence_when_no_evidence

## Top bug patterns (counts)

| Pattern | Count |
|---------|-------|
| domain_miss | ${patterns.domain_miss} |
| order_dominance | ${patterns.order_dominance} |
| missing_primary_law | ${patterns.missing_primary_law} |
| overconfidence_when_no_evidence | ${patterns.overconfidence_when_no_evidence} |
| ref_expansion_not_triggered | ${patterns.ref_expansion_not_triggered} |
| low_conf_no_reason | ${patterns.low_conf_no_reason} |

## Runs with issues

Total runs with at least one pattern: ${issues.length}

## Top 10 runs for manual review (debug bundle)

${topRunsForReview
  .map(
    (u, i) => `
### ${i + 1}. \`${u.run_id}\`
- **query:** ${u.query}
- **domainHint:** ${u.domainHint || '(empty)'}
- **patterns:** ${u.patterns.join(', ')}
- **low_confidence:** ${u.meta.low_confidence ?? '—'}
- **reason_codes:** ${(u.meta.reason_codes ?? []).join(', ') || '—'}
- **selected_acts count:** ${(u.meta.selected_acts ?? []).length}
- **chunks_evidence_top_acts count:** ${(u.meta.chunks_evidence_top_acts ?? []).length}
- **reference_expansion attempted:** ${u.meta.reference_expansion?.attempted ?? '—'}
- **qdrant_calls_count_total:** ${u.meta.qdrant_calls_count_total ?? '—'}
- **domain_bootstrap used:** ${u.meta.domain_bootstrap?.used ?? '—'}
`
  )
  .join('\n')}
`;

    mkdirSync(resolve(__dirname, '../_reports'), { recursive: true });
    writeFileSync(OUT_REPORT, md, 'utf8');
    console.log('[audit_runs] wrote', OUT_REPORT);
    console.log('[audit_runs] runs with issues:', issues.length);
    console.log('[audit_runs] top patterns:', Object.entries(patterns).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(', ') || 'none');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
