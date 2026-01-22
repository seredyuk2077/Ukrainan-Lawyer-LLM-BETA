/**
 * Taxonomy V1 — канонічний перелік категорій законодавства
 */

export const TAXONOMY_V1 = {
  constitutional: 'конституційне',
  criminal: 'кримінальне',
  criminal_procedure: 'кримінально-процесуальне',
  civil: 'цивільне',
  civil_procedure: 'цивільно-процесуальне',
  administrative: 'адміністративне',
  administrative_offenses: 'адміністративна відповідальність',
  labor_social: 'трудове та соціальне',
  finance_banking: 'фінансове та банківське',
  tax_customs: 'податкове та митне',
  business_corporate: 'господарське та корпоративне',
  property_real_estate: 'право власності та нерухомість',
  construction_urban: 'будівництво та містобудування',
  energy_utilities: 'енергетика та комунальні послуги',
  defense_mobilization: 'оборона та мобілізація',
  national_security: 'національна безпека',
  border_migration: 'кордон та міграція',
  anti_corruption: 'антикорупційне',
  procurement: 'державні закупівлі',
  healthcare: 'охорона здоров\'я',
  education_science: 'освіта та наука',
  environment: 'екологія та охорона навколишнього середовища',
  transport_infrastructure: 'транспорт та інфраструктура',
  local_government: 'місцеве самоврядування',
  judiciary_justice: 'судоустрій та правосуддя',
  international_eu: 'міжнародне право та євроінтеграція',
  digital_data: 'цифрове право та захист даних',
  other: 'інше',
} as const;

export type TaxonomySlug = keyof typeof TAXONOMY_V1;

export const VALID_CATEGORIES = Object.keys(TAXONOMY_V1) as TaxonomySlug[];

/**
 * Перевіряє чи category валідна
 */
export function isValidCategory(category: string): category is TaxonomySlug {
  return category in TAXONOMY_V1;
}

/**
 * Повертає українську назву категорії
 */
export function getCategoryLabel(slug: TaxonomySlug): string {
  return TAXONOMY_V1[slug];
}

/**
 * Нормалізує category до taxonomy slug (EN)
 * Підтримує legacy UA значення та мапить їх на slugs
 */
export function normalizeCategory(category: string | null | undefined): TaxonomySlug {
  if (!category) return 'other';
  
  const normalized = category.toLowerCase().trim();
  
  // Якщо це вже taxonomy slug
  if (isValidCategory(normalized as TaxonomySlug)) {
    return normalized as TaxonomySlug;
  }
  
  // Legacy UA mappings
  const legacyMappings: Record<string, TaxonomySlug> = {
    'інше': 'other',
    'конституційне': 'constitutional',
    'кримінальне': 'criminal',
    'цивільне': 'civil',
    'адміністративне': 'administrative',
    'трудове': 'labor_social',
    'сімейне': 'labor_social',
    'податкове': 'tax_customs',
    'митне': 'tax_customs',
    'земельне': 'property_real_estate',
    'господарське': 'business_corporate',
    'процесуальне': 'civil_procedure',
    'оборона': 'defense_mobilization',
    'мобілізація': 'defense_mobilization',
    'кордон': 'border_migration',
    'міграція': 'border_migration',
    'безпека': 'national_security',
  };
  
  if (normalized in legacyMappings) {
    return legacyMappings[normalized];
  }
  
  // Reverse lookup по UA labels в TAXONOMY_V1
  const foundSlug = Object.entries(TAXONOMY_V1).find(
    ([_, label]) => label.toLowerCase() === normalized
  )?.[0] as TaxonomySlug | undefined;
  
  if (foundSlug) {
    return foundSlug;
  }
  
  // Fallback
  return 'other';
}

/**
 * Rule-based fallback для категоризації (якщо AI не спрацював)
 */
export function guessCategoryFromKeywords(
  title: string,
  documentType: string
): TaxonomySlug | null {
  const lowerTitle = title.toLowerCase();
  
  // Ключові слова для кожної категорії
  const keywords: Array<{ category: TaxonomySlug; patterns: RegExp[] }> = [
    {
      category: 'constitutional',
      patterns: [/конституція/i, /конституційний суд/i],
    },
    {
      category: 'criminal',
      patterns: [/кримінальний кодекс/i, /кримінальна відповідальність/i, /кк/i],
    },
    {
      category: 'criminal_procedure',
      patterns: [/кримінальний процесуальний кодекс/i, /кпк/i, /кримінальне провадження/i],
    },
    {
      category: 'civil',
      patterns: [/цивільний кодекс/i, /цк/i, /право власності/i],
    },
    {
      category: 'civil_procedure',
      patterns: [/цивільний процесуальний кодекс/i, /цпк/i, /цивільне судочинство/i],
    },
    {
      category: 'administrative',
      patterns: [/кодекс.*адміністративних правопорушень/i, /куп/i, /адміністративна відповідальність/i],
    },
    {
      category: 'defense_mobilization',
      patterns: [/мобілізаці/i, /оборон/i, /військов/i, /служба/i],
    },
    {
      category: 'border_migration',
      patterns: [/кордон/i, /перетин.*кордон/i, /міграці/i, /біженц/i],
    },
    {
      category: 'tax_customs',
      patterns: [/податковий кодекс/i, /податок/i, /митн/i],
    },
    {
      category: 'business_corporate',
      patterns: [/господарський кодекс/i, /гк/i, /акціонерн/i, /корпоративн/i],
    },
  ];
  
  for (const { category, patterns } of keywords) {
    if (patterns.some(p => p.test(lowerTitle))) {
      return category;
    }
  }
  
  return null;
}

/**
 * Визначає чи документ МОЖЕ мати "other" категорію
 */
export function canBeOtherCategory(documentType: string): boolean {
  // Кодекси та Закони майже завжди мають точну категорію
  const restrictedTypes = ['Кодекс', 'Закон', 'Конституція'];
  return !restrictedTypes.includes(documentType);
}
