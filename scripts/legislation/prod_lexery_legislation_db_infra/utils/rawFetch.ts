/**
 * Детермінований RAW fetch результат
 * 
 * Цей модуль визначає структуру RAW результату завантаження документа.
 * Це допомагає зрозуміти що завжди присутнє, що опціональне,
 * та що може зламатися.
 * 
 * Цей результат використовується для:
 * - Проектування canonical JSON формату
 * - Проектування DB схеми
 * - Проектування R2 layout
 */

export interface RawFetchResult {
  /**
   * Ідентифікатори (завжди присутні якщо документ знайдено)
   */
  identifiers: {
    /** Primary identifier - завжди присутній */
    nreg: string;
    /** Додатковий ідентифікатор - може бути відсутнім */
    dokid?: number;
  };

  /**
   * Базові метадані (завжди присутні)
   */
  metadata: {
    /** Назва документа - завжди присутня */
    title: string;
    /** Дата редакції - завжди присутня (формат: YYYY-MM-DD) */
    datred: string;
    /** URL джерела - завжди присутній */
    sourceUrl: string;
  };

  /**
   * Сирі дані з API
   */
  raw: {
    /** JSON відповідь з API - завжди присутня якщо завантажено JSON */
    json?: any;
    /** TXT версія - опціональна (fallback якщо JSON не містить контенту) */
    txt?: string;
  };

  /**
   * Структура документа
   */
  structure: {
    /** Чи містить JSON масив stru (структурні елементи) */
    hasStru: boolean;
    /** Кількість структурних елементів (якщо hasStru === true) */
    struCount?: number;
    /** Чи містить JSON поле text або content */
    hasText: boolean;
    /** Чи містить JSON поле content */
    hasContent: boolean;
  };

  /**
   * Статистика
   */
  stats: {
    /** Розмір JSON відповіді в байтах */
    jsonSize: number;
    /** Розмір TXT в символах (якщо є) */
    txtSize?: number;
    /** Загальний розмір контенту (наближено) */
    totalSize: number;
  };

  /**
   * Метадані завантаження
   */
  fetch: {
    /** Timestamp завантаження (ISO) */
    fetchedAt: string;
    /** Формат який був завантажений (json, txt, both) */
    format: 'json' | 'txt' | 'both';
    /** Чи використовувався токен */
    usedToken: boolean;
  };
}

/**
 * Створює детермінований RAW результат з даних завантаження
 */
export function createRawFetchResult(params: {
  nreg: string;
  dokid?: number;
  title: string;
  datred: string;
  jsonData?: any;
  txtData?: string;
  usedToken: boolean;
}): RawFetchResult {
  const { nreg, dokid, title, datred, jsonData, txtData, usedToken } = params;

  // Визначаємо формат
  let format: 'json' | 'txt' | 'both' = 'json';
  if (jsonData && txtData) {
    format = 'both';
  } else if (txtData && !jsonData) {
    format = 'txt';
  }

  // Аналізуємо структуру
  const stru = jsonData?.stru || jsonData?.meta?.stru || jsonData?.structure || null;
  const hasStru = Array.isArray(stru) && stru.length > 0;
  const struCount = hasStru ? stru.length : undefined;

  const hasText = !!(jsonData?.text || jsonData?.meta?.text);
  const hasContent = !!(jsonData?.content || jsonData?.meta?.content);

  // Статистика
  const jsonSize = jsonData ? JSON.stringify(jsonData).length : 0;
  const txtSize = txtData ? txtData.length : undefined;
  const totalSize = jsonSize + (txtSize || 0);

  // Формуємо source URL
  const sourceUrl = `https://data.rada.gov.ua/laws/show/${nreg}`;

  return {
    identifiers: {
      nreg,
      dokid,
    },
    metadata: {
      title,
      datred,
      sourceUrl,
    },
    raw: {
      json: jsonData,
      txt: txtData,
    },
    structure: {
      hasStru,
      struCount,
      hasText,
      hasContent,
    },
    stats: {
      jsonSize,
      txtSize,
      totalSize,
    },
    fetch: {
      fetchedAt: new Date().toISOString(),
      format,
      usedToken,
    },
  };
}

