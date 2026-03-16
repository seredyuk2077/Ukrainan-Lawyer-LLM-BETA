#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { join } from 'path';
import { tmpdir } from 'os';
import { config as loadEnv } from 'dotenv';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { countArticleRefs } from '../../write/outputValidator.js';
import { buildTextPdfBuffer, canBuildTextPdf } from './pdf-fixture.js';
import { buildMinimalXlsxBuffer } from './xlsx-fixture.js';
import { buildTextImagePngBuffer, canBuildTextImagePng } from './image-fixture.js';
import { hasExplicitLegalReferenceRequest, isExplicitUserDocumentQuery } from '../../lib/queryScopeHints.js';

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
if (!process.env.REDIS_QUEUE_NAMESPACE) {
  process.env.REDIS_QUEUE_NAMESPACE = `lexery:mm-docs:pipeline:${randomUUID()}`;
}

const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;

function normalizeEndpoint(value: string | undefined | null): string {
  return (value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contains(text: string | null | undefined, needle: string): boolean {
  if (!text) return false;
  return normalize(text).includes(normalize(needle));
}

function assertDocsOnlyNoInventedLaw(run: CompletedRun, label: string): void {
  const explicitDocQuery = isExplicitUserDocumentQuery(run.query) && !hasExplicitLegalReferenceRequest(run.query);
  if (!explicitDocQuery) return;
  assert(countArticleRefs(run.answerText) === 0, `${label} must not invent legal article citations when law evidence is absent`);
  assert(!/^\s*•?\s*норма(?:\s*\(.*?\))?\s*:/im.test(run.answerText), `${label} must not emit legal norm section when law evidence is absent`);
  assert(
    !/витяг(?:и)?\s+з\s+норм\s+законодавства|норм(?:и|а)?\s+законодавств(?:а|о)?|законодавств(?:о|а)?\s+не\s+було\s+надано|правов(?:а|і)\s+норм|внутрішнь(?:ої|я)\s+бази\s+lexery|internal\s+legislation\s+database/i.test(run.answerText),
    `${label} must not mention legal framing or LLDBI when explicit docs-only query has no law evidence`
  );
}

type ScopeContext = {
  tenantId: string;
  userId: string;
  conversationId: string;
  projectId?: string | null;
};

type InlineAttachment = {
  name: string;
  contentType: string;
  buffer: Buffer;
};

type PresignedUrlAttachment = {
  name: string;
  contentType: string;
  presignedUrl: string;
};

type SubmitRunAttachment = InlineAttachment | PresignedUrlAttachment;

type CompletedRun = {
  runId: string;
  answerText: string;
  status: string;
  docCount: number;
  lawCount: number;
  memoryCount: number;
  historyCount: number;
  assembledDocCount: number;
  query: string;
  planUseLldbi: boolean | null;
  planUseMemory: boolean | null;
  planStepKinds: string[];
  planReasonCodes: string[];
};

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
    sb.from('tenants').upsert({ id: tenantId, name: `MM Docs ${tenantId.slice(0, 8)}`, settings: {}, updated_at: now }, { onConflict: 'id' })
  );
  if (te && te.code !== '23505') throw new Error(`tenants upsert: ${te.message}`);
  const { error: ce } = await retryIo('chat_sessions upsert', () =>
    sb.from('chat_sessions').upsert({ id: conversationId, tenant_id: tenantId, user_id: userId, updated_at: now }, { onConflict: 'id' })
  );
  if (ce && ce.code !== '23505') throw new Error(`chat_sessions upsert: ${ce.message}`);
}

