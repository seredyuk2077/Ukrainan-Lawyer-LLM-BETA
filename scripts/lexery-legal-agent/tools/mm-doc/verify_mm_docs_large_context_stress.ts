#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { createServer } from 'net';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  HeadingLevel,
} from 'docx';
import { countArticleRefs } from '../../write/outputValidator.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

process.env.MM_DOCS_ENABLED ??= 'true';
process.env.PROMPT_COMPOSER_ENABLED ??= 'false';
process.env.LEGAL_AGENT_MODEL_ID ??= process.env.MM_DOCS_TEST_MODEL_ID || 'openai/gpt-4o-mini';
process.env.PROMPT_COMPOSER_MODEL_COMPLEX_ID ??= process.env.LEGAL_AGENT_MODEL_ID;
process.env.PROMPT_COMPOSER_MODEL_SIMPLE_ID ??= 'openai/gpt-5-nano';

const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';
if (!process.env.DEV_API_KEY) process.env.DEV_API_KEY = DEV_KEY;
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';

const POLL_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const SHUTDOWN_WAIT_MS = 5_000;
const __dirname = dirname(fileURLToPath(import.meta.url));

type ScopeContext = {
  tenantId: string;
  userId: string;
  conversationId: string;
  projectId?: string | null;
};

type CompletedRun = {
  runId: string;
  status: string;
  answerText: string;
  docCount: number;
  lawCount: number;
  memoryCount: number;
  historyCount: number;
  planUseLldbi: boolean | null;
  planUseMemory: boolean | null;
  planStepKinds: string[];
  planReasonCodes: string[];
  wallClockMs: number;
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error('Could not get free port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForHealth(baseUrl: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const json = (await res.json()) as { status?: string };
        if (json.status === 'healthy') return true;
      }
    } catch {
      // ignore until timeout
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

function shutdownServer(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise) => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolvePromise();
    }, SHUTDOWN_WAIT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contains(text: string | null | undefined, needle: string): boolean {
  if (!text) return false;
  return normalize(text).includes(normalize(needle));
}

function assertDocsOnlyNoLawFraming(answerText: string, label: string): void {
  assert(countArticleRefs(answerText) === 0, `${label} must not invent legal article citations`);
  assert(!/^\s*•?\s*норма(?:\s*\(.*?\))?\s*:/im.test(answerText), `${label} must not emit legal norm section`);
  assert(
    !/витяг(?:и)?\s+з\s+норм\s+законодавства|норм(?:и|а)?\s+законодавств(?:а|о)?|законодавств(?:о|а)?\s+не\s+було\s+надано|правов(?:а|і)\s+норм|внутрішнь(?:ої|я)\s+бази\s+lexery|internal\s+legislation\s+database/i.test(answerText),
    `${label} must not mention legal framing or LLDBI`
  );
}

async function retryIo<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|503|502|429/i.test(msg) || i === attempts - 1) {
        throw error instanceof Error ? error : new Error(`${label}: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: retry failed`);
}

async function ensureConversation(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  tenantId: string,
  userId: string,
  conversationId: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error: te } = await retryIo('tenants upsert', () =>
    sb.from('tenants').upsert({ id: tenantId, name: `MM Docs Stress ${tenantId.slice(0, 8)}`, settings: {}, updated_at: now }, { onConflict: 'id' })
  );
  if (te && te.code !== '23505') throw new Error(`tenants upsert: ${te.message}`);
  const { error: ce } = await retryIo('chat_sessions upsert', () =>
    sb.from('chat_sessions').upsert({ id: conversationId, tenant_id: tenantId, user_id: userId, updated_at: now }, { onConflict: 'id' })
  );
  if (ce && ce.code !== '23505') throw new Error(`chat_sessions upsert: ${ce.message}`);
}

async function pollCompletedRun(
  base: string,
  runId: string,
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const res = await retryIo('poll run', () =>
      fetch(`${base}/v1/runs/${runId}?include_snapshot=true`, { headers })
    );
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 503 && /DB_READ_FAIL|Database temporarily unavailable/i.test(text)) continue;
      throw new Error(`GET /v1/runs/${runId} failed: ${res.status} ${text}`);
    }
    const run = (await res.json()) as Record<string, unknown>;
    const status = String(run.status ?? '');
    if (status === 'completed' || status === 'failed') return run;
  }
  throw new Error(`Timeout waiting for run completion: ${runId}`);
}

