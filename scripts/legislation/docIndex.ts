/**
 * Модуль для пошуку документів через індекс rada.gov.ua
 * 
 * ⚠️ LEGACY MODULE — DEPRECATED
 * 
 * Цей модуль залишено для сумісності зі старими скриптами.
 * НОВІ скрипти повинні використовувати `radaDocIndex.ts` замість цього модуля.
 * 
 * Пріоритети джерел індексу:
 * Priority A: ZIP з /open/data/doc (повний каталог, якщо доступний)
 * Priority B: HTML парсинг /laws/main/a (всі документи з пагінацією) — ЗАБОРОНЕНО
 * Priority C: TSV з /laws/main/r.tsv (оновлені документи, fallback)
 * 
 * Кешує дані локально в tmp/rada_index/
 * 
 * @deprecated Використовуйте `radaDocIndex.ts` для нових реалізацій
 */

import { RADA_API_CONFIG, PATHS } from './config.js';
import { OpenDataPortalClient, DatasetItem } from './openDataPortalClient.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

export interface DocumentIndexEntry {
  nreg: string;
  dokid?: number;
  title: string;
  type?: string;
  organ?: string;
  datred?: string;
  url?: string;
}

interface IndexMetadata {
  downloaded_at: string;
  etag?: string;
  last_modified?: string;
  source: 'opendata' | 'html_all' | 'tsv_recent';
  entry_count: number;
  total_pages?: number; // для HTML парсингу
  dataset_id?: string; // для Open Data Portal
  file_name?: string; // для Open Data Portal
}

const INDEX_DIR = `${PATHS.tmp}/rada_index`;
const INDEX_CACHE_FILE = `${INDEX_DIR}/documents.json`; // JSON для зручності
const METADATA_FILE = `${INDEX_DIR}/metadata.json`;
const TSV_CACHE_FILE = `${INDEX_DIR}/documents.tsv`; // для TSV fallback
const ZIP_CACHE_FILE = `${INDEX_DIR}/doc.zip`; // для ZIP кешу

// Джерела індексу (пріоритети)
const ZIP_URL = `${RADA_API_CONFIG.baseUrl}/open/data/doc`;
const HTML_ALL_URL = `${RADA_API_CONFIG.baseUrl}/laws/main/a`;
const TSV_RECENT_URL = `${RADA_API_CONFIG.baseUrl}/laws/main/r.tsv`;

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 години

/**
 * Забезпечує наявність локального індексу
 * Завантажує та кешує дані якщо потрібно
 */
export async function ensureDocIndexLocal(forceRefresh: boolean = false): Promise<void> {
  // Створюємо папку якщо не існує
  if (!existsSync(INDEX_DIR)) {
    await mkdir(INDEX_DIR, { recursive: true });
  }

  // Перевіряємо чи потрібно оновити кеш
  const needsRefresh = forceRefresh || await shouldRefreshIndex();
  
  if (needsRefresh) {
    console.log('📥 Завантажуємо індекс документів...');
    await downloadIndexWithPriority(forceRefresh);
  } else {
    console.log('✅ Використовуємо кешований індекс');
  }
}

/**
 * Отримує інформацію про джерело індексу
 */
export async function getIndexSource(): Promise<{ source: string; entryCount: number; downloadedAt?: string } | null> {
  if (!existsSync(METADATA_FILE)) {
    return null;
  }

  try {
    const metadata = JSON.parse(await readFile(METADATA_FILE, 'utf-8')) as IndexMetadata;
    return {
      source: metadata.source,
      entryCount: metadata.entry_count,
      downloadedAt: metadata.downloaded_at,
    };
  } catch {
    return null;
  }
}

/**
 * Перевіряє чи потрібно оновити індекс
 */
