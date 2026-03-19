/**
 * U5 Gate unit tests — evaluateGate with mock inputs. No server, no DB.
 * Run: pnpm brain:test:gate-units
 */
// Assumes DOCLIST_ENABLED is not 'false' so full gate logic (hits + degraded) runs.
import { evaluateGate } from '../../gate/gate.js';
import { gateStatus } from '../../lib/pipeline/contracts.js';
import type { RawHit, RetrievalTrace } from '../../retrieval/types.js';
import type { QueryProfile } from '../../classify/types.js';
import type { SearchPlan } from '../../plan/types.js';

function makeTrace(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    version: 1,
    hits: [],
    top_score: null,
    degraded_sources: undefined,
    ...overrides,
  };
}

function makeHit(score: number, rada_nreg?: string, article_number?: string | null, title?: string): RawHit {
  return {
    r2_key: 'test/key.json',
    json_path: '$.content.chunks[0].text',
    score,
    rada_nreg,
    article_number,
    title,
  };
}

function testGateEmptyHitsRagMissing(): void {
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits: [] }),
    rawHits: [],
    queryProfile: null,
    searchPlan: null,
  });
  if (!decision.expand) throw new Error('Expected expand=true for 0 hits');
  if (!decision.reason_codes.includes('FEW_HITS')) throw new Error('Expected FEW_HITS in reason_codes');
  if (gateStatus(decision) !== 'rag_missing') throw new Error('Expected gateStatus rag_missing');
  console.log('[OK] rawHits=[] → expand=true, FEW_HITS, status=rag_missing');
}

function testGateEnoughHitsOk(): void {
  const hits = [makeHit(0.4), makeHit(0.35), makeHit(0.3)];
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits, top_score: 0.4 }),
    rawHits: hits,
    queryProfile: null,
    searchPlan: null,
  });
  if (decision.expand) throw new Error('Expected expand=false for 3 hits above threshold');
  if (!decision.reason_codes.includes('OK')) throw new Error('Expected OK in reason_codes');
  if (gateStatus(decision) !== 'ok') throw new Error('Expected gateStatus ok');
  console.log('[OK] rawHits>=3, no degraded → expand=false, OK, status=ok');
}

function testGateDegradedLldbiRagMissing(): void {
  const hits = [makeHit(0.5)];
  const decision = evaluateGate({
    retrievalTrace: makeTrace({
      hits,
      top_score: 0.5,
      degraded_sources: { lldbi: true },
    }),
    rawHits: hits,
    queryProfile: null,
    searchPlan: null,
  });
  if (!decision.expand) throw new Error('Expected expand=true when degraded_lldbi');
  if (!decision.reason_codes.includes('DEGRADED_LLDBI')) throw new Error('Expected DEGRADED_LLDBI');
  if (gateStatus(decision) !== 'rag_missing') throw new Error('Expected gateStatus rag_missing');
  console.log('[OK] degraded_sources.lldbi=true → expand=true, DEGRADED_LLDBI, status=rag_missing');
}

function testGateFewHitsBelowThreshold(): void {
  const hits = [makeHit(0.2), makeHit(0.15)]; // 2 < MIN_HITS_THRESHOLD (3)
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits, top_score: 0.2 }),
    rawHits: hits,
    queryProfile: null,
    searchPlan: null,
  });
  if (!decision.expand) throw new Error('Expected expand=true for 2 hits');
  if (!decision.reason_codes.includes('FEW_HITS')) throw new Error('Expected FEW_HITS');
  console.log('[OK] rawHits=2 → expand=true, FEW_HITS');
}

