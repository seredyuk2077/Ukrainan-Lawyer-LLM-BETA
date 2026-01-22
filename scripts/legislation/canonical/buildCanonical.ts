/**
 * Canonical Builder — побудова canonical JSON формату
 * 
 * Перетворює raw дані з rada.gov.ua API у canonical формат
 * згідно з docs/legislation-rag/09_r2_format.md
 */

import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { parseArticlesFromTxt, ParsedArticle } from './parseTxtArticles.js';
import { nregToSafeFilename } from '../utils/nreg.js';
import { generateR2Key } from './r2Path.js';
import { createChunksFromArticles, Chunk } from './chunking.js';

export interface CanonicalDocument {
  version: string;
  schema_version: string;
  metadata: CanonicalMetadata;
  content: CanonicalContent;
  ai_enrichment?: CanonicalAIEnrichment;
  raw: CanonicalRaw;
}

export interface CanonicalMetadata {
  rada_nreg: string;
  rada_dokid?: number;
  title: string;
  document_type: string;
  document_type_slug?: string; // PHASE 14: стандартизований EN slug
  category: string;
  law_number?: string;
  document_number?: string; // PHASE 15: універсальний номер
  rada_datred: string;
  source_url: string;
  imported_at: string;
  updated_at: string;
  content_hash: string;
  previous_hash?: string | null;
  r2_key?: string;
}

export interface CanonicalContent {
  articles: CanonicalArticle[];
  chunks: CanonicalChunk[];
  structure?: CanonicalStructure;
}

export interface CanonicalChunk {
  chunk_index: number;
  article_number: string | null; // може бути null для постанов (points)
  text: string;
  title?: string;
  token_count: number;
}

export interface CanonicalArticle {
  number: string;
  title: string;
  content: string;
  parts?: CanonicalPart[];
}

export interface CanonicalPart {
  number: string;
  content: string;
  points?: CanonicalPoint[];
}

export interface CanonicalPoint {
  number: string;
  content: string;
  subpoints?: CanonicalSubpoint[];
}

export interface CanonicalSubpoint {
  number: string;
  content: string;
}

export interface CanonicalStructure {
  type: string;
  children?: CanonicalStructureNode[];
}

export interface CanonicalStructureNode {
  type: string;
  title?: string;
  articles?: string[];
  children?: CanonicalStructureNode[];
}

export interface CanonicalAIEnrichment {
  keywords: string[];
  topics?: string[];
  summary?: string;
  classification?: {
    document_type: string;
    category: string;
    confidence: number;
  };
}

export interface CanonicalRaw {
  rada_api_json: any;
  rada_api_txt?: string | null;
}

export interface BuildCanonicalOptions {
  jsonPath: string;
  txtPath?: string;
  previousHash?: string | null;
}

/**
 * Будує canonical JSON з raw даних
 */
