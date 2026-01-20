import { S3Client } from '@aws-sdk/client-s3';
import type { EnvConfig } from '../config.js';

export function createR2S3Client(env: Pick<EnvConfig, 'r2Endpoint' | 'r2Region' | 'r2AccessKeyId' | 'r2SecretAccessKey'>): S3Client {
  return new S3Client({
    region: env.r2Region || 'auto',
    endpoint: env.r2Endpoint,
    credentials: {
      accessKeyId: env.r2AccessKeyId,
      secretAccessKey: env.r2SecretAccessKey,
    },
    forcePathStyle: true,
  });
}

