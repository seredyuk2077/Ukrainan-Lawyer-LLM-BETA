/**
 * Fetch legislation fragment from R2 by r2_key + json_path.
 * Supports LLDBI format: $.content.chunks[N].text
 *
 * S3Client is created once per (endpoint, bucket) configuration and reused for
 * the lifetime of the process — safe for concurrent calls.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';
import type { LawSourceRef } from '../lib/pipeline/contracts.js';

// --- S3Client singleton (keyed by endpoint+bucket so test overrides work) ---
let _r2Client: S3Client | null = null;
let _r2ClientKey = '';
const MAX_R2_DOC_CACHE = 64;
const _docCache = new Map<string, unknown>();
const _docCacheOrder: string[] = [];
const _docInflight = new Map<string, Promise<unknown>>();

function getR2Client(): S3Client {
  // Test override takes priority — no credential check needed
  if (_r2Client && _r2ClientKey === '__test__') return _r2Client;

  const endpoint = config.r2Endpoint;
  const accessKey = config.r2AccessKey;
  const secretKey = config.r2SecretKey;
  const region = config.r2Region || 'auto';
  const key = `${endpoint}::${accessKey}::${region}`;

  if (_r2Client && _r2ClientKey === key) return _r2Client;

  _r2Client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
  _r2ClientKey = key;
  return _r2Client;
}

function isR2Configured(): boolean {
  // Test override bypasses config check
  if (_r2ClientKey === '__test__') return true;
  return !!(config.r2Endpoint && config.r2AccessKey && config.r2SecretKey);
}

/** For tests: override the R2 client (e.g. with a mock). */
export function _setR2ClientForTest(client: S3Client | null): void {
  _r2Client = client;
  _r2ClientKey = client ? '__test__' : '';
  _docCache.clear();
  _docCacheOrder.length = 0;
  _docInflight.clear();
}

function touchDocCacheKey(key: string): void {
  const idx = _docCacheOrder.indexOf(key);
  if (idx >= 0) _docCacheOrder.splice(idx, 1);
  _docCacheOrder.push(key);
  while (_docCacheOrder.length > MAX_R2_DOC_CACHE) {
    const oldest = _docCacheOrder.shift();
    if (oldest) _docCache.delete(oldest);
  }
}

// --- Utilities ---

function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Promise.resolve(Buffer.from(''));
  if (typeof (body as { transformToString?: (enc: string) => Promise<string> }).transformToString === 'function') {
    return (body as { transformToString: (enc: string) => Promise<string> })
      .transformToString('utf-8')
      .then((s) => Buffer.from(s, 'utf-8'));
  }
  const chunks: Buffer[] = [];
  const iter = (body as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]?.();
  if (!iter) return Promise.resolve(Buffer.from(''));
  return (async () => {
    for (let r = await iter.next(); !r.done; r = await iter.next()) {
      chunks.push(Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value));
    }
    return Buffer.concat(chunks);
  })();
}

/**
 * Resolve json_path to text. Supported: $.content.chunks[<index>].text
 */
export function extractTextByJsonPath(doc: unknown, jsonPath: string): string | null {
  const m = jsonPath.match(/^\$\.content\.chunks\[(\d+)\]\.text$/);
  if (!m) return null;
  const idx = Number(m[1]);
  const docObj = doc as { content?: { chunks?: Array<{ text?: unknown }> } };
  const chunk = docObj?.content?.chunks?.[idx];
  if (!chunk) return null;
  const text = chunk?.text;
  return typeof text === 'string' ? text : null;
}

/** DEV RUN v18: preserve first N chars of norm header (Стаття/Частина) so citation is not cut. */
const QUOTE_CRITICAL_HEAD_CHARS = 350;
const NORM_HEADER_PATTERN = /^(Стаття|Частина|Статья|Часть)\s/miu;

/**
 * Truncate text at `maxChars`, respecting word boundaries.
 * When text starts with "Стаття"/"Частина", preserves first QUOTE_CRITICAL_HEAD_CHARS so header and disposition are not cut.
 */