export async function buildCanonical(options: BuildCanonicalOptions): Promise<CanonicalDocument> {
  const { jsonPath, txtPath, previousHash } = options;

  // Читаємо JSON
  const jsonData = JSON.parse(await readFile(jsonPath, 'utf-8'));

  // Витягуємо метадані
  const nreg = jsonData?.nreg || jsonData?.meta?.nreg || jsonData?.metadata?.nreg;
  if (!nreg) {
    throw new Error('NREG не знайдено в JSON');
  }

  const nazva = jsonData?.nazva || jsonData?.meta?.nazva || jsonData?.metadata?.nazva || 'Без назви';
  const dokid = jsonData?.dokid || jsonData?.meta?.dokid || jsonData?.metadata?.dokid;
  
  // Витягуємо law_number (системний підхід)
  const { extractLawNumber } = await import('./extractLawNumber.js');
  const lawNumberResult = extractLawNumber({
    nazva,
    nreg,
    jsonData,
  });
  const lawNumber = lawNumberResult.law_number || undefined;
  
  let datred: string;
  const datredRaw = jsonData?.datred || jsonData?.meta?.datred || jsonData?.metadata?.datred;
  if (datredRaw) {
    const datredStr = String(datredRaw);
    if (datredStr.length === 8 && /^\d+$/.test(datredStr)) {
      datred = `${datredStr.substring(0, 4)}-${datredStr.substring(4, 6)}-${datredStr.substring(6, 8)}`;
    } else {
      datred = datredStr;
    }
  } else {
    throw new Error('datred не знайдено в JSON');
  }

  // Читаємо TXT якщо є
  let txtContent: string | undefined;
  if (txtPath) {
    try {
      txtContent = await readFile(txtPath, 'utf-8');
    } catch (error) {
      console.warn(`⚠️  Не вдалося прочитати TXT файл: ${txtPath}`);
    }
  }

  // PHASE 22: Document Type System V2 — Heuristics + AI Fallback + Caching + Validation
  const { enrichDocumentType } = await import('../lib/documentTypeEnrichment.js');
  
  // Отримуємо snippet для валідації (перші 200 символів txtContent)
  const snippet = txtContent ? txtContent.substring(0, 200) : undefined;
  
  const documentNumber = jsonData?.organs?.orgnum || nreg; // PHASE 15: orgnum або nreg
  
  const docTypeEnrichment = await enrichDocumentType({
    title: nazva,
    typ: jsonData?.typ,
    typn: jsonData?.typn,
    organs: jsonData?.organs,
    stru: jsonData?.stru,
    snippet: snippet,
    document_number: documentNumber,
  });
  const documentTypeSlug = docTypeEnrichment.slug;
  const documentType = docTypeEnrichment.label_uk; // UA label з taxonomy
  
  // Визначаємо категорію (простий rule-based підхід, буде перезаписано AI)
  const category = guessCategory(nazva, documentType);

  // Генеруємо R2 key path
  const r2Key = generateR2Key(category, nreg);

  // Парсимо Content Units (універсальний підхід)
  const { parseContentUnits } = await import('./parseUnits.js');
  const { units, strategy, strategyReason, distribution, requiresFallback } = await parseContentUnits(
    jsonData?.stru,
    txtContent,
    documentType,
    {
      title: nazva,
      nreg: nreg,
      lawNumber: lawNumber,
    }
  );

  // Логування стратегії (для debug)
  if (units.length === 0) {
    console.warn(`⚠️  Не знайдено content units (strategy: ${strategy}, reason: ${strategyReason}, distribution: ${JSON.stringify(distribution)})`);
  } else {
    console.log(`✓ Parsed ${units.length} units using strategy: ${strategy} (${strategyReason})`);
    if (requiresFallback) {
      console.warn(`⚠️  Used TXT fallback due to no-empty-index policy for document_type=${documentType}`);
    }
  }

  // Будуємо canonical articles (для сумісності, але тепер з units)
  const canonicalArticles: CanonicalArticle[] = units
    .filter(u => u.unit_type === 'article')
    .map(unit => ({
      number: unit.number,
      title: unit.title || `Стаття ${unit.number}`,
      content: unit.text,
    }));

  // Створюємо chunks зі всіх units (не тільки статей!)
  const { createChunksFromUnits } = await import('./chunking.js');
  const chunks = createChunksFromUnits(units, {
    title: nazva,
    document_type: documentType,
    category,
  });
  const canonicalChunks: CanonicalChunk[] = chunks.map(chunk => ({
    chunk_index: chunk.chunk_index,
    article_number: chunk.article_number || chunk.unit_number || null,
    text: chunk.text,
    title: chunk.title || undefined,
    token_count: chunk.token_count,
  }));

  // Будуємо структуру (з інформацією про strategy для debug)
  const structure = buildStructure(canonicalArticles, txtContent);
  if (structure) {
    (structure as any).parsing_strategy = strategy;
    (structure as any).parsing_strategy_reason = strategyReason;
    (structure as any).units_count = units.length;
    (structure as any).requires_fallback = requiresFallback;
  }

  // Генеруємо content hash (включаємо chunks)
  const contentHash = generateContentHash(nazva, canonicalArticles, canonicalChunks);

  // Формуємо canonical документ
  const now = new Date().toISOString();
  const sourceUrl = `https://data.rada.gov.ua/laws/show/${nreg}`;

  const canonical: CanonicalDocument = {
    version: '1.0',
    schema_version: '1.0',
    metadata: {
      rada_nreg: nreg,
      rada_dokid: dokid,
      title: nazva,
      document_type: documentType,
      document_type_slug: documentTypeSlug, // PHASE 14
      category,
      law_number: lawNumber,
      document_number: jsonData?.organs?.orgnum || nreg, // PHASE 15: orgnum або nreg
      rada_datred: datred,
      source_url: sourceUrl,
      imported_at: now,
      updated_at: now,
      content_hash: contentHash,
      previous_hash: previousHash || null,
      r2_key: r2Key,
    },
    content: {
      articles: canonicalArticles,
      chunks: canonicalChunks,
      structure: structure,
    },
    raw: {
      rada_api_json: jsonData,
      rada_api_txt: txtContent || null,
    },
  };

  return canonical;
}