async function shouldRefreshIndex(): Promise<boolean> {
  // Якщо файл не існує - потрібно завантажити
  if (!existsSync(INDEX_CACHE_FILE) || !existsSync(METADATA_FILE)) {
    return true;
  }

  try {
    const metadata: IndexMetadata = JSON.parse(await readFile(METADATA_FILE, 'utf-8'));
    const downloadedAt = new Date(metadata.downloaded_at).getTime();
    const now = Date.now();
    
    // Перевіряємо TTL
    if (now - downloadedAt > CACHE_TTL) {
      console.log('⏰ Кеш застарів, потрібне оновлення');
      return true;
    }

    return false;
  } catch (error) {
    console.warn('⚠️  Помилка читання метаданих, завантажуємо заново');
    return true;
  }
}

/**
 * Завантажує індекс з пріоритетами
 */
async function downloadIndexWithPriority(forceRefresh: boolean = false): Promise<void> {
  // Priority A: Open Data Portal - docs -> doc.csv
  // Це єдине джерело - HTML crawling заборонено
  try {
    console.log('🔍 Завантажуємо індекс через Open Data Portal (docs -> doc.csv)...');
    const opendataAvailable = await tryOpenDataPortal(forceRefresh);
    if (opendataAvailable) {
      console.log('✅ Використано Open Data Portal індекс');
      return;
    }
  } catch (error) {
    console.warn('⚠️  Open Data Portal недоступний:', error instanceof Error ? error.message : String(error));
  }

  // Fallback: TSV (тільки оновлені документи)
  console.log('🔍 Використовуємо fallback: TSV (оновлені документи)...');
  await downloadTsvIndex();
  console.log('✅ Використано TSV індекс (оновлені)');
}

/**
 * Спроба завантажити індекс через Open Data Portal (Priority A)
 * 
 * Алгоритм:
 * 1. Отримуємо passport для 'zak'
 * 2. Знаходимо піддатасет 'laws'
 * 3. Знаходимо піддатасет 'docs'
 * 4. Знаходимо файл 'doc' (картки документів)
 * 5. Завантажуємо та парсимо CSV/ZIP
 */