/** DIRECT_REF_MISSING: no false positive when article refs (130, 286) are present in hits. */
function testDirectRefPresentNoMissing(): void {
  const queryProfile: QueryProfile = {
    query_profile_version: 1,
    intent: 'question',
    domain: 'criminal',
    entities: [
      { type: 'article_ref', value: 'ст 130 КУпАП', norm: { act: 'КУпАП', article: '130' } },
      { type: 'article_ref', value: 'ст 286 ККУ', norm: { act: 'ККУ', article: '286' } },
    ],
    ambiguity: { is_ambiguous: false, reasons: [] },
    computed_flags: { has_direct_citation: true },
    routing_flags: {},
    pipeline_step: 'U2',
    updated_at: new Date().toISOString(),
  };
  const hits: RawHit[] = [
    makeHit(0.6, '80731-10', '130', 'Кодекс України про адміністративні правопорушення'),
    makeHit(0.58, '2341-14', '286', 'Кримінальний кодекс України'),
    makeHit(0.5, '2341-14', '185'),
  ];
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits, top_score: 0.6 }),
    rawHits: hits,
    queryProfile,
    searchPlan: { sources: { use_lldbi: true, use_doclist: true }, steps: [] },
  });
  if (decision.reason_codes.includes('DIRECT_REF_MISSING'))
    throw new Error('Expected no DIRECT_REF_MISSING when refs 130 and 286 present in hits');
  if (decision.signals.direct_refs_total !== 2) throw new Error('Expected direct_refs_total=2');
  if (decision.signals.direct_refs_hit !== 2) throw new Error('Expected direct_refs_hit=2');
  console.log('[OK] direct refs 130+286 present in hits → no DIRECT_REF_MISSING, direct_refs_hit=2');
}

/** DIRECT_REF_MISSING: true when expected article refs are absent from hits. */
function testDirectRefMissingWhenAbsent(): void {
  const queryProfile: QueryProfile = {
    query_profile_version: 1,
    intent: 'question',
    domain: 'criminal',
    entities: [
      { type: 'article_ref', value: 'ст 999 ККУ', norm: { act: 'ККУ', article: '999' } },
    ],
    ambiguity: { is_ambiguous: false, reasons: [] },
    computed_flags: { has_direct_citation: true },
    routing_flags: {},
    pipeline_step: 'U2',
    updated_at: new Date().toISOString(),
  };
  const hits: RawHit[] = [
    makeHit(0.6, '2341-14', '185', 'Кримінальний кодекс України'),
    makeHit(0.5, '2341-14', '186'),
  ];
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits, top_score: 0.6 }),
    rawHits: hits,
    queryProfile,
    searchPlan: { sources: { use_lldbi: true, use_doclist: true }, steps: [] },
  });
  if (!decision.reason_codes.includes('DIRECT_REF_MISSING'))
    throw new Error('Expected DIRECT_REF_MISSING when ref 999 absent from hits');
  if (decision.signals.direct_refs_hit !== 0) throw new Error('Expected direct_refs_hit=0');
  console.log('[OK] direct ref 999 absent → DIRECT_REF_MISSING, direct_refs_hit=0');
}

function testMemoryPlanDoesNotExpandOnSoftAmbiguityAlone(): void {
  const queryProfile: QueryProfile = {
    query_profile_version: 1,
    intent: 'question',
    domain: 'general',
    entities: [],
    ambiguity: {
      is_ambiguous: true,
      reasons: ['general_domain_no_direct_ref'],
      strength: 'soft',
      reason_codes: ['GENERAL_DOMAIN_NO_DIRECT_REF'],
    },
    computed_flags: { has_direct_citation: false },
    routing_flags: { context_mode: 'memory' },
    pipeline_step: 'U2',
    updated_at: new Date().toISOString(),
  };
  const searchPlan: SearchPlan = {
    version: 1,
    sources: {
      use_lldbi: false,
      use_memory: true,
      use_doclist: false,
      use_web: false,
    },
    thresholds: { top_k_chunks: 20, min_score: 0.5 },
    reason_codes: ['memory_mode'],
    meta: { built_at: new Date().toISOString(), rules_version: 'test' },
  };
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits: [], top_score: null }),
    rawHits: [],
    queryProfile,
    searchPlan,
  });
  if (decision.expand)
    throw new Error('Expected expand=false when no legal retrieval channels are active');
  if (decision.reason_codes.includes('AMBIGUOUS_QUERY'))
    throw new Error('Expected no AMBIGUOUS_QUERY when lldbi is disabled for memory mode');
  if (decision.reason_codes.includes('NEED_DEEP_RETRIEVAL'))
    throw new Error('Expected no NEED_DEEP_RETRIEVAL when lldbi is disabled for memory mode');
  if (!decision.reason_codes.includes('OK'))
    throw new Error('Expected OK when gate is not relevant to memory/no-source plan');
  console.log('[OK] memory/no-source plans do not expand on soft ambiguity alone');
}

