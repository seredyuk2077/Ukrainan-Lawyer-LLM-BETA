/**
 * Chunking — розбиття тексту на семантичні чанки для RAG
 * 
 * Згідно з вимогами:
 * - Target size: ~700-1200 tokens (~3000-6000 chars)
 * - Overlap: 10-15% при розбитті довгих статей
 * - Вирівнювання по структурі: стаття -> частина -> пункт
 * - Підтримка різних типів units: articles, points, subpoints, etc.
 */

import { ContentUnit } from './contentUnits.js';

export interface Chunk {
  chunk_index: number;
  article_number?: string | null; // для сумісності
  unit_number?: string; // номер unit (може бути article_number або point_number)
  unit_type?: string; // тип unit
  text: string;
  title?: string;
  token_count: number;
  char_count: number;
}

/**
 * Наближена оцінка кількості токенів (для української мови)
 * Використовує просте правило: ~4 символи на токен
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Розбиває текст на чанки з overlap
 * 
 * @param text - Текст для розбиття
 * @param targetTokens - Цільова кількість токенів (~800)
 * @param overlapTokens - Кількість токенів overlap (~100)
 * @returns Масив чанків
 */
function splitTextWithOverlap(
  text: string,
  targetTokens: number = 800,
  overlapTokens: number = 100
): string[] {
  const chunks: string[] = [];
  const targetChars = targetTokens * 4; // ~4 chars per token
  const overlapChars = overlapTokens * 4;

  let start = 0;
  
  while (start < text.length) {
    let end = start + targetChars;
    
    // Якщо не досягли кінця, намагаємося знайти гарну точку розриву
    if (end < text.length) {
      // Шукаємо крапку, новий рядок або пробіл поблизу кінця
      const searchStart = Math.max(start + targetChars - 200, start);
      const searchEnd = Math.min(end + 200, text.length);
      const searchText = text.substring(searchStart, searchEnd);
      
      // Пріоритет: крапка + пробіл > новий рядок > пробіл
      const dotMatch = searchText.lastIndexOf('. ');
      const newlineMatch = searchText.lastIndexOf('\n');
      const spaceMatch = searchText.lastIndexOf(' ');
      
      let breakPoint = -1;
      if (dotMatch >= 0) {
        breakPoint = searchStart + dotMatch + 2;
      } else if (newlineMatch >= 0) {
        breakPoint = searchStart + newlineMatch + 1;
      } else if (spaceMatch >= 0) {
        breakPoint = searchStart + spaceMatch + 1;
      }
      
      if (breakPoint > start) {
        end = breakPoint;
      }
    }
    
    chunks.push(text.substring(start, end).trim());
    
    // Наступний чанк починається з overlap
    start = Math.max(start + 1, end - overlapChars);
  }
  
  return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Створює чанки зі статей документа
 * 
 * @param articles - Масив статей з canonical формату
 * @returns Масив чанків
 */
export function createChunksFromArticles(
  articles: Array<{
    number: string;
    title: string;
    content: string;
    parts?: Array<{
      number: string;
      content: string;
    }>;
  }>
): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const article of articles) {
    const articleText = article.content.trim();
    const articleTokens = estimateTokens(articleText);

    // Якщо стаття коротка (< 1000 токенів), робимо один чанк
    if (articleTokens < 1000) {
      chunks.push({
        chunk_index: chunkIndex++,
        article_number: article.number,
        text: articleText,
        title: article.title,
        token_count: articleTokens,
        char_count: articleText.length,
      });
    } else {
      // Довга стаття: розбиваємо на частини з overlap
      const articleChunks = splitTextWithOverlap(articleText);
      
      for (let i = 0; i < articleChunks.length; i++) {
        const chunkText = articleChunks[i];
        chunks.push({
          chunk_index: chunkIndex++,
          article_number: article.number,
          text: chunkText,
          title: i === 0 ? article.title : `${article.title} (частина ${i + 1})`,
          token_count: estimateTokens(chunkText),
          char_count: chunkText.length,
        });
      }
    }
  }

  return chunks;
}

/**
 * Створює chunks з Content Units (універсальна версія)
 * 
 * @param units - Масив Content Units (articles, points, subpoints, etc.)
 * @param context - Контекст документу для header_context
 * @returns Масив chunks
 */
export function createChunksFromUnits(
  units: ContentUnit[],
  context: {
    title: string;
    document_type: string;
    category?: string;
  }
): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  // Формуємо header context для всіх chunks
  const headerParts: string[] = [context.title];
  if (context.document_type) {
    headerParts.push(`(${context.document_type})`);
  }

  for (const unit of units) {
    const unitText = unit.text.trim();
    if (!unitText) continue;

    const unitTokens = estimateTokens(unitText);

    // Формуємо title з контекстом
    const hierarchyStr = buildHierarchyString(unit.hierarchy);
    const unitTitle = unit.title || `${getUnitTypeLabel(unit.unit_type)} ${unit.number}`;
    const fullTitle = hierarchyStr ? `${hierarchyStr} ${unitTitle}` : unitTitle;

    // Якщо unit короткий (< 1000 токенів), робимо один chunk
    if (unitTokens < 1000) {
      const headerContext = headerParts.join(' ') + ': ';
      chunks.push({
        chunk_index: chunkIndex++,
        article_number: unit.unit_type === 'article' ? unit.number : null,
        unit_number: unit.number,
        unit_type: unit.unit_type,
        text: headerContext + fullTitle + '\n\n' + unitText,
        title: fullTitle,
        token_count: estimateTokens(headerContext + fullTitle + '\n\n' + unitText),
        char_count: (headerContext + fullTitle + '\n\n' + unitText).length,
      });
    } else {
      // Довгий unit: розбиваємо на частини з overlap
      const unitChunks = splitTextWithOverlap(unitText);
      
      for (let i = 0; i < unitChunks.length; i++) {
        const chunkText = unitChunks[i];
        const headerContext = headerParts.join(' ') + ': ';
        const chunkTitle = i === 0 ? fullTitle : `${fullTitle} (частина ${i + 1})`;
        
        chunks.push({
          chunk_index: chunkIndex++,
          article_number: unit.unit_type === 'article' ? unit.number : null,
          unit_number: unit.number,
          unit_type: unit.unit_type,
          text: headerContext + chunkTitle + '\n\n' + chunkText,
          title: chunkTitle,
          token_count: estimateTokens(headerContext + chunkTitle + '\n\n' + chunkText),
          char_count: (headerContext + chunkTitle + '\n\n' + chunkText).length,
        });
      }
    }
  }

  return chunks;
}

/**
 * Будує рядок ієрархії з hierarchy object
 */
function buildHierarchyString(hierarchy: ContentUnit['hierarchy']): string {
  const parts: string[] = [];
  if (hierarchy.book) parts.push(`Книга ${hierarchy.book}`);
  if (hierarchy.part) parts.push(`Частина ${hierarchy.part}`);
  if (hierarchy.section) parts.push(`Розділ ${hierarchy.section}`);
  if (hierarchy.chapter) parts.push(`Глава ${hierarchy.chapter}`);
  return parts.join(', ');
}

/**
 * Повертає label для типу unit
 */
function getUnitTypeLabel(unitType: string): string {
  switch (unitType) {
    case 'article': return 'Стаття';
    case 'point': return 'Пункт';
    case 'subpoint': return 'Підпункт';
    case 'paragraph': return 'Параграф';
    case 'chapter': return 'Глава';
    case 'section': return 'Розділ';
    default: return 'Елемент';
  }
}

