/**
 * Content Units — універсальна модель одиниць контенту
 * 
 * Замість жорсткого "articles[]" використовуємо гнучку модель Units,
 * яка підтримує різні типи структурних елементів:
 * - статті (для законів/кодексів)
 * - пункти/підпункти (для постанов/правил)
 * - розділи/глави (для великих актів)
 * - додатки/таблиці (для спеціальних форматів)
 */

export type UnitType = 
  | 'article' 
  | 'point' 
  | 'subpoint' 
  | 'paragraph' 
  | 'chapter' 
  | 'section' 
  | 'book'
  | 'part'
  | 'annex' 
  | 'table'
  | 'form'
  | 'other';

export interface ContentUnit {
  /** Тип одиниці контенту */
  unit_type: UnitType;
  
  /** Номер одиниці (може бути "57", "1", "1.2", "ІІ", "Додаток 1") */
  number: string;
  
  /** Заголовок одиниці (якщо є) */
  title: string | null;
  
  /** Текст одиниці (plain text, cleaned from HTML) */
  text: string;
  
  /** Ієрархія верхніх рівнів для контексту */
  hierarchy: {
    book?: string;
    part?: string;
    section?: string;
    chapter?: string;
    article?: string;
    point?: string;
  };
  
  /** Джерело з rada stru для трасування */
  source: {
    tree_id?: string;
    id?: string;
    typ?: string;
    typn?: string;
    pos?: number;
    len?: number;
    parent?: string;
    level?: number;
    line?: string;
  };
}

/**
 * Розподіл типів структурних елементів в документі
 */
export interface StruTypeDistribution {
  /** Кількість статей (typ='ST') */
  articles: number;
  /** Кількість пунктів (typ='PU', 'PR') */
  points: number;
  /** Кількість підпунктів (typ='PP', 'FR') */
  subpoints: number;
  /** Кількість розділів (typ='RZ') */
  sections: number;
  /** Кількість глав (typ='GL') */
  chapters: number;
  /** Кількість книг (typ='KN' або tree_id prefix 'kn') */
  books: number;
  /** Кількість частин (typ='CH') */
  parts: number;
  /** Кількість параграфів (typ='ABZ') */
  paragraphs: number;
  /** Кількість додатків/форм (typ='ANNEX', 'FORM' або в назві "Додаток") */
  annexes: number;
  /** Кількість таблиць (typ='TB') */
  tables: number;
  /** Інші типи */
  other: number;
  /** Загальна кількість елементів */
  total: number;
}

/**
 * Аналізує stru масив і повертає розподіл типів
 */
/**
 * Мапінг typ/tree_id → unit_type
 */
export function mapTypToUnitType(item: any): UnitType | null {
  if (!item || typeof item !== 'object') return null;
  
  const typ = (item.typ || item.type || '').toUpperCase();
  const typn = (item.typn || '').toLowerCase();
  const treeId = (item.tree_id || '').toLowerCase();
  const line = (item.line || '').toLowerCase();
  
  // Явний мапінг typ
  switch (typ) {
    case 'ST':
      return 'article';
    case 'PU':
    case 'PR':
      return 'point';
    case 'PP':
    case 'FR':
      return 'subpoint';
    case 'GL':
      return 'chapter';
    case 'RZ':
      return 'section';
    case 'CH':
      return 'part';
    case 'TB':
      return 'table';
    case 'ABZ':
      return 'paragraph';
    case 'KN':
    case 'ZG':
      return 'book';
  }
  
  // Перевірка tree_id prefix
  if (treeId.startsWith('kn') || treeId.startsWith('zg')) {
    return 'book';
  }
  if (treeId.startsWith('gl')) {
    return 'chapter';
  }
  if (treeId.startsWith('rz')) {
    return 'section';
  }
  if (treeId.startsWith('st')) {
    return 'article';
  }
  
  // Перевірка typn або line для додатків/форм
  if (typn.includes('додаток') || typn.includes('annex') || 
      line.includes('додаток') || line.includes('форма')) {
    if (line.includes('таблиця') || typn.includes('таблиця')) {
      return 'table';
    }
    if (line.includes('форма') || typn.includes('форма')) {
      return 'form';
    }
    return 'annex';
  }
  
  return null; // Невизначений тип
}

