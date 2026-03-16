/**
 * Dev Chat Core — runOnce (POST + poll) and fetchRunSummary (DB).
 * Used by single-shot CLI and interactive REPL. No duplicate logic.
 */
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 120_000;

export type ChatMode = 'dry' | 'real';

export interface RunOnceOptions {
  message: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  mode: ChatMode;
  prompt_stack?: Record<string, string>;
  project_id?: string;
}

export interface RunResult {
  run_id: string;
  status: string;
  total_ms: number;
  answerText: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  evidence_insufficient?: boolean;
  lawCount?: number;
  memoryCount?: number;
  historyCount?: number;
  triage_used?: boolean;
  triage_selected_count?: number;
  warnings?: string[];
}

interface GetRunPayload {
  run_id: string;
  status: string;
  assembled_prompt?: {
    sources?: { lawCount?: number; memoryCount?: number; historyCount?: number };
    meta?: { sources?: { lawCount?: number; memoryCount?: number; historyCount?: number } };
  };
  llm_result?: {
    answerText?: string;
    answer?: string;
    usage?: RunResult['usage'];
    model_id?: string;
    model?: string;
    evidence_insufficient?: boolean;
    triage_used?: boolean;
    triage_selected_count?: number;
    warnings?: string[];
  };
  retrieval_trace?: { lawCount?: number; memoryCount?: number; memory_count?: number; hits_count?: number };
  snapshot?: {
    source_summary?: { law_count?: number | null; memory_count?: number | null; history_count?: number | null };
    u10_selection?: { triage_used?: boolean; law_source_ids_selected?: unknown[] };
  };
}

function extractRunResult(
  run: GetRunPayload,
  totalMs: number
): RunResult {
  const llm = run.llm_result;
  const answerText = llm?.answerText ?? llm?.answer ?? '(no llm_result.answerText)';
  const sourceSummary = run.snapshot?.source_summary;
  const assembledSources = run.assembled_prompt?.sources ?? run.assembled_prompt?.meta?.sources;
  const trace = run.retrieval_trace;
  const triageSelection = run.snapshot?.u10_selection;
  return {
    run_id: run.run_id,
    status: run.status,
    total_ms: totalMs,
    answerText: typeof answerText === 'string' ? answerText : JSON.stringify(answerText),
    usage: llm?.usage,
    model: llm?.model_id ?? llm?.model,
    evidence_insufficient: llm?.evidence_insufficient,
    lawCount:
      sourceSummary?.law_count ??
      assembledSources?.lawCount ??
      trace?.lawCount ??
      trace?.hits_count,
    memoryCount:
      sourceSummary?.memory_count ??
      assembledSources?.memoryCount ??
      trace?.memoryCount ??
      trace?.memory_count,
    historyCount:
      sourceSummary?.history_count ??
      assembledSources?.historyCount,
    triage_used: triageSelection?.triage_used ?? llm?.triage_used,
    triage_selected_count:
      Array.isArray(triageSelection?.law_source_ids_selected)
        ? triageSelection!.law_source_ids_selected!.length
        : llm?.triage_selected_count,
    warnings: llm?.warnings,
  };
}

/**
 * Run one request: start server (if not provided), POST /v1/runs, poll until completed/failed.
 * Sets LEGAL_AGENT_DISABLE_LLM based on options.mode before importing server.
 */
