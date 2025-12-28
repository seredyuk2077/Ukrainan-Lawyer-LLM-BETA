/**
 * Open Data Portal Client
 * 
 * Клієнт для роботи з офіційним Open Data Portal rada.gov.ua.
 * Підтримує завантаження датасетів з умовними запитами (If-Modified-Since, ETag).
 * 
 * API формати:
 * - HTML: https://data.rada.gov.ua/open/data/<id>
 * - CSV:  https://data.rada.gov.ua/open/data/<id>.csv
 * - JSON: https://data.rada.gov.ua/open/data/<id>.json
 * - XML:  https://data.rada.gov.ua/open/data/<id>.xml
 */

import { RADA_API_CONFIG, PATHS } from './config.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

export interface DatasetPassport {
  id: string;
  guid?: string;
  title: string;
  description?: string;
  path?: string;
  format?: string;
  pubDate?: string;
  lastBuildDate?: string;
  item?: DatasetItem[];
}

export interface DatasetItem {
  id: string;
  type?: string;
  title: string;
  description?: string;
  path?: string;
  name?: string;
  format?: string;
  size?: number;
  checksum?: string;
  archived?: string;
  link?: string;
  pubDate?: string;
}

export interface CachedMetadata {
  etag?: string;
  lastModified?: string;
  cachedAt: string;
  size?: number;
  checksum?: string;
}

const METADATA_DIR = `${PATHS.tmp}/opendata_metadata`;

/**
 * Клас для роботи з Open Data Portal
 */
export class OpenDataPortalClient {
  private baseUrl = 'https://data.rada.gov.ua';
  private ogdBaseUrl = 'https://data.rada.gov.ua/ogd';

  /**
   * Отримує passport датасету за ID
   */
  async getDatasetPassport(datasetId: string): Promise<DatasetPassport> {
    const url = `${this.baseUrl}/open/data/${datasetId}.json`;
    
    console.log(`📋 Отримуємо passport датасету: ${datasetId}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': RADA_API_CONFIG.tokenUserAgent,
      },
      signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset passport: HTTP ${response.status} ${response.statusText}`);
    }

    const passport = await response.json() as DatasetPassport;
    console.log(`✅ Passport отримано: ${passport.title}`);
    
