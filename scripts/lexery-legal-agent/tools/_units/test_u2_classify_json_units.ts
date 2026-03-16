/**
 * Unit tests for U2 classifier JSON parsing/extraction reliability.
 * Run: pnpm -s exec tsx scripts/lexery-legal-agent/tools/_units/test_u2_classify_json_units.ts
 */
import { parseLLMClassifyOutput, tryParseLLMOutputWithReason } from '../../classify/schema.js';
import { U2_CLASSIFY_RESPONSE_FORMAT } from '../../classify/llm-classifier.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function buildValidJson(routingOverrides?: { context_mode?: 'law' | 'memory' | 'mixed' | null }): string {
  return JSON.stringify({
    intent: 'question',
    domain: 'general',
    entities: [],
    ambiguity: { is_ambiguous: false, reasons: [], ambig_terms: [] },
    routing_flags: {
      need_deep_retrieval: false,
      need_web: false,
      ambiguous: false,
      context_mode: routingOverrides?.context_mode ?? 'law',
    },
  });
}

/** Ukrainian apostrophe in preamble must not break JSON extraction/parsing. */
function testApostrophePreamblePlusJson(): void {
  const raw = `Поясни про п'яти елементів. ${buildValidJson()}`;
  const parsed = parseLLMClassifyOutput(raw);
  assert(parsed.intent === 'question', 'intent parsed');
  assert(parsed.domain === 'general', 'domain parsed');
  assert(Array.isArray(parsed.entities) && parsed.entities.length === 0, 'entities empty array');
  console.log("[OK] U2 schema: apostrophe preamble (п'яти) + JSON object parses");
}

/** Preamble + fenced JSON must parse. */
function testPreamblePlusFencedJson(): void {
  const json = buildValidJson();
  const raw = `Ось відповідь:\n\`\`\`json\n${json}\n\`\`\`\nДякую.`;
  const parsed = parseLLMClassifyOutput(raw);
  assert(parsed.ambiguity.is_ambiguous === false, 'ambiguity parsed');
  console.log('[OK] U2 schema: preamble + fenced JSON parses');
}

/** Invalid JSON should return parsed=null with non-empty reason (for degraded path telemetry). */
function testInvalidJsonReason(): void {
  const raw = `Преамбула п'яти. {"intent":"question","domain":"general","entities":[],"ambiguity":{"is_ambiguous":false,"reasons":[]}`;
  const out = tryParseLLMOutputWithReason(raw);
  assert(out.parsed === null, 'parsed=null on invalid JSON');
  assert(typeof out.reason === 'string' && out.reason.length > 0, 'reason is present');
  console.log('[OK] U2 schema: invalid JSON yields reason');
}

/** Structural guard: root and every nested object with properties must have required[] containing ALL keys (strict provider compliance). */
function testStrictSchemaNestedRequired(): void {
  type ObjSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown[]; items?: ObjSchema };
  const schema = U2_CLASSIFY_RESPONSE_FORMAT.json_schema.schema as ObjSchema;

  function checkObject(name: string, obj: ObjSchema): void {
    if (!obj?.properties || Array.isArray(obj.required) === false) return;
    const propKeys = Object.keys(obj.properties);
    const required = obj.required!;
    for (const k of propKeys) {
      assert(required.includes(k), `[${name}] required must include property key: ${k}`);
    }
  }

  checkObject('root', schema);
  const entities = schema.properties?.entities as { items?: ObjSchema } | undefined;
  if (entities?.items) {
    checkObject('entities.items', entities.items);
    const normProp = entities.items.properties?.norm;
    if (normProp && typeof normProp === 'object' && 'anyOf' in normProp) {
      const anyOf = (normProp as { anyOf: ObjSchema[] }).anyOf;
      const normObj = anyOf?.find((x) => x && typeof x === 'object' && (x as ObjSchema).type === 'object') as ObjSchema | undefined;
      if (normObj) checkObject('entities.items.norm', normObj);
    }
  }
  checkObject('ambiguity', schema.properties?.ambiguity as ObjSchema);
  checkObject('routing_flags', schema.properties?.routing_flags as ObjSchema);

  const rootRequired = schema.required ?? [];
  assert(rootRequired.includes('routing_flags'), 'root.required includes routing_flags');
  console.log('[OK] U2 schema: strict nested required (no empty required)');
}

/** Entity with norm (act, article, part) parses; Zod accepts optional norm. */
function testEntityWithNormParses(): void {
  const json = JSON.stringify({
    intent: 'question',
    domain: 'criminal',
    entities: [{ type: 'article_ref', value: 'ст. 185', norm: { act: 'ККУ', article: '185', part: '' } }],
    ambiguity: { is_ambiguous: false, reasons: [], ambig_terms: [] },
    routing_flags: { need_deep_retrieval: false, need_web: false, ambiguous: false, context_mode: 'law' },
  });
  const parsed = parseLLMClassifyOutput(json);
  assert(parsed.entities.length === 1, 'one entity');
  assert(parsed.entities[0].norm?.act === 'ККУ' && parsed.entities[0].norm?.article === '185', 'norm parsed');
  console.log('[OK] U2 schema: entity with norm (act, article, part) parses');
}

/** Nullable routing_flags from provider normalize to booleans and optional context_mode. */
function testNullableRoutingFlagsParse(): void {
  const json = JSON.stringify({
    intent: 'other',
    domain: 'general',
    entities: [],
    ambiguity: { is_ambiguous: true, reasons: ['short'], ambig_terms: [] },
    routing_flags: {
      need_deep_retrieval: null,
      need_web: null,
      ambiguous: true,
      context_mode: 'memory',
    },
  });
  const parsed = parseLLMClassifyOutput(json);
  assert(parsed.routing_flags != null, 'routing_flags present');
  assert(parsed.routing_flags!.need_deep_retrieval === false, 'null -> false');
  assert(parsed.routing_flags!.need_web === false, 'null -> false');
  assert(parsed.routing_flags!.ambiguous === true, 'true preserved');
  assert(parsed.routing_flags!.context_mode === 'memory', 'context_mode memory');
  const jsonNullContext = JSON.stringify({
    intent: 'question',
    domain: 'general',
    entities: [],
    ambiguity: { is_ambiguous: false, reasons: [], ambig_terms: [] },
    routing_flags: { need_deep_retrieval: false, need_web: false, ambiguous: false, context_mode: null },
  });
  const p2 = parseLLMClassifyOutput(jsonNullContext);
  assert(p2.routing_flags!.context_mode === undefined, 'null context_mode -> undefined');
  console.log('[OK] U2 schema: nullable routing_flags parse and normalize');
}

/** context_mode memory/mixed/law round-trip. */
function testContextModeRegression(): void {
  for (const mode of ['memory', 'mixed', 'law'] as const) {
    const json = buildValidJson({ context_mode: mode });
    const parsed = parseLLMClassifyOutput(json);
    assert(parsed.routing_flags?.context_mode === mode, `context_mode ${mode} preserved`);
  }
  console.log('[OK] U2 schema: context_mode memory/mixed/law regression');
}

function main(): void {
  testApostrophePreamblePlusJson();
  testPreamblePlusFencedJson();
  testInvalidJsonReason();
  testStrictSchemaNestedRequired();
  testEntityWithNormParses();
  testNullableRoutingFlagsParse();
  testContextModeRegression();
  console.log('All U2 classify JSON unit tests passed.');
}

main();