async function tryOpenDataPortal(forceRefresh: boolean = false): Promise<boolean> {
  const client = new OpenDataPortalClient();
  
  try {
    // Крок 1: Отримуємо passport для 'zak'
    console.log('📋 Крок 1: Отримуємо passport для датасету "zak"...');
    const zakPassport = await client.getDatasetPassport('zak');
    
    // Крок 2: Знаходимо піддатасет 'laws'
    const lawsItem = zakPassport.item?.find((item: DatasetItem) => item.id === 'laws');
    if (!lawsItem) {
      console.warn('⚠️  Піддатасет "laws" не знайдено в "zak"');
      return false;
    }
    
    // Крок 3: Отримуємо passport для 'docs' напряму
    // Згідно з документацією, docs доступний через /open/data/docs.json
    console.log('📋 Крок 2: Отримуємо passport для датасету "docs"...');
    const docsPassport = await client.getDatasetPassport('docs');
    
    // Крок 6: Знаходимо файл 'doc' (картки документів)
    const docFile = client.findDatasetFile(docsPassport, {
      type: 'data',
      namePattern: /^doc/i,
      preferLargest: true,
    });
    
    if (!docFile) {
      console.warn('⚠️  Файл "doc" не знайдено в "docs"');
      return false;
    }
    
    console.log(`📄 Знайдено файл: ${docFile.name} (${docFile.size ? Math.round(docFile.size / 1024 / 1024) + ' MB' : 'unknown size'})`);
    
    // Крок 7: Завантажуємо та парсимо файл
    const entries: DocumentIndexEntry[] = [];
    let downloadMetadata: { etag?: string; lastModified?: string } = {};
    
    if (docFile.archived === 'zip') {
      // ZIP файл - розпаковуємо та парсимо
      console.log('📦 Файл архівований в ZIP, розпаковуємо...');
      
      const result = await client.downloadDatasetFile(docFile, {
        forceRefresh,
        streamParser: async (stream: ReadableStream<Uint8Array>) => {
          // Конвертуємо ReadableStream в ArrayBuffer для unzipper
          const chunks: Uint8Array[] = [];
          const reader = stream.getReader();
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          
          const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
          const buffer = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.length;
          }
          
          // Розпаковуємо ZIP
          const parsed = await client.extractZipFile(
            buffer.buffer,
            (filename, content) => {
              if (filename.toLowerCase().endsWith('.csv') || filename.toLowerCase().endsWith('.txt')) {
                // content може бути Buffer або string, конвертуємо в string
                const text = Buffer.isBuffer(content) ? content.toString('binary') : content;
                return parseDocCsv(text);
              }
              return [];
            }
          );
          
          return parsed.flat();
        },
      });
      
      downloadMetadata = result.metadata;
      
      if (result.data && Array.isArray(result.data)) {
        entries.push(...result.data);
      }
    } else {
      // Прямий CSV файл
      console.log('📄 Завантажуємо CSV файл...');
      
      const result = await client.downloadDatasetFile(docFile, {
        forceRefresh,
        streamParser: async (stream: ReadableStream<Uint8Array>) => {
          // Конвертуємо stream в текст
          const chunks: string[] = [];
          const reader = stream.getReader();
          const decoder = new TextDecoder('utf-8');
          
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
          
          const text = chunks.join('');
          return parseDocCsv(text);
        },
      });
      
      downloadMetadata = result.metadata;
      
      if (result.data && Array.isArray(result.data)) {
        entries.push(...result.data);
      }
    }
    
    if (entries.length === 0) {
      console.warn('⚠️  Файл завантажено, але документи не знайдено');
      return false;
    }
    
    // Зберігаємо derived index (тільки компактні дані)
    await writeFile(INDEX_CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    
    // Зберігаємо метадані
    const metadata: IndexMetadata = {
      downloaded_at: new Date().toISOString(),
      etag: downloadMetadata.etag,
      last_modified: downloadMetadata.lastModified,
      source: 'opendata',
      entry_count: entries.length,
      dataset_id: 'zak/laws/docs',
      file_name: docFile.name,
    };
    
    await writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    
    console.log(`✅ Open Data Portal індекс створено (${entries.length} документів)`);
    return true;
  } catch (error) {
    console.warn('⚠️  Помилка завантаження через Open Data Portal:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Парсить CSV файл з картками документів
 * 
 * Формат CSV визначається структурою doc-stru.
 * Очікувані колонки: nreg, nazva (назва), dokid, datred, тощо.
 */
function parseDocCsv(csvText: string): DocumentIndexEntry[] {
  const entries: DocumentIndexEntry[] = [];
  const lines = csvText.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) return entries;
  
  // Парсимо заголовки (перший рядок)
  const headers = parseCsvLine(lines[0]);
  
  // Знаходимо індекси потрібних колонок
  const nregIndex = headers.findIndex(h => h.toLowerCase() === 'nreg' || h.toLowerCase().includes('nreg'));
  const nazvaIndex = headers.findIndex(h => h.toLowerCase() === 'nazva' || h.toLowerCase().includes('nazva') || h.toLowerCase().includes('назва'));
  const dokidIndex = headers.findIndex(h => h.toLowerCase() === 'dokid' || h.toLowerCase().includes('dokid'));
  const datredIndex = headers.findIndex(h => h.toLowerCase() === 'datred' || h.toLowerCase().includes('datred') || h.toLowerCase().includes('дата'));
  
  if (nregIndex === -1 || nazvaIndex === -1) {
    console.warn('⚠️  Не знайдено обов\'язкові колонки (nreg, nazva) в CSV');
    return entries;
  }
  
  // Парсимо дані
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = parseCsvLine(line);
    
    const nreg = columns[nregIndex]?.trim();
    const nazva = columns[nazvaIndex]?.trim();
    
    if (nreg && nazva) {
      entries.push({
        nreg,
        title: nazva,
        dokid: dokidIndex >= 0 ? parseInt(columns[dokidIndex] || '0', 10) || undefined : undefined,
        datred: datredIndex >= 0 ? columns[datredIndex]?.trim() : undefined,
      });
    }
  }
  
  return entries;
}

/**
 * Простий парсер CSV рядка (з підтримкою значень в лапках)
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current);
  return result;
}

/**
 * Завантажує HTML індекс всіх документів (Priority B)
 * Парсить HTML з /laws/main/a з пагінацією
 */
async function downloadHtmlAllIndex(): Promise<void> {
  const entries: DocumentIndexEntry[] = [];
  let page = 1;
  let hasMore = true;
  const maxPages = 100; // Обмеження для безпеки (можна збільшити)

  while (hasMore && page <= maxPages) {
    // Формат пагінації: /laws/main/a/page2, /laws/main/a/page3, ...
    // Або /a/page2 (без /laws/main/)
    const url = page === 1 ? HTML_ALL_URL : `${RADA_API_CONFIG.baseUrl}/laws/main/a/page${page}`;
    
    console.log(`📥 Завантажуємо сторінку ${page}...`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': RADA_API_CONFIG.tokenUserAgent,
      },
      signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request),
    });

    if (!response.ok) {
      if (response.status === 404 && page > 1) {
        // Сторінка не існує - досягли кінця
        hasMore = false;
        break;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const pageEntries = parseHtmlIndexPage(html);
    
    if (pageEntries.length === 0) {
      hasMore = false;
    } else {
      entries.push(...pageEntries);
      console.log(`   Знайдено ${pageEntries.length} документів на сторінці ${page} (всього: ${entries.length})`);
      
      // Перевіряємо чи є наступна сторінка в HTML
      // Шукаємо посилання на наступну сторінку
      const nextPagePattern = new RegExp(`/page${page + 1}|href="[^"]*page${page + 1}`, 'i');
      hasMore = nextPagePattern.test(html) || pageEntries.length >= 100; // Якщо знайдено багато - ймовірно є ще
      page++;
      
      // Пауза між запитами
      await new Promise(resolve => setTimeout(resolve, RADA_API_CONFIG.rateLimit.recommendedDelay));
      
      // Обмеження для Phase 2: 50 сторінок (≈50,000 документів)
      // Для повного каталогу (289,079 документів) потрібно ~289 сторінок
      // Це обмеження можна збільшити в Phase 3 якщо потрібно
      if (page > 50) {
        console.log('⚠️  Обмежено до 50 сторінок (Phase 2). Для повного каталогу потрібно ~289 сторінок.');
        hasMore = false;
      }
    }
  }

  console.log(`📊 Всього завантажено ${entries.length} документів`);

  // Зберігаємо в JSON
  await writeFile(INDEX_CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');

  // Зберігаємо метадані
  const metadata: IndexMetadata = {
    downloaded_at: new Date().toISOString(),
    source: 'html_all',
    entry_count: entries.length,
    total_pages: page - 1,
  };

  await writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Парсить HTML сторінку індексу
 * Формат: <li><a href="/go/nreg">Назва документа</a></li>
 */
function parseHtmlIndexPage(html: string): DocumentIndexEntry[] {
  const entries: DocumentIndexEntry[] = [];
  
  // Регулярний вираз для посилань: <a href="/go/nreg">Назва</a>
  const linkRegex = /<a\s+href="\/go\/([^"]+)">([^<]+)<\/a>/g;
  
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const nregEncoded = match[1];
    const title = match[2].trim();
    
    // Декодуємо nreg з URL
    let nreg: string;
    try {
      nreg = decodeURIComponent(nregEncoded);
    } catch {
      nreg = nregEncoded;
    }

    if (nreg && title) {
      entries.push({
        nreg,
        title,
      });
    }
  }

  return entries;
}