/**
 * Парсимо статті з stru масиву (якщо є в JSON)
 */
function parseArticlesFromStru(stru: any[]): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  for (const item of stru) {
    const typ = item?.typ || item?.type;
    const typn = item?.typn || item?.typeName;

    // Шукаємо статті (ST)
    if (typ === 'ST' || typn === 'Стаття') {
      const struNumber = item?.stru || item?.number || '';
      const text = item?.text || item?.content || '';

      if (text.length > 0) {
        articles.push({
          number: struNumber,
          title: `Стаття ${struNumber}`,
          content: text,
        });
      }
    }
  }

  return articles;
}

/**
 * Визначає тип документа (rule-based + JSON typ)
 * 
 * Typ значення з rada.gov.ua:
 * - 216: Конституція
 * - 2: Постанова
 * - 1: Закон
 * - 3: Розпорядження
 * - 4: Указ
 * - 5: Кодекс
 */
function guessDocumentType(nazva: string, jsonData: any): string {
  const lowerNazva = nazva.toLowerCase();
  const typ = jsonData?.typ;
  const organs = jsonData?.organs;

  // Спочатку перевіряємо JSON typ (більш надійний)
  if (typ === 216) {
    return 'Конституція';
  }
  // Кодекс може мати різні typ значення (5, 21, тощо)
  if (typ === 5 || typ === 21) {
    return 'Кодекс';
  }
  if (typ === 1) {
    return 'Закон';
  }
  if (typ === 2) {
    // Постанова - уточнюємо тип
    // organs формат: "2:19950127:57" де перше число - орган (2 = КМУ, 1 = ВР)
    if (organs && typeof organs === 'string') {
      const organMatch = organs.match(/^(\d+):/);
      if (organMatch && organMatch[1] === '2') {
        return 'Постанова КМУ';
      }
      if (organMatch && organMatch[1] === '1') {
        return 'Постанова ВР';
      }
    }
    // Перевіряємо в назві
    if (lowerNazva.includes('кабінет') || lowerNazva.includes('кму') || lowerNazva.includes('км')) {
      return 'Постанова КМУ';
    }
    if (lowerNazva.includes('верховна') || lowerNazva.includes('вр')) {
      return 'Постанова ВР';
    }
    return 'Постанова';
  }
  if (typ === 3) {
    return 'Розпорядження';
  }
  if (typ === 4) {
    return 'Указ';
  }

  // Якщо typ не визначений, використовуємо rule-based з назви
  if (lowerNazva.includes('конституція')) {
    return 'Конституція';
  }
  if (lowerNazva.includes('кодекс')) {
    return 'Кодекс';
  }
  if (lowerNazva.includes('постанова')) {
    if (lowerNazva.includes('кабінет') || lowerNazva.includes('кму') || lowerNazva.includes('км')) {
      return 'Постанова КМУ';
    }
    if (lowerNazva.includes('верховна') || lowerNazva.includes('вр')) {
      return 'Постанова ВР';
    }
    return 'Постанова';
  }
  if (lowerNazva.includes('закон')) {
    return 'Закон';
  }
  if (lowerNazva.includes('указ')) {
    return 'Указ';
  }
  if (lowerNazva.includes('розпорядження')) {
    return 'Розпорядження';
  }

  return 'Документ';
}

/**
 * Визначає категорію права (rule-based)
 */
