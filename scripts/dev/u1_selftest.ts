#!/usr/bin/env node
/**
 * U1 Gateway Self-test (LEX-75)
 * Run: pnpm brain:selftest
 * Requires: Brain server running (use BRAIN_BASE_URL/BRAIN_URL for port).
 * Or: pnpm brain:verify:u3 for full autonomous run.
 */
const BASE = process.env.BRAIN_BASE_URL ?? process.env.BRAIN_URL ?? 'http://localhost:3081';
const DEV_KEY = process.env.DEV_API_KEY ?? 'dev-key-change-me';

async function fetch(url: string, opts: RequestInit = {}) {
  return globalThis.fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers as object),
    },
  });
}

async function main() {
  console.log('U1 Self-test —', BASE);

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const userId = '00000000-0000-0000-0000-000000000002';

  // 1) Dry-run
  console.log('\n1) Dry-run...');
  const dryRes = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { 'X-Dev-API-Key': DEV_KEY },
    body: JSON.stringify({
      query: 'Test dry run',
      tenant_id: tenantId,
      user_id: userId,
      dry_run: true,
    }),
  });
  const dryJson = await dryRes.json();
  if (dryRes.status !== 200 || dryJson.status !== 'dry_run_accepted') {
    console.error('FAIL: dry-run', dryRes.status, dryJson);
    process.exit(1);
  }
  console.log('OK:', dryJson);

  // 2) Real run
  console.log('\n2) Real run...');
  const realRes = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { 'X-Dev-API-Key': DEV_KEY },
    body: JSON.stringify({
      query: 'Які підстави для звільнення за власним бажанням?',
      tenant_id: tenantId,
      user_id: userId,
    }),
  });
  const realJson = await realRes.json();
  if (realRes.status !== 202 || realJson.status !== 'accepted') {
    console.error('FAIL: real run', realRes.status, realJson);
    process.exit(1);
  }
  console.log('OK: run_id=', realJson.run_id);

  // 3) 401 without key (no DEV_API_KEY and no tenant_id/user_id)
  console.log('\n3) 401 without key...');
  const noKeyRes = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    body: JSON.stringify({ query: 'test' }),
  });
  if (noKeyRes.status !== 401) {
    console.error('FAIL: expected 401, got', noKeyRes.status, await noKeyRes.text());
    process.exit(1);
  }
  console.log('OK: 401');

  console.log('\n✅ All self-tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
