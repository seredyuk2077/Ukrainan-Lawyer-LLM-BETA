/**
 * R2 Upload — завантаження файлів в Cloudflare R2 з retry та валідацією
 */

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, statSync } from 'fs';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

export interface UploadResult {
  r2Key: string;
  etag: string;
  size: number;
  uploaded: boolean; // true якщо завантажено, false якщо вже існував
}

export interface UploadOptions {
  contentType?: string;
  maxRetries?: number;
  retryDelay?: number;
  skipIfExists?: boolean; // Перевіряти ETag перед завантаженням
}

/**
 * Завантажує файл в R2 з streaming та retry
 */
export async function uploadFileToR2(
  client: S3Client,
  bucket: string,
  r2Key: string,
  filePath: string,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const {
    contentType = 'application/json; charset=utf-8',
    maxRetries = 3,
    retryDelay = 1000,
    skipIfExists = true,
  } = options;

  // Перевірка розміру файлу
  const stats = statSync(filePath);
  const fileSize = stats.size;
  
  if (fileSize === 0) {
    throw new Error(`Файл порожній: ${filePath}`);
  }

  console.log(`📤 Завантаження в R2: ${r2Key}`);
  console.log(`   Файл: ${filePath}`);
  console.log(`   Розмір: ${(fileSize / 1024).toFixed(2)} KB`);

  // Обчислюємо MD5 hash для idempotency
  const fileHash = await computeFileHash(filePath);

  // Перевірка чи файл вже існує (якщо skipIfExists)
  if (skipIfExists) {
    try {
      const headResult = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: r2Key,
        })
      );

      // Якщо файл існує та розмір співпадає, пропускаємо
      if (headResult.ContentLength === fileSize) {
        console.log(`   ✅ Файл вже існує в R2 (розмір співпадає)`);
        return {
          r2Key,
          etag: headResult.ETag || '',
          size: fileSize,
          uploaded: false,
        };
      }
    } catch (error: any) {
      // 404 - файл не існує, продовжуємо завантаження
      if (error.name !== 'NotFound') {
        throw error;
      }
    }
  }

  // Завантаження з retry
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fileStream = createReadStream(filePath);
      
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        Body: fileStream,
        ContentType: contentType,
        Metadata: {
          'file-hash': fileHash,
        },
      });

      const result = await client.send(command);
      
      console.log(`   ✅ Завантажено успішно (attempt ${attempt})`);
      
      // Валідація: перевіряємо що файл дійсно завантажився
      await validateUpload(client, bucket, r2Key, fileSize);
      
      return {
        r2Key,
        etag: result.ETag || '',
        size: fileSize,
        uploaded: true,
      };
    } catch (error: any) {
      lastError = error;
      console.warn(`   ⚠️  Помилка завантаження (attempt ${attempt}/${maxRetries}): ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`   ⏳ Повтор через ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Не вдалося завантажити файл після ${maxRetries} спроб: ${lastError?.message}`
  );
}

/**
 * Валідує завантаження: перевіряє розмір та наявність файлу
 */
async function validateUpload(
  client: S3Client,
  bucket: string,
  r2Key: string,
  expectedSize: number
): Promise<void> {
  try {
    const headResult = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: r2Key,
      })
    );

    if (headResult.ContentLength !== expectedSize) {
      throw new Error(
        `Розмір файлу не співпадає: очікується ${expectedSize}, отримано ${headResult.ContentLength}`
      );
    }

    console.log(`   ✅ Валідація пройдена: розмір ${headResult.ContentLength} bytes`);
  } catch (error: any) {
    if (error.name === 'NotFound') {
      throw new Error(`Файл не знайдено в R2 після завантаження: ${r2Key}`);
    }
    throw error;
  }
}

/**
 * Обчислює MD5 hash файлу для idempotency
 */
async function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);
    
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Завантажує canonical JSON з об'єкта (для випадків коли файл вже в пам'яті)
 */
export async function uploadCanonicalJsonToR2(
  client: S3Client,
  bucket: string,
  r2Key: string,
  canonicalJson: string,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const {
    contentType = 'application/json; charset=utf-8',
    maxRetries = 3,
    retryDelay = 1000,
    skipIfExists = true,
  } = options;

  const fileSize = Buffer.byteLength(canonicalJson, 'utf-8');

  console.log(`📤 Завантаження canonical JSON в R2: ${r2Key}`);
  console.log(`   Розмір: ${(fileSize / 1024).toFixed(2)} KB`);

  // Обчислюємо hash
  const hash = createHash('md5');
  hash.update(canonicalJson, 'utf-8');
  const fileHash = hash.digest('hex');

  // Перевірка чи файл вже існує
  if (skipIfExists) {
    try {
      const headResult = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: r2Key,
        })
      );

      if (headResult.ContentLength === fileSize) {
        console.log(`   ✅ Файл вже існує в R2`);
        return {
          r2Key,
          etag: headResult.ETag || '',
          size: fileSize,
          uploaded: false,
        };
      }
    } catch (error: any) {
      if (error.name !== 'NotFound') {
        throw error;
      }
    }
  }

  // Завантаження з retry
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        Body: canonicalJson,
        ContentType: contentType,
        Metadata: {
          'file-hash': fileHash,
        },
      });

      const result = await client.send(command);
      
      console.log(`   ✅ Завантажено успішно`);
      
      // Валідація
      await validateUpload(client, bucket, r2Key, fileSize);
      
      return {
        r2Key,
        etag: result.ETag || '',
        size: fileSize,
        uploaded: true,
      };
    } catch (error: any) {
      lastError = error;
      console.warn(`   ⚠️  Помилка (attempt ${attempt}/${maxRetries}): ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Не вдалося завантажити після ${maxRetries} спроб: ${lastError?.message}`
  );
}

