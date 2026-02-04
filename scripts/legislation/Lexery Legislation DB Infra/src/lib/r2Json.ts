/**
 * R2 JSON helpers (Legislation bucket).
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client, getLegislationBucket } from './r2Client.js';
import { assertLegislationBucketConfiguredCorrectly, assertNoDoubleLegislationPrefix } from './r2Guardrails.js';

async function streamToString(body: any): Promise<string> {
  if (!body) return '';
  // AWS SDK v3 returns ReadableStream/Readable depending on runtime
  if (typeof body.transformToString === 'function') {
    return await body.transformToString('utf-8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function getJsonFromR2(key: string): Promise<any> {
  assertLegislationBucketConfiguredCorrectly();
  assertNoDoubleLegislationPrefix(key);

  const client = createR2Client();
  const bucket = getLegislationBucket();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await streamToString((res as any).Body);
  return JSON.parse(text);
}

/**
 * Мінімальна підтримка json_path для наших payload'ів.
 * Очікуваний формат: $.content.chunks[<index>].text
 */
export function extractTextByJsonPath(doc: any, jsonPath: string): string | null {
  const m = jsonPath.match(/^\$\.content\.chunks\[(\d+)\]\.text$/);
  if (!m) return null;
  const idx = Number(m[1]);
  const chunk = doc?.content?.chunks?.[idx];
  if (!chunk) return null;
  const text = chunk?.text;
  return typeof text === 'string' ? text : null;
}

