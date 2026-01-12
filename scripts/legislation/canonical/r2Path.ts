/**
 * R2 Path Generator — генерація шляхів для Cloudflare R2
 * 
 * Згідно з docs/legislation-rag/09_r2_format.md
 */

/**
 * Mapping категорій права на папки в R2
 */
const CATEGORY_MAPPING: Record<string, string> = {
  'цивільне': 'civil',
  'кримінальне': 'criminal',
  'трудове': 'labor',
  'сімейне': 'family',
  'податкове': 'tax',
  'земельне': 'land',
  'господарське': 'commercial',
  'адміністративне': 'administrative',
  'процесуальне': 'procedural',
  'конституційне': 'constitutional',
  'інше': 'other',
};

/**
 * Нормалізує категорію для R2 path
 */
function normalizeCategory(category: string): string {
  const normalized = category.toLowerCase().trim();
  return CATEGORY_MAPPING[normalized] || 'other';
}

/**
 * Генерує R2 key path для canonical JSON
 * 
 * Формат: legislation/{category}/{nreg}.json
 * 
 * @param category - Категорія права (українською)
 * @param nreg - NREG документа
 * @returns R2 key path
 * 
 * @example
 * generateR2Key('конституційне', '254к/96-вр')
 * // => 'legislation/constitutional/254к%2F96-%D0%B2%D1%80.json'
 */
export function generateR2Key(category: string, nreg: string): string {
  const normalizedCategory = normalizeCategory(category);
  const encodedNreg = encodeURIComponent(nreg);
  
  return `legislation/${normalizedCategory}/${encodedNreg}.json`;
}

/**
 * Парсить R2 key path назад в category та nreg
 * 
 * @param r2Key - R2 key path
 * @returns Об'єкт з category та nreg
 */
export function parseR2Key(r2Key: string): { category: string; nreg: string } | null {
  const match = r2Key.match(/^legislation\/([^\/]+)\/(.+)\.json$/);
  if (!match) {
    return null;
  }

  const categoryFolder = match[1];
  const encodedNreg = match[2];

  // Знаходимо оригінальну категорію (reverse mapping)
  const category = Object.entries(CATEGORY_MAPPING).find(
    ([_, folder]) => folder === categoryFolder
  )?.[0] || categoryFolder;

  const nreg = decodeURIComponent(encodedNreg);

  return { category, nreg };
}

/**
 * Перевіряє чи R2 key path валідний
 */
export function isValidR2Key(r2Key: string): boolean {
  return /^legislation\/[a-z]+\/.+\.json$/.test(r2Key);
}

