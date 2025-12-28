/**
 * Конфігурація для скриптів Legislation RAG
 * 
 * Завантажує та валідує змінні оточення.
 * Надає базові налаштування для роботи з rada.gov.ua API.
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Завантажуємо .env з кореня проєкту
dotenv.config({ path: resolve(process.cwd(), '.env') });

/**
 * Базові налаштування API
 */
export const RADA_API_CONFIG = {
  baseUrl: 'https://data.rada.gov.ua',
  tokenUrl: 'https://data.rada.gov.ua/api/token',
  tokenUserAgent: 'OpenData',
  
  // Ліміти API (з документації)
  rateLimit: {
    requestsPerMinute: 60,
    delayBetweenRequests: 5000, // 5 секунд (мінімум)
    recommendedDelay: 7000,      // 7 секунд (рекомендовано)
  },
  
  // Timeouts
  timeout: {
    request: 30000,  // 30 секунд
    token: 10000,     // 10 секунд
  },
} as const;

/**
 * Налаштування шляхів для збереження файлів
 */
export const PATHS = {
  tmp: resolve(process.cwd(), 'tmp'),
  radaRaw: resolve(process.cwd(), 'tmp', 'rada_raw'),
  canonical: resolve(process.cwd(), 'tmp', 'canonical'),
} as const;

/**
 * Перевірка наявності необхідних змінних оточення
 * 
 * Для локального тестування токен не обов'язковий (можна використовувати OpenData режим)
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Поки що не вимагаємо жодних env змінних для локального тестування
  // В майбутньому можуть знадобитися:
  // - RADA_API_TOKEN (опціонально, для підвищених лімітів)
  // - SUPABASE_URL, SUPABASE_KEY (для роботи з БД)
  // - R2_* (для завантаження в Cloudflare R2)
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Логування конфігурації (без секретів)
 */
export function logConfig(): void {
  console.log('📋 Конфігурація:');
  console.log(`  Base URL: ${RADA_API_CONFIG.baseUrl}`);
  console.log(`  Rate limit: ${RADA_API_CONFIG.rateLimit.requestsPerMinute} req/min`);
  console.log(`  Delay: ${RADA_API_CONFIG.rateLimit.recommendedDelay}ms`);
  console.log(`  Tmp dir: ${PATHS.tmp}`);
  console.log('');
}

