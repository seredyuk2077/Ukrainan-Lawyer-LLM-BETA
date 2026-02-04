/**
 * Rada Document Index
 * 
 * Швидкий lookup індекс документів з каталогу відкритих даних ВРУ.
 * Використовує файл "Картки документів" з /open/data/docs (doc.txt).
 * 
 * Особливості:
 * - Кешує дані локально з TTL (6-12 годин)
 * - Не зберігає файли в репозиторії
 * - Швидкий lookup за назвою або nreg
 * - Автоматичне оновлення кешу
 */

import { OpenDataPortalClient, DatasetPassport, DatasetItem } from './openDataPortalClient.js';
import { PATHS, RADA_API_CONFIG } from './config.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'module';

// Ініціалізуємо iconv-lite для конвертації Windows-1251
const require = createRequire(import.meta.url);
const iconvLite = require('iconv-lite');

export interface DocIndexEntry {
  nreg: string;
  title: string;
  dokid?: number;
  datred?: string;
  type?: string;
  organ?: string;
  url?: string;
}

export interface LookupCandidate {
  nreg: string;
  title: string;
  score: number;
  dokid?: number;
  datred?: string;
  type?: string;
  organ?: string;
}

interface CacheMetadata {
  downloaded_at: string;
  source_url: string;
  etag?: string;
  last_modified?: string;
  ttl_seconds: number;
  entry_count: number;
  file_size?: number;
}

const CACHE_DIR = `${PATHS.tmp}/rada-open-data`;
const INDEX_CACHE_FILE = `${CACHE_DIR}/doc_index.json`;
const METADATA_FILE = `${CACHE_DIR}/meta.json`;
const DEFAULT_TTL_HOURS = 6; // 6 годин за замовчуванням

let cachedIndex: DocIndexEntry[] | null = null;
let cacheMetadata: CacheMetadata | null = null;

/**
 * Нормалізує текст для пошуку
 * 
 * Використовується для нормалізації як запиту, так і назв документів.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Видаляємо діакритики
    .replace(/[^\w\s\u0400-\u04FF]/g, ' ') // Замінюємо пунктуацію на пробіли (зберігаємо кирилицю)
    .replace(/\s+/g, ' ') // Нормалізуємо пробіли
    .trim();
}

/**
 * Обчислює score збігу (0-100)
 */
function calculateScore(query: string, title: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedTitle = normalizeText(title);
  
  // Точний збіг
  if (normalizedTitle === normalizedQuery) {
    return 100;
  }
  
  // Починається з запиту
  if (normalizedTitle.startsWith(normalizedQuery)) {
    return 90;
  }
  
  // Містить весь запит
  if (normalizedTitle.includes(normalizedQuery)) {
    return 80;
  }
  
  // Містить слова з запиту
  const queryWords = normalizedQuery.split(' ').filter(w => w.length > 2);
  const titleWords = normalizedTitle.split(' ');
  
  let matchedWords = 0;
  for (const word of queryWords) {
    if (titleWords.some(tw => tw.includes(word) || word.includes(tw))) {
      matchedWords++;
    }
  }
  
  if (matchedWords === 0) {
    return 0;
  }
  
  return Math.round((matchedWords / queryWords.length) * 60);
}

/**
 * Перевіряє чи потрібно оновити кеш
 */
async function shouldRefreshCache(): Promise<boolean> {
  if (!existsSync(METADATA_FILE) || !existsSync(INDEX_CACHE_FILE)) {
    return true;
  }
  
  try {
    const metadata = JSON.parse(await readFile(METADATA_FILE, 'utf-8')) as CacheMetadata;
    const ttlMs = metadata.ttl_seconds * 1000;
    const downloadedAt = new Date(metadata.downloaded_at).getTime();
    const now = Date.now();
    
    if (now - downloadedAt > ttlMs) {
      return true; // TTL минув
    }
    
    return false;
  } catch {
    return true; // Помилка читання - оновлюємо
  }
}