export function analyzeStruTypes(stru: any[]): StruTypeDistribution {
  const dist: StruTypeDistribution = {
    articles: 0,
    points: 0,
    subpoints: 0,
    sections: 0,
    chapters: 0,
    books: 0,
    parts: 0,
    paragraphs: 0,
    annexes: 0,
    tables: 0,
    other: 0,
    total: stru.length,
  };

  for (const item of stru) {
    if (!item || typeof item !== 'object') continue;
    
    const unitType = mapTypToUnitType(item);
    
    if (unitType === 'article') {
      dist.articles++;
    } else if (unitType === 'point') {
      dist.points++;
    } else if (unitType === 'subpoint') {
      dist.subpoints++;
    } else if (unitType === 'section') {
      dist.sections++;
    } else if (unitType === 'chapter') {
      dist.chapters++;
    } else if (unitType === 'book') {
      dist.books++;
    } else if (unitType === 'part') {
      dist.parts++;
    } else if (unitType === 'paragraph') {
      dist.paragraphs++;
    } else if (unitType === 'annex' || unitType === 'form') {
      dist.annexes++;
    } else if (unitType === 'table') {
      dist.tables++;
    } else {
      dist.other++;
    }
  }

  return dist;
}

/**
 * Визначає стратегію парсингу на основі розподілу типів
 */
export type ParsingStrategy = 
  | 'article-based' 
  | 'point-based' 
  | 'chapter-based'
  | 'annex-based'
  | 'fallback';

export function determineParsingStrategy(
  dist: StruTypeDistribution,
  documentType?: string
): { strategy: ParsingStrategy; reason: string } {
  // Якщо є суттєва кількість статей → article-based
  if (dist.articles >= 3) {
    return { 
      strategy: 'article-based', 
      reason: `${dist.articles} статей знайдено` 
    };
  }
  
  // Якщо немає статей, але є пункти → point-based
  if (dist.articles === 0 && dist.points >= 3) {
    return { 
      strategy: 'point-based', 
      reason: `0 статей, але ${dist.points} пунктів знайдено` 
    };
  }
  
  // Якщо є і статті і пункти, переважає той що більше
  if (dist.articles > 0 && dist.points > 0) {
    const strategy = dist.articles > dist.points ? 'article-based' : 'point-based';
    return { 
      strategy, 
      reason: `${dist.articles} статей vs ${dist.points} пунктів, обрано ${strategy}` 
    };
  }
  
  // Якщо багато розділів/глав/книг, але мало leaf units → chapter-based
  if ((dist.chapters >= 3 || dist.sections >= 3 || dist.books >= 1) && 
      dist.articles < 3 && dist.points < 3) {
    return { 
      strategy: 'chapter-based', 
      reason: `${dist.chapters} глав, ${dist.sections} розділів, ${dist.books} книг, але мало leaf units` 
    };
  }
  
  // Якщо багато додатків/форм/таблиць → annex-based
  if (dist.annexes >= 2 || dist.tables >= 2) {
    return { 
      strategy: 'annex-based', 
      reason: `${dist.annexes} додатків, ${dist.tables} таблиць знайдено` 
    };
  }
  
  // Fallback для інших випадків
  return { 
    strategy: 'fallback', 
    reason: `Недостатньо структурних елементів (articles:${dist.articles}, points:${dist.points}, chapters:${dist.chapters})` 
  };
}

/**
 * Очищає HTML текст до plain text
 * Детермінована функція — однаковий HTML → однаковий результат
 */
export function sanitizeHtmlToText(html: string): string {
  if (!html) return '';
  
  let text = html;
  
  // Видаляємо HTML теги (замінюємо на пробіл, щоб не склеїти слова)
  text = text.replace(/<[^>]*>/g, ' ');
  
  // Декодуємо HTML entities (спочатку стандартні, потім числові)
  // Важливо: порядок має значення (не декодувати &#160; як частину числового)
  text = text
    .replace(/&nbsp;/g, ' ') // Спеціальний випадок неразривного пробілу
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num);
      // 160 = non-breaking space
      if (code === 160) return ' ';
      return String.fromCharCode(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      // 00A0 = non-breaking space
      if (code === 0xa0) return ' ';
      return String.fromCharCode(code);
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  
  // Зберігаємо переноси рядків (вони важливі для структури)
  // Але нормалізуємо множинні переноси
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\n{4,}/g, '\n\n\n'); // Максимум 3 переноси підряд
  
  // Нормалізуємо пробіли (але не видаляємо переноси)
  text = text.replace(/[ \t]+/g, ' '); // Множинні пробіли/таби → один пробіл
  text = text.replace(/[ \t]+\n/g, '\n'); // Пробіли перед переносом
  text = text.replace(/\n[ \t]+/g, '\n'); // Пробіли після переносу
  
  // Видаляємо пробіли на початку/кінці (але зберігаємо переноси)
  text = text.trim();
  
  return text;
}