async function buildContractDocx(params: {
  title: string;
  clause: string;
  counterparty: string;
  amount: string;
  note: string;
}): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: params.title, bold: true })] }),
          new Paragraph(`Контрагент: ${params.counterparty}`),
          new Paragraph(`Ключова умова: ${params.clause}`),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Показник')] }),
                  new TableCell({ children: [new Paragraph('Значення')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Сума')] }),
                  new TableCell({ children: [new Paragraph(params.amount)] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Примітка')] }),
                  new TableCell({ children: [new Paragraph(params.note)] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function canBuildLegacyDoc(): boolean {
  return spawnSync('which', ['textutil']).status === 0;
}

function buildLegacyDocBuffer(lines: string[]): Buffer {
  const tempDir = mkdtempSync(join(tmpdir(), 'mm-doc-legacy-doc-'));
  try {
    const txtPath = join(tempDir, 'input.txt');
    const docPath = join(tempDir, 'input.doc');
    writeFileSync(txtPath, `${lines.join('\n')}\n`, 'utf8');
    execFileSync('textutil', ['-convert', 'doc', txtPath, '-output', docPath], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return readFileSync(docPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
      if (res.status === 503 && /DB_READ_FAIL|Database temporarily unavailable/i.test(text)) {
        continue;
      }
      throw new Error(`GET /v1/runs/${runId} failed: ${res.status} ${text}`);
    }
    const run = (await res.json()) as Record<string, unknown>;
    const status = String(run.status ?? '');
    if (status === 'completed' || status === 'failed') return run;
  }
  throw new Error(`Timeout waiting for run completion: ${runId}`);
}

async function submitRun(params: {
  base: string;
  headers: Record<string, string>;
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>;
  repo: import('../../gateway/storage.js').RunRepository;
  scope: ScopeContext;
  query: string;
  requestedScope?: 'conversation' | 'project' | 'user_global';
  attachment?: SubmitRunAttachment;
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
    const attachmentPayload =
      'buffer' in params.attachment
        ? {
            name: params.attachment.name,
            contentType: params.attachment.contentType,
            contentBase64: params.attachment.buffer.toString('base64'),
          }
        : {
            name: params.attachment.name,
            contentType: params.attachment.contentType,
            presignedUrl: params.attachment.presignedUrl,
          };
    body.attachments = [
      attachmentPayload,
    ];
  }

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

  const run = await pollCompletedRun(params.base, postBody.run_id, { 'X-Dev-API-Key': DEV_KEY });
  const persisted = await params.repo.findByRunId(postBody.run_id);
  if (!persisted) throw new Error(`Run not found after completion: ${postBody.run_id}`);
  const answerText = await findAssistantAnswer(params.sb, params.scope.conversationId, postBody.run_id);
  const sourceSummary =
    persisted.snapshot && typeof persisted.snapshot === 'object' && !Array.isArray(persisted.snapshot)
      ? ((persisted.snapshot as Record<string, unknown>).source_summary as Record<string, unknown> | undefined)
      : undefined;
  const assembledSources =
    persisted.assembled_prompt && typeof persisted.assembled_prompt === 'object' && !Array.isArray(persisted.assembled_prompt)
      ? ((((persisted.assembled_prompt as Record<string, unknown>).sources as Record<string, unknown> | undefined) ??
          (((persisted.assembled_prompt as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.sources ??
            {})) as Record<string, unknown>)
      : {};
  const searchPlanAudit =
    persisted.search_plan && typeof persisted.search_plan === 'object' && !Array.isArray(persisted.search_plan)
      ? (persisted.search_plan as Record<string, unknown>)
      : {};
  const persistedPlan =
    searchPlanAudit.plan && typeof searchPlanAudit.plan === 'object' && !Array.isArray(searchPlanAudit.plan)
      ? (searchPlanAudit.plan as Record<string, unknown>)
      : {};
  const persistedSteps = Array.isArray(searchPlanAudit.steps) ? searchPlanAudit.steps as Array<Record<string, unknown>> : [];

  return {
    runId: postBody.run_id,
    answerText,
    status: String(run.status ?? persisted.status ?? ''),
    docCount: Number(sourceSummary?.document_count ?? 0),
    lawCount: Number(sourceSummary?.law_count ?? 0),
    memoryCount: Number(sourceSummary?.memory_count ?? 0),
    historyCount: Number(sourceSummary?.history_count ?? 0),
    assembledDocCount: Number(assembledSources.docCount ?? 0),
    query: params.query,
    planUseLldbi:
      typeof (persistedPlan.sources as Record<string, unknown> | undefined)?.use_lldbi === 'boolean'
        ? Boolean((persistedPlan.sources as Record<string, unknown>).use_lldbi)
        : null,
    planUseMemory:
      typeof (persistedPlan.sources as Record<string, unknown> | undefined)?.use_memory === 'boolean'
        ? Boolean((persistedPlan.sources as Record<string, unknown>).use_memory)
        : null,
    planStepKinds: persistedSteps
      .map((step) => (typeof step.kind === 'string' ? step.kind : null))
      .filter((kind): kind is string => Boolean(kind)),
    planReasonCodes: Array.isArray(persistedPlan.reason_codes)
      ? persistedPlan.reason_codes.filter((code): code is string => typeof code === 'string')
      : [],
  };
}

async function findMmDocRawKeyByRunId(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  runId: string
): Promise<string> {
  const { data, error } = await retryIo('find mm doc raw key by run id', () =>
    sb
      .from('mm_doc_records')
      .select('raw_r2_key, created_at')
      .eq('source_run_id', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  if (error) throw new Error(`mm_doc_records lookup failed for ${runId}: ${error.message}`);
  if (!data?.raw_r2_key) throw new Error(`raw_r2_key not found for source_run_id=${runId}`);
  return String(data.raw_r2_key);
}

async function countMmDocRecordsBySourceRunId(
  sb: ReturnType<typeof import('../../lib/supabase.js').getSupabaseClient>,
  runId: string
): Promise<number> {
  const { count, error } = await retryIo('count mm doc records by source run', () =>
    sb
      .from('mm_doc_records')
      .select('id', { count: 'exact', head: true })
      .eq('source_run_id', runId)
  );
  if (error) throw new Error(`mm_doc_records count failed for ${runId}: ${error.message}`);
  return Number(count ?? 0);
}

async function main(): Promise<void> {
  const { start } = await import('../../server.js');
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const { RunRepository } = await import('../../gateway/storage.js');
  const { ensureMmDocTablesReady } = await import('../../mm/doc/store.js');
  const { ensureMmDocsCollection } = await import('../../mm/doc/qdrant.js');
  const { runOutboxWorkerBatch } = await import('../../mm/outboxWorker.js');
  const { config } = await import('../../lib/config.js');
  const resolvedDocsQdrantEndpoint = normalizeEndpoint(config.mmDocsQdrantUrl);
  const dedicatedQdrantConfigured = Boolean(
    process.env.MM_DOCS_QDRANT_URL ||
      process.env.QDRANT_DOCS_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA_DOCS
  );
  const qdrantSharedWithMemory = Boolean(
    resolvedDocsQdrantEndpoint &&
      normalizeEndpoint(
        process.env.QDRANT_MEMORY_URL ||
          process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
          process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
          process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
          ''
      ) &&
      resolvedDocsQdrantEndpoint ===
        normalizeEndpoint(
          process.env.QDRANT_MEMORY_URL ||
            process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
            process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
            process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
            ''
        )
  );

  assert(config.mmDocsEnabled, 'MM Docs must be enabled');
  assert(config.mmDocsQdrantUrl && config.mmDocsQdrantApiKey, 'MM Docs Qdrant must be configured');
  await ensureMmDocTablesReady();
  await ensureMmDocsCollection();

  const sb = getSupabaseClient();
  const repo = new RunRepository();
  const { port, close } = await start(0);
  const cleanupConversationIds: string[] = [];

  try {
    const base = `http://127.0.0.1:${port}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Dev-API-Key': DEV_KEY,
    };

    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const projectA = randomUUID();
    const convA1 = randomUUID();
    const convA2 = randomUUID();
    const convA3 = randomUUID();
    const convA4 = randomUUID();
    const convB1 = randomUUID();
    const convTenantB = randomUUID();
    cleanupConversationIds.push(convA1, convA2, convA3, convA4, convB1, convTenantB);

    for (const [tenantId, userId, conversationId] of [
      [tenantA, userA, convA1],
      [tenantA, userA, convA2],
      [tenantA, userA, convA3],
      [tenantA, userA, convA4],
      [tenantA, userB, convB1],
      [tenantB, userA, convTenantB],
    ] as const) {
      await ensureConversation(sb, tenantId, userId, conversationId);
    }

    const contractDoc = await buildContractDocx({
      title: 'Договір поставки яблук',
      clause: 'штраф за прострочення поставки яблук становить 12 відсотків за кожен день затримки',
      counterparty: 'ТОВ Альфа Сад',
      amount: '120000 грн',
      note: 'CHAT_SCOPE_NEEDLE',
    });
    const projectCsv = Buffer.from(
      ['field,value', 'guarantee_term,гарантійний платіж повертається за 7 банківських днів', 'marker,PROJECT_SCOPE_NEEDLE'].join('\n'),
      'utf8'
    );
    const projectSheet = buildMinimalXlsxBuffer({
      sheetName: 'ProjectTerms',
      rows: [
        ['Показник', 'Значення'],
        ['Передсудове врегулювання', '15 робочих днів'],
        ['Маркер', 'PROJECT_XLSX_NEEDLE'],
      ],
    });
    const globalText = Buffer.from(
      'Арбітражна обмовка: усі спори розглядаються за правилами ICC у Парижі англійською мовою. GLOBAL_SCOPE_NEEDLE',
      'utf8'
    );
    const projectPdf = canBuildTextPdf()
      ? buildTextPdfBuffer(
          [
            'Додаток до договору escrow',
            'Строк оплати escrow-платежу становить 21 календарний день.',
            'PDF_SCOPE_NEEDLE',
          ].join('\n')
        )
      : null;
    const projectImage = canBuildTextImagePng()
      ? buildTextImagePngBuffer({
          filenameBase: 'project-visual-term',
          text: [
            'Візуальний додаток до договору',
            'Ліміт відповідальності становить 250000 грн.',
            'PROJECT_IMAGE_NEEDLE',
          ].join('\n'),
        })
      : null;
    const projectRtf = Buffer.from(
      [
        '{\\rtf1\\ansi\\deff0',
        '{\\fonttbl{\\f0 Times New Roman;}}',
        '\\f0\\fs24',
        'Додаток до проектного договору.\\par',
        'Повідомлення про дефект подається за 48 годин.\\par',
        'PROJECT_RTF_NEEDLE',
        '}',
      ].join(''),
      'utf8'
    );
    const projectLegacyDoc = canBuildLegacyDoc()
      ? buildLegacyDocBuffer([
          'Старий договір у форматі DOC',
          'Неустойка за прострочення усунення дефекту становить 9 відсотків.',
          'PROJECT_DOC_NEEDLE',
        ])
      : null;
    const foreignChatText = Buffer.from(
      'У цій іншій розмові є унікальна умова: штраф 99 відсотків за манго. FOREIGN_CHAT_NEEDLE',
      'utf8'
    );
    const foreignUserText = Buffer.from(
      'Документ іншого користувача: депозит повертається через 90 днів. FOREIGN_USER_NEEDLE',
      'utf8'
    );
    const foreignTenantText = Buffer.from(
      'Той самий користувач, але інший tenant: аванс повертається через 33 дні. FOREIGN_TENANT_NEEDLE',
      'utf8'
    );

    const seedRuns = [
      await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
      requestedScope: 'conversation',
      query: 'Який штраф за прострочення поставки яблук у завантаженому договорі?',
      attachment: {
        name: 'chat-contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: contractDoc,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
      requestedScope: 'project',
      query: 'Коли повертається гарантійний платіж у цьому документі?',
      attachment: {
        name: 'project-terms.csv',
        contentType: 'text/csv',
        buffer: projectCsv,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
      requestedScope: 'project',
      query: 'Який строк передсудового врегулювання у моїй проектній таблиці?',
      attachment: {
        name: 'project-terms.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: projectSheet,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA1 },
      requestedScope: 'user_global',
      query: 'Яка арбітражна обмовка у цьому документі?',
      attachment: {
        name: 'global-policy.txt',
        contentType: 'text/plain',
        buffer: globalText,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA2, projectId: projectA },
      requestedScope: 'conversation',
      query: 'Яка умова про штраф за манго у цьому документі?',
      attachment: {
        name: 'foreign-chat.txt',
        contentType: 'text/plain',
        buffer: foreignChatText,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userB, conversationId: convB1 },
      requestedScope: 'conversation',
      query: 'Через скільки днів повертається депозит у цьому документі?',
      attachment: {
        name: 'foreign-user.txt',
        contentType: 'text/plain',
        buffer: foreignUserText,
      },
    }),
    await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantB, userId: userA, conversationId: convTenantB },
      requestedScope: 'conversation',
      query: 'Через скільки днів повертається аванс у цьому документі?',
      attachment: {
        name: 'foreign-tenant.txt',
        contentType: 'text/plain',
        buffer: foreignTenantText,
      },
    }),
  ];
    if (projectPdf) {
      seedRuns.push(
        await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
          requestedScope: 'project',
          query: 'Який строк оплати в моєму pdf документі цього проєкту?',
          attachment: {
            name: 'project-escrow.pdf',
            contentType: 'application/pdf',
            buffer: projectPdf,
          },
        })
      );
    }
    if (projectImage) {
      seedRuns.push(
        await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
          requestedScope: 'project',
          query: 'Який ліміт відповідальності у моєму зображенні цього проєкту?',
          attachment: {
            name: 'project-visual-term.png',
            contentType: 'image/png',
            buffer: projectImage,
          },
        })
      );
    }
    seedRuns.push(
      await submitRun({
        base,
        headers,
        sb,
        repo,
        scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
        requestedScope: 'project',
        query: 'Який строк повідомлення про дефект у моєму rtf документі цього проєкту?',
        attachment: {
          name: 'project-notice.rtf',
          contentType: 'application/rtf',
          buffer: projectRtf,
        },
      })
    );

    assert(seedRuns.every((run) => run.status === 'completed'), 'all seed runs must complete');
    assert(seedRuns.every((run) => run.docCount >= 1), 'all seed runs must have doc evidence');

    const foreignUserRawKey = await findMmDocRawKeyByRunId(sb, seedRuns[5]!.runId);
    const foreignTenantRawKey = await findMmDocRawKeyByRunId(sb, seedRuns[6]!.runId);
    const projectLegacyDocSeed = projectLegacyDoc
      ? await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
          requestedScope: 'project',
          query: 'Яка неустойка у моєму старому doc документі цього проєкту?',
          attachment: {
            name: 'project-legacy-terms.doc',
            contentType: 'application/msword',
            buffer: projectLegacyDoc,
          },
        })
      : null;
    if (projectLegacyDocSeed) {
      assert(projectLegacyDocSeed.status === 'completed', 'legacy doc seed run must complete');
      assert(projectLegacyDocSeed.docCount >= 1, 'legacy doc seed run must have doc evidence');
    }
    const mmDocsBucket = config.mmDocsBucket || config.r2BucketRuns;
    assert(config.r2Endpoint && mmDocsBucket, 'R2 endpoint and MM Docs bucket must be configured for internal URL attack checks');
    const foreignUserRawUrl = `${config.r2Endpoint}/${mmDocsBucket}/${encodeURI(foreignUserRawKey)}?sig=attack-check`;
    const foreignTenantRawUrl = `${config.r2Endpoint}/${mmDocsBucket}/${encodeURI(foreignTenantRawKey)}?sig=attack-check`;

    const checks = await Promise.all([
      submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA1, projectId: projectA },
      query: 'Повтори лише розмір штрафу за прострочення поставки яблук з мого документа.',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      query: 'Коли повертається гарантійний платіж у моїх документах цього проєкту?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      query: 'Який строк передсудового врегулювання у моїй проектній таблиці?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      query: 'Яка арбітражна обмовка в моїх завантажених документах?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA4 },
      query: 'Яка арбітражна обмовка в моїх завантажених документах?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      query: 'манго 99 відсотків FOREIGN_CHAT_NEEDLE',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userB, conversationId: convB1 },
      query: 'Яка арбітражна обмовка в моїх документах?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantB, userId: userA, conversationId: convTenantB },
      query: 'Яка арбітражна обмовка в моїх документах?',
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      requestedScope: 'conversation',
      query: 'Що сказано у моєму щойно доданому документі про повернення депозиту?',
      attachment: {
        name: 'foreign-user-raw-ref.txt',
        contentType: 'text/plain',
        presignedUrl: foreignUserRawUrl,
      },
    }),
    submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      requestedScope: 'conversation',
      query: 'Що сказано у моєму щойно доданому документі про повернення авансу?',
      attachment: {
        name: 'foreign-tenant-raw-ref.txt',
        contentType: 'text/plain',
        presignedUrl: foreignTenantRawUrl,
      },
    }),
  ]);

    const [
      ownConversationRecall,
      projectRecall,
      projectXlsxRecall,
      globalRecall,
      globalRecallNoProject,
      noChatLeak,
      noUserLeak,
      noTenantLeak,
      foreignUserAttachmentLeak,
      foreignTenantAttachmentLeak,
    ] = checks;
    const projectPdfRecall = projectPdf
      ? await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
          query: 'Який строк оплати в моєму pdf документі цього проєкту?',
        })
      : null;
    const projectImageRecall = projectImage
      ? await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
          query: 'Який ліміт відповідальності у моєму зображенні цього проєкту?',
        })
      : null;
    const projectLegacyDocRecall = projectLegacyDoc
      ? await submitRun({
          base,
          headers,
          sb,
          repo,
          scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
          query: 'Яка неустойка у моєму старому doc документі цього проєкту?',
        })
      : null;
    const projectRtfRecall = await submitRun({
      base,
      headers,
      sb,
      repo,
      scope: { tenantId: tenantA, userId: userA, conversationId: convA3, projectId: projectA },
      query: 'Який строк повідомлення про дефект у моєму rtf документі цього проєкту?',
    });

    assert(contains(ownConversationRecall.answerText, '12 відсотків'), 'conversation recall must quote the contract penalty');
    assert(ownConversationRecall.docCount >= 1 && ownConversationRecall.assembledDocCount >= 1, 'conversation recall must use docs evidence');

    assert(contains(projectRecall.answerText, '7 банківських днів'), 'project recall must find project-scope clause');
    assert(projectRecall.docCount >= 1, 'project recall must use docs evidence');
    assertDocsOnlyNoInventedLaw(projectRecall, 'project recall');
    assert(projectRecall.planUseLldbi === false, 'project recall should disable LLDBI in U3 for explicit docs-only query');
    assert(projectRecall.planUseMemory === false, 'project recall should disable memory for explicit docs-only query');
    assert(projectRecall.memoryCount === 0, 'project recall should not pull unrelated memory for explicit docs-only query');
    assert(projectRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project recall should avoid LLDBI search steps');

    assert(
      contains(projectXlsxRecall.answerText, '15 робочих днів'),
      'project xlsx recall must find project-scope spreadsheet clause'
    );
    assert(projectXlsxRecall.docCount >= 1, 'project xlsx recall must use docs evidence');
    assertDocsOnlyNoInventedLaw(projectXlsxRecall, 'project xlsx recall');
    assert(projectXlsxRecall.planUseLldbi === false, 'project xlsx recall should disable LLDBI in U3 for explicit docs-only query');
    assert(projectXlsxRecall.planUseMemory === false, 'project xlsx recall should disable memory for explicit docs-only query');
    assert(projectXlsxRecall.memoryCount === 0, 'project xlsx recall should not pull unrelated memory');
    assert(projectXlsxRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project xlsx recall should avoid LLDBI search steps');

    if (projectPdfRecall) {
      assert(
        contains(projectPdfRecall.answerText, '21 календарний день'),
        'project pdf recall must find project-scope PDF clause'
      );
      assert(projectPdfRecall.docCount >= 1, 'project pdf recall must use docs evidence');
      assertDocsOnlyNoInventedLaw(projectPdfRecall, 'project pdf recall');
      assert(projectPdfRecall.planUseLldbi === false, 'project pdf recall should disable LLDBI in U3 for explicit docs-only query');
      assert(projectPdfRecall.planUseMemory === false, 'project pdf recall should disable memory for explicit docs-only query');
      assert(projectPdfRecall.memoryCount === 0, 'project pdf recall should not pull unrelated memory');
      assert(projectPdfRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project pdf recall should avoid LLDBI search steps');
    }
    if (projectImageRecall) {
      assert(
        contains(projectImageRecall.answerText, '250000 грн'),
        'project image recall must find project-scope image clause'
      );
      assert(projectImageRecall.docCount >= 1, 'project image recall must use docs evidence');
      assertDocsOnlyNoInventedLaw(projectImageRecall, 'project image recall');
      assert(projectImageRecall.planUseLldbi === false, 'project image recall should disable LLDBI in U3 for explicit docs-only query');
      assert(projectImageRecall.planUseMemory === false, 'project image recall should disable memory for explicit docs-only query');
      assert(projectImageRecall.memoryCount === 0, 'project image recall should not pull unrelated memory');
      assert(projectImageRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project image recall should avoid LLDBI search steps');
    }
    if (projectLegacyDocRecall) {
      assert(
        contains(projectLegacyDocRecall.answerText, '9 відсотків'),
        'project legacy doc recall must find project-scope DOC clause'
      );
      assert(projectLegacyDocRecall.docCount >= 1, 'project legacy doc recall must use docs evidence');
      assertDocsOnlyNoInventedLaw(projectLegacyDocRecall, 'project legacy doc recall');
      assert(projectLegacyDocRecall.planUseLldbi === false, 'project legacy doc recall should disable LLDBI in U3 for explicit docs-only query');
      assert(projectLegacyDocRecall.planUseMemory === false, 'project legacy doc recall should disable memory for explicit docs-only query');
      assert(projectLegacyDocRecall.memoryCount === 0, 'project legacy doc recall should not pull unrelated memory');
      assert(projectLegacyDocRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project legacy doc recall should avoid LLDBI search steps');
    }

    assert(
      contains(projectRtfRecall.answerText, '48 годин'),
      'project rtf recall must find project-scope RTF clause'
    );
    assert(projectRtfRecall.docCount >= 1, 'project rtf recall must use docs evidence');
    assertDocsOnlyNoInventedLaw(projectRtfRecall, 'project rtf recall');
    assert(projectRtfRecall.planUseLldbi === false, 'project rtf recall should disable LLDBI in U3 for explicit docs-only query');
    assert(projectRtfRecall.planUseMemory === false, 'project rtf recall should disable memory for explicit docs-only query');
    assert(projectRtfRecall.memoryCount === 0, 'project rtf recall should not pull unrelated memory');
    assert(projectRtfRecall.planStepKinds.every((kind) => !kind.startsWith('lldbi')), 'project rtf recall should avoid LLDBI search steps');

    assert(contains(globalRecall.answerText, 'ICC') || contains(globalRecall.answerText, 'Парижі'), 'global recall must find global doc clause');
    assert(globalRecall.docCount >= 1, 'global recall must use docs evidence');
    assertDocsOnlyNoInventedLaw(globalRecall, 'global recall');
    assert(globalRecall.planUseLldbi === false, 'global recall should disable LLDBI for explicit docs-only query');
    assert(globalRecall.planUseMemory === false, 'global recall should disable memory for explicit docs-only query');
    assert(globalRecall.memoryCount === 0, 'global recall should not pull unrelated memory for explicit docs-only query');
    assert(
      contains(globalRecallNoProject.answerText, 'ICC') || contains(globalRecallNoProject.answerText, 'Парижі'),
      'global recall without project context must still find global doc clause'
    );
    assert(globalRecallNoProject.docCount >= 1, 'global recall without project context must use docs evidence');
    assertDocsOnlyNoInventedLaw(globalRecallNoProject, 'global recall without project context');
    assert(globalRecallNoProject.planUseLldbi === false, 'global recall without project context should disable LLDBI for explicit docs-only query');
    assert(globalRecallNoProject.planUseMemory === false, 'global recall without project context should disable memory for explicit docs-only query');
    assert(globalRecallNoProject.memoryCount === 0, 'global recall without project context should not pull unrelated memory');

    assert(!contains(noChatLeak.answerText, '99 відсотків') && !contains(noChatLeak.answerText, 'FOREIGN_CHAT_NEEDLE'), 'foreign conversation doc must not leak');
    assert(noChatLeak.docCount === 0, 'foreign conversation query in another chat should not retrieve docs');
    assertDocsOnlyNoInventedLaw(noChatLeak, 'foreign conversation docs lookup');

    assert(!contains(noUserLeak.answerText, 'ICC') && !contains(noUserLeak.answerText, 'GLOBAL_SCOPE_NEEDLE'), 'foreign user docs must not leak');
    assert(noUserLeak.docCount === 0, 'foreign user query should not retrieve docs');
    assert(noUserLeak.lawCount === 0, 'foreign user explicit docs query should not fall back to law snippets');
    assert(noUserLeak.planUseLldbi === false, 'foreign user explicit docs query should not use LLDBI');
    assertDocsOnlyNoInventedLaw(noUserLeak, 'foreign user docs lookup');

    assert(!contains(noTenantLeak.answerText, 'ICC') && !contains(noTenantLeak.answerText, 'GLOBAL_SCOPE_NEEDLE'), 'cross-tenant docs must not leak');
    assert(noTenantLeak.docCount === 0, 'cross-tenant query should not retrieve docs');
    assert(noTenantLeak.lawCount === 0, 'cross-tenant explicit docs query should not fall back to law snippets');
    assertDocsOnlyNoInventedLaw(noTenantLeak, 'cross-tenant docs lookup');

    assert(
      !contains(foreignUserAttachmentLeak.answerText, '90 днів') && !contains(foreignUserAttachmentLeak.answerText, 'FOREIGN_USER_NEEDLE'),
      'foreign user raw attachment ref must not leak foreign doc content'
    );
    assert(foreignUserAttachmentLeak.docCount === 0, 'foreign user raw attachment ref must not create doc evidence');
    assert(foreignUserAttachmentLeak.lawCount === 0, 'foreign user raw attachment ref explicit docs query should not fall back to law');
    assertDocsOnlyNoInventedLaw(foreignUserAttachmentLeak, 'foreign user raw attachment ref');
    assert(
      (await countMmDocRecordsBySourceRunId(sb, foreignUserAttachmentLeak.runId)) === 0,
      'foreign user raw attachment ref must not create mm_doc_records rows'
    );

    assert(
      !contains(foreignTenantAttachmentLeak.answerText, '33 дні') && !contains(foreignTenantAttachmentLeak.answerText, 'FOREIGN_TENANT_NEEDLE'),
      'foreign tenant raw attachment ref must not leak foreign tenant doc content'
    );
    assert(foreignTenantAttachmentLeak.docCount === 0, 'foreign tenant raw attachment ref must not create doc evidence');
    assert(foreignTenantAttachmentLeak.lawCount === 0, 'foreign tenant raw attachment ref explicit docs query should not fall back to law');
    assertDocsOnlyNoInventedLaw(foreignTenantAttachmentLeak, 'foreign tenant raw attachment ref');
    assert(
      (await countMmDocRecordsBySourceRunId(sb, foreignTenantAttachmentLeak.runId)) === 0,
      'foreign tenant raw attachment ref must not create mm_doc_records rows'
    );

    console.log('MM Docs pipeline live: PASS');
    console.log(
      JSON.stringify(
        {
          model: process.env.LEGAL_AGENT_MODEL_ID,
          prompt_composer_enabled: process.env.PROMPT_COMPOSER_ENABLED,
          dedicated_qdrant_configured: dedicatedQdrantConfigured,
          qdrant_shared_with_memory: qdrantSharedWithMemory,
          docs_seeded: seedRuns.length,
          tenant_a: tenantA,
          tenant_b: tenantB,
          user_a: userA,
          user_b: userB,
          conversation_a1: convA1,
          conversation_a2: convA2,
          conversation_a3: convA3,
          conversation_a4: convA4,
          conversation_b1: convB1,
          conversation_tenant_b: convTenantB,
          seed_runs: seedRuns.map((run) => ({
            run_id: run.runId,
            doc_count: run.docCount,
            law_count: run.lawCount,
            memory_count: run.memoryCount,
            plan_use_lldbi: run.planUseLldbi,
            plan_use_memory: run.planUseMemory,
            plan_step_kinds: run.planStepKinds,
          })),
          checks: {
            ownConversationRecall,
            projectRecall,
            projectXlsxRecall,
            projectPdfRecall,
            projectImageRecall,
            projectRtfRecall,
            globalRecall,
            globalRecallNoProject,
            noChatLeak,
            noUserLeak,
            noTenantLeak,
            foreignUserAttachmentLeak,
            foreignTenantAttachmentLeak,
          },
        },
        null,
        2
      )
    );
  } finally {
    for (const conversationId of cleanupConversationIds) {
      for (let i = 0; i < 6; i++) {
        const batch = await runOutboxWorkerBatch({ conversationId, batchSize: 10, runId: `mm-doc-pipeline-cleanup-${i}` });
        if ((batch.processed + batch.failed) === 0) break;
      }
    }
    await close();
  }
}

main().catch((err) => {
  console.error('MM Docs pipeline live: FAIL');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