/**
 * Завантажує структуру CSV файлу doc-stru
 */
async function loadDocStructure(): Promise<Map<string, number>> {
  try {
    const response = await fetch('https://data.rada.gov.ua/ogd/zak/stru/doc-stru.csv', {
      headers: { 'User-Agent': 'OpenData' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const text = await response.text();
    const lines = text.split('\n').filter(line => line.trim());
    
    const structure = new Map<string, number>();
    lines.forEach((line, index) => {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length >= 2) {
        const fieldName = parts[0].toLowerCase();
        structure.set(fieldName, index);
      }
    });
    
    return structure;
  } catch (error) {
    console.warn('⚠️  Не вдалося завантажити структуру, використовуємо стандартні колонки');
    // Повертаємо стандартні колонки
    const standard = new Map<string, number>();
    standard.set('nreg', 0);
    standard.set('nazva', 1);
    standard.set('dokid', 2);
    return standard;
  }
}

/**
 * Конвертує Buffer з Windows-1251 в UTF-8
 * 
 * Файл doc.txt зберігається в Windows-1251.
 * Buffer містить сирі байти Windows-1251, конвертуємо їх в UTF-8.
 */
function convertBufferEncoding(buffer: Buffer): string {
  // iconv-lite вже імпортований на рівні модуля через createRequire
  // Файл doc.txt точно в Windows-1251, конвертуємо без перевірок
  return iconvLite.decode(buffer, 'windows-1251');
}

/**
 * Мапа колонок у файлі doc.txt
 * 
 * Формат: TSV (табуляція як роздільник)
 * Структура (9 колонок):
 * [0] dokid - ідентифікатор документа (integer)
 * [1] nreg - номер реєстрації (string)
 * [2] nazva - назва документа (string, Windows-1251)
 * [3] status - статус (short)
 * [4] types - типи документів (array)
 * [5] organs - органи (array)
 * [6] (порожня)
 * [7] minjust - міністерство юстиції (byte)
 * [8] datred - дата редагування (YYYYMMDD)
 */
const DOC_COLUMNS = {
  DOKID: 0,
  NREG: 1,
  NAZVA: 2,
  STATUS: 3,
  TYPES: 4,
  ORGANS: 5,
  EMPTY: 6,
  MINJUST: 7,
  DATRED: 8,
} as const;

/**
 * Нормалізує текст назви документа
 */
function normalizeTitle(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ') // Подвійні пробіли -> один
    .replace(/^["']|["']$/g, '') // Видаляємо лапки на початку/кінці
    .trim();
}

/**
 * Конвертує дату з формату YYYYMMDD в ISO формат
 */
function formatDate(dateStr: string): string | undefined {
  if (!dateStr || dateStr.length !== 8) {
    return undefined;
  }
  
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  
  return `${year}-${month}-${day}`;
}

/**
 * Парсить TSV рядок з картками документів
 * 
 * Файл doc.txt використовує табуляцію як роздільник.
 * Кодування: Windows-1251 (конвертується в UTF-8 при завантаженні)
 */
function parseDocCsvLine(line: string): DocIndexEntry | null {
  // Розділяємо по табуляції
  const columns = line.split('\t');
  
  // Перевіряємо мінімальну кількість колонок
  if (columns.length < 9) {
    return null;
  }
  
  // Витягуємо дані з колонок
  const dokidStr = columns[DOC_COLUMNS.DOKID]?.trim();
  const nreg = columns[DOC_COLUMNS.NREG]?.trim();
  const nazvaRaw = columns[DOC_COLUMNS.NAZVA]?.trim();
  const datredRaw = columns[DOC_COLUMNS.DATRED]?.trim();
  
  // Перевірка обов'язкових полів
  if (!dokidStr || !nreg || !nazvaRaw) {
    return null;
  }
  
  // Парсимо dokid
  const dokid = parseInt(dokidStr, 10);
  if (isNaN(dokid)) {
    return null;
  }
  
  // Нормалізуємо назву
  const title = normalizeTitle(nazvaRaw);
  if (title.length === 0) {
    return null;
  }
  
  // Формуємо запис
  const entry: DocIndexEntry = {
    nreg,
    title,
    dokid,
  };
  
  // Додаємо дату редагування (формат YYYYMMDD -> YYYY-MM-DD)
  if (datredRaw) {
    entry.datred = formatDate(datredRaw);
  }
  
  // Додаємо типи (якщо є)
  const typesStr = columns[DOC_COLUMNS.TYPES]?.trim();
  if (typesStr && typesStr !== '0') {
    entry.type = typesStr;
  }
  
  // Додаємо органи (якщо є)
  const organsStr = columns[DOC_COLUMNS.ORGANS]?.trim();
  if (organsStr && organsStr.length > 0) {
    entry.organ = organsStr;
  }
  
  // Формуємо URL
  entry.url = `https://data.rada.gov.ua/laws/show/${nreg}`;
  
  return entry;
}

/**
 * Завантажує та парсить індекс документів
 */
async function loadDocIndex(forceRefresh: boolean = false): Promise<DocIndexEntry[]> {
  // Перевіряємо кеш
  if (!forceRefresh && !(await shouldRefreshCache())) {
    if (cachedIndex) {
      return cachedIndex;
    }
    
    // Завантажуємо з кешу
    if (existsSync(INDEX_CACHE_FILE)) {
      try {
        const cached = JSON.parse(await readFile(INDEX_CACHE_FILE, 'utf-8')) as DocIndexEntry[];
        cachedIndex = cached;
        console.log(`✅ Використовуємо кешований індекс (${cached.length} документів)`);
        return cached;
      } catch (error) {
        console.warn('⚠️  Помилка читання кешу, завантажуємо заново');
      }
    }
  }
  
  console.log('📥 Завантажуємо індекс документів з Open Data Portal...');
  
  const client = new OpenDataPortalClient();
  
  // Отримуємо passport для docs
  const docsPassport = await client.getDatasetPassport('docs');
  
  // Знаходимо файл doc
  const docFile = client.findDatasetFile(docsPassport, {
    type: 'data',
    namePattern: /^doc/i,
    preferLargest: true,
  });
  
  if (!docFile) {
    throw new Error('Файл doc не знайдено в каталозі docs');
  }
  
  console.log(`📄 Знайдено файл: ${docFile.name} (${docFile.size ? Math.round(docFile.size / 1024 / 1024) + ' MB' : 'unknown size'})`);
  
  // Завантажуємо та парсимо файл
  const entries: DocIndexEntry[] = [];
  let downloadMetadata: { etag?: string; lastModified?: string } = {};
  
  if (docFile.archived === 'zip') {
    console.log('📦 Файл архівований в ZIP, розпаковуємо...');
    
    // Для ZIP файлів завантажуємо весь файл, потім розпаковуємо
    // Формуємо URL: видаляємо розширення з імені та додаємо .zip
    if (!docFile.name) {
      throw new Error('Файл doc не має імені');
    }
    const nameWithoutExt = docFile.name.replace(/\.[^.]+$/, '');
    const zipUrl = `${RADA_API_CONFIG.baseUrl}${docFile.path}${nameWithoutExt}.zip`;
    
    const response = await fetch(zipUrl, {
      headers: { 'User-Agent': RADA_API_CONFIG.tokenUserAgent },
      signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request * 10),
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download ZIP: HTTP ${response.status}`);
    }
    
    console.log('📦 Завантажуємо ZIP файл в пам\'ять...');
    const arrayBuffer = await response.arrayBuffer();
    console.log(`✅ ZIP завантажено (${Math.round(arrayBuffer.byteLength / 1024 / 1024)} MB)`);
    
    // Зберігаємо тимчасово на диск для розпакування
    const { writeFile, unlink } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const tempZipPath = join(tmpdir(), `rada_doc_${Date.now()}.zip`);
    
    try {
      console.log(`💾 Зберігаємо ZIP в тимчасовий файл: ${tempZipPath}`);
      await writeFile(tempZipPath, Buffer.from(arrayBuffer));
      
      // Перевіряємо що файл існує
      const { existsSync } = await import('fs');
      if (!existsSync(tempZipPath)) {
        throw new Error(`Тимчасовий ZIP файл не створено: ${tempZipPath}`);
      }
      
      console.log(`✅ ZIP збережено, розпаковуємо...`);
      
      // Розпаковуємо ZIP (передаємо шлях до файлу)
      const parsed = await client.extractZipFile(
        tempZipPath,
        (filename: string, content: Buffer | string) => {
          if (filename.toLowerCase().endsWith('.csv') || filename.toLowerCase().endsWith('.txt')) {
            // content від unzipper - це Buffer
            // Важливо: unzipper повертає Buffer з сирими байтами Windows-1251
            // Конвертуємо їх в UTF-8
            const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'binary');
            
            // Конвертуємо з Windows-1251 в UTF-8
            const text = convertBufferEncoding(buffer);
            const lines = text.split(/\r?\n/);
            const parsedEntries: DocIndexEntry[] = [];
            
            // Файл doc.txt не має заголовку - парсимо всі рядки
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (!line || !line.trim()) continue;
              
              try {
                const entry = parseDocCsvLine(line);
                if (entry) {
                  parsedEntries.push(entry);
                }
              } catch (error) {
                // Пропускаємо помилкові рядки (лог тільки для перших 10)
                if (i < 10) {
                  console.warn(`⚠️  Помилка парсингу рядка ${i + 1}:`, error instanceof Error ? error.message : String(error));
                }
              }
            }
            
            console.log(`📊 Розпарсено ${parsedEntries.length} документів з ${lines.length} рядків`);
            return parsedEntries;
          }
          return [];
        }
      );
      
      // extractZipFile повертає масив результатів (вже плоский)
      // Але якщо parser повертає масив масивів, потрібно їх об'єднати
      let allEntries: DocIndexEntry[] = [];
      
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Якщо перший елемент - масив, значить це масив масивів
        if (Array.isArray(parsed[0])) {
          // Об'єднуємо по частинах щоб уникнути stack overflow
          for (let i = 0; i < parsed.length; i++) {
            const batch = parsed[i];
            if (Array.isArray(batch)) {
              for (let j = 0; j < batch.length; j++) {
                allEntries.push(batch[j]);
              }
            }
          }
        } else {
          // Це вже плоский масив
          allEntries = parsed as DocIndexEntry[];
        }
      }
      
      const result = {
        data: allEntries,
        metadata: {
          etag: response.headers.get('etag') || undefined,
          lastModified: response.headers.get('last-modified') || undefined,
        },
      };
      
      downloadMetadata = result.metadata;
      
      if (result.data && Array.isArray(result.data)) {
        // Використовуємо цикл замість spread для великих масивів
        for (const entry of result.data) {
          entries.push(entry);
        }
      }
    } finally {
      // Видаляємо тимчасовий файл
      try {
        await unlink(tempZipPath);
      } catch {
        // Ігноруємо помилки видалення
      }
    }
  } else {
    // Прямий CSV файл
    console.log('📄 Завантажуємо CSV файл...');
    
    const result = await client.downloadDatasetFile(docFile, {
      forceRefresh,
      streamParser: async (stream: ReadableStream<Uint8Array>) => {
        const chunks: string[] = [];
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
        
        const text = chunks.join('');
        const lines = text.split('\n').filter(line => line.trim());
        
        // Пропускаємо заголовок
        const startIndex = lines[0]?.includes('nreg') || lines[0]?.includes('nazva') ? 1 : 0;
        
        // Конвертуємо текст з Windows-1251
        const buffer = Buffer.from(text, 'binary');
        const textConverted = convertBufferEncoding(buffer);
        const linesConverted = textConverted.split(/\r?\n/).filter(line => line.trim());
        
        const parsedEntries: DocIndexEntry[] = [];
        for (let i = 0; i < linesConverted.length; i++) {
          const entry = parseDocCsvLine(linesConverted[i]);
          if (entry) {
            parsedEntries.push(entry);
          }
        }
        
        return parsedEntries;
      },
    });
    
    downloadMetadata = result.metadata;
    
    // Якщо файл не змінився (304), result.data буде undefined
    if (result.data && Array.isArray(result.data)) {
      // Використовуємо цикл замість spread для великих масивів
      for (const entry of result.data) {
        entries.push(entry);
      }
    } else if (!result.data) {
      // Файл не змінився, завантажуємо з кешу
      if (existsSync(INDEX_CACHE_FILE)) {
        try {
          const cached = JSON.parse(await readFile(INDEX_CACHE_FILE, 'utf-8')) as DocIndexEntry[];
          entries.push(...cached);
          console.log(`✅ Використано кешований індекс (304 Not Modified)`);
        } catch {
          throw new Error('Файл не змінився, але кеш недоступний');
        }
      } else {
        throw new Error('Файл не змінився, але кеш відсутній');
      }
    }
  }
  
  if (entries.length === 0) {
    throw new Error('Не вдалося розпарсити індекс документів');
  }
  
  // Зберігаємо в кеш
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
  
  // Зберігаємо індекс в UTF-8 (JSON.stringify правильно обробляє Unicode)
  await writeFile(INDEX_CACHE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  
  // Зберігаємо метадані
  const metadata: CacheMetadata = {
    downloaded_at: new Date().toISOString(),
    source_url: `https://data.rada.gov.ua/ogd/zak/laws/data/csv/${docFile.name}`,
    etag: downloadMetadata.etag,
    last_modified: downloadMetadata.lastModified,
    ttl_seconds: DEFAULT_TTL_HOURS * 3600,
    entry_count: entries.length,
    file_size: docFile.size,
  };
  
  await writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
  
  cachedIndex = entries;
  cacheMetadata = metadata;
  
  console.log(`✅ Індекс завантажено та збережено (${entries.length} документів)`);
  
  return entries;
}

/**
 * Забезпечує актуальність індексу
 */
export async function ensureIndexFresh(forceRefresh: boolean = false): Promise<void> {
  await loadDocIndex(forceRefresh);
}

/**
 * Шукає кандидатів за запитом
 */
export async function resolveCandidates(
  query: string,
  limit: number = 20
): Promise<LookupCandidate[]> {
  const index = await loadDocIndex();
  
  const normalizedQuery = normalizeText(query);
  const candidates: LookupCandidate[] = [];
  
  for (const entry of index) {
    const score = calculateScore(query, entry.title);
    
    if (score > 0) {
      candidates.push({
        nreg: entry.nreg,
        title: entry.title,
        score,
        dokid: entry.dokid,
        datred: entry.datred,
        type: entry.type,
        organ: entry.organ,
      });
    }
  }
  
  // Сортуємо за score (від більшого до меншого)
  candidates.sort((a, b) => b.score - a.score);
  
  return candidates.slice(0, limit);
}

/**
 * Отримує документ за nreg
 */
export async function getByNreg(nreg: string): Promise<DocIndexEntry | null> {
  const index = await loadDocIndex();
  
  return index.find(entry => entry.nreg === nreg) || null;
}

/**
 * Отримує статистику індексу
 */
export async function getIndexStats(): Promise<{
  entryCount: number;
  cachedAt?: string;
  sourceUrl?: string;
} | null> {
  if (!existsSync(METADATA_FILE)) {
    return null;
  }
  
  try {
    const metadata = JSON.parse(await readFile(METADATA_FILE, 'utf-8')) as CacheMetadata;
    return {
      entryCount: metadata.entry_count,
      cachedAt: metadata.downloaded_at,
      sourceUrl: metadata.source_url,
    };
  } catch {
    return null;
  }
}