/**
 * Завантажує TSV індекс (Priority C - fallback)
 */
async function downloadTsvIndex(): Promise<void> {
  try {
    console.log(`📥 Завантажуємо TSV з ${TSV_RECENT_URL}...`);
    
    const response = await fetch(TSV_RECENT_URL, {
      headers: {
        'User-Agent': RADA_API_CONFIG.tokenUserAgent,
      },
      signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request * 2),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const tsvContent = await response.text();
    const etag = response.headers.get('etag') || undefined;
    const lastModified = response.headers.get('last-modified') || undefined;

    // Зберігаємо TSV
    await writeFile(TSV_CACHE_FILE, tsvContent, 'utf-8');

    // Парсимо та конвертуємо в JSON
    const entries = await parseTsvIndex();
    await writeFile(INDEX_CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');

    // Зберігаємо метадані
    const metadata: IndexMetadata = {
      downloaded_at: new Date().toISOString(),
      etag,
      last_modified: lastModified,
      source: 'tsv_recent',
      entry_count: entries.length,
    };

    await writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');

    console.log(`✅ Індекс завантажено (${metadata.entry_count} записів)`);
  } catch (error) {
    console.error('❌ Помилка завантаження індексу:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Парсить TSV файл та повертає записи
 */
async function parseTsvIndex(): Promise<DocumentIndexEntry[]> {
  if (!existsSync(TSV_CACHE_FILE)) {
    throw new Error('TSV файл не знайдено');
  }

  const entries: DocumentIndexEntry[] = [];
  const fileStream = createReadStream(TSV_CACHE_FILE, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let isFirstLine = true;
  let headers: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;

    const columns = line.split('\t');
    
    if (isFirstLine) {
      headers = columns.map(h => h.trim().toLowerCase());
      isFirstLine = false;
      continue;
    }

    const entry: DocumentIndexEntry = {
      nreg: '',
      title: '',
    };

    headers.forEach((header, index) => {
      const value = columns[index]?.trim() || '';
      
      if (header === 'nazva') {
        entry.title = value;
      } else if (header === 'link') {
        entry.url = value;
        const urlMatch = value.match(/go\/([^\/]+)/);
        if (urlMatch && urlMatch[1]) {
          try {
            entry.nreg = decodeURIComponent(urlMatch[1]);
          } catch {
            entry.nreg = urlMatch[1];
          }
        }
      } else if (header === 'card') {
        entry.organ = value;
      } else if (header === 'status') {
        if (value && value !== 'Не визначено') {
          entry.type = value;
        }
      }
    });

    if (entry.nreg && entry.title) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Завантажує індекс з кешу
 */
async function loadIndexFromCache(): Promise<DocumentIndexEntry[]> {
  if (!existsSync(INDEX_CACHE_FILE)) {
    throw new Error('Індекс не знайдено. Запустіть ensureDocIndexLocal() спочатку.');
  }

  const content = await readFile(INDEX_CACHE_FILE, 'utf-8');
  return JSON.parse(content) as DocumentIndexEntry[];
}

/**
 * Пошук документів за запитом
 * Повертає найкращі збіги з оцінкою
 */
export async function searchDocIndex(query: string, limit: number = 10): Promise<Array<DocumentIndexEntry & { score: number }>> {
  await ensureDocIndexLocal();
  
  const entries = await loadIndexFromCache();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  // Обчислюємо оцінку для кожного документа
  const scored = entries.map(entry => {
    const titleLower = entry.title.toLowerCase();
    let score = 0;

    // Точний збіг назви
    if (titleLower === queryLower) {
      score += 1000;
    }
    // Початок назви
    else if (titleLower.startsWith(queryLower)) {
      score += 500;
    }
    // Містить всю фразу
    else if (titleLower.includes(queryLower)) {
      score += 300;
    }

    // Збіги окремих слів
    queryWords.forEach(word => {
      if (titleLower.includes(word)) {
        score += 50;
      }
    });

    // Бонус за довжину (коротші назви краще)
    score += Math.max(0, 100 - entry.title.length);

    return { ...entry, score };
  });

  // Сортуємо за оцінкою та обмежуємо
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Знаходить документ за точною назвою
 */
export async function findByExactTitle(title: string): Promise<DocumentIndexEntry | null> {
  const results = await searchDocIndex(title, 1);
  if (results.length === 0) {
    return null;
  }

  const best = results[0];
  if (best.title.toLowerCase() === title.toLowerCase()) {
    return best;
  }

  return null;
}
