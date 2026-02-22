/**
 * Fetch legislation fragment from R2 by r2_key + json_path.
 * Supports LLDBI format: $.content.chunks[N].text
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../lib/config.js';

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

/**
 * Fetch JSON from R2 (LLDBI bucket) and return text at json_path.
 * Throws on missing config or unsupported json_path.
 */
export async function getFragmentFromR2(r2Key: string, jsonPath: string): Promise<string | null> {
  const endpoint = config.r2Endpoint;
  const accessKey = config.r2AccessKey;
  const secretKey = config.r2SecretKey;
  const bucket = config.r2BucketLegislation;

  if (!endpoint || !accessKey || !secretKey) {
    throw new Error(
      'R2 not configured for LLDBI: set R2_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY (or CLOUDFLARE_* / R2_LEGISLATION_* aliases)'
    );
  }

  const client = new S3Client({
    endpoint,
    region: config.r2Region || 'auto',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });

  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: r2Key,
    })
  );
  const buf = await streamToBuffer((res as { Body?: unknown })?.Body);
  const doc = JSON.parse(buf.toString('utf-8')) as unknown;

  const text = extractTextByJsonPath(doc, jsonPath);
  if (text === null && !/^\$\.content\.chunks\[\d+\]\.text$/.test(jsonPath)) {
    throw new Error(`Unsupported json_path for LLDBI: "${jsonPath}". Expected $.content.chunks[N].text`);
  }
  return text;
}
