/**
 * Парсер статей з TXT формату
 * 
 * Парсить статті з TXT файлу, який отримано з rada.gov.ua API.
 * Підтримує різні формати статей та їх структуру.
 */

export interface ParsedArticle {
  number: string;
  title: string;
  content: string;
  parts?: ParsedPart[];
}

export interface ParsedPart {
  number: string;
  content: string;
  points?: ParsedPoint[];
}

export interface ParsedPoint {
  number: string;
  content: string;
  subpoints?: ParsedSubpoint[];
}

export interface ParsedSubpoint {
  number: string;
  content: string;
}

/**
 * Парсить статті з TXT тексту
 */
export function parseArticlesFromTxt(txt: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  
  // Нормалізуємо текст: замінюємо різні варіанти переносів рядків
  const normalized = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Паттерн для статті: "Стаття N." або "Стаття N" (з опціональною крапкою)
  // Також підтримує "Стаття N-1" (статті з підпунктами)
  const articlePattern = /Стаття\s+(\d+[а-яіїє]?(?:-\d+)?)\s*\.?\s*([^]*?)(?=Стаття\s+\d+[а-яіїє]?(?:-\d+)?|Розділ\s+[IVX]+|$)/gi;
  
  let match;
  let lastIndex = 0;
  
  while ((match = articlePattern.exec(normalized)) !== null) {
    const articleNumber = match[1].trim();
    let articleText = match[2].trim();
    
    // Видаляємо зайві пробіли та переноси
    articleText = articleText.replace(/\n{3,}/g, '\n\n').trim();
    
    // Пропускаємо дуже короткі статті (ймовірно помилка парсингу)
    if (articleText.length < 50) {
      continue;
    }
    
    // Витягуємо назву статті (перший рядок або перші кілька слів)
    const title = extractArticleTitle(articleText, articleNumber);
    
    // Парсимо частини статті
    const parts = parseParts(articleText);
    
    articles.push({
      number: articleNumber,
      title,
      content: articleText,
      parts: parts.length > 0 ? parts : undefined,
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Якщо не знайдено статей через regex, спробуємо альтернативний підхід
  if (articles.length === 0) {
    console.warn('⚠️  Не знайдено статей через regex, спробуємо альтернативний парсинг...');
    return parseArticlesAlternative(normalized);
  }
  
  return articles;
}

/**
 * Витягує назву статті
 */
function extractArticleTitle(text: string, articleNumber: string): string {
  // Назва статті зазвичай на початку, до першого переносу рядка або до першого речення
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  
  if (lines.length === 0) {
    return `Стаття ${articleNumber}`;
  }
  
  // Перший рядок часто містить назву
  const firstLine = lines[0].trim();
  
  // Якщо перший рядок короткий (менше 200 символів), вважаємо його назвою
  if (firstLine.length < 200 && !firstLine.match(/^\d+\./)) {
    return `Стаття ${articleNumber}. ${firstLine}`;
  }
  
  // Інакше просто "Стаття N"
  return `Стаття ${articleNumber}`;
}

/**
 * Парсимо частини статті
 */
function parseParts(text: string): ParsedPart[] {
  const parts: ParsedPart[] = [];
  
  // Паттерн для частини: "1." або "1)" на початку рядка
  const partPattern = /^(\d+)\.\s+([^]*?)(?=^\d+\.|^Стаття|$)/gm;
  
  let match;
  while ((match = partPattern.exec(text)) !== null) {
    const partNumber = match[1];
    let partContent = match[2].trim();
    
    // Парсимо пункти в частині
    const points = parsePoints(partContent);
    
    parts.push({
      number: partNumber,
      content: partContent,
      points: points.length > 0 ? points : undefined,
    });
  }
  
  return parts;
}

/**
 * Парсимо пункти
 */
function parsePoints(text: string): ParsedPoint[] {
  const points: ParsedPoint[] = [];
  
  // Паттерн для пункту: "1)" або "а)" на початку рядка
  const pointPattern = /^([а-яіїє\d]+)\)\s+([^]*?)(?=^[а-яіїє\d]+\)|^\d+\.|^Стаття|$)/gm;
  
  let match;
  while ((match = pointPattern.exec(text)) !== null) {
    const pointNumber = match[1];
    let pointContent = match[2].trim();
    
    // Парсимо підпункти
    const subpoints = parseSubpoints(pointContent);
    
    points.push({
      number: pointNumber,
      content: pointContent,
      subpoints: subpoints.length > 0 ? subpoints : undefined,
    });
  }
  
  return points;
}

/**
 * Парсимо підпункти
 */
function parseSubpoints(text: string): ParsedSubpoint[] {
  const subpoints: ParsedSubpoint[] = [];
  
  // Паттерн для підпункту: "1)" або "а)" (вкладені)
  const subpointPattern = /\(([а-яіїє\d]+)\)\s+([^]*?)(?=\([а-яіїє\d]+\)|$)/g;
  
  let match;
  while ((match = subpointPattern.exec(text)) !== null) {
    const subpointNumber = match[1];
    const subpointContent = match[2].trim();
    
    if (subpointContent.length > 10) {
      subpoints.push({
        number: subpointNumber,
        content: subpointContent,
      });
    }
  }
  
  return subpoints;
}

/**
 * Альтернативний метод парсингу (якщо regex не спрацював)
 */
function parseArticlesAlternative(text: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  
  // Шукаємо всі входження "Стаття" в тексті
  const articleMatches: Array<{ index: number; number: string }> = [];
  const articleRegex = /Стаття\s+(\d+[а-яіїє]?(?:-\d+)?)/gi;
  
  let match;
  while ((match = articleRegex.exec(text)) !== null) {
    articleMatches.push({
      index: match.index,
      number: match[1].trim(),
    });
  }
  
  // Для кожної знайденої статті витягуємо текст до наступної
  for (let i = 0; i < articleMatches.length; i++) {
    const current = articleMatches[i];
    const next = articleMatches[i + 1];
    
    const startIndex = current.index;
    const endIndex = next ? next.index : text.length;
    
    let articleText = text.substring(startIndex, endIndex).trim();
    
    // Видаляємо заголовок "Стаття N"
    articleText = articleText.replace(/^Стаття\s+\d+[а-яіїє]?(?:-\d+)?\s*\.?\s*/i, '').trim();
    
    if (articleText.length < 50) {
      continue;
    }
    
    const title = extractArticleTitle(articleText, current.number);
    const parts = parseParts(articleText);
    
    articles.push({
      number: current.number,
      title,
      content: articleText,
      parts: parts.length > 0 ? parts : undefined,
    });
  }
  
  return articles;
}

