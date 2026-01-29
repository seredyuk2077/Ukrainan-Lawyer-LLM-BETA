/**
 * Document Type Taxonomy V1
 * 
 * Стандартизовані типи документів для legislation RAG system.
 * Аналогічно category taxonomy — контрольований перелік, не "вигадування" нових типів.
 */

export type DocumentTypeSlug =
  // Основні закони
  | 'law'
  | 'code'
  | 'constitution'
  
  // Постанови та рішення
  | 'cmu_resolution'      // Постанова КМУ
  | 'cmu_order'           // Розпорядження КМУ
  | 'cmu_decree'          // Декрет КМУ
  | 'vr_resolution'       // Постанова ВРУ
  | 'vr_speaker_order'    // Розпорядження Голови ВРУ
  | 'presidential_decree' // Указ Президента
  | 'presidential_order'  // Розпоряження Президента
  | 'cec_resolution'      // Постанова ЦВК
  | 'rnbo_decision'       // Рішення РНБО
  | 'nbu_resolution'      // Постанова НБУ / Правління НБУ
  | 'nbu_letter'          // Лист/Повідомлення/Роз'яснення НБУ
  | 'nerc_resolution'     // Постанова НКРЕКП
  
  // Адміністративні акти
  | 'minister_order'      // Наказ міністра
  | 'minister_explanation' // Роз'яснення міністерства
  | 'regulation'          // Положення
  | 'rules'               // Правила
  | 'instruction'         // Інструкція
  | 'charter'             // Статут
  
  // Міжнародні документи
  | 'international_treaty' // Міжнародний договір
  | 'convention'          // Конвенція
  | 'protocol'            // Протокол
  | 'agreement'           // Угода
  | 'eu_directive'        // Директива Європейського парламенту
  | 'eu_regulation'       // Регламент Європейського парламенту
  
  // Судові документи
  | 'court_decision'       // Рішення суду
  | 'court_opinion'        // Окрема думка судді
  | 'court_explanation'    // Постанова Пленуму Верховного Суду (роз'яснення судової практики)
  | 'ccu_decision'        // Рішення КСУ
  | 'ccu_ruling'          // Ухвала КСУ
  | 'ccu_opinion'          // Окрема думка судді КСУ
  
  // Інші
  | 'memorandum'          // Меморандум
  | 'declaration'         // Декларація
  | 'unknown'             // Невизначений тип (краще ніж "Закон" від балди)
  | 'other';              // Інше (fallback)

export interface DocumentTypeInfo {
  slug: DocumentTypeSlug;
  label_uk: string;
  label_en: string;
  description?: string;
}

