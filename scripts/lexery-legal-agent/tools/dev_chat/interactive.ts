#!/usr/bin/env node
/**
 * Interactive dev chat (REPL): pnpm brain:chat or pnpm brain:chat:interactive.
 * Commands: /mode dry|real, /prompt show|set user, /new, /status, /run <msg>, /verbose on|off,
 *   /last, /runs [n], /unsafe-unlimited, /exit
 */
// Default auth for local CLI so server accepts tenant_id/user_id without DEV_API_KEY
if (process.env.DEV_ALLOW_ANONYMOUS === undefined) process.env.DEV_ALLOW_ANONYMOUS = 'true';

// DEV RUN v17: suppress structured logs in interactive so stdout stays clean (REPL UX)
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'warn';

import * as readline from 'node:readline';
import {
  runOnce,
  fetchRunSummary,
  DEV_TENANT,
  DEV_USER,
  DEV_CONV,
  type RunOnceOptions,
  type ChatMode,
} from './core.js';

const DEFAULT_MAX_REAL_RUNS = 2;
const SAFETY_LIMIT_MSG = `Safety: max 2 real LLM runs per session. Use /unsafe-unlimited to raise (requires confirmation).`;

interface SessionState {
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  mode: ChatMode;
  realLlmConfirmed: boolean;
  realRunCount: number;
  prompt_stack: Record<string, string>;
  verbose: boolean;
  serverStart?: () => Promise<{ port: number }>;
  maxRealRuns: number;
  /** Show safety notice once when entering real mode. */
  safetyNoticeShown: boolean;
  /** Show limit-reached message once per session. */
  safetyLimitShown: boolean;
  lastRunId: string | null;
  recentRunIds: string[];
}

function defaultState(maxRealRuns: number = DEFAULT_MAX_REAL_RUNS): SessionState {
  return {
    tenant_id: DEV_TENANT,
    user_id: DEV_USER,
    conversation_id: DEV_CONV,
    mode: 'dry',
    realLlmConfirmed: false,
    realRunCount: 0,
    prompt_stack: {},
    verbose: false,
    maxRealRuns,
    safetyNoticeShown: false,
    safetyLimitShown: false,
    lastRunId: null,
    recentRunIds: [],
  };
}

let serverPromise: Promise<{ port: number }> | null = null;

function getServerStart(): () => Promise<{ port: number }> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const { start } = await import('../../server.js');
      return start(0);
    })();
  }
  return () => serverPromise!;
}

function printRunSummary(result: Awaited<ReturnType<typeof runOnce>>) {
  console.log('\n--- Run summary ---');
  console.log('run_id:', result.run_id);
  console.log('total_ms:', result.total_ms);
  if (result.lawCount != null) console.log('lawCount:', result.lawCount);
  if (result.memoryCount != null) console.log('memoryCount:', result.memoryCount);
  if (result.triage_used != null) console.log('triage_used:', result.triage_used);
  if (result.triage_selected_count != null) console.log('triage_selected_count:', result.triage_selected_count);
  if (result.evidence_insufficient != null) console.log('evidence_insufficient:', result.evidence_insufficient);
  if (result.usage) console.log('usage:', JSON.stringify(result.usage));
  if (result.model) console.log('model:', result.model);
  if (result.warnings?.length) console.log('warnings:', result.warnings);
}

async function sendMessage(state: SessionState, message: string): Promise<SessionState> {
  if (state.mode === 'real') {
    if (!state.realLlmConfirmed) {
      console.log('Real LLM is off until you confirm. Type: YES (to allow real LLM for this session).');
      return state;
    }
    if (state.realRunCount >= state.maxRealRuns) {
      if (!state.safetyLimitShown) {
        console.log(SAFETY_LIMIT_MSG);
        state = { ...state, safetyLimitShown: true };
      } else {
        console.log('Limit reached. No more real runs this session.');
      }
      return state;
    }
  }

  const options: RunOnceOptions = {
    message,
    tenant_id: state.tenant_id,
    user_id: state.user_id,
    conversation_id: state.conversation_id,
    mode: state.mode,
    prompt_stack: Object.keys(state.prompt_stack).length > 0 ? state.prompt_stack : undefined,
  };

  const serverStart = state.serverStart ?? getServerStart();
  let result;
  try {
    result = await runOnce(options, { serverStart });
  } catch (err) {
    console.error('Error:', (err as Error).message);
    return state;
  }

  console.log('\nLexery:', result.answerText);
  printRunSummary(result);

  if (state.verbose) {
    const summary = await fetchRunSummary(result.run_id);
    if (summary) {
      console.log('DB: completed_at:', summary.completed_at ?? '—', 'has_assembled:', summary.has_assembled, 'has_llm_result:', summary.has_llm_result);
    }
  }

  const next = { ...state, serverStart };
  next.lastRunId = result.run_id;
  next.recentRunIds = [result.run_id, ...state.recentRunIds].slice(0, 20);
  if (state.mode === 'real') next.realRunCount = state.realRunCount + 1;
  return next;
}

