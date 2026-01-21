import type { Logger } from '../util/logger';

export interface R2S3Config {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  region: string; // auto
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string; // e.g. legislation/ActCatalogResolver/cache/
  timeoutMs: number;
}

export class R2S3Client {
  constructor(
    private readonly logger: Logger,
    private readonly cfg: R2S3Config
  ) {}

  async getJson<T>(key: string): Promise<T | null> {
    const url = this.objectUrl(key);
    const res = await this.signedFetch('GET', url, undefined, undefined);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn({ status: res.status, url, resp_preview: text.slice(0, 400) }, 'r2 get failed');
      throw new Error(`R2 GET HTTP ${res.status}`);
    }
    const text = await res.text().catch(() => '');
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const url = this.objectUrl(key);
    const body = JSON.stringify(value);
    const res = await this.signedFetch('PUT', url, { 'Content-Type': 'application/json; charset=utf-8' }, body);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn({ status: res.status, url, resp_preview: text.slice(0, 400) }, 'r2 put failed');
      throw new Error(`R2 PUT HTTP ${res.status}`);
    }
  }

  private objectUrl(key: string): string {
    const base = this.cfg.endpoint.replace(/\/+$/, '');
    const safeKey = joinKeys(this.cfg.prefix, key);
    // path-style: /<bucket>/<key>
    const path = `/${encodeURIComponent(this.cfg.bucket)}/${encodePathSegments(safeKey)}`;
    return `${base}${path}`;
  }

  private async signedFetch(
    method: 'GET' | 'PUT',
    url: string,
    extraHeaders: Record<string, string> | undefined,
    body: string | undefined
  ): Promise<Response> {
    const u = new URL(url);
    const host = u.host;
    const now = new Date();
    const amzDate = toAmzDate(now); // YYYYMMDD'T'HHMMSS'Z'
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = await sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(extraHeaders || {}),
    };

    const signedHeaders = canonicalSignedHeaders(headers);
    const canonicalHeaders = canonicalHeadersString(headers, signedHeaders);
    const canonicalRequest = [
      method,
      u.pathname,
      u.searchParams.toString(), // query (rarely used here)
      canonicalHeaders,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = [algorithm, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

    const signingKey = await getSignatureKey(this.cfg.secretAccessKey, dateStamp, this.cfg.region, 's3');
    const signature = await hmacHex(signingKey, stringToSign);

    headers.authorization = `${algorithm} Credential=${this.cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(
      ';'
    )}, Signature=${signature}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort('timeout'), this.cfg.timeoutMs);
    try {
      return await fetch(url, {
        method,
        headers,
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }
}

function joinKeys(prefix: string, key: string): string {
  const p = String(prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const k = String(key || '').replace(/^\/+/, '');
  if (!p) return k;
  if (!k) return p;
  return `${p}/${k}`;
}

function encodePathSegments(path: string): string {
  // Keep slashes, encode each segment.
  return String(path || '')
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

function toAmzDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function canonicalSignedHeaders(headers: Record<string, string>): string[] {
  return Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
}

function canonicalHeadersString(headers: Record<string, string>, signed: string[]): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  return signed.map((k) => `${k}:${lower[k]}`).join('\n') + '\n';
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufToHex(hash);
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return bufToHex(sig);
}

async function hmacRaw(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const rawKey = typeof key === 'string' ? new TextEncoder().encode(key).buffer : key;
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacRaw(`AWS4${secret}`, dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, 'aws4_request');
  return kSigning;
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