export const DOCUMENT_TYPES: Record<DocumentTypeSlug, DocumentTypeInfo> = {
  law: {
    slug: 'law',
    label_uk: 'Закон',
    label_en: 'Law',
    description: 'Закон України',
  },
  code: {
    slug: 'code',
    label_uk: 'Кодекс',
    label_en: 'Code',
    description: 'Кодекс України',
  },
  constitution: {
    slug: 'constitution',
    label_uk: 'Конституція',
    label_en: 'Constitution',
    description: 'Конституція України',
  },
  cmu_resolution: {
    slug: 'cmu_resolution',
    label_uk: 'Постанова КМУ',
    label_en: 'CMU Resolution',
    description: 'Постанова Кабінету Міністрів України',
  },
  cmu_order: {
    slug: 'cmu_order',
    label_uk: 'Розпорядження КМУ',
    label_en: 'CMU Order',
    description: 'Розпорядження Кабінету Міністрів України',
  },
  cmu_decree: {
    slug: 'cmu_decree',
    label_uk: 'Декрет Кабінету Міністрів України',
    label_en: 'CMU Decree',
    description: 'Декрет Кабінету Міністрів України',
  },
  vr_resolution: {
    slug: 'vr_resolution',
    label_uk: 'Постанова ВРУ',
    label_en: 'VRU Resolution',
    description: 'Постанова Верховної Ради України',
  },
  vr_speaker_order: {
    slug: 'vr_speaker_order',
    label_uk: 'Розпорядження Голови ВРУ',
    label_en: 'VRU Speaker Order',
    description: 'Розпорядження Голови Верховної Ради України',
  },
  presidential_decree: {
    slug: 'presidential_decree',
    label_uk: 'Указ Президента',
    label_en: 'Presidential Decree',
    description: 'Указ Президента України',
  },
  presidential_order: {
    slug: 'presidential_order',
    label_uk: 'Розпорядження Президента України',
    label_en: 'Presidential Order',
    description: 'Розпорядження Президента України',
  },
  cec_resolution: {
    slug: 'cec_resolution',
    label_uk: 'Постанова ЦВК',
    label_en: 'CEC Resolution',
    description: 'Постанова Центральної виборчої комісії',
  },
  rnbo_decision: {
    slug: 'rnbo_decision',
    label_uk: 'Рішення РНБО',
    label_en: 'RNBO Decision',
    description: 'Рішення Ради національної безпеки і оборони України',
  },
  nbu_resolution: {
    slug: 'nbu_resolution',
    label_uk: 'Постанова НБУ',
    label_en: 'NBU Resolution',
    description: 'Постанова Правління Національного банку України',
  },
  nbu_letter: {
    slug: 'nbu_letter',
    label_uk: 'Повідомлення НБУ',
    label_en: 'NBU Letter',
    description: 'Лист/Повідомлення/Роз\'яснення Національного банку України',
  },
  nerc_resolution: {
    slug: 'nerc_resolution',
    label_uk: 'Постанова НКРЕКП',
    label_en: 'NERC Resolution',
    description: 'Постанова Національної комісії, що здійснює державне регулювання у сферах енергетики та комунальних послуг',
  },
  minister_order: {
    slug: 'minister_order',
    label_uk: 'Наказ',
    label_en: 'Minister Order',
    description: 'Наказ міністра/відомства',
  },
  minister_explanation: {
    slug: 'minister_explanation',
    label_uk: 'Роз\'яснення',
    label_en: 'Minister Explanation',
    description: 'Роз\'яснення міністерства/відомства',
  },
  regulation: {
    slug: 'regulation',
    label_uk: 'Положення',
    label_en: 'Regulation',
    description: 'Положення про...',
  },
  rules: {
    slug: 'rules',
    label_uk: 'Правила',
    label_en: 'Rules',
    description: 'Правила...',
  },
  instruction: {
    slug: 'instruction',
    label_uk: 'Інструкція',
    label_en: 'Instruction',
    description: 'Інструкція про...',
  },
  charter: {
    slug: 'charter',
    label_uk: 'Статут',
    label_en: 'Charter',
    description: 'Статут...',
  },
  international_treaty: {
    slug: 'international_treaty',
    label_uk: 'Міжнародний договір',
    label_en: 'International Treaty',
    description: 'Міжнародний договір України',
  },
  convention: {
    slug: 'convention',
    label_uk: 'Конвенція',
    label_en: 'Convention',
    description: 'Міжнародна конвенція',
  },
  protocol: {
    slug: 'protocol',
    label_uk: 'Протокол',
    label_en: 'Protocol',
    description: 'Міжнародний протокол',
  },
  agreement: {
    slug: 'agreement',
    label_uk: 'Угода',
    label_en: 'Agreement',
    description: 'Міжнародна угода',
  },
  eu_directive: {
    slug: 'eu_directive',
    label_uk: 'Директива Європейського парламенту',
    label_en: 'EU Directive',
    description: 'Директива Європейського парламенту і Ради',
  },
  eu_regulation: {
    slug: 'eu_regulation',
    label_uk: 'Регламент Європейського парламенту',
    label_en: 'EU Regulation',
    description: 'Регламент Європейського парламенту і Ради',
  },
  court_decision: {
    slug: 'court_decision',
    label_uk: 'Рішення суду',
    label_en: 'Court Decision',
    description: 'Рішення суду',
  },
  court_opinion: {
    slug: 'court_opinion',
    label_uk: 'Окрема думка судді',
    label_en: 'Court Opinion',
    description: 'Окрема думка судді',
  },
  court_explanation: {
    slug: 'court_explanation',
    label_uk: 'Постанова Пленуму Верховного Суду',
    label_en: 'Court Plenum Resolution',
    description: 'Постанова Пленуму Верховного Суду України (роз\'яснення судової практики)',
  },
  ccu_decision: {
    slug: 'ccu_decision',
    label_uk: 'Рішення КСУ',
    label_en: 'CCU Decision',
    description: 'Рішення Конституційного Суду України',
  },
  ccu_ruling: {
    slug: 'ccu_ruling',
    label_uk: 'Ухвала КСУ',
    label_en: 'CCU Ruling',
    description: 'Ухвала Конституційного Суду України',
  },
  ccu_opinion: {
    slug: 'ccu_opinion',
    label_uk: 'Окрема думка судді КСУ',
    label_en: 'CCU Opinion',
    description: 'Окрема думка судді Конституційного Суду України',
  },
  memorandum: {
    slug: 'memorandum',
    label_uk: 'Меморандум',
    label_en: 'Memorandum',
    description: 'Меморандум',
  },
  declaration: {
    slug: 'declaration',
    label_uk: 'Декларація',
    label_en: 'Declaration',
    description: 'Декларація',
  },
  unknown: {
    slug: 'unknown',
    label_uk: 'Невизначений тип',
    label_en: 'Unknown',
    description: 'Тип документа не визначено (краще ніж "Закон" від балди)',
  },
  other: {
    slug: 'other',
    label_uk: 'Інше',
    label_en: 'Other',
    description: 'Інший тип документа',
  },
};