function guessCategory(nazva: string, documentType: string): string {
  const lowerNazva = nazva.toLowerCase();

  if (lowerNazva.includes('конституція')) {
    return 'конституційне';
  }
  if (lowerNazva.includes('цивільн') || lowerNazva.includes('цивільно')) {
    return 'цивільне';
  }
  if (lowerNazva.includes('кримінальн') || lowerNazva.includes('кримінально')) {
    return 'кримінальне';
  }
  if (lowerNazva.includes('трудов') || lowerNazva.includes('трудо')) {
    return 'трудове';
  }
  if (lowerNazva.includes('сімейн') || lowerNazva.includes('сімейно')) {
    return 'сімейне';
  }
  if (lowerNazva.includes('податков') || lowerNazva.includes('податко')) {
    return 'податкове';
  }
  if (lowerNazva.includes('земельн') || lowerNazva.includes('земельно')) {
    return 'земельне';
  }
  if (lowerNazva.includes('господарськ') || lowerNazva.includes('господарсько')) {
    return 'господарське';
  }
  if (lowerNazva.includes('адміністративн') || lowerNazva.includes('адміністративно')) {
    return 'адміністративне';
  }
  if (lowerNazva.includes('процесуальн') || lowerNazva.includes('процесуально')) {
    return 'процесуальне';
  }

  return 'інше';
}

/**
 * Будує ієрархічну структуру (поки що проста)
 */
function buildStructure(articles: CanonicalArticle[], txtContent?: string): CanonicalStructure | undefined {
  // Поки що повертаємо просту структуру
  // В майбутньому можна парсити розділи та глави з TXT
  return {
    type: 'document',
    children: articles.length > 0 ? [{
      type: 'section',
      title: 'Статті',
      articles: articles.map(a => a.number),
    }] : undefined,
  };
}

/**
 * Генерує content hash (SHA-256)
 */
function generateContentHash(
  title: string, 
  articles: CanonicalArticle[],
  chunks: CanonicalChunk[]
): string {
  // Створюємо canonical представлення для хешування
  const canonical = {
    title,
    articles: articles.map(a => ({
      number: a.number,
      content: a.content.trim().replace(/\s+/g, ' '), // Нормалізуємо пробіли
    })),
    chunks: chunks.map(c => ({
      chunk_index: c.chunk_index,
      article_number: c.article_number,
      text: c.text.trim().replace(/\s+/g, ' '),
    })),
  };

  // Сортуємо статті за номером для детермінованості
  canonical.articles.sort((a, b) => {
    return a.number.localeCompare(b.number, 'uk-UA', { numeric: true });
  });

  // Chunks вже відсортовані за chunk_index

  // Конвертуємо в JSON string (без пробілів для детермінованості)
  const jsonString = JSON.stringify(canonical);

  // Генеруємо SHA-256 hash
  const hash = createHash('sha256');
  hash.update(jsonString, 'utf-8');
  return hash.digest('hex');
}

/**
 * Генерує RAG chunks з canonical документу
 */
export function generateRagChunks(canonical: CanonicalDocument): Array<{
  key: string;
  title: string;
  content: string;
  article_number: string;
  part_number?: string;
  point_number?: string;
}> {
  const chunks: Array<{
    key: string;
    title: string;
    content: string;
    article_number: string;
    part_number?: string;
    point_number?: string;
  }> = [];

  const nreg = canonical.metadata.rada_nreg;

  for (const article of canonical.content.articles) {
    // Chunk на рівні статті
    chunks.push({
      key: `${nreg}::article:${article.number}`,
      title: article.title,
      content: article.content,
      article_number: article.number,
    });

    // Chunks на рівні частин (якщо є)
    if (article.parts) {
      for (const part of article.parts) {
        chunks.push({
          key: `${nreg}::article:${article.number}::part:${part.number}`,
          title: `${article.title}, частина ${part.number}`,
          content: part.content,
          article_number: article.number,
          part_number: part.number,
        });

        // Chunks на рівні пунктів (якщо є)
        if (part.points) {
          for (const point of part.points) {
            chunks.push({
              key: `${nreg}::article:${article.number}::part:${part.number}::point:${point.number}`,
              title: `${article.title}, частина ${part.number}, пункт ${point.number}`,
              content: point.content,
              article_number: article.number,
              part_number: part.number,
              point_number: point.number,
            });
          }
        }
      }
    }
  }

  return chunks;
}

