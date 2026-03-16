/**
 * Unit tests for dev_chat/core: runOnce (mock server), fetchRunSummary (mock repo optional).
 * No real LLM, no real HTTP to Lexery server.
 */
import { runOnce, fetchRunSummary, DEV_TENANT, DEV_USER, DEV_CONV } from './core.js';

const testRunId = '00000000-0000-0000-0000-000000000099';

async function createMockServer(completedPayload: Record<string, unknown>): Promise<{ port: number; close: () => void }> {
  const http = await import('node:http');
  let runPayload: Record<string, unknown> = { run_id: testRunId, status: 'Intake' };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? '';
    if (method === 'POST' && url === '/v1/runs') {
      let body = '';
      req.on('data', (ch) => { body += ch; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          runPayload = { ...completedPayload, run_id: testRunId, query: parsed.query };
        } catch {
          runPayload = { ...completedPayload, run_id: testRunId };
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: testRunId, status: 'accepted' }));
      });
      return;
    }
    if (method === 'GET' && url.startsWith(`/v1/runs/${testRunId}`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(runPayload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
    server.on('error', reject);
  });
}

async function test1_dryRunReturnsStub() {
  const completed = {
    status: 'completed',
    llm_result: {
      answerText: '[DRY_RUN] Legal agent disabled.',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model_id: 'stub',
    },
  };
  const { port, close } = await createMockServer(completed);
  try {
    const result = await runOnce(
      {
        message: 'Test query',
        tenant_id: DEV_TENANT,
        user_id: DEV_USER,
        conversation_id: DEV_CONV,
        mode: 'dry',
      },
      { baseUrl: `http://127.0.0.1:${port}`, serverStart: async () => ({ port }) }
    );
    if (result.status !== 'completed') throw new Error(`expected status completed, got ${result.status}`);
    if (!result.answerText.includes('DRY_RUN')) throw new Error('expected stub answer');
    if (result.run_id !== testRunId) throw new Error('run_id mismatch');
    console.log('[OK] test1: dry-run returns stub llm_result');
  } finally {
    close();
  }
}

async function test2_realModeWithoutApiKeyFails() {
  const orig = process.env.OPENROUTER_API_KEY_BRAIN;
  delete process.env.OPENROUTER_API_KEY_BRAIN;
  delete process.env.OPENROUTER_API_KEY_ONLINE;
  try {
    await runOnce(
      {
        message: 'Test',
        tenant_id: DEV_TENANT,
        user_id: DEV_USER,
        conversation_id: DEV_CONV,
        mode: 'real',
      },
      { serverStart: async () => ({ port: 0 }) }
    );
    throw new Error('expected runOnce to throw when real mode and no key');
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('OPENROUTER') && !msg.includes('Real LLM')) throw new Error('expected helpful message about API key, got: ' + msg);
    console.log('[OK] test2: real mode without API key fails with helpful message');
  } finally {
    if (orig !== undefined) process.env.OPENROUTER_API_KEY_BRAIN = orig;
  }
}

async function test3_promptStackPassedToPost() {
  let capturedBody: string | null = null;
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (ch) => { body += ch; });
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/v1/runs') {
        capturedBody = body;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: testRunId, status: 'accepted' }));
        return;
      }
      if (req.method === 'GET' && url.startsWith(`/v1/runs/${testRunId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ run_id: testRunId, status: 'completed', llm_result: { answerText: 'ok' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr?.port ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  await runOnce(
    {
      message: 'Q',
      tenant_id: DEV_TENANT,
      user_id: DEV_USER,
      conversation_id: DEV_CONV,
      mode: 'dry',
      prompt_stack: { user: 'Be concise.' },
    },
    { baseUrl, serverStart: async () => ({ port }) }
  );

  server.close();
  const parsed = capturedBody ? (JSON.parse(capturedBody) as Record<string, unknown>) : null;
  const ctx = parsed?.client_context as Record<string, unknown> | undefined;
  const stack = ctx?.prompt_stack as Record<string, string> | undefined;
  if (!stack?.user || stack.user !== 'Be concise.') throw new Error('prompt_stack not passed in body');
  console.log('[OK] test3: prompt_stack passed in POST body.client_context.prompt_stack');
}

async function test4_fetchRunSummaryReturnsNullForMissing() {
  const summary = await fetchRunSummary('00000000-0000-0000-0000-000000000000');
  // May be null if no DB or run missing; or an object if test DB has data. We only assert it doesn't throw.
  if (summary !== null && typeof summary.run_id !== 'string') throw new Error('fetchRunSummary should return null or valid summary');
  console.log('[OK] test4: fetchRunSummary does not throw (missing run => null or valid shape)');
}

async function main() {
  await test1_dryRunReturnsStub();
  await test2_realModeWithoutApiKeyFails();
  await test3_promptStackPassedToPost();
  await test4_fetchRunSummaryReturnsNullForMissing();
  console.log('\nAll dev_chat core unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
