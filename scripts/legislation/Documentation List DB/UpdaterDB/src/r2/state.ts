import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { makeRunId, nowIso } from '../utils.js';

export interface UpdaterState {
  schema_version: 1;
  updated_at: string;
  last_success_at?: string;
  last_backstop_success_at?: string;
  last_modified: {
    r_txt?: string | null;
    nn?: string | null;
    n_backstop?: string | null;
  };
}

export function defaultState(): UpdaterState {
  return {
    schema_version: 1,
    updated_at: nowIso(),
    last_modified: {
      r_txt: null,
      nn: null,
      n_backstop: null,
    },
  };
}

function joinKey(prefix: string, ...parts: string[]): string {
  const p = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const tail = parts
    .map((x) => String(x || '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/');
  return p ? `${p}/${tail}` : tail;
}

async function readBodyAsString(body: any): Promise<string> {
  if (!body) return '';
  if (typeof body.transformToString === 'function') {
    return await body.transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isNotFound(e: any): boolean {
  const code = e?.$metadata?.httpStatusCode;
  if (code === 404) return true;
  const name = String(e?.name || '');
  return name === 'NoSuchKey' || name === 'NotFound';
}

function encodeCopySource(bucket: string, key: string): string {
  // S3 expects URL-encoded key, but "/" must remain.
  const parts = key.split('/').map((p) => encodeURIComponent(p));
  return `${bucket}/${parts.join('/')}`;
}

export async function loadState(params: {
  s3: S3Client;
  bucket: string;
  prefix: string;
}): Promise<UpdaterState> {
  const key = joinKey(params.prefix, 'state.json');
  try {
    const res = await params.s3.send(new GetObjectCommand({ Bucket: params.bucket, Key: key }));
    const raw = await readBodyAsString(res.Body as any);
    const parsed = raw ? (JSON.parse(raw) as any) : null;
    if (!parsed || Number(parsed.schema_version) !== 1) return defaultState();

    return {
      schema_version: 1,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : nowIso(),
      last_success_at: typeof parsed.last_success_at === 'string' ? parsed.last_success_at : undefined,
      last_backstop_success_at: typeof parsed.last_backstop_success_at === 'string' ? parsed.last_backstop_success_at : undefined,
      last_modified: {
        r_txt: parsed?.last_modified?.r_txt ?? null,
        nn: parsed?.last_modified?.nn ?? null,
        n_backstop: parsed?.last_modified?.n_backstop ?? null,
      },
    };
  } catch (e: any) {
    if (isNotFound(e)) return defaultState();
    throw e;
  }
}

export async function saveStateAtomic(params: {
  s3: S3Client;
  bucket: string;
  prefix: string;
  state: UpdaterState;
  runId?: string;
}): Promise<void> {
  const runId = params.runId || makeRunId('state');
  const finalKey = joinKey(params.prefix, 'state.json');
  const tmpKey = joinKey(params.prefix, `state.json.tmp.${runId}`);
  const body = JSON.stringify({ ...params.state, updated_at: nowIso() }, null, 2);

  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: tmpKey,
      Body: body,
      ContentType: 'application/json',
    })
  );

  await params.s3.send(
    new CopyObjectCommand({
      Bucket: params.bucket,
      Key: finalKey,
      CopySource: encodeCopySource(params.bucket, tmpKey),
      ContentType: 'application/json',
      MetadataDirective: 'REPLACE',
    })
  );

  await params.s3.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: tmpKey })).catch(() => null);
}

