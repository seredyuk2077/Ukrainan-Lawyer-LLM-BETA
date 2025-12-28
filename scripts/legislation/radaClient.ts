/**
 * Клієнт для роботи з rada.gov.ua API
 * 
 * Реалізує:
 * - Отримання та кешування токену
 * - Завантаження JSON та TXT форматів
 * - Rate limiting
 * - Обробку помилок
 */

import { RADA_API_CONFIG, PATHS } from './config.js';
import { encodeNregForUrl, nregToSafeFilename } from './utils/nreg.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

interface TokenResponse {
  token: string;
  expire: number;
}

interface RateLimiter {
  lastRequestTime: number;
  requestCount: number;
  resetTime: number;
}

/**
 * Клас для роботи з RADA API
 */
export class RadaClient {
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private rateLimiter: RateLimiter = {
    lastRequestTime: 0,
    requestCount: 0,
    resetTime: Date.now() + 60000, // 1 хвилина
  };

  /**
   * Отримує токен для JSON запитів
   * Токен кешується до закінчення терміну дії
   */
  async getToken(): Promise<string | null> {
    // Перевіряємо чи токен ще дійсний
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    try {
      console.log('🔑 Отримуємо токен API...');
      
      const response = await fetch(RADA_API_CONFIG.tokenUrl, {
        headers: {
          'User-Agent': RADA_API_CONFIG.tokenUserAgent,
        },
        signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.token),
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as TokenResponse;
      this.token = data.token;
      this.tokenExpiresAt = Date.now() + (data.expire * 1000);
      
      console.log(`✅ Токен отримано (діє ${data.expire} секунд)`);
      return this.token;
    } catch (error) {
      console.warn('⚠️  Не вдалося отримати токен:', error instanceof Error ? error.message : String(error));
      console.warn('   Продовжуємо в режимі OpenData (без токену)');
      this.token = null;
      this.tokenExpiresAt = 0;
      return null;
    }
  }

  /**
   * Дотримується rate limiting
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Скидаємо лічильник якщо минула хвилина
    if (now >= this.rateLimiter.resetTime) {
      this.rateLimiter.requestCount = 0;
      this.rateLimiter.resetTime = now + 60000;
    }

    // Перевіряємо ліміт
    if (this.rateLimiter.requestCount >= RADA_API_CONFIG.rateLimit.requestsPerMinute) {
      const waitTime = this.rateLimiter.resetTime - now;
      console.log(`⏳ Rate limit досягнуто, чекаємо ${Math.ceil(waitTime / 1000)} секунд...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.rateLimiter.requestCount = 0;
      this.rateLimiter.resetTime = Date.now() + 60000;
    }

    // Дотримуємося мінімальної затримки між запитами
    const timeSinceLastRequest = now - this.rateLimiter.lastRequestTime;
    if (timeSinceLastRequest < RADA_API_CONFIG.rateLimit.recommendedDelay) {
      const waitTime = RADA_API_CONFIG.rateLimit.recommendedDelay - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.rateLimiter.lastRequestTime = Date.now();
    this.rateLimiter.requestCount++;
  }

  /**
   * Завантажує JSON документ
   */
  async fetchJson(nreg: string): Promise<any> {
    await this.waitForRateLimit();

    const token = await this.getToken();
    const url = `${RADA_API_CONFIG.baseUrl}/laws/show/${encodeNregForUrl(nreg)}.json`;
    
    console.log(`📥 Завантажуємо JSON: ${nreg}`);

    try {
      // Для JSON запитів використовуємо токен (згідно з документацією та існуючим кодом)
      const headers: Record<string, string> = {
        'User-Agent': RADA_API_CONFIG.tokenUserAgent,
        'Accept': 'application/json',
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request),
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Документ не знайдено: ${nreg}`);
        }
        if (response.status === 429) {
          throw new Error('Rate limit досягнуто. Спробуйте пізніше.');
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`✅ JSON завантажено (${JSON.stringify(data).length} байт)`);
      return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Таймаут запиту');
      }
      throw error;
    }
  }

  /**
   * Завантажує TXT документ (fallback)
   */
  async fetchTxt(nreg: string): Promise<string> {
    await this.waitForRateLimit();

    const url = `${RADA_API_CONFIG.baseUrl}/laws/show/${encodeNregForUrl(nreg)}.txt`;
    
    console.log(`📥 Завантажуємо TXT: ${nreg}`);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': RADA_API_CONFIG.tokenUserAgent,
        },
        signal: AbortSignal.timeout(RADA_API_CONFIG.timeout.request),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      console.log(`✅ TXT завантажено (${text.length} символів)`);
      return text;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Таймаут запиту');
      }
      throw error;
    }
  }

  /**
   * Зберігає raw відповідь в файл
   */
  async saveRaw(nreg: string, data: any, format: 'json' | 'txt' = 'json'): Promise<string> {
    // Створюємо папку якщо не існує
    if (!existsSync(PATHS.radaRaw)) {
      await mkdir(PATHS.radaRaw, { recursive: true });
    }

    // Формуємо безпечне ім'я файлу
    const safeNreg = nregToSafeFilename(nreg);
    const filename = `${safeNreg}.${format === 'json' ? 'json' : 'txt'}`;
    const filepath = `${PATHS.radaRaw}/${filename}`;

    if (format === 'json') {
      await writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
    } else {
      await writeFile(filepath, data, 'utf-8');
    }

    console.log(`💾 Збережено: ${filepath}`);
    return filepath;
  }
}