function printStatus(state: SessionState) {
  console.log('--- Status ---');
  console.log('tenant_id:', state.tenant_id);
  console.log('user_id:', state.user_id);
  console.log('conversation_id:', state.conversation_id);
  console.log('mode:', state.mode);
  console.log('real_llm_confirmed:', state.realLlmConfirmed);
  console.log('real_run_count:', state.realRunCount);
  console.log('memory/triage: from env (MEMORY_SEMANTIC_ENABLED, EVIDENCE_TRIAGE_ENABLED) — restart to change');
  console.log('verbose:', state.verbose);
  const keys = Object.keys(state.prompt_stack);
  if (keys.length) console.log('prompt_stack keys:', keys.join(', '));
}

function printPromptStack(state: SessionState) {
  const keys = Object.keys(state.prompt_stack);
  if (!keys.length) {
    console.log('prompt_stack: (empty)');
    return;
  }
  for (const k of keys) {
    const len = (state.prompt_stack[k] ?? '').length;
    console.log(`  ${k}: ${len} chars`);
  }
}

async function readMultiLine(rl: readline.Interface, prompt: string): Promise<string> {
  const lines: string[] = [];
  console.log(prompt + ' (end with empty line or .)');
  for (;;) {
    const line = await new Promise<string>((resolve) => rl.question('> ', resolve));
    if (line === '' || line.trim() === '.') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

export async function runInteractive(opts?: { unsafeUnlimited?: boolean }) {
  const maxRealRuns = opts?.unsafeUnlimited ? 999 : DEFAULT_MAX_REAL_RUNS;
  let state = defaultState(maxRealRuns);
  state.serverStart = getServerStart();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('Lexery Brain CLI (interactive). Commands: /mode dry|real, /prompt show|set user, /new, /status, /run <msg>, /verbose on|off, /last, /runs [n], /unsafe-unlimited, /exit');
  console.log('Default: dry-run. For real LLM: /mode real then type YES.\n');

  const ask = (): Promise<void> =>
    new Promise((resolve) => {
      rl.question('You: ', async (line) => {
        const input = (line ?? '').trim();
        if (!input) {
          ask();
          return resolve();
        }

        if (input === '/exit') {
          rl.close();
          process.exit(0);
        }

        if (input.startsWith('/')) {
          const parts = input.slice(1).split(/\s+/);
          const cmd = parts[0]?.toLowerCase();
          const arg = parts.slice(1).join(' ').trim();

          if (cmd === 'mode') {
            if (arg === 'dry' || arg === 'real') {
              state = { ...state, mode: arg as ChatMode };
              if (arg === 'dry') state.realLlmConfirmed = false;
              console.log('mode:', state.mode);
            } else {
              console.log('Usage: /mode dry | /mode real');
            }
          } else if (cmd === 'triage' || cmd === 'memory') {
            console.log(`${cmd} is driven by env. Restart with env set to change.`);
          } else if (cmd === 'last') {
            if (state.lastRunId) console.log('last run_id:', state.lastRunId);
            else console.log('No run yet this session.');
          } else if (cmd === 'runs') {
            const n = Math.min(20, Math.max(1, parseInt(arg, 10) || 5));
            const list = state.recentRunIds.slice(0, n);
            if (list.length) list.forEach((id, i) => console.log(`${i + 1}. ${id}`));
            else console.log('No runs yet this session.');
          } else if (cmd === 'unsafe-unlimited') {
            console.log('To enable unlimited real runs, type exactly: YES I UNDERSTAND COSTS');
          } else if (cmd === 'prompt') {
            if (arg === 'show') {
              printPromptStack(state);
            } else if (arg === 'set' && parts[1] === 'user') {
              const text = await readMultiLine(rl, 'Enter user prompt (multi-line):');
              state = { ...state, prompt_stack: { ...state.prompt_stack, user: text } };
              console.log('user prompt set, length:', text.length);
            } else {
              console.log('Usage: /prompt show | /prompt set user');
            }
          } else if (cmd === 'new') {
            state = { ...state, conversation_id: crypto.randomUUID() };
            console.log('New conversation_id:', state.conversation_id);
          } else if (cmd === 'status') {
            printStatus(state);
          } else if (cmd === 'run') {
            if (arg) state = await sendMessage(state, arg);
            else console.log('Usage: /run <message>');
          } else if (cmd === 'verbose') {
            state = { ...state, verbose: arg === 'on' };
            console.log('verbose:', state.verbose);
          } else {
            console.log('Unknown command. Use /exit to quit.');
          }
          ask();
          return resolve();
        }

        if (state.mode === 'real' && input.toUpperCase() === 'YES') {
          state = { ...state, realLlmConfirmed: true };
          if (!state.safetyNoticeShown) {
            console.log(SAFETY_LIMIT_MSG);
            state = { ...state, safetyNoticeShown: true };
          }
          console.log('Real LLM confirmed. You can send messages.');
          ask();
          return resolve();
        }
        if (input === 'YES I UNDERSTAND COSTS') {
          state = { ...state, maxRealRuns: 999 };
          console.log('Unlimited real runs enabled for this session.');
          ask();
          return resolve();
        }

        state = await sendMessage(state, input);
        ask();
        resolve();
      });
    });

  await ask();
}

const unsafeUnlimited = process.argv.includes('--unsafe-unlimited');
runInteractive({ unsafeUnlimited }).catch((err) => {
  console.error(err);
  process.exit(1);
});