    return passport;
  }

  /**
   * Знаходить файл датасету за критеріями
   * 
   * @param passport - passport датасету
   * @param criteria - критерії пошуку (type, format, name pattern)
   * @returns знайдений item або null
   */
  findDatasetFile(
    passport: DatasetPassport,
    criteria: {
      type?: string;
      format?: string;
      namePattern?: RegExp;
      preferLargest?: boolean;
    }
  ): DatasetItem | null {
    if (!passport.item || passport.item.length === 0) {
      return null;
    }

    let candidates = passport.item.filter(item => {
      if (criteria.type && item.type !== criteria.type) {
        return false;
      }
      if (criteria.format && item.format !== criteria.format) {
        return false;
      }
      if (criteria.namePattern && item.name && !criteria.namePattern.test(item.name)) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    // Якщо потрібен найбільший файл
    if (criteria.preferLargest) {
      candidates.sort((a, b) => (b.size || 0) - (a.size || 0));
    }

    return candidates[0];
  }

  /**
   * Завантажує файл датасету з умовним запитом
   * 
   * Підтримує If-Modified-Since та If-None-Match для кешування.
   * Зберігає тільки метадані в tmp/, не зберігає сам файл.
   * 
   * @param item - item датасету з path та name
   * @param streamParser - функція для stream-парсингу (опціонально)
   * @returns дані файлу (якщо streamParser не вказано) або результат парсингу
   */
  async downloadDatasetFile(
    item: DatasetItem,
    options: {
      streamParser?: (stream: ReadableStream) => Promise<any>;
      forceRefresh?: boolean;
    } = {}
  ): Promise<{ data?: any; metadata: CachedMetadata }> {
    if (!item.path || !item.name) {
      throw new Error('Dataset item must have path and name');
    }

    // Формуємо URL до файлу
    // item.path вже містить /ogd/, тому додаємо baseUrl
    const basePath = item.path?.startsWith('/') 
      ? `${this.baseUrl}${item.path}` 
      : `${this.ogdBaseUrl}${item.path}`;
    
    // Для ZIP файлів: якщо name містить розширення (напр. doc.txt), 
    // то ZIP має назву без розширення (doc.zip)
    let fileName = item.name || '';
    if (item.archived === 'zip') {
      // Видаляємо розширення з імені файлу перед додаванням .zip
      const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
      fileName = `${nameWithoutExt}.zip`;
    }
    
    const fileUrl = `${basePath}${fileName}`;

    console.log(`📥 Завантажуємо файл: ${item.name} (${item.size ? Math.round(item.size / 1024 / 1024) + ' MB' : 'unknown size'})`);

    // Завантажуємо метадані кешу
    const cacheKey = `${item.id}_${item.name}`;
    const metadataFile = `${METADATA_DIR}/${cacheKey}.json`;
    let cachedMetadata: CachedMetadata | null = null;

    if (!options.forceRefresh && existsSync(metadataFile)) {
      try {
        cachedMetadata = JSON.parse(await readFile(metadataFile, 'utf-8'));
      } catch {
        // Ігноруємо помилки читання кешу
      }
    }

    // Формуємо умовні заголовки
    const headers: Record<string, string> = {
      'User-Agent': RADA_API_CONFIG.tokenUserAgent,
    };

    if (cachedMetadata && !options.forceRefresh) {
      if (cachedMetadata.etag) {
        headers['If-None-Match'] = cachedMetadata.etag;
      }
      if (cachedMetadata.lastModified) {
        headers['If-Modified-Since'] = cachedMetadata.lastModified;
      }
    }

    // Виконуємо запит
    const response = await fetch(fileUrl, {
      headers,
      signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request * 10), // Великі файли потребують більше часу
    });

    // 304 Not Modified - використовуємо кеш
    if (response.status === 304) {
      console.log('✅ Файл не змінився (304 Not Modified), використовуємо кеш');
      return {
        metadata: cachedMetadata!,
      };
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`File not found: ${fileUrl}`);
      }
      throw new Error(`Failed to download file: HTTP ${response.status} ${response.statusText}`);
    }

    // Оновлюємо метадані
    const etag = response.headers.get('etag') || undefined;
    const lastModified = response.headers.get('last-modified') || undefined;
    const contentLength = response.headers.get('content-length');
    const size = contentLength ? parseInt(contentLength, 10) : undefined;

    const metadata: CachedMetadata = {
      etag,
      lastModified,
      cachedAt: new Date().toISOString(),
      size,
      checksum: item.checksum,
    };

    // Зберігаємо метадані
    if (!existsSync(METADATA_DIR)) {
      await mkdir(METADATA_DIR, { recursive: true });
    }
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), 'utf-8');

    // Якщо є stream parser - використовуємо його
    if (options.streamParser) {
      console.log('📊 Парсимо файл через stream...');
      const result = await options.streamParser(response.body!);
      console.log('✅ Файл розпарсено');
      return { data: result, metadata };
    }

    // Інакше завантажуємо весь файл
    const data = await response.text();
    console.log(`✅ Файл завантажено (${data.length} символів)`);
    
    return { data, metadata };
  }

  /**
   * Розпаковує ZIP файл та парсить вміст
   * 
   * @param zipPathOrData - шлях до ZIP файлу або ArrayBuffer з даними
   * @param parser - функція для парсингу вмісту файлів (filename, content: Buffer | string)
   * @param shouldCleanup - чи видаляти тимчасовий файл після розпакування (якщо передано ArrayBuffer)
   */
  async extractZipFile(
    zipPathOrData: string | ArrayBuffer,
    parser: (filename: string, content: Buffer | string) => any[],
    shouldCleanup: boolean = true
  ): Promise<any[]> {
    // Використовуємо unzipper для розпакування
    const { createReadStream } = await import('fs');
    const unzipper = (await import('unzipper')).default;
    const { writeFile, unlink } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { existsSync } = await import('fs');

    let tempZipPath: string;
    let isTemporary = false;

    if (typeof zipPathOrData === 'string') {
      // Передано шлях до файлу
      tempZipPath = zipPathOrData;
      if (!existsSync(tempZipPath)) {
        throw new Error(`ZIP файл не знайдено: ${tempZipPath}`);
      }
    } else {
      // Передано ArrayBuffer - зберігаємо тимчасово
      tempZipPath = join(tmpdir(), `rada_doc_${Date.now()}.zip`);
      await writeFile(tempZipPath, Buffer.from(zipPathOrData));
      isTemporary = shouldCleanup;
      
      if (!existsSync(tempZipPath)) {
        throw new Error(`Тимчасовий ZIP файл не створено: ${tempZipPath}`);
      }
    }

    try {
      const results: any[] = [];
      
      return new Promise((resolve, reject) => {
        const stream = createReadStream(tempZipPath);
        
        stream.on('error', (error: Error) => {
          reject(new Error(`Помилка читання ZIP файлу: ${error.message}`));
        });
        
        stream
          .pipe(unzipper.Parse())
          .on('entry', async (entry: any) => {
            const fileName = entry.path.toLowerCase();
            
            // Шукаємо CSV/TSV файли
            if (fileName.endsWith('.csv') || fileName.endsWith('.tsv') || fileName.endsWith('.txt')) {
              try {
                const content = await entry.buffer();
                // content - це Buffer, передаємо його в parser
                // parser приймає Buffer | string
                const parsed = parser(fileName, content as Buffer | string);
                if (parsed) {
                  // Використовуємо цикл замість spread для великих масивів
                  if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                      results.push(item);
                    }
                  } else {
                    results.push(parsed);
                  }
                }
              } catch (error) {
                console.warn(`⚠️  Помилка парсингу ${entry.path}:`, error instanceof Error ? error.message : String(error));
              }
            }
            
            entry.autodrain();
          })
          .on('finish', () => {
            resolve(results);
          })
          .on('error', (error: Error) => {
            reject(error);
          });
      });
    } finally {
      // Видаляємо тимчасовий файл тільки якщо він був створений нами
      if (isTemporary && shouldCleanup) {
        try {
          await unlink(tempZipPath);
        } catch {
          // Ігноруємо помилки видалення
        }
      }
    }
  }
}

