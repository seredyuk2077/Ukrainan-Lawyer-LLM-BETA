/**
 * R2 Client — клієнт для роботи з Cloudflare R2 через AWS SDK v3
 * 
 * Використовує S3-сумісний API для завантаження canonical JSON файлів
 */

import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Отримує R2 credentials з env змінних
 * Підтримує різні варіанти назв для сумісності
 */
export function getR2Config(): {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
} {
  // Endpoint
  const endpoint = 
    process.env.R2_ENDPOINT ||
    process.env.CLOUDFLARE_R2_ENDPOINT ||
    process.env.R2_LEGISLATION_ENDPOINT;
  
  // Access Key
  const accessKeyId = 
    process.env.R2_ACCESS_KEY ||
    process.env.R2_ACCESS_KEY_ID ||
    process.env.CLOUDFLARE_R2_ACCESS_KEY ||
    process.env.R2_LEGISLATION_ACCESS_KEY;
  
  // Secret Key
  const secretAccessKey = 
    process.env.R2_SECRET_KEY ||
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.CLOUDFLARE_R2_SECRET_KEY ||
    process.env.R2_LEGISLATION_SECRET_KEY;
  
  // Bucket (legislation bucket, не Supreme Court)
  const bucket = 
    process.env.R2_LEGISLATION_BUCKET ||
    process.env.R2_BUCKET_LEGISLATION ||
    'legislation'; // default для legislation bucket
  
  // Region
  const region = process.env.R2_REGION || 'auto';

  const errors: string[] = [];
  
  if (!endpoint) {
    errors.push('R2_ENDPOINT не встановлено');
  }
  if (!accessKeyId) {
    errors.push('R2_ACCESS_KEY не встановлено');
  }
  if (!secretAccessKey) {
    errors.push('R2_SECRET_KEY не встановлено');
  }
  
  if (errors.length > 0) {
    throw new Error(
      `Помилка конфігурації R2:\n${errors.map(e => `  - ${e}`).join('\n')}\n\n` +
      `Необхідні змінні оточення:\n` +
      `  - R2_ENDPOINT (або CLOUDFLARE_R2_ENDPOINT)\n` +
      `  - R2_ACCESS_KEY (або R2_ACCESS_KEY_ID)\n` +
      `  - R2_SECRET_KEY (або R2_SECRET_ACCESS_KEY)\n` +
      `  - R2_LEGISLATION_BUCKET (опціонально, default: "legislation")\n` +
      `  - R2_REGION (опціонально, default: "auto")`
    );
  }

  // Перевірка що bucket не є Supreme Court bucket
  if (bucket === 'legal-court-decisions' || bucket === 'legal-cases') {
    throw new Error(
      `Помилка: bucket "${bucket}" є Supreme Court bucket. ` +
      `Використовуйте bucket "legislation" для Legislation RAG.`
    );
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
  };
}

/**
 * Створює S3 клієнт для R2
 */
export function createR2Client(): S3Client {
  const config = getR2Config();
  
  const s3Config: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true, // R2 вимагає path-style URLs
  };

  return new S3Client(s3Config);
}

/**
 * Отримує bucket name для legislation
 */
export function getLegislationBucket(): string {
  const config = getR2Config();
  return config.bucket;
}

