/**
 * R2 Path Generator — генерація шляхів для Cloudflare R2
 * 
 * Згідно з docs/legislation-rag/09_r2_format.md
 */

/**
 * Mapping категорій права на папки в R2
 * Тепер використовуємо taxonomy slugs (з taxonomy/taxonomy.ts)
 */
import { TaxonomySlug, isValidCategory, TAXONOMY_V1 } from '../taxonomy/taxonomy.js';

export const CATEGORY_TO_R2_FOLDER: Record<TaxonomySlug, string> = {
  constitutional: 'constitutional',
  criminal: 'criminal',
  criminal_procedure: 'criminal',
  civil: 'civil',
  civil_procedure: 'civil',
  administrative: 'administrative',
  administrative_offenses: 'administrative',
  labor_social: 'labor',
  finance_banking: 'finance',
  tax_customs: 'tax',
  business_corporate: 'commercial',
  property_real_estate: 'land',
  construction_urban: 'land',
  energy_utilities: 'energy',
  defense_mobilization: 'defense',
  national_security: 'security',
  border_migration: 'migration',
  anti_corruption: 'anti_corruption',
  procurement: 'procurement',
  healthcare: 'healthcare',
  education_science: 'education',
  environment: 'environment',
  transport_infrastructure: 'transport',
  local_government: 'local',
  judiciary_justice: 'judiciary',
  international_eu: 'international',
  digital_data: 'digital',
  other: 'other',
};

// Legacy mapping для сумісності (українські назви)
const LEGACY_CATEGORY_MAPPING: Record<string, string> = {
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
 * Підтримує як taxonomy slugs, так і legacy українські назви
 */
function normalizeCategory(category: string): string {
  const normalized = category.toLowerCase().trim();
  
  // Якщо це taxonomy slug
  if (isValidCategory(normalized as TaxonomySlug)) {
    return CATEGORY_TO_R2_FOLDER[normalized as TaxonomySlug];
  }
  
  // Якщо це legacy українська назва
  if (normalized in LEGACY_CATEGORY_MAPPING) {
    return LEGACY_CATEGORY_MAPPING[normalized];
  }
  
  // Якщо це українська назва з taxonomy (reverse lookup)
  const foundSlug = Object.entries(TAXONOMY_V1).find(
    ([_, label]) => label.toLowerCase() === normalized
  )?.[0] as TaxonomySlug | undefined;
  
  if (foundSlug) {
    return CATEGORY_TO_R2_FOLDER[foundSlug];
  }
  
  return 'other';
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
  // Шукаємо taxonomy slug за R2 folder
  const foundSlug = Object.entries(CATEGORY_TO_R2_FOLDER).find(
    ([_, folder]) => folder === categoryFolder
  )?.[0] as TaxonomySlug | undefined;
  
  const category = foundSlug || categoryFolder;

  const nreg = decodeURIComponent(encodedNreg);

  return { category, nreg };
}

/**
 * Перевіряє чи R2 key path валідний
 */
export function isValidR2Key(r2Key: string): boolean {
  return /^legislation\/[a-z]+\/.+\.json$/.test(r2Key);
}

