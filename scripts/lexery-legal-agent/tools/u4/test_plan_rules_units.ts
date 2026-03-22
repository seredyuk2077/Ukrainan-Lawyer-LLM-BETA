import { buildSearchPlanFromProfile } from '../../plan/rules.js';
import type { QueryProfile, RoutingFlags } from '../../classify/types.js';
import { config } from '../../lib/config.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function makeProfile(): QueryProfile {
  return {
    query_profile_version: 1,
    intent: 'question',
    domain: 'general',
    entities: [],
    ambiguity: {
      is_ambiguous: true,
      reasons: ['ambiguous'],
      strength: 'hard',
      reason_codes: ['TOO_SHORT_QUERY'],
    },
    computed_flags: {
      has_direct_citation: true,
      profile_generation: 'llm',
    },
    routing_flags: {},
    lldbi: {
      categories_ranked_top3: [],
      document_types_ranked_top3: [],
      routing_confidence: 0.5,
      routing_source: 'heuristic',
    },
    meta: {
      classifier_mode: 'llm',
      latency_ms: 10,
      warnings: [],
    },
    pipeline_step: 'U2d_done',
    updated_at: new Date().toISOString(),
  };
}

function testUnresolvedNoSourceWhenNoStructuralCues(): void {
  const profile = makeProfile();
  const routing: RoutingFlags = { need_web: true, need_deep_retrieval: true };
  const { plan, reason_codes } = buildSearchPlanFromProfile(profile, routing);
  assert(plan.sources.use_lldbi === false, 'unresolved without structural cues must keep lldbi off');
  assert(plan.sources.use_memory === false, 'unresolved must keep memory off');
  assert(reason_codes.includes('CONTEXT_MODE_UNRESOLVED'), 'unresolved reason must be present');
  console.log('[OK] unresolved without structural cues remains no-source');
}

function testUnresolvedWithStructuralLegalGetsDegradedLegalFallback(): void {
  const profile = makeProfile();
  profile.entities = [{ type: 'act_abbrev', value: 'ЦКУ', norm: { act: 'Цивільний кодекс України' } }];
  const routing: RoutingFlags = {};
  const { plan, reason_codes } = buildSearchPlanFromProfile(profile, routing);
  assert(plan.sources.use_lldbi === true, 'unresolved with structural legal cues must get degraded legal fallback (lldbi on)');
  assert(plan.sources.use_memory === false, 'unresolved must not enable memory');
  assert(reason_codes.includes('CONTEXT_MODE_UNRESOLVED'), 'unresolved reason must remain');
  assert(reason_codes.includes('DEGRADED_STRUCTURAL_LEGAL_FALLBACK'), 'degraded fallback reason must be present');
  assert(plan.meta?.used_degraded_fallback === true, 'meta.used_degraded_fallback must be set');
  console.log('[OK] unresolved + structural legal cues => degraded legal fallback, not clean route');
}

function testResolvedMixedStillAllowsDoclistAndWeb(): void {
  const profile = makeProfile();
  const routing: RoutingFlags = {
    context_mode: 'mixed',
    need_web: true,
    need_deep_retrieval: true,
  };
  const { plan } = buildSearchPlanFromProfile(profile, routing);
  assert(plan.sources.use_lldbi === true, 'mixed should keep lldbi on');
  assert(plan.sources.use_memory === true, 'mixed should keep memory on');
  assert(plan.sources.use_doclist === true, 'resolved mixed may use doclist');
  assert(plan.sources.use_web === true, 'resolved mixed may use web');
  console.log('[OK] resolved mixed route may still enable doclist/web');
}

function testResolvedMemoryStaysPureMemory(): void {
  const profile = makeProfile();
  const routing: RoutingFlags = {
    context_mode: 'memory',
    need_web: true,
    need_deep_retrieval: true,
  };
  const { plan, reason_codes } = buildSearchPlanFromProfile(profile, routing);
  assert(plan.sources.use_lldbi === false, 'memory mode must keep lldbi off');
  assert(plan.sources.use_memory === true, 'memory mode must keep memory on');
  assert(plan.sources.use_doclist === false, 'memory mode must not enable doclist');
  assert(plan.sources.use_web === false, 'memory mode must not enable web');
  assert(reason_codes.includes('memory_mode'), 'memory mode reason should remain');
  assert(reason_codes.includes('ambiguity_hard'), 'diagnostic ambiguity reason should remain');
  assert(reason_codes.includes('need_deep_retrieval'), 'diagnostic deep reason should remain');
  assert(reason_codes.includes('need_web'), 'diagnostic web reason should remain');
  console.log('[OK] resolved memory route stays pure-memory even with ambiguity/deep/web flags');
}

function testSoftAmbiguityDoesNotBecomeHard(): void {
  const profile = makeProfile();
  profile.ambiguity = {
    is_ambiguous: true,
    reasons: ['general_domain_no_direct_ref'],
    strength: 'soft',
    reason_codes: ['GENERAL_DOMAIN_NO_DIRECT_REF'],
  };
  const routing: RoutingFlags = { context_mode: 'memory' };
  const { reason_codes } = buildSearchPlanFromProfile(profile, routing);
  assert(!reason_codes.includes('ambiguity_hard'), 'soft ambiguity must not be promoted to ambiguity_hard');
  console.log('[OK] soft ambiguity is not promoted to ambiguity_hard');
}

function testDoclistDisabledPreventsDoclistExpansion(): void {
  const original = config.doclistEnabled;
  config.doclistEnabled = false;
  try {
    const profile = makeProfile();
    const routing: RoutingFlags = {
      context_mode: 'mixed',
      need_deep_retrieval: true,
    };
    const { plan, reason_codes } = buildSearchPlanFromProfile(profile, routing);
    assert(reason_codes.includes('ambiguity_hard'), 'diagnostic ambiguity reason must remain');
    assert(reason_codes.includes('need_deep_retrieval'), 'diagnostic deep reason must remain');
    assert(plan.sources.use_doclist === false, 'doclist must stay off when config disables it');
    console.log('[OK] config.doclistEnabled=false blocks doclist expansion');
  } finally {
    config.doclistEnabled = original;
  }
}

function main(): void {
  console.log('plan rules unit tests\n');
  testUnresolvedNoSourceWhenNoStructuralCues();
  testUnresolvedWithStructuralLegalGetsDegradedLegalFallback();
  testResolvedMixedStillAllowsDoclistAndWeb();
  testResolvedMemoryStaysPureMemory();
  testSoftAmbiguityDoesNotBecomeHard();
  testDoclistDisabledPreventsDoclistExpansion();
  console.log('\nAll plan rules unit tests passed.');
}

main();
