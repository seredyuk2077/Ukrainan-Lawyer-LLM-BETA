/**
 * verify_u4_runtime_config — Report U4 planner/routing-hints effective config.
 * Surfaces deploy-parity risks: planners/hints off, bad model IDs, missing keys.
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/u4/verify_u4_runtime_config.ts
 */
import { config } from '../../lib/config.js';

interface ConfigItem {
  name: string;
  value: string | number | boolean;
  expected?: string;
  warn?: string;
}

const KNOWN_GOOD_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'openai/gpt-4-turbo',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3-haiku',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-sonnet',
  'anthropic/claude-3-opus',
  'google/gemini-flash-1.5',
  'google/gemini-pro-1.5',
  'meta-llama/llama-3.1-8b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
];

function isKnownGoodModel(modelId: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  // Allow any openai/gpt, anthropic/claude-3, google/gemini, meta-llama/llama-3
  return (
    lower.startsWith('openai/gpt') ||
    lower.startsWith('anthropic/claude-3') ||
    lower.startsWith('google/gemini') ||
    lower.startsWith('meta-llama/llama-3') ||
    KNOWN_GOOD_MODELS.includes(lower)
  );
}

function checkModel(label: string, modelId: string): { ok: boolean; note: string } {
  if (!modelId) return { ok: false, note: `${label}: model id is empty` };
  if (isKnownGoodModel(modelId)) return { ok: true, note: `${label}: ${modelId} ✓` };
  return {
    ok: false,
    note: `${label}: "${modelId}" is not in the known-good model list — verify it is a valid OpenRouter model ID`,
  };
}

async function main(): Promise<void> {
  console.log('=== U4 Runtime Config Verifier ===\n');

  const apiKeyPresent = !!config.openRouterApiKey;

  const items: ConfigItem[] = [
    {
      name: 'openRouterApiKey',
      value: apiKeyPresent ? '[set]' : '[MISSING]',
      warn: apiKeyPresent ? undefined : 'OPENROUTER_API_KEY not set — all LLM planners will be skipped',
    },
    { name: 'u4PlannerEnabled', value: config.u4PlannerEnabled, expected: 'true' },
    { name: 'u4PlannerModelId', value: config.u4PlannerModelId },
    { name: 'u4PlannerTimeoutSec', value: config.u4PlannerTimeoutSec },
    { name: 'u4PlannerMaxTokens', value: config.u4PlannerMaxTokens },
    { name: 'u4ActPlannerEnabled', value: config.u4ActPlannerEnabled, expected: 'true' },
    { name: 'u4ActPlannerModel', value: config.u4ActPlannerModel },
    { name: 'u4RoutingHintsEnabled', value: config.u4RoutingHintsEnabled, expected: 'true' },
    { name: 'u4RoutingHintsModel', value: config.u4RoutingHintsModel },
    { name: 'u4RerankEnabled', value: config.u4RerankEnabled },
    { name: 'u4HitsCap', value: config.u4HitsCap },
    { name: 'u4GoalsMax', value: config.u4GoalsMax },
    { name: 'lldbiTopK', value: config.lldbiTopK },
  ];

  const warns: string[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const val = String(item.value);
    const mismatch = item.expected && val !== item.expected ? ` ← EXPECTED ${item.expected}` : '';
    console.log(`  ${item.name}: ${val}${mismatch}`);
    if (item.warn) warns.push(item.warn);
    if (item.expected && val !== item.expected) {
      warns.push(`${item.name}=${val} (expected ${item.expected})`);
    }
  }

  console.log('');

  // Model sanity
  const modelChecks = [
    checkModel('u4PlannerModelId', config.u4PlannerModelId),
    checkModel('u4ActPlannerModel', config.u4ActPlannerModel),
    checkModel('u4RoutingHintsModel', config.u4RoutingHintsModel),
  ];
  for (const mc of modelChecks) {
    if (mc.ok) {
      console.log(`  [OK] ${mc.note}`);
    } else {
      console.log(`  [WARN] ${mc.note}`);
      warns.push(mc.note);
    }
  }

  // Summary
  const allPlannersOn = config.u4PlannerEnabled && config.u4ActPlannerEnabled && config.u4RoutingHintsEnabled;

  console.log('');
  console.log('=== Summary ===');
  console.log(`  planner_enabled: ${config.u4PlannerEnabled}`);
  console.log(`  act_planner_enabled: ${config.u4ActPlannerEnabled}`);
  console.log(`  routing_hints_enabled: ${config.u4RoutingHintsEnabled}`);
  console.log(`  api_key_present: ${apiKeyPresent}`);
  console.log(`  all_planners_on: ${allPlannersOn}`);
  console.log(`  warn_count: ${warns.length}`);
  console.log(`  error_count: ${errors.length}`);

  if (warns.length > 0) {
    console.log('\n  Warnings:');
    for (const w of warns) console.log(`    - ${w}`);
  }
  if (errors.length > 0) {
    console.log('\n  Errors:');
    for (const e of errors) console.log(`    - ${e}`);
  }

  console.log('');

  if (errors.length > 0) {
    console.log('RESULT: CONFIG_ERROR');
    process.exit(1);
  } else if (!allPlannersOn) {
    console.log('RESULT: PLANNERS_NOT_FULLY_ENABLED — deploy-parity risk');
    process.exit(1);
  } else if (warns.length > 0) {
    console.log('RESULT: CONFIG_WARN — planners on but warnings present');
    process.exit(0);
  } else {
    console.log('RESULT: CONFIG_OK');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
