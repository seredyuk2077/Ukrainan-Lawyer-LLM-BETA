#!/usr/bin/env node
/**
 * Migrate R2 runs/ objects from legislation bucket to lexery-legal-agent bucket.
 * Idempotent: skips objects that already exist in target.
 * Usage:
 *   pnpm brain:migrate-r2-runs -- --dry-run
 *   pnpm brain:migrate-r2-runs
 */
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../.env') });

const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || '';
const SOURCE_BUCKET = process.env.R2_LEGISLATION_BUCKET || 'legislation';
const TARGET_BUCKET = process.env.R2_RUNS_BUCKET || process.env.R2_BUCKET_RUNS || 'lexery-legal-agent';
const PREFIX = 'runs/';

function createClient(): S3Client {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
    throw new Error('Missing R2 config: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  return new S3Client({
    endpoint: R2_ENDPOINT,
    region: process.env.R2_REGION || 'auto',
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'NotFound') return false;
    throw e;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('[DRY-RUN] Will list source objects and report what would be copied.\n');
  }

  const client = createClient();
  console.log(`Source: ${SOURCE_BUCKET}/${PREFIX}`);
  console.log(`Target: ${TARGET_BUCKET}/${PREFIX}\n`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let continuationToken: string | undefined;

  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: SOURCE_BUCKET,
        Prefix: PREFIX,
        MaxKeys: 100,
        ContinuationToken: continuationToken,
      })
    );

    const contents = list.Contents || [];
    for (const obj of contents) {
      const key = obj.Key;
      if (!key) continue;

      if (dryRun) {
        console.log(`  Would copy: ${key}`);
        copied++;
        continue;
      }

      const inTarget = await exists(client, TARGET_BUCKET, key);
      if (inTarget) {
        console.log(`  Skip (exists): ${key}`);
        skipped++;
        continue;
      }

      try {
        const getRes = await client.send(
          new GetObjectCommand({ Bucket: SOURCE_BUCKET, Key: key })
        );
        const body = getRes.Body;
        if (!body) throw new Error('Empty body');
        const buf = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          body.on('data', (c: Uint8Array) => chunks.push(c));
          body.on('error', reject);
          body.on('end', () => resolve(Buffer.concat(chunks)));
        });
        await client.send(
          new PutObjectCommand({
            Bucket: TARGET_BUCKET,
            Key: key,
            Body: buf,
            ContentType: getRes.ContentType || 'application/octet-stream',
            Metadata: (getRes.Metadata as Record<string, string>) || undefined,
          })
        );
        console.log(`  Copied: ${key} (${buf.length} bytes)`);
        copied++;
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`  FAIL: ${key}`, msg);
        if (msg.includes('does not exist') && msg.includes('bucket')) {
          console.error('    → Ensure bucket "%s" exists in Cloudflare R2 dashboard.', TARGET_BUCKET);
        }
        failed++;
      }
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log('\n--- Summary ---');
  console.log(`Copied: ${copied}, Skipped: ${skipped}, Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