/**
 * Нормалізує document type до стандартного slug
 */
export function normalizeDocumentType(
  input: string | null | undefined
): DocumentTypeSlug {
  if (!input) return 'other';
  
  const normalized = input.toLowerCase().trim();
  
  // Прямі мапінги
  const directMap: Record<string, DocumentTypeSlug> = {
    'закон': 'law',
    'закон україни': 'law',
    'кодекс': 'code',
    'кодекс україни': 'code',
    'конституція': 'constitution',
    'конституція україни': 'constitution',
    'постанова кму': 'cmu_resolution',
    'постанова кабінету міністрів': 'cmu_resolution',
    'постанова вр': 'vr_resolution',
    'постанова верховної ради': 'vr_resolution',
    'розпорядження голови вр': 'vr_speaker_order',
    'розпорядження голови верховної ради': 'vr_speaker_order',
    'указ президента': 'presidential_decree',
    'розпоряження президента': 'presidential_order',
    'наказ': 'minister_order',
    'положення': 'regulation',
    'правила': 'rules',
    'інструкція': 'instruction',
    'статут': 'charter',
    'конвенція': 'convention',
    'міжнародний договір': 'international_treaty',
    'протокол': 'protocol',
    'угода': 'agreement',
    'рішення суду': 'court_decision',
    'окрема думка': 'court_opinion',
    'окрема думка судді': 'court_opinion',
    'рішення ксу': 'ccu_decision',
    'окрема думка судді ксу': 'ccu_opinion',
    'меморандум': 'memorandum',
    'декларація': 'declaration',
    'документ': 'other',
  };
  
  if (directMap[normalized]) {
    return directMap[normalized];
  }
  
  // Часткові матчі
  if (normalized.includes('кодекс')) return 'code';
  if (normalized.includes('закон') && !normalized.includes('про')) return 'law';
  if (normalized.includes('конституція')) return 'constitution';
  if (normalized.includes('постанова') && normalized.includes('кму')) return 'cmu_resolution';
  if (normalized.includes('розпорядження') && normalized.includes('голови') && (normalized.includes('вр') || normalized.includes('верховної'))) return 'vr_speaker_order';
  if (normalized.includes('постанова') && (normalized.includes('вр') || normalized.includes('верховної'))) return 'vr_resolution';
  if (normalized.includes('указ') && normalized.includes('президента')) return 'presidential_decree';
  if (normalized.includes('розпоряження') && normalized.includes('президента')) return 'presidential_order';
  if (normalized.includes('наказ')) return 'minister_order';
  if (normalized.includes('положення')) return 'regulation';
  if (normalized.includes('правила')) return 'rules';
  if (normalized.includes('інструкція')) return 'instruction';
  if (normalized.includes('конвенція')) return 'convention';
  if (normalized.includes('міжнародний') && (normalized.includes('договір') || normalized.includes('конвенція'))) return 'international_treaty';
  if (normalized.includes('окрема думка') && normalized.includes('ксу')) return 'ccu_opinion';
  if (normalized.includes('окрема думка')) return 'court_opinion';
  if (normalized.includes('рішення') && normalized.includes('ксу')) return 'ccu_decision';
  
  return 'other';
}

/**
 * Отримує інформацію про document type
 */
export function getDocumentTypeInfo(slug: DocumentTypeSlug): DocumentTypeInfo {
  return DOCUMENT_TYPES[slug] || DOCUMENT_TYPES.other;
}