async function findAssistantAnswer(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  conversationId: string,
  runId: string
): Promise<string> {
  const { data, error } = await sb
    .from('messages')
    .select('role, content, metadata, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`messages query failed: ${error.message}`);
  const row = (data ?? []).find((message) => {
    const metadata =
      message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;
    return message.role === 'assistant' && metadata?.run_id === runId;
  });
  return String(row?.content ?? '');
}

async function submitRun(params: {
  base: string;
  headers: Record<string, string>;
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>;
  repo: import('../../gateway/storage.js').RunRepository;
  scope: ScopeContext;
  query: string;
  requestedScope?: 'conversation' | 'project' | 'user_global';
  attachment?: {
    name: string;
    contentType: string;
    buffer: Buffer;
  };
}): Promise<CompletedRun> {
  await ensureConversation(params.sb, params.scope.tenantId, params.scope.userId, params.scope.conversationId);
  const body: Record<string, unknown> = {
    query: params.query,
    tenant_id: params.scope.tenantId,
    user_id: params.scope.userId,
    conversation_id: params.scope.conversationId,
    dry_run: false,
    client_context: {
      ...(params.scope.projectId ? { project_id: params.scope.projectId } : {}),
      ...(params.requestedScope ? { mm_doc_scope: params.requestedScope } : {}),
    },
  };
  if (params.attachment) {
    body.attachments = [
      {
        name: params.attachment.name,
        contentType: params.attachment.contentType,
        contentBase64: params.attachment.buffer.toString('base64'),
      },
    ];
  }

  const startedAt = Date.now();
  const postRes = await retryIo('post run', () =>
    fetch(`${params.base}/v1/runs`, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(body),
    })
  );
  if (postRes.status !== 202) {
    const text = await postRes.text();
    throw new Error(`POST /v1/runs failed: ${postRes.status} ${text}`);
  }
  const postBody = (await postRes.json()) as { run_id?: string };
  if (!postBody.run_id) throw new Error('POST /v1/runs missing run_id');

  await pollCompletedRun(params.base, postBody.run_id, { 'X-Dev-API-Key': DEV_KEY });
  const persisted = await params.repo.findByRunId(postBody.run_id);
  if (!persisted) throw new Error(`Run not found after completion: ${postBody.run_id}`);
  const answerText = await findAssistantAnswer(params.sb, params.scope.conversationId, postBody.run_id);
  const sourceSummary =
    persisted.snapshot && typeof persisted.snapshot === 'object' && !Array.isArray(persisted.snapshot)
      ? ((persisted.snapshot as Record<string, unknown>).source_summary as Record<string, unknown> | undefined)
      : undefined;
  const planAudit =
    persisted.search_plan && typeof persisted.search_plan === 'object' && !Array.isArray(persisted.search_plan)
      ? (persisted.search_plan as Record<string, unknown>)
      : null;
  const plan =
    planAudit?.plan && typeof planAudit.plan === 'object' && !Array.isArray(planAudit.plan)
      ? (planAudit.plan as Record<string, unknown>)
      : null;
  const steps = Array.isArray(planAudit?.steps) ? (planAudit?.steps as Array<Record<string, unknown>>) : [];
  return {
    runId: postBody.run_id,
    status: String(persisted.status ?? ''),
    answerText,
    docCount: Number(sourceSummary?.document_count ?? sourceSummary?.doc_count ?? 0),
    lawCount: Number(sourceSummary?.law_count ?? 0),
    memoryCount: Number(sourceSummary?.memory_count ?? 0),
    historyCount: Number(sourceSummary?.history_count ?? 0),
    planUseLldbi: typeof plan?.sources === 'object' && plan.sources && !Array.isArray(plan.sources)
      ? Boolean((plan.sources as Record<string, unknown>).use_lldbi)
      : null,
    planUseMemory: typeof plan?.sources === 'object' && plan.sources && !Array.isArray(plan.sources)
      ? Boolean((plan.sources as Record<string, unknown>).use_memory)
      : null,
    planStepKinds: steps.map((step) => String(step.kind ?? '')),
    planReasonCodes: Array.isArray(plan?.reason_codes) ? plan.reason_codes.map(String) : [],
    wallClockMs: Date.now() - startedAt,
  };
}

