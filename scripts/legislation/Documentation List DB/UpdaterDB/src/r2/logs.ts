import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';

function joinKey(prefix: string, ...parts: string[]): string {
  const p = (prefix || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const tail = parts
    .map((x) => String(x || '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .join('/');
  return p ? `${p}/${tail}` : tail;
}

export async function writeRunReport(params: {
  s3: S3Client;
  bucket: string;
  prefix: string;
  runId: string;
  report: unknown;
}): Promise<void> {
  const key = joinKey(params.prefix, `runs/${params.runId}.json`);
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: key,
      Body: JSON.stringify(params.report, null, 2),
      ContentType: 'application/json',
    })
  );
}

export async function writeRunLog(params: {
  s3: S3Client;
  bucket: string;
  prefix: string;
  runId: string;
  text: string;
}): Promise<void> {
  const key = joinKey(params.prefix, `runs/${params.runId}.log`);
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: key,
      Body: params.text,
      ContentType: 'text/plain; charset=utf-8',
    })
  );
}