export function truncateSnippetText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const hasNormHeader = NORM_HEADER_PATTERN.test(text);
  if (hasNormHeader && maxChars > QUOTE_CRITICAL_HEAD_CHARS) {
    const head = text.slice(0, QUOTE_CRITICAL_HEAD_CHARS);
    const tail = text.slice(QUOTE_CRITICAL_HEAD_CHARS);
    const tailBudget = maxChars - QUOTE_CRITICAL_HEAD_CHARS - 1;
    if (tailBudget <= 0) return head + '…';
    if (tail.length <= tailBudget) return head + tail;
    const cut = tail.slice(0, tailBudget);
    const lastSpace = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    const truncatedTail =
      lastSpace > tailBudget * 0.7 ? cut.slice(0, lastSpace) + '…' : cut + '…';
    return head + truncatedTail;
  }
  const cut = text.slice(0, maxChars);
  const lastSpace = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return lastSpace > maxChars * 0.7 ? cut.slice(0, lastSpace) + '…' : cut + '…';
}

/**
 * Fetch JSON from R2 (LLDBI bucket) and return text at json_path.
 * Throws on missing config or unsupported json_path.
 */
export async function getFragmentFromR2(r2Key: string, jsonPath: string): Promise<string | null> {
  if (!isR2Configured()) {
    throw new Error(
      'R2 not configured for LLDBI: set R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY (or CLOUDFLARE_* / R2_LEGISLATION_* aliases)'
    );
  }

  let doc = _docCache.get(r2Key);
  if (!doc) {
    let inflight = _docInflight.get(r2Key);
    if (!inflight) {
      inflight = (async () => {
        const bucket = config.r2BucketLegislation;
        const client = getR2Client();
        const res = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: r2Key })
        );
        const buf = await streamToBuffer((res as { Body?: unknown })?.Body);
        return JSON.parse(buf.toString('utf-8')) as unknown;
      })();
      _docInflight.set(r2Key, inflight);
    }
    try {
      doc = await inflight;
      _docCache.set(r2Key, doc);
      touchDocCacheKey(r2Key);
    } finally {
      _docInflight.delete(r2Key);
    }
  } else {
    touchDocCacheKey(r2Key);
  }

  const text = extractTextByJsonPath(doc, jsonPath);
  if (text === null && !/^\$\.content\.chunks\[\d+\]\.text$/.test(jsonPath)) {
    throw new Error(`Unsupported json_path for LLDBI: "${jsonPath}". Expected $.content.chunks[N].text`);
  }
  return text;
}

/**
 * Result of a canonical snippet load attempt.
 */
export type SnippetLoadResult =
  | { ok: true; text: string; truncated: boolean; sourceRef: LawSourceRef }
  | { ok: false; error: string; sourceRef: LawSourceRef };

/**
 * Load a canonical snippet from R2 for a given LawSourceRef.
 * Returns ok=true with text (possibly truncated) or ok=false with error message.
 * Never throws — always returns a result so the caller can proceed.
 */
export async function loadCanonicalSnippet(
  sourceRef: LawSourceRef,
  maxChars: number
): Promise<SnippetLoadResult> {
  if (!isR2Configured()) {
    return {
      ok: false,
      error: 'R2 not configured',
      sourceRef: { ...sourceRef, loaded: false },
    };
  }

  try {
    const text = await getFragmentFromR2(sourceRef.r2_key, sourceRef.json_path);
    if (text === null) {
      return {
        ok: false,
        error: `json_path not found: ${sourceRef.json_path}`,
        sourceRef: { ...sourceRef, loaded: false },
      };
    }
    const truncated = text.length > maxChars;
    return {
      ok: true,
      text: truncateSnippetText(text, maxChars),
      truncated,
      sourceRef: { ...sourceRef, loaded: true },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      sourceRef: { ...sourceRef, loaded: false },
    };
  }
}
