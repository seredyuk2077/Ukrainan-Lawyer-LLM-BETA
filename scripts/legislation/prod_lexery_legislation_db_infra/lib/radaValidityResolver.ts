/**
 * Rada Validity Resolver — authoritative resolver для чинності документів
 * 
 * PRIMARY SOURCE: Rada card/show JSON status object (stan codes)
 * 
 * Мапінг stan codes:
 * - 5 → in_force (чинний)
 * - 1 → expired (втратив чинність)
 * - 6 → not_in_force (не набрав чинності)
 * 
 * Якщо код невідомий → детерміноване визначення через dates або консервативна політика
 */

import { RadaClient } from './radaClient.js';
import { ValidityStatus, ValidityResult } from '../canonical/extractValidity.js';
import { encodeNregForUrl } from '../utils/nreg.js';

interface ValidityBundle {
  validity_status: ValidityStatus;
  valid_from: string | null;
  valid_to: string | null;
  source_status_code: string;
  source_status_location: 'rada_card.status';
  status_note: string;
}

// Кеш для resolver (in-memory на час backfill)
const cache = new Map<string, ValidityBundle>();

/**
 * Мапінг stan codes → наші enum
 */
function mapStanCodeToValidityStatus(code: number | string): ValidityStatus | null {
  const codeNum = typeof code === 'string' ? parseInt(code, 10) : code;
  
  if (isNaN(codeNum)) return null;
  
  // Стандартні мапінги згідно з документацією
  if (codeNum === 5) return 'in_force';
  if (codeNum === 1) return 'expired';
  if (codeNum === 6) return 'not_in_force';
  
  // Інші коди поки невідомі
  return null;
}

/**
 * Детерміноване визначення через dates (якщо код невідомий)
 * 
 * Логіка:
 * - Якщо status_to є і status_to <= today → expired
 * - Якщо status_from є і status_from > today → not_in_force
 * - Інакше → in_force (консервативна політика)
 */
function determineFromDates(
  statusFrom: string | null | undefined,
  statusTo: string | null | undefined,
  unknownCode: string
): ValidityStatus {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Перевіряємо status_to
  if (statusTo) {
    try {
      const toDate = new Date(statusTo);
      toDate.setHours(0, 0, 0, 0);
      if (toDate <= today) {
        return 'expired';
      }
    } catch {
      // Ігноруємо помилки парсингу дат
    }
  }
  
  // Перевіряємо status_from
  if (statusFrom) {
    try {
      const fromDate = new Date(statusFrom);
      fromDate.setHours(0, 0, 0, 0);
      if (fromDate > today) {
        return 'not_in_force';
      }
    } catch {
      // Ігноруємо помилки парсингу дат
    }
  }
  
  // Консервативна політика: якщо немає явних маркерів → in_force
  return 'in_force';
}

/**
 * Резолвить чинність документа через Rada API (authoritative source)
 * 
 * @param nreg - NREG документа
 * @param radaClient - RadaClient для запитів
 * @param useCache - використовувати кеш (за замовчуванням true)
 * @returns ValidityBundle з визначеним статусом
 */
export async function resolveValidityByNreg(
  nreg: string,
  radaClient: RadaClient,
  useCache: boolean = true
): Promise<ValidityBundle> {
  // Перевіряємо кеш
  if (useCache && cache.has(nreg)) {
    return cache.get(nreg)!;
  }
  
    try {
      // Завантажуємо card JSON (authoritative source для status)
      // Використовуємо fetchJson (show JSON) якщо card недоступний
      let cardJson: any;
      try {
        // Спробуємо card JSON спочатку
        const cardUrl = `https://data.rada.gov.ua/laws/card/${encodeNregForUrl(nreg)}.json`;
        const token = await radaClient.getToken();
        const headers: Record<string, string> = {
          'User-Agent': token || 'OpenData',
          'Accept': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        
        const cardResponse = await fetch(cardUrl, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        
        if (cardResponse.ok) {
          cardJson = await cardResponse.json();
        } else {
          // Fallback на show JSON
          cardJson = await radaClient.fetchJson(nreg);
        }
      } catch {
        // Fallback на show JSON
        cardJson = await radaClient.fetchJson(nreg);
      }
    
    // Витягуємо status (stan code)
    const statusCode = cardJson?.status;
    const statusFrom = cardJson?.status_from || null;
    const statusTo = cardJson?.status_to || null;
    
    const codeStr = statusCode !== undefined && statusCode !== null ? String(statusCode) : 'N/A';
    
    // Мапимо stan code → validity status
    let validityStatus: ValidityStatus;
    let statusNote: string;
    
    const mappedStatus = mapStanCodeToValidityStatus(statusCode);
    
    if (mappedStatus) {
      // Відомий код → використовуємо мапінг
      validityStatus = mappedStatus;
      statusNote = `derived_from_stan_${codeStr}`;
    } else {
      // Невідомий код → детерміноване визначення через dates
      validityStatus = determineFromDates(statusFrom, statusTo, codeStr);
      statusNote = `derived_from_status_dates_unknown_code_${codeStr}`;
    }
    
    // Форматуємо dates (якщо є)
    let validFrom: string | null = null;
    let validTo: string | null = null;
    
    if (statusFrom) {
      try {
        const fromDate = new Date(statusFrom);
        if (!isNaN(fromDate.getTime())) {
          validFrom = fromDate.toISOString().split('T')[0]; // YYYY-MM-DD
        }
      } catch {
        // Ігноруємо помилки парсингу
      }
    }
    
    if (statusTo) {
      try {
        const toDate = new Date(statusTo);
        if (!isNaN(toDate.getTime())) {
          validTo = toDate.toISOString().split('T')[0]; // YYYY-MM-DD
        }
      } catch {
        // Ігноруємо помилки парсингу
      }
    }
    
    const bundle: ValidityBundle = {
      validity_status: validityStatus,
      valid_from: validFrom,
      valid_to: validTo,
      source_status_code: codeStr,
      source_status_location: 'rada_card.status',
      status_note: statusNote,
    };
    
    // Зберігаємо в кеш
    if (useCache) {
      cache.set(nreg, bundle);
    }
    
    return bundle;
  } catch (error) {
    // Якщо HTTP впав (timeout/5xx) → консервативна політика (in_force)
    // Це fallback тільки для тимчасових помилок API
    console.warn(`⚠️  Rada API error for ${nreg}: ${error instanceof Error ? error.message : String(error)}`);
    
    const fallbackBundle: ValidityBundle = {
      validity_status: 'in_force', // Консервативна політика
      valid_from: null,
      valid_to: null,
      source_status_code: 'N/A',
      source_status_location: 'rada_card.status',
      status_note: `fallback_api_error_${error instanceof Error ? error.message : String(error)}`,
    };
    
    if (useCache) {
      cache.set(nreg, fallbackBundle);
    }
    
    return fallbackBundle;
  }
}

/**
 * Очищає кеш resolver
 */
export function clearValidityCache(): void {
  cache.clear();
}

/**
 * Конвертує ValidityBundle → ValidityResult (для сумісності з extractValidity)
 */
export function bundleToResult(bundle: ValidityBundle): ValidityResult {
  return {
    validity_status: bundle.validity_status,
    valid_from: bundle.valid_from,
    valid_to: bundle.valid_to,
    status_note: bundle.status_note,
    source_status_text: bundle.source_status_code,
    source_status_location: bundle.source_status_location,
    confidence: 'high', // Authoritative source
  };
}