function testStrongLegalEvidenceDoesNotExpandOnSoftAmbiguityAlone(): void {
  const queryProfile: QueryProfile = {
    query_profile_version: 1,
    intent: 'question',
    domain: 'criminal',
    entities: [],
    ambiguity: {
      is_ambiguous: true,
      reasons: ['possible_multi_aspect'],
      strength: 'soft',
      reason_codes: ['GENERAL_DOMAIN_NO_DIRECT_REF'],
    },
    computed_flags: { has_direct_citation: false },
    routing_flags: { context_mode: 'law' },
    pipeline_step: 'U2',
    updated_at: new Date().toISOString(),
  };
  const hits = Array.from({ length: 100 }, (_, idx) => makeHit(0.46 - idx * 0.0001, '2341-14', String(185 + (idx % 3))));
  const searchPlan: SearchPlan = {
    version: 1,
    sources: {
      use_lldbi: true,
      use_memory: false,
      use_doclist: false,
      use_web: false,
    },
    thresholds: { top_k_chunks: 20, min_score: 0.5 },
    reason_codes: ['law_mode'],
    meta: { built_at: new Date().toISOString(), rules_version: 'test' },
  };
  const decision = evaluateGate({
    retrievalTrace: makeTrace({ hits, top_score: 0.46 }),
    rawHits: hits,
    queryProfile,
    searchPlan,
  });
  if (decision.expand)
    throw new Error('Expected expand=false when ambiguity is soft but legal retrieval evidence is already strong');
  if (decision.reason_codes.includes('AMBIGUOUS_QUERY'))
    throw new Error('Expected no AMBIGUOUS_QUERY when legal retrieval evidence is already strong');
  if (!decision.reason_codes.includes('OK')) throw new Error('Expected OK for strong-evidence legal retrieval');
  console.log('[OK] strong legal evidence suppresses soft ambiguity-only expand');
}

function testCoverageGapLikelyMissingActForcesRagMissing(): void {
  const hits = [makeHit(0.31, 'random-1', null, 'Сторонній акт')];
  const decision = evaluateGate({
    retrievalTrace: makeTrace({
      hits,
      top_score: 0.31,
      meta: {
        hits_count: 1,
        low_confidence: true,
        coverage_gap: 'likely_missing_act',
      },
    }),
    rawHits: hits,
    queryProfile: null,
    searchPlan: { sources: { use_lldbi: true, use_doclist: true }, steps: [] },
  });
  if (!decision.expand) throw new Error('Expected expand=true for likely_missing_act coverage gap');
  if (!decision.reason_codes.includes('LIKELY_MISSING_ACT')) {
    throw new Error(`Expected LIKELY_MISSING_ACT, got ${JSON.stringify(decision.reason_codes)}`);
  }
  if (gateStatus(decision) !== 'rag_missing') throw new Error('Expected rag_missing for likely_missing_act');
  console.log('[OK] coverage_gap=likely_missing_act forces rag_missing path');
}

async function main(): Promise<void> {
  console.log('U5 Gate unit tests\n');
  testGateEmptyHitsRagMissing();
  testGateEnoughHitsOk();
  testGateDegradedLldbiRagMissing();
  testGateFewHitsBelowThreshold();
  testDirectRefPresentNoMissing();
  testDirectRefMissingWhenAbsent();
  testMemoryPlanDoesNotExpandOnSoftAmbiguityAlone();
  testStrongLegalEvidenceDoesNotExpandOnSoftAmbiguityAlone();
  testCoverageGapLikelyMissingActForcesRagMissing();
  console.log('\nAll gate unit tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