export async function runOnce(
  options: RunOnceOptions,
  opts?: { baseUrl?: string; serverStart?: () => Promise<{ port: number }> }
): Promise<RunResult> {
  const { message, tenant_id, user_id, conversation_id, mode, prompt_stack, project_id } = options;

  if (mode === 'real') {
    const key = process.env.OPENROUTER_API_KEY_BRAIN || process.env.OPENROUTER_API_KEY_ONLINE || '';
    if (!key || key.length < 10) {
      throw new Error('Real LLM requires OPENROUTER_API_KEY_BRAIN (or OPENROUTER_API_KEY_ONLINE). Set env and retry.');
    }
  }

  process.env.LEGAL_AGENT_DISABLE_LLM = mode === 'dry' ? 'true' : 'false';

  const startServer = opts?.serverStart ?? (async () => {
    const { start } = await import('../../server.js');
    return start(0);
  });

  const { port } = await startServer();
  const base = opts?.baseUrl ?? `http://127.0.0.1:${port}`;

  const devApiKey = process.env.DEV_API_KEY ?? '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(devApiKey ? { 'X-Dev-API-Key': devApiKey } : {}),
    ...(!devApiKey ? { 'X-Tenant-Id': tenant_id, 'X-User-Id': user_id } : {}),
  };

  const body: Record<string, unknown> = {
    query: message,
    tenant_id,
    user_id,
    conversation_id,
    dry_run: false,
  };
  const clientContext: Record<string, unknown> = {};
  if (prompt_stack && Object.keys(prompt_stack).length > 0) clientContext.prompt_stack = prompt_stack;
  if (project_id) clientContext.project_id = project_id;
  if (Object.keys(clientContext).length > 0) body.client_context = clientContext;

  const created = await fetch(`${base}/v1/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!created.ok) {
    const text = await created.text();
    throw new Error(`POST /v1/runs failed: ${created.status} ${text}`);
  }

  const createdJson = (await created.json()) as { run_id: string; status: string };
  const runId = createdJson.run_id;
  if (!runId) throw new Error('No run_id in response');

  const startWall = Date.now();
  const getHeaders = { ...headers };
  delete (getHeaders as Record<string, string>)['Content-Type'];

  let run: GetRunPayload | null = null;
  while (Date.now() - startWall < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const getRes = await fetch(`${base}/v1/runs/${runId}?include_snapshot=true`, { headers: getHeaders });
    if (!getRes.ok) throw new Error(`GET /v1/runs/:id failed: ${getRes.status}`);
    run = (await getRes.json()) as GetRunPayload;
    if (run.status === 'completed' || run.status === 'failed') break;
  }

  const totalMs = Date.now() - startWall;
  if (!run || (run.status !== 'completed' && run.status !== 'failed')) {
    throw new Error(`Poll timeout; last status: ${run?.status ?? 'unknown'}`);
  }

  return extractRunResult(run, totalMs);
}

/**
 * Fetch minimal run summary from Supabase (status, completed_at, assembled counts, llm usage).
 * Use for DB verification without MCP.
 */
export interface RunSummaryFromDb {
  run_id: string;
  status: string;
  completed_at: string | null;
  has_assembled: boolean;
  has_llm_result: boolean;
  lawCount?: number;
  memoryCount?: number;
  usage?: RunResult['usage'];
}

export async function fetchRunSummary(runId: string): Promise<RunSummaryFromDb | null> {
  try {
    const { RunRepository } = await import('../../gateway/storage.js');
    const repo = new RunRepository();
    const run = await repo.findByRunId(runId);
    if (!run) return null;

    const assembled = run.assembled_prompt as { meta?: { sources?: { lawCount?: number; memoryCount?: number; historyCount?: number } } } | undefined;
    const meta = assembled?.meta?.sources;
    const llm = run.llm_result as { usage?: RunResult['usage'] } | undefined;

    return {
      run_id: run.run_id,
      status: run.status,
      completed_at: (run as { completed_at?: string | null }).completed_at ?? null,
      has_assembled: run.assembled_prompt != null,
      has_llm_result: run.llm_result != null,
      lawCount: meta?.lawCount,
      memoryCount: meta?.memoryCount,
      usage: llm?.usage,
    };
  } catch {
    return null;
  }
}

/** Default seed UUIDs (same as seed-dev-user). */
export const DEV_TENANT = '00000000-0000-0000-0000-000000000001';
export const DEV_USER = '00000000-0000-0000-0000-000000000002';
export const DEV_CONV = '00000000-0000-0000-0000-000000000003';
