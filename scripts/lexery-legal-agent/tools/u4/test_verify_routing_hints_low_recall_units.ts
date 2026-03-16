import assert from 'node:assert/strict';
import {
  evaluateRoutingHintsVerifierResults,
  describeTraceShape,
  getRoutingHintsMeta,
  getUseLldbi,
} from './verify_routing_hints_low_recall.js';

function testReadsTopLevelTraceMeta(): void {
  const run = {
    search_plan: { sources: { use_lldbi: true } },
    retrieval_trace: {
      meta: {
        routing_hints: {
          enabled: true,
          called: false,
          not_used_reason_codes: ['NOT_CALLED'],
        },
      },
    },
  };
  const meta = getRoutingHintsMeta(run);
  assert.ok(meta, 'expected routing_hints meta');
  assert.equal(meta?.enabled, true);
  assert.equal(meta?.called, false);
  assert.equal(getUseLldbi(run), true);
}

function testFallsBackToSnapshotTrace(): void {
  const run = {
    snapshot: {
      query_profile: { routing_flags: { use_lldbi: true } },
      retrieval_trace: {
        meta: {
          routing_hints: {
            enabled: true,
            called: true,
            used_reason_codes: ['LOW_RECALL'],
          },
        },
      },
    },
  };
  const meta = getRoutingHintsMeta(run);
  assert.ok(meta, 'expected routing_hints meta from snapshot');
  assert.equal(meta?.called, true);
  assert.equal(getUseLldbi(run), true);
}

function testShapeDiagnostics(): void {
  const shape = describeTraceShape({
    retrieval_trace: {
      meta: {
        routing_hints: { enabled: true },
      },
    },
  });
  assert.match(shape, /"top_level_retrieval_trace":true/);
  assert.match(shape, /"routing_hints_present":true/);
}

function testSummaryFailsWhenHintsNeverCalled(): void {
  const summary = evaluateRoutingHintsVerifierResults([
    {
      id: 'c1',
      query: 'q1',
      description: 'd1',
      ok: true,
      use_lldbi: true,
      routing_hints_enabled: true,
      routing_hints_called: false,
      not_used_reasons: ['NOT_CALLED'],
      used_reasons: [],
      note: 'evaluated',
    },
    {
      id: 'c2',
      query: 'q2',
      description: 'd2',
      ok: true,
      use_lldbi: true,
      routing_hints_enabled: true,
      routing_hints_called: false,
      not_used_reasons: ['NOT_CALLED'],
      used_reasons: [],
      note: 'evaluated',
    },
  ]);
  assert.equal(summary.pass, false);
  assert.equal(summary.hintsCalled, 0);
  assert.match(summary.reason, /never called/i);
}

function testSummaryPassesWhenAtLeastOneCaseCallsHints(): void {
  const summary = evaluateRoutingHintsVerifierResults([
    {
      id: 'c1',
      query: 'q1',
      description: 'd1',
      ok: true,
      use_lldbi: true,
      routing_hints_enabled: true,
      routing_hints_called: true,
      not_used_reasons: [],
      used_reasons: ['LOW_RECALL'],
      note: 'called',
    },
    {
      id: 'c2',
      query: 'q2',
      description: 'd2',
      ok: true,
      use_lldbi: true,
      routing_hints_enabled: true,
      routing_hints_called: false,
      not_used_reasons: ['NOT_CALLED'],
      used_reasons: [],
      note: 'evaluated',
    },
  ]);
  assert.equal(summary.pass, true);
  assert.equal(summary.hintsCalled, 1);
}

function main(): void {
  testReadsTopLevelTraceMeta();
  testFallsBackToSnapshotTrace();
  testShapeDiagnostics();
  testSummaryFailsWhenHintsNeverCalled();
  testSummaryPassesWhenAtLeastOneCaseCallsHints();
  console.log('All verify_routing_hints_low_recall unit tests passed.');
}

main();
