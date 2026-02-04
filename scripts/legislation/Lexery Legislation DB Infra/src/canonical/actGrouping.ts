/**
 * Act Grouping — визначення груп багаточастинних актів
 * 
 * PHASE 5: Підтримка актів типу "один кодекс в кількох документах"
 * 
 * Логіка:
 * - Heuristics для визначення груп (по назві, частинах, томах)
 * - Deterministic act_group_key для стабільності
 * - Optional AI assist для складних випадків
 */

import { createHash } from 'crypto';

export interface ActGroupInfo {
  act_group_key: string;
  act_is_part: boolean;
  act_part_label: string | null;
  act_group_title: string | null;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Нормалізує базову назву акту (прибирає частини/томи/редакції/діапазони статей)
 */
export function normalizeBaseTitle(title: string): string {
  let normalized = title;
  
  // Прибираємо діапазони статей у дужках: "(статті 1 - 212-24)", "(статті 213 - 330)"
  normalized = normalized
    .replace(/\s*\(статті\s+\d+(?:-\d+)?\s*[-–—]\s*\d+(?:-\d+)?\)/gi, '')
    .replace(/\s*\(статті\s+\d+[^)]*\)/gi, ''); // Загальний патерн для статей
  
  // Прибираємо частини/томи з назви
  normalized = normalized
    .replace(/\s*\([^)]*частина[^)]*\)/gi, '')
    .replace(/\s*\([^)]*том[^)]*\)/gi, '')
    .replace(/\s*\([^)]*книга[^)]*\)/gi, '')
    .replace(/\s*\([^)]*розділ[^)]*\)/gi, '')
    .replace(/\s*частина\s+(перша|друга|третя|четверта|п'ята|І|ІІ|ІІІ|IV|V)/gi, '')
    .replace(/\s*том\s+(І|ІІ|ІІІ|IV|V|перший|другий|третій)/gi, '');
  
  // Прибираємо службові хвости
  normalized = normalized
    .replace(/\s*\(в\s+редакції[^)]*\)/gi, '')
    .replace(/\s*\(зі\s+змінами[^)]*\)/gi, '')
    .replace(/\s*\(остання\s+редакція[^)]*\)/gi, '');
  
  // Нормалізуємо пробіли
  normalized = normalized.replace(/\s+/g, ' ').trim();
  
  return normalized;
}

/**
 * Витягує label частини/тома з назви
 * Підтримує патерни типу "(статті 1 - 212-24)", "(статті 213 - 330)"
 */
export function detectPartLabel(title: string): string | null {
  // Шукаємо діапазони статей у дужках: "(статті 1 - 212-24)", "(статті 213 - 330)"
  const articleRangeMatch = title.match(/\(статті\s+(\d+(?:-\d+)?)\s*[-–—]\s*(\d+(?:-\d+)?)\)/i);
  if (articleRangeMatch) {
    return `статті ${articleRangeMatch[1]} - ${articleRangeMatch[2]}`;
  }
  
  // Шукаємо "частина перша/друга", "том І/ІІ", "книга I/II"
  const partMatch = title.match(/\(?частина\s+(перша|друга|третя|четверта|п'ята|І|ІІ|ІІІ|IV|V)\)?/i);
  if (partMatch) {
    return `Частина ${partMatch[1]}`;
  }
  
  const bookMatch = title.match(/\(?книга\s+(І{1,3}|IV|V|VI{0,3}|IX|X|перша|друга|третя)\)?/i);
  if (bookMatch) {
    return `Книга ${bookMatch[1]}`;
  }
  
  const tomMatch = title.match(/\(?том\s+(І{1,3}|IV|V|VI{0,3}|IX|X|перший|другий|третій|четвертий|п'ятий)\)?/i);
  if (tomMatch) {
    return `Том ${tomMatch[1]}`;
  }
  
  // Шукаємо в дужках загальні індикатори
  const parenthesesMatch = title.match(/\(([^)]*(?:частина|том|книга|статті)[^)]*)\)/i);
  if (parenthesesMatch) {
    const label = parenthesesMatch[1].trim();
    // Перевіряємо чи це дійсно частина (а не просто згадка)
    if (/частина|том|книга|статті\s+\d+.*[-–—].*\d+/i.test(label)) {
      return label;
    }
  }
  
  return null;
}

/**
 * Генерує deterministic act_group_key
 */
export function generateActGroupKey(params: {
  normalizedTitle: string;
  documentType: string;
  lawNumber?: string | null;
}): string {
  const parts = [
    params.normalizedTitle.toLowerCase(),
    params.documentType.toLowerCase(),
    params.lawNumber || '',
  ].filter(Boolean);
  
  const keyString = parts.join('::');
  
  // Генеруємо hash для стабільності
  const hash = createHash('sha256').update(keyString).digest('hex').slice(0, 16);
  
  // Створюємо читабельний slug
  const slug = params.normalizedTitle
    .toLowerCase()
    .replace(/[^а-яіїєa-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50);
  
  return `${slug}-${hash}`;
}

/**
 * Визначає act group info для документа
 * 
 * СЕМАНТИКА:
 * - Для одиночних актів: act_group_key = NULL, act_is_part = false
 * - Для multi-part актів: act_group_key = stable hash, act_is_part = true
 */
export function determineActGroup(params: {
  title: string;
  documentType: string;
  lawNumber?: string | null;
}): ActGroupInfo {
  const partLabel = detectPartLabel(params.title);
  const isPart = partLabel !== null;
  
  // КРИТИЧНО: act_group_key генерується ТІЛЬКИ якщо detectPartLabel повернув щось
  // Або якщо в назві є явна індикація частини/тома
  if (!isPart) {
    // Окремий акт (не частина групи) — НЕ заповнюємо act_group_key
    return {
      act_group_key: '', // NULL (порожній рядок буде конвертовано в NULL в БД)
      act_is_part: false,
      act_part_label: null,
      act_group_title: null,
      confidence: 'high',
    };
  }
  
  // Multi-part акт: генеруємо act_group_key
  const normalizedTitle = normalizeBaseTitle(params.title);
  const groupKey = generateActGroupKey({
    normalizedTitle,
    documentType: params.documentType,
    lawNumber: params.lawNumber,
  });
  
  return {
    act_group_key: groupKey,
    act_is_part: true,
    act_part_label: partLabel,
    act_group_title: normalizedTitle,
    confidence: 'high',
  };
}