function makeLargeParagraph(seed: string, repeats = 12): string {
  return Array.from({ length: repeats }, (_, index) =>
    `${seed} Пояснення ${index + 1}: сторони підтверджують обсяг, строк, порядок повідомлення та контроль виконання.`
  ).join(' ');
}

async function buildLargeContractDocx(params: {
  title: string;
  counterparty: string;
  uniqueClauses: string[];
  scheduleRows: Array<[string, string]>;
}): Promise<Buffer> {
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: params.title, bold: true })] }),
    new Paragraph(`Контрагент: ${params.counterparty}`),
  ];

  params.uniqueClauses.forEach((clause, index) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: `Розділ ${index + 1}. Ключова умова`, bold: true })],
      }),
      new Paragraph(clause),
      new Paragraph(makeLargeParagraph(`Додаткові деталі до розділу ${index + 1}.`))
    );
  });

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: 'Додаток A. Графік платежів', bold: true })],
    }),
    new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph('Показник')] }),
            new TableCell({ children: [new Paragraph('Значення')] }),
          ],
        }),
        ...params.scheduleRows.map(([label, value]) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(label)] }),
              new TableCell({ children: [new Paragraph(value)] }),
            ],
          })
        ),
      ],
    })
  );

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function main(): Promise<void> {
  const { config } = await import('../../lib/config.js');
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const { RunRepository } = await import('../../gateway/storage.js');
  const { ensureMmDocTablesReady } = await import('../../mm/doc/store.js');
  const { ensureMmDocsCollection } = await import('../../mm/doc/qdrant.js');

  assert(config.mmDocsEnabled, 'MM Docs must be enabled');
  assert(config.mmDocsQdrantUrl && config.mmDocsQdrantApiKey, 'MM Docs Qdrant must be configured');

  await ensureMmDocTablesReady();
  await ensureMmDocsCollection();

  const port = process.env.BRAIN_PORT ? parseInt(process.env.BRAIN_PORT, 10) : await getFreePort();
  const base = process.env.BRAIN_BASE_URL ?? `http://127.0.0.1:${port}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Dev-API-Key': DEV_KEY,
  };

  const sb = getSupabaseClient();
  const repo = new RunRepository();
  let serverProc: ReturnType<typeof spawn> | null = null;

  if (!process.env.BRAIN_BASE_URL) {
    const serverEnv = {
      ...process.env,
      BRAIN_PORT: String(port),
      DEV_API_KEY: DEV_KEY,
      DEV_ALLOW_ANONYMOUS: 'true',
      MM_OUTBOX_WORKER_ENABLED: 'true',
      MM_OUTBOX_POLL_INTERVAL_MS: process.env.MM_OUTBOX_POLL_INTERVAL_MS || '2000',
      MM_OUTBOX_BATCH_SIZE: process.env.MM_OUTBOX_BATCH_SIZE || '10',
      REDIS_QUEUE_NAMESPACE:
        process.env.REDIS_QUEUE_NAMESPACE || `lexery:mm-doc-large-stress:${randomUUID()}`,
    };
    const serverScript = resolve(__dirname, '../../server.ts');
    serverProc = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'tsx', serverScript],
      {
        env: serverEnv,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    serverProc.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    serverProc.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    serverProc.on('error', (err) => {
      console.error('[verify_mm_docs_large_context_stress] server spawn error:', err);
    });
    const healthy = await waitForHealth(base);
    assert(healthy, 'stress verifier server health check must pass');
  }

  try {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const projectId = randomUUID();
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    const foreignConversation = randomUUID();

    const projectDoc = await buildLargeContractDocx({
    title: 'Великий договір поставки обладнання',
    counterparty: 'ТОВ Оріон Логістик',
    uniqueClauses: [
      'Гарантійний платіж повертається за 7 банківських днів після підписання остаточного акта приймання-передачі.',
      'Штраф за прострочення поставки яблук становить 12 відсотків за кожен день затримки.',
      'Арбітражна обмовка: усі спори розглядаються за правилами ICC у Парижі англійською мовою.',
      'Передсудове врегулювання триває 15 робочих днів до подання позову.',
    ],
    scheduleRows: [
      ['Гарантійний платіж', '7 банківських днів'],
      ['Передсудове врегулювання', '15 робочих днів'],
      ['Маркер', 'PROJECT_LARGE_DOC_NEEDLE'],
    ],
  });

    const chatDoc = await buildLargeContractDocx({
    title: 'Чат-додаток до договору',
    counterparty: 'ТОВ Альфа Сад',
    uniqueClauses: [
      'Резервний склад для яблук розташований у Львові. CHAT_SCOPE_NEEDLE.',
      'Пеня за прострочення звіту становить 3 відсотки за день.',
    ],
    scheduleRows: [['Резервний склад', 'Львів'], ['Маркер', 'CHAT_SCOPE_NEEDLE']],
  });

    const globalDoc = Buffer.from(
    [
      'Глобальна політика користувача щодо спорів та листування.',
      'Фраза GLOBAL_POLICY_NEEDLE: усі англомовні спори ескалюються до зовнішнього радника.',
      makeLargeParagraph('Глобальна політика деталізує порядок комунікації.', 20),
    ].join('\n\n'),
    'utf8'
  );

    await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId, userId, conversationId: conversationA, projectId },
    query: 'Завантажую великий договір проєкту.',
    requestedScope: 'project',
    attachment: {
      name: 'project-large-contract.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: projectDoc,
    },
  });

    await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId, userId, conversationId: conversationA, projectId },
    query: 'Завантажую окремий чат-додаток.',
    requestedScope: 'conversation',
    attachment: {
      name: 'chat-annex.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: chatDoc,
    },
  });

    await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId, userId, conversationId: conversationA, projectId },
    query: 'Завантажую глобальну внутрішню політику.',
    requestedScope: 'user_global',
    attachment: {
      name: 'global-policy.txt',
      contentType: 'text/plain',
      buffer: globalDoc,
    },
  });

    const memorySeed = await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId, userId, conversationId: conversationA, projectId },
    query: 'Запамʼятай: мій улюблений колір синій, а собаку звати Рорі.',
  });
  assert(memorySeed.status === 'completed', 'memory seed run must complete');

    const [
    docsOnlyRecall,
    tableRecall,
    mixedRecall,
    memoryDocsRecall,
    globalRecall,
    noChatLeak,
  ] = await Promise.all([
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationA, projectId },
      query: 'Коли повертається гарантійний платіж у моїх документах цього проєкту?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationA, projectId },
      query: 'Повтори лише строк з таблиці щодо передсудового врегулювання з мого документа.',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationA, projectId },
      query: 'Яка норма закону регулює строк виконання зобовʼязання і що про це сказано в моєму договорі про гарантійний платіж?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationA, projectId },
      query: 'Нагадай мій улюблений колір і скажи, коли повертається гарантійний платіж у моєму документі.',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationB, projectId: null },
      query: 'Яка фраза GLOBAL_POLICY_NEEDLE у моїх документах?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId, userId, conversationId: conversationB, projectId },
      query: 'Де резервний склад для яблук у моїх документах?',
    }),
  ]);

    await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId: otherTenantId, userId: otherUserId, conversationId: foreignConversation, projectId: null },
    query: 'Завантажую чужий документ.',
    requestedScope: 'conversation',
    attachment: {
      name: 'foreign.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('FOREIGN_USER_NEEDLE: депозит повертається за 90 днів.', 'utf8'),
    },
  });

    const noUserLeak = await submitRun({
    base,
    headers,
    sb,
    repo,
    scope: { tenantId, userId, conversationId: conversationB, projectId: null },
    query: 'Який FOREIGN_USER_NEEDLE у моїх документах?',
  });

  assert(docsOnlyRecall.docCount > 0, 'docs-only recall must use MM Docs evidence');
  assert(docsOnlyRecall.lawCount === 0, 'docs-only recall must not use law evidence');
  assert(docsOnlyRecall.planUseMemory === false, 'docs-only recall must disable memory in the U3 plan');
  assert(docsOnlyRecall.memoryCount === 0, 'docs-only recall must not pull unrelated memory facts');
  assert(docsOnlyRecall.planUseLldbi === false, 'docs-only recall plan must disable LLDBI');
  assert(contains(docsOnlyRecall.answerText, '7 банківських днів'), 'docs-only recall must surface guarantee term');
  assert(countArticleRefs(docsOnlyRecall.answerText) === 0, 'docs-only recall must not invent legal citations');

  assert(tableRecall.docCount > 0, 'table recall must use MM Docs evidence');
  assert(tableRecall.lawCount === 0, 'table recall must stay docs-only');
  assert(contains(tableRecall.answerText, '15 робочих днів'), 'table recall must surface table value');

  assert(mixedRecall.docCount > 0, 'mixed recall must keep doc evidence');
  assert(mixedRecall.lawCount > 0, 'mixed recall must include law evidence');
  assert(contains(mixedRecall.answerText, '7 банківських днів'), 'mixed recall must keep contract clause');
  assert(countArticleRefs(mixedRecall.answerText) > 0, 'mixed recall must include a legal citation');

  assert(memoryDocsRecall.docCount > 0, 'memory+docs recall must keep docs evidence');
  assert(memoryDocsRecall.lawCount === 0, 'memory+docs recall should not inject law evidence');
  assert(contains(memoryDocsRecall.answerText, 'син'), 'memory+docs recall must keep personal fact');
  assert(contains(memoryDocsRecall.answerText, '7 банківських днів'), 'memory+docs recall must keep doc fact');

  assert(globalRecall.docCount > 0, 'global recall must find user-global doc');
  assert(globalRecall.lawCount === 0, 'global recall must stay docs-only');
  assert(contains(globalRecall.answerText, 'global_policy_needle') || contains(globalRecall.answerText, 'зовнішнього радника'), 'global recall must surface global policy text');

  assert(noChatLeak.lawCount === 0, 'separate chat docs lookup must not pull law evidence');
  assert(!contains(noChatLeak.answerText, 'львів'), 'separate chat answer must not leak conversation-scoped clause');
  assertDocsOnlyNoLawFraming(noChatLeak.answerText, 'separate chat docs lookup');

  assert(noUserLeak.docCount === 0, 'different tenant/user doc must not leak');
  assert(noUserLeak.lawCount === 0, 'foreign-user leak check must not fall back to law');
  assert(!contains(noUserLeak.answerText, '90 днів'), 'foreign-user answer must not leak foreign tenant/user doc');
  assertDocsOnlyNoLawFraming(noUserLeak.answerText, 'foreign-user docs lookup');

    const wallClockSamples = [
    docsOnlyRecall.wallClockMs,
    tableRecall.wallClockMs,
    mixedRecall.wallClockMs,
    memoryDocsRecall.wallClockMs,
    globalRecall.wallClockMs,
    noChatLeak.wallClockMs,
    noUserLeak.wallClockMs,
  ].sort((a, b) => a - b);
  const p50 = wallClockSamples[Math.floor(wallClockSamples.length * 0.5)] ?? 0;
  const p95 = wallClockSamples[Math.min(wallClockSamples.length - 1, Math.floor(wallClockSamples.length * 0.95))] ?? 0;

    console.log('MM Docs large-context stress: PASS');
    console.log(
      JSON.stringify(
        {
          model: process.env.LEGAL_AGENT_MODEL_ID,
          tenant_id: tenantId,
          user_id: userId,
          project_id: projectId,
          conversation_a: conversationA,
          conversation_b: conversationB,
          checks: {
            docsOnlyRecall,
            tableRecall,
            mixedRecall,
            memoryDocsRecall,
            globalRecall,
            noChatLeak,
            noUserLeak,
          },
          latency_ms: {
            p50,
            p95,
            samples: wallClockSamples,
          },
        },
        null,
        2
      )
    );
  } finally {
    if (serverProc) {
      await shutdownServer(serverProc);
    }
  }
}

main().catch((err) => {
  console.error('MM Docs large-context stress: FAIL');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
