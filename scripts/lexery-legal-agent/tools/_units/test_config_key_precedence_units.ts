/**
 * Unit test: OpenRouter key precedence (OPENROUTER_API_KEY_BRAIN > OPENROUTER_API_KEY_ONLINE).
 * Run: pnpm brain:test:config-key-precedence
 */
import { getOpenRouterKeyFromEnv } from '../../lib/config.js';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${msg}`);
}

function run(): void {
  // Both set → BRAIN wins
  const both = getOpenRouterKeyFromEnv({
    OPENROUTER_API_KEY_BRAIN: 'key-brain',
    OPENROUTER_API_KEY_ONLINE: 'key-online',
  });
  assert(both === 'key-brain', 'When both set, BRAIN wins');

  // Only ONLINE → used
  const onlineOnly = getOpenRouterKeyFromEnv({
    OPENROUTER_API_KEY_ONLINE: 'key-online',
  });
  assert(onlineOnly === 'key-online', 'When only ONLINE set, used');

  // None → empty string (callers throw when key required)
  const none = getOpenRouterKeyFromEnv({});
  assert(none === '', 'When none set, empty string');

  // Only BRAIN
  const brainOnly = getOpenRouterKeyFromEnv({ OPENROUTER_API_KEY_BRAIN: 'key-brain' });
  assert(brainOnly === 'key-brain', 'When only BRAIN set, used');

  console.log('[OK] Config key precedence: BRAIN > ONLINE, none => empty');
}

run();
