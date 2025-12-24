// @ts-ignore - Deno edge function imports
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @ts-ignore - Deno edge function imports
import OpenAI from "https://esm.sh/openai@4";
import { SupremeCourtCaseLawService } from "./supremeCourtCaseLawService.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Types
interface Article {
  number: string;
  title: string;
  content: string;
}

interface Document {
  id: string;
  title: string;
  content: string;
  law_number?: string;
  rada_nreg?: string;
  category?: string;
  source_url?: string;
  articles?: Article[] | string;
}

interface ManualLawMapping {
  nreg: string;
  lawNumber?: string;
  radaDokid?: number;
  title: string;
  normalizedPatterns: string[];
  category: string;
  codexType?: string;
  documentType?: string;
  isProcedural?: boolean;
  storageFolder?: string;
  storageCategoryPath?: string;
  storageLawFolderName?: string;
  themeCode?: string;
  storageBucket?: string;
  keywords?: string[];
}

interface LawThemeConfig {
  code: string;
  title: string;
  description: string;
  matchingPhrases: string[];
  categoryFallback?: string;
}

interface SoftSearchSignals {
  tokens: string[];
  manualMatch?: ManualLawMapping | null;
  themeCode?: string | null;
}

interface QuestionClassification {
  isLegalQuestion: boolean;
  confidence: number;
  requiredCodex: string | null; // "ККУ", "ЦК", "ТК" тощо
  articleNumber: string | null; // "115", "21" тощо
  articlePart?: string | null;
  articlePoint?: string | null;
  articleSubPoint?: string | null;
  searchKeywords: string[];
  questionType: 'punishment' | 'rights' | 'procedure' | 'definition' | 'general';
  category: string; // "кримінальне", "цивільне" тощо
}

interface QuestionAnalysis {
  categories: Array<{ category: string; score: number }>;
  primaryCategory: string;
  keywords: string[];
  complexity: 'low' | 'medium' | 'high';
}

type RouterBranch =
  | 'criminal'
  | 'civil'
  | 'administrative'
  | 'tax'
  | 'labour'
  | 'constitutional'
  | 'commercial'
  | 'military'
  | 'other';

interface RouterDecision {
  branch: RouterBranch;
  recommended_nreg: string | null;
  confidence: number;
  reasoning: string;
}

interface RouterWhitelistLaw {
  nreg: string;
  title: string;
  branch: RouterBranch;
  category?: string | null;
  keywords?: string[];
  themeCode?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  source: 'manual' | 'storage';
}

interface RouterWhitelistPayload {
  manual: RouterWhitelistLaw[];
  storage: RouterWhitelistLaw[];
  index: Map<string, RouterWhitelistLaw>;
}

const ROUTER_BRANCH_META: Record<
  RouterBranch,
  { category: string; defaultCodex?: string }
> = {
  criminal: {
    category: 'кримінальне',
    defaultCodex: 'Кримінальний кодекс України'
  },
  civil: {
    category: 'цивільне',
    defaultCodex: 'Цивільний кодекс України'
  },
  administrative: {
    category: 'адміністративне',
    defaultCodex: 'Кодекс України про адміністративні правопорушення'
  },
  tax: {
    category: 'податкове',
    defaultCodex: 'Податковий кодекс України'
  },
  labour: {
    category: 'трудове',
    defaultCodex: 'Кодекс законів про працю України'
  },
  constitutional: {
    category: 'конституційне',
    defaultCodex: 'Конституція України'
  },
  commercial: {
    category: 'господарське',
    defaultCodex: 'Господарський кодекс України'
  },
  military: {
    category: 'оборонне',
    defaultCodex: 'Закон України "Про мобілізаційну підготовку та мобілізацію"'
  },
  other: {
    category: 'загальне'
  }
};

const ROUTER_ALLOWED_BRANCHES: RouterBranch[] = Object.keys(
  ROUTER_BRANCH_META
) as RouterBranch[];

const ROUTER_SYSTEM_PROMPT = `Ти — Router українського LegalTech-асистента.
- Визначай правову гілку питання з переліку ${ROUTER_ALLOWED_BRANCHES.join(', ')}.
- Якщо питання явно не про право України, встанови branch="other" і recommended_nreg=null.
- Коли вибираєш recommended_nreg, використовуй ЛИШЕ значення зі списку whitelist, які я надам нижче.
- Якщо впевненості немає, став recommended_nreg=null, але все одно вкажи branch і поясни чому.
- Вихід лише у форматі валідного JSON:
{
  "branch": "...",
  "recommended_nreg": "...",
  "confidence": 0.0-1.0,
  "reasoning": "1-2 речення"
}`;

const SYSTEM_PROMPT_GPT3_ANSWER = `Ти — український юрист. Користуйся лише наданими статтями (жодних зовнішніх знань). Формат Harvey AI:
1. Норми — стисло, з посиланнями (“п. 1 ч. 1 ст. 5”, “ст. 12–15”).
2. Аналіз — юридична логіка без вигадок.
3. Застосування — практичні наслідки для ситуації.
4. Висновок — короткий підсумок.
Цитуй не більше 1–2 речень дослівно; для наборів норм узагальнюй блоками (“ст. 5–7 встановлюють …”). Заборонено вигадувати закони, змішувати кодекси або створювати нові дефініції. Якщо інформації немає в статтях — прямо зазнач. Стиль офіційний, лаконічний, без емоцій.`;

const SYSTEM_PROMPT_CLAUDE_HAIKU_ANSWER = `Ти — український юрист. Джерело — тільки статті з контексту. Формат Harvey AI:
1. Норми — коротко, з посиланнями (“ч. 2 ст. 23”, “ст. 5–7”).
2. Аналіз — структурний юридичний розбір.
3. Застосування — поясни наслідки для кейсу.
4. Висновок — лаконічна рекомендація.
Дозволено узагальнювати групи норм, але заборонено вигадувати чи цитувати поза текстом, змішувати закони або вводити нові терміни. Якщо даних недостатньо, повідом про це. Пиши офіційно, стисло, без емоцій.`;

const DEFAULT_MAIN_PROVIDER = 'openai';
const DEFAULT_OPENAI_MODEL = 'gpt-3.5-turbo';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-haiku-20240307';

function mapCategoryToBranch(category?: string | null): RouterBranch {
  if (!category) {
    return 'other';
  }
  const normalized = category.toLowerCase();
  if (normalized.includes('кримін') || normalized.includes('crime') || normalized.includes('law-enforcement')) {
    return 'criminal';
  }
  if (
    normalized.includes('адмін') ||
    normalized.includes('administr') ||
    normalized.includes('поліц') ||
    normalized.includes('public order')
  ) {
    return 'administrative';
  }
  if (normalized.includes('подат') || normalized.includes('tax')) {
    return 'tax';
  }
  if (normalized.includes('труд') || normalized.includes('labour') || normalized.includes('labor') || normalized.includes('employment')) {
    return 'labour';
  }
  if (normalized.includes('конститу') || normalized.includes('constitution')) {
    return 'constitutional';
  }
  if (
    normalized.includes('господар') ||
    normalized.includes('комер') ||
    normalized.includes('business') ||
    normalized.includes('economic') ||
    normalized.includes('commerce')
  ) {
    return 'commercial';
  }
  if (
    normalized.includes('оборон') ||
    normalized.includes('військ') ||
    normalized.includes('мобіліз') ||
    normalized.includes('повіст') ||
    normalized.includes('military') ||
    normalized.includes('defence') ||
    normalized.includes('defense')
  ) {
    return 'military';
  }
  if (
    normalized.includes('сімей') ||
    normalized.includes('family') ||
    normalized.includes('житл') ||
    normalized.includes('housing')
  ) {
    return 'civil';
  }
  if (normalized.includes('цивіл') || normalized.includes('civil')) {
    return 'civil';
  }
  return 'other';
}

function branchToCategoryMeta(branch: RouterBranch) {
  return ROUTER_BRANCH_META[branch] || ROUTER_BRANCH_META.other;
}

// Enhanced Legal Agent Class
class LegalAgent {
  private legalCategories = {
    'цивільне': ['договір', 'власність', 'спадщина', 'шкода', 'відшкодування', 'купівля', 'продаж', 'цивільний кодекс', 'цк', 'цк україни'],
    'трудове': ['робота', 'заробітна плата', 'відпустка', 'звільнення', 'трудовий договір', 'роботодавець', 'працівник', 'трудовий кодекс', 'тк', 'тк україни'],
    'сімейне': ['шлюб', 'розлучення', 'діти', 'аліменти', 'сім\'я', 'подружжя', 'сімейний кодекс', 'ск', 'ск україни'],
    'кримінальне': ['злочин', 'кримінал', 'покарання', 'вбивство', 'крадіжка', 'шахрайство', 'кримінальний кодекс', 'кку', 'кку україни'],
    'господарське': ['бізнес', 'підприємство', 'господарство', 'комерція', 'торгівля', 'ФОП'],
    'адміністративне': ['штраф', 'порушення', 'адміністративне', 'поліція', 'протокол', 'купап', 'купап україни', 'кодекс адміністративних правопорушень'],
    'конституційне': ['конституція', 'права людини', 'громадянство', 'вибори', 'державність', 'конституція україни'],
    'податкове': ['податок', 'пдв', 'прибуток', 'дохід', 'податковий кодекс', 'пк', 'пк україни'],
    'земельне': ['земля', 'ділянка', 'земельний кодекс', 'зк', 'зк україни'],
    'митне': ['мито', 'кордон', 'експорт', 'імпорт', 'митний кодекс', 'мк', 'мк україни']
  };

  // Маппінг кодексів та їх скорочень
  private codexMapping: Record<string, { fullName: string; category: string; keywords: string[]; searchTerms: string[] }> = {
    'кку': { 
      fullName: 'Кримінальний кодекс України', 
      category: 'кримінальне', 
      keywords: ['злочин', 'кримінал', 'покарання', 'вбивство', 'крадіжка'],
      searchTerms: ['кримінальний кодекс', 'кку', 'злочин', 'кримінал']
    },
    'кк': { 
      fullName: 'Кримінальний кодекс України', 
      category: 'кримінальне', 
      keywords: ['злочин', 'кримінал', 'покарання'],
      searchTerms: ['кримінальний кодекс', 'кк', 'злочин']
    },
    'кримінальний кодекс': { 
      fullName: 'Кримінальний кодекс України', 
      category: 'кримінальне', 
      keywords: ['злочин', 'кримінал'],
      searchTerms: ['кримінальний кодекс', 'кк', 'злочин']
    },
    'купап': { 
      fullName: 'Кодекс України про адміністративні правопорушення', 
      category: 'адміністративне', 
      keywords: ['штраф', 'порушення', 'адміністративне', 'поліція'],
      searchTerms: ['купап', 'адміністративні правопорушення', 'штраф', 'порушення']
    },
    'кодекс адміністративних правопорушень': { 
      fullName: 'Кодекс України про адміністративні правопорушення', 
      category: 'адміністративне', 
      keywords: ['штраф', 'порушення'],
      searchTerms: ['купап', 'адміністративні правопорушення', 'штраф']
    },
    'цк': { 
      fullName: 'Цивільний кодекс України', 
      category: 'цивільне', 
      keywords: ['договір', 'власність', 'спадщина', 'зобов\'язання'],
      searchTerms: ['цивільний кодекс', 'цк', 'договір', 'власність']
    },
    'цивільний кодекс': { 
      fullName: 'Цивільний кодекс України', 
      category: 'цивільне', 
      keywords: ['договір', 'власність'],
      searchTerms: ['цивільний кодекс', 'цк', 'договір']
    },
    'тк': { 
      fullName: 'Трудовий кодекс України', 
      category: 'трудове', 
      keywords: ['робота', 'заробітна плата', 'відпустка', 'працівник'],
      searchTerms: ['трудовий кодекс', 'тк', 'робота', 'працівник']
    },
    'трудовий кодекс': { 
      fullName: 'Трудовий кодекс України', 
      category: 'трудове', 
      keywords: ['робота', 'заробітна плата'],
      searchTerms: ['трудовий кодекс', 'тк', 'робота']
    },
    'ск': { 
      fullName: 'Сімейний кодекс України', 
      category: 'сімейне', 
      keywords: ['шлюб', 'розлучення', 'діти', 'аліменти'],
      searchTerms: ['сімейний кодекс', 'ск', 'шлюб', 'сім\'я']
    },
    'сімейний кодекс': { 
      fullName: 'Сімейний кодекс України', 
      category: 'сімейне', 
      keywords: ['шлюб', 'розлучення'],
      searchTerms: ['сімейний кодекс', 'ск', 'шлюб']
    },
    'пк': { 
      fullName: 'Податковий кодекс України', 
      category: 'податкове', 
      keywords: ['податок', 'пдв', 'прибуток', 'дохід'],
      searchTerms: ['податковий кодекс', 'пк', 'податок', 'пдв']
    },
    'податковий кодекс': { 
      fullName: 'Податковий кодекс України', 
      category: 'податкове', 
      keywords: ['податок', 'пдв'],
      searchTerms: ['податковий кодекс', 'пк', 'податок']
    },
    'зк': { 
      fullName: 'Земельний кодекс України', 
      category: 'земельне', 
      keywords: ['земля', 'ділянка', 'нерухомість'],
      searchTerms: ['земельний кодекс', 'зк', 'земля', 'ділянка']
    },
    'земельний кодекс': { 
      fullName: 'Земельний кодекс України', 
      category: 'земельне', 
      keywords: ['земля', 'ділянка'],
      searchTerms: ['земельний кодекс', 'зк', 'земля']
    },
    'мк': { 
      fullName: 'Митний кодекс України', 
      category: 'митне', 
      keywords: ['мито', 'кордон', 'експорт'],
      searchTerms: ['митний кодекс', 'мк', 'мито', 'кордон']
    },
    'митний кодекс': { 
      fullName: 'Митний кодекс України', 
      category: 'митне', 
      keywords: ['мито', 'кордон'],
      searchTerms: ['митний кодекс', 'мк', 'мито']
    },
    'конституція': { 
      fullName: 'Конституція України', 
      category: 'конституційне', 
      keywords: ['конституція', 'держава', 'права', 'громадянство'],
      searchTerms: ['конституція', 'конституція україни', 'держава', 'права людини']
    },
    'конституція україни': { 
      fullName: 'Конституція України', 
      category: 'конституційне', 
      keywords: ['конституція', 'держава', 'права'],
      searchTerms: ['конституція', 'конституція україни', 'держава']
    }
  };

  // Manual Law Mappings - маппінг конкретних законів
  private manualLawMappings: ManualLawMapping[] = [
    {
      nreg: '3543-12',
      lawNumber: '3543-XII',
      radaDokid: 20736,
      title: 'Закон України "Про мобілізаційну підготовку та мобілізацію"',
      normalizedPatterns: [
        'закон україни про мобілізаційну підготовку та мобілізацію',
        'закон про мобілізацію',
        'зу про мобілізацію',
        'мобілізаційну підготовку',
        'мобілізація'
      ],
      category: 'оборонне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      isProcedural: false,
      storageBucket: 'zu',
      storageCategoryPath: 'MILITARY-DEFENCE',
      storageLawFolderName: 'zu-mobilization',
      themeCode: 'MILITARY-DEFENCE',
      keywords: ['мобілізація', 'призов', 'бронь', 'військовий облік']
    },
    {
      nreg: '1700-18',
      lawNumber: '1700-VIII',
      radaDokid: 433082,
      title: 'Закон України "Про запобігання корупції"',
      normalizedPatterns: [
        'закон про запобігання корупції',
        'зу про запобігання корупції',
        'антикорупційний закон',
        'запобігання корупції',
        'корупція'
      ],
      category: 'антикорупційне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      isProcedural: false,
      storageBucket: 'zu',
      storageCategoryPath: 'GOV-SER-LAWS',
      storageLawFolderName: 'zu-anticorruption',
      themeCode: 'GOV-SER-LAWS',
      keywords: ['корупція', 'держслужбовець', 'подарунки', 'конфлікт інтересів']
    },
    {
      nreg: '2232-12',
      lawNumber: '2232-XII',
      radaDokid: 6093,
      title: 'Закон України "Про військовий обов\'язок і військову службу"',
      normalizedPatterns: [
        'закон про військовий обов\'язок і військову службу',
        'закон про військовий обовязок',
        'військовий обов\'язок і військова служба',
        'військовий обовязок',
        'військова служба',
        'призов на строкову службу',
        'контрактна служба'
      ],
      category: 'оборонне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'MILITARY-DEFENCE',
      storageLawFolderName: 'zu-military-duty',
      themeCode: 'MILITARY-DEFENCE',
      keywords: ['призов', 'строкова служба', 'контракт', 'резервісти']
    },
    {
      nreg: '889-19',
      lawNumber: '889-VIII',
      radaDokid: 198162,
      title: 'Закон України "Про державну службу"',
      normalizedPatterns: [
        'закон про державну службу',
        'держслужба',
        'державний службовець',
        'державна служба україни'
      ],
      category: 'держслужба',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'GOV-SER-LAWS',
      storageLawFolderName: 'zu-civil-service',
      themeCode: 'GOV-SER-LAWS',
      keywords: ['держслужбовець', 'посади', 'службова дисципліна', 'кадровий резерв']
    },
    {
      nreg: '922-19',
      lawNumber: '922-VIII',
      radaDokid: 250573,
      title: 'Закон України "Про публічні закупівлі"',
      normalizedPatterns: [
        'закон про публічні закупівлі',
        'публічні закупівлі',
        'prozorro',
        'тендерні процедури'
      ],
      category: 'економічне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'PROCUREMENT-TRANSPARENCY',
      storageLawFolderName: 'zu-public-procurement',
      themeCode: 'PROCUREMENT-TRANSPARENCY',
      keywords: ['закупівлі', 'тендер', 'prozorro', 'договір закупівлі']
    },
    {
      nreg: '1023-12',
      lawNumber: '1023-XII',
      radaDokid: 16322,
      title: 'Закон України "Про захист прав споживачів"',
      normalizedPatterns: [
        'закон про захист прав споживачів',
        'права споживачів',
        'захист споживача',
        'повернення товару'
      ],
      category: 'цивільне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'CONSUMER-RIGHTS',
      storageLawFolderName: 'zu-consumer-protection',
      themeCode: 'CONSUMER-RIGHTS',
      keywords: ['споживач', 'гарантія', 'повернення']
    },
    {
      nreg: '393/96-ВР',
      lawNumber: '393/96-ВР',
      radaDokid: 30269,
      title: 'Закон України "Про звернення громадян"',
      normalizedPatterns: [
        'закон про звернення громадян',
        'законом про звернення громадян',
        'звернення громадян',
        'звернень громадян',
        'строки розгляду звернень',
        'скарга громадянина',
        'електронна петиція'
      ],
      category: 'конституційне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'CITIZEN-RIGHTS',
      storageLawFolderName: 'zu-citizen-appeals',
      themeCode: 'CITIZEN-RIGHTS',
      keywords: ['звернення', 'скарга', 'петиція', 'оскарження']
    },
    {
      nreg: '580-19',
      lawNumber: '580-VIII',
      radaDokid: 190361,
      title: 'Закон України "Про Національну поліцію"',
      normalizedPatterns: [
        'закон про національну поліцію',
        'національна поліція',
        'поліцейські повноваження',
        'патрульна поліція'
      ],
      category: 'правоохоронне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'LAW-ENFORCEMENT',
      storageLawFolderName: 'zu-national-police',
      themeCode: 'LAW-ENFORCEMENT',
      keywords: ['поліція', 'правопорядок', 'служба', 'повноваження поліції']
    },
    {
      nreg: '280/97-ВР',
      lawNumber: '280/97-ВР',
      radaDokid: 33209,
      title: 'Закон України "Про місцеве самоврядування в Україні"',
      normalizedPatterns: [
        'закон про місцеве самоврядування',
        'місцеве самоврядування',
        'органи місцевого самоврядування',
        'територіальна громада'
      ],
      category: 'місцеве самоврядування',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'LOCAL-GOV',
      storageLawFolderName: 'zu-local-self-government',
      themeCode: 'LOCAL-GOV',
      keywords: ['тергромада', 'міська рада', 'сільська рада', 'повноваження рад']
    },
    {
      nreg: '222-19',
      lawNumber: '222-VIII',
      radaDokid: 220584,
      title: 'Закон України "Про ліцензування видів господарської діяльності"',
      normalizedPatterns: [
        'закон про ліцензування',
        'ліцензування діяльності',
        'отримання ліцензії',
        'анулювання ліцензії'
      ],
      category: 'господарське',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'BUSINESS-REG',
      storageLawFolderName: 'zu-licensing',
      themeCode: 'BUSINESS-REG',
      keywords: ['ліцензія', 'господарська діяльність', 'дозвіл', 'контроль']
    },
    {
      nreg: '2011-12',
      lawNumber: '2011-XII',
      radaDokid: 5116,
      title: 'Закон України "Про соціальний і правовий захист військовослужбовців та членів їх сімей"',
      normalizedPatterns: [
        'закон про соціальний і правовий захист військовослужбовців',
        'соціальні гарантії військових',
        'захист військовослужбовців'
      ],
      category: 'соціальне',
      codexType: 'ЗУ',
      documentType: 'Закон',
      storageBucket: 'zu',
      storageCategoryPath: 'MILITARY-DEFENCE',
      storageLawFolderName: 'zu-military-social-protection',
      themeCode: 'MILITARY-DEFENCE',
      keywords: ['соціальні гарантії', 'військові', 'допомога сім\'ям', 'пільги']
    }
  ];

  private readonly RAW_LAW_THEME_CONFIGS: LawThemeConfig[] = [
    {
      code: 'MILITARY-DEFENCE',
      title: 'Військова безпека та оборона',
      description: 'Мобілізація, військові обов\'язки, захист військових та їх сімей',
      matchingPhrases: ['мобілізац', 'військов', 'бронь', 'резервіст', 'мобоблік'],
      categoryFallback: 'оборонне'
    },
    {
      code: 'GOV-SER-LAWS',
      title: 'Державна служба та антикорупція',
      description: 'Державна служба, обмеження, подарунки, конфлікт інтересів',
      matchingPhrases: ['держслужб', 'антикоруп', 'подарунк', 'конфлікт інтересів', 'посадова'],
      categoryFallback: 'антикорупційне'
    },
    {
      code: 'PROCUREMENT-TRANSPARENCY',
      title: 'Публічні закупівлі',
      description: 'Prozorro, тендери, договори закупівлі, оскарження',
      matchingPhrases: ['prozorro', 'тендер', 'закупівл', 'договір закупівлі'],
      categoryFallback: 'економічне'
    },
    {
      code: 'CONSUMER-RIGHTS',
      title: 'Захист прав споживачів',
      description: 'Повернення товарів, гарантія, обмін, штрафи для продавців',
      matchingPhrases: ['споживач', 'повернення товару', 'гарантія', 'обмін'],
      categoryFallback: 'цивільне'
    },
    {
      code: 'CITIZEN-RIGHTS',
      title: 'Звернення громадян',
      description: 'Скарги, заяви, петиції, строки розгляду звернень',
      matchingPhrases: ['звернення громадян', 'скарга', 'петиція', 'оскарження'],
      categoryFallback: 'конституційне'
    },
    {
      code: 'LAW-ENFORCEMENT',
      title: 'Правоохоронні органи',
      description: 'Поліція, повноваження, застосування сили, дисципліна',
      matchingPhrases: ['поліція', 'правопорядок', 'патрульна', 'поліцейськ'],
      categoryFallback: 'правоохоронне'
    },
    {
      code: 'LOCAL-GOV',
      title: 'Місцеве самоврядування',
      description: 'Повноваження рад, територіальні громади, виконкоми',
      matchingPhrases: ['територіальн', 'міська рада', 'сільська рада', 'громад'],
      categoryFallback: 'місцеве самоврядування'
    },
    {
      code: 'BUSINESS-REG',
      title: 'Бізнес-регулювання та ліцензії',
      description: 'Ліцензування, контроль, анулювання дозволів',
      matchingPhrases: ['ліцензія', 'дозвіл', 'контроль діяльності', 'анулювання'],
      categoryFallback: 'господарське'
    },
    {
      code: 'CIVIL-LAW',
      title: 'Цивільне право',
      description: 'Договори, власність, спадщина, відшкодування',
      matchingPhrases: ['договір', 'цивільн', 'власність', 'спадщ'],
      categoryFallback: 'цивільне'
    },
    {
      code: 'CRIMINAL-LAW',
      title: 'Кримінальне право',
      description: 'Злочини, покарання, кримінальна відповідальність',
      matchingPhrases: ['кримінал', 'злочин', 'кку', 'покарання'],
      categoryFallback: 'кримінальне'
    },
    {
      code: 'LABOR-LAW',
      title: 'Трудове право',
      description: 'Звільнення, відпустки, заробітна плата, трудові спори',
      matchingPhrases: ['трудов', 'звільнення', 'відпустк', 'роботодавець'],
      categoryFallback: 'трудове'
    },
    {
      code: 'GENERAL',
      title: 'Загальні питання',
      description: 'Інші питання без чіткої тематики',
      matchingPhrases: []
    }
  ];

  private readonly defaultThemeCode = 'GENERAL';

  private readonly categoryThemeFallback: Record<string, string> = {
    'оборонне': 'MILITARY-DEFENCE',
    'антикорупційне': 'GOV-SER-LAWS',
    'економічне': 'PROCUREMENT-TRANSPARENCY',
    'цивільне': 'CIVIL-LAW',
    'конституційне': 'CITIZEN-RIGHTS',
    'правоохоронне': 'LAW-ENFORCEMENT',
    'місцеве самоврядування': 'LOCAL-GOV',
    'господарське': 'BUSINESS-REG',
    'трудове': 'LABOR-LAW',
    'кримінальне': 'CRIMINAL-LAW'
  };

  private LAW_THEME_LOOKUP: Record<string, LawThemeConfig>;
  private radaApiToken: string | null = null;
  private radaTokenExpiresAt = 0;
  private async getRadaApiToken(): Promise<string | null> {
    if (this.radaApiToken && Date.now() < this.radaTokenExpiresAt) {
      return this.radaApiToken;
    }

    try {
      const resp = await fetch('https://data.rada.gov.ua/api/token', {
        headers: { 'User-Agent': 'OpenData' }
      });
      if (!resp.ok) {
        throw new Error(`Token response ${resp.status}`);
      }
      const data = await resp.json();
      this.radaApiToken = data?.token || null;
      const expiresIn = typeof data?.expire === 'number' ? data.expire : 600;
      this.radaTokenExpiresAt = Date.now() + expiresIn * 1000;
      return this.radaApiToken;
    } catch (error) {
      console.warn('⚠️ Failed to obtain Rada API token:', error);
      this.radaApiToken = null;
      this.radaTokenExpiresAt = 0;
      return null;
    }
  }

  private applyArticleStructureHints(
    classification: QuestionClassification,
    userMessage: string
  ): QuestionClassification {
    const structure = this.extractArticleStructure(userMessage);
    if (structure.articleNumber && !classification.articleNumber) {
      classification.articleNumber = structure.articleNumber;
    }
    classification.articlePart = structure.articlePart || classification.articlePart || null;
    classification.articlePoint = structure.articlePoint || classification.articlePoint || null;
    classification.articleSubPoint = structure.articleSubPoint || classification.articleSubPoint || null;
    return classification;
  }

  private extractArticleStructure(text: string): {
    articleNumber: string | null;
    articlePart: string | null;
    articlePoint: string | null;
    articleSubPoint: string | null;
  } {
    if (!text) {
      return { articleNumber: null, articlePart: null, articlePoint: null, articleSubPoint: null };
    }

    const normalizedText = text.replace(/\s+/g, ' ');

    const findMatch = (patterns: RegExp[]): string | null => {
      for (const pattern of patterns) {
        const match = pattern.exec(normalizedText);
        if (match && match[match.length - 1]) {
          return match[match.length - 1].trim();
        }
      }
      return null;
    };

    const articleRaw = findMatch([
      /статт(?:я|і|ю|ею|ях)\s*([0-9][0-9а-яa-z\-]*)/i,
      /ст\.?\s*([0-9][0-9а-яa-z\-]*)/i
    ]);
    const partRaw = findMatch([
      /частин(?:а|и|і|ою|у|ах)\s*([0-9а-яa-z\-]+)/i,
      /ч\.\s*([0-9а-яa-z\-]+)/i
    ]);
    const pointRaw = findMatch([
      /пункт(?:у|ом|а|і)?\s*([0-9а-яa-z\-]+)/i,
      /п\.\s*([0-9а-яa-z\-]+)/i
    ]);
    const subPointRaw = findMatch([
      /підпункт(?:у|ом|а|і)?\s*([0-9а-яa-z\-]+)/i,
      /пп\.\s*([0-9а-яa-z\-]+)/i
    ]);

    const articleNumber = articleRaw ? articleRaw.replace(/[.,;]/g, '').trim() : null;

    return {
      articleNumber: articleNumber || null,
      articlePart: this.normalizeArticleFragmentId(partRaw),
      articlePoint: this.normalizeArticleFragmentId(pointRaw),
      articleSubPoint: this.normalizeArticleFragmentId(subPointRaw)
    };
  }

  private normalizeArticleFragmentId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let value = raw.toString().toLowerCase();
    value = value.replace(/[,;:]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!value) return null;

    const digitMatch = value.match(/\d+[0-9a-z\-]*/);
    if (digitMatch) {
      return digitMatch[0];
    }

    const romanMatch = value.match(/\b[ivxlcdm]+\b/i);
    if (romanMatch) {
      const converted = this.romanToNumber(romanMatch[0]);
      if (converted !== null) {
        return converted.toString();
      }
    }

    const ordinalMap: Record<string, string> = {
      'перш': '1',
      'друг': '2',
      'трет': '3',
      'четверт': '4',
      'пят': '5',
      'шост': '6',
      'сьом': '7',
      'восьм': '8',
      'девят': '9',
      'десят': '10',
      'одинадц': '11',
      'дванадц': '12'
    };
    for (const [prefix, num] of Object.entries(ordinalMap)) {
      if (value.startsWith(prefix)) {
        return num;
      }
    }

    return value || null;
  }

  private romanToNumber(roman: string): number | null {
    if (!roman) return null;
    const map: Record<string, number> = {
      I: 1,
      V: 5,
      X: 10,
      L: 50,
      C: 100,
      D: 500,
      M: 1000
    };
    const chars = roman.toUpperCase().split('');
    let total = 0;
    let prev = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      const value = map[chars[i]] || 0;
      if (value < prev) {
        total -= value;
      } else {
        total += value;
        prev = value;
      }
    }
    return total > 0 ? total : null;
  }

  constructor() {
    this.LAW_THEME_LOOKUP = this.RAW_LAW_THEME_CONFIGS.reduce((acc, cfg) => {
      acc[cfg.code] = cfg;
      return acc;
    }, {} as Record<string, LawThemeConfig>);
  }

  private getThemeConfig(themeCode: string | null | undefined): LawThemeConfig | null {
    if (!themeCode) {
      return null;
    }
    return this.LAW_THEME_LOOKUP[themeCode.toUpperCase()] || null;
  }

  private normalizeSearchText(text: string | null | undefined): string {
    if (!text) {
      return '';
    }
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private findBestThemeMatch(text: string): string | null {
    const normalized = this.normalizeSearchText(text);
    if (!normalized) {
      return null;
    }

    let bestScore = 0;
    let bestTheme: string | null = null;

    for (const config of this.RAW_LAW_THEME_CONFIGS) {
      let score = 0;
      for (const phrase of config.matchingPhrases) {
        if (normalized.includes(phrase)) {
          score += phrase.length;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestTheme = config.code;
      }
    }

    return bestTheme;
  }

  private resolveThemeCode(params: {
    manualMatch?: ManualLawMapping | null;
    classification?: QuestionClassification | null;
    documentTitle?: string | null;
    documentCategory?: string | null;
    userMessage?: string | null;
  }): string {
    const manualTheme = params.manualMatch?.themeCode;
    if (manualTheme) {
      return manualTheme.toUpperCase();
    }

    const storedTheme = params.manualMatch?.storageCategoryPath?.toUpperCase();
    if (storedTheme && this.getThemeConfig(storedTheme)) {
      return storedTheme;
    }

    const corpus = [
      params.documentTitle,
      params.documentCategory,
      params.manualMatch?.title,
      params.manualMatch?.normalizedPatterns?.join(' '),
      params.classification?.requiredCodex,
      params.classification?.category,
      params.userMessage
    ]
      .filter(Boolean)
      .join(' ');

    const bestTheme = this.findBestThemeMatch(corpus);
    if (bestTheme) {
      return bestTheme;
    }

    const categoryKey = this.normalizeSearchText(
      params.documentCategory ||
      params.classification?.category ||
      params.manualMatch?.category
    );

    if (categoryKey && this.categoryThemeFallback[categoryKey]) {
      return this.categoryThemeFallback[categoryKey];
    }

    return this.defaultThemeCode;
  }

  private slugifySegment(text: string, fallback: string = 'law'): string {
    const normalized = this.normalizeSearchText(text);
    if (!normalized) {
      return fallback;
    }
    return normalized.replace(/\s+/g, '-');
  }

  private formatCategorySegment(category: string | null | undefined): string {
    if (!category) {
      return 'GENERAL';
    }
    return this.slugifySegment(category, 'general').toUpperCase();
  }

  private buildStorageFolder(
    manualMatch: ManualLawMapping,
    themeCode: string,
    documentTitle?: string | null,
    lawId?: string
  ): string {
    if (manualMatch.storageFolder) {
      return manualMatch.storageFolder.replace(/\/+$/, '');
    }

    const bucketPrefix = 'ZU/legal-laws';
    const categorySegment = this.formatCategorySegment(
      manualMatch.storageCategoryPath || themeCode || manualMatch.category
    );
    const lawSegment = manualMatch.storageLawFolderName
      ? this.slugifySegment(manualMatch.storageLawFolderName, lawId || 'law')
      : this.slugifySegment(documentTitle || manualMatch.title || lawId || 'law', lawId || 'law');

    return `${bucketPrefix}/${categorySegment}/${lawSegment}`;
  }

  private getManualLawMappingByTitle(title: string | null | undefined): ManualLawMapping | null {
    if (!title) {
      return null;
    }
    const normalizedTitle = this.normalizeSearchText(title);
    if (!normalizedTitle) {
      return null;
    }
    return this.manualLawMappings.find(mapping => {
      const normalizedMappingTitle = this.normalizeSearchText(mapping.title);
      if (normalizedTitle.includes(normalizedMappingTitle)) {
        return true;
      }
      return mapping.normalizedPatterns.some(pattern =>
        normalizedTitle.includes(this.normalizeSearchText(pattern))
      );
    }) || null;
  }

  getManualLawMappingByNreg(nreg: string | null | undefined): ManualLawMapping | null {
    if (!nreg) {
      return null;
    }
    return this.manualLawMappings.find(m => m.nreg === nreg) || null;
  }

  getManualWhitelistForRouter(): RouterWhitelistLaw[] {
    return this.manualLawMappings.map(mapping => ({
      nreg: mapping.nreg,
      title: mapping.title,
      branch: mapCategoryToBranch(mapping.category),
      category: mapping.category,
      keywords: mapping.keywords || [],
      themeCode: mapping.themeCode || null,
      storageBucket: mapping.storageBucket || 'zu',
      storagePath: null,
      source: 'manual' as const
    }));
  }

  private tokenizeNormalizedText(text: string): string[] {
    return text.split(' ').filter(Boolean);
  }

  private patternMatchScore(textTokens: string[], rawPattern: string): number {
    const normalizedPattern = this.normalizeSearchText(rawPattern);
    if (!normalizedPattern) {
      return 0;
    }
    const patternTokens = normalizedPattern
      .split(' ')
      .filter(token => token.length > 3);
    if (patternTokens.length === 0) {
      return 0;
    }
    const allMatched = patternTokens.every(pt =>
      textTokens.some(tt => tt.startsWith(pt) || pt.startsWith(tt))
    );
    return allMatched ? patternTokens.length : 0;
  }

  private buildLawSourceUrl(nreg: string | null | undefined): string | undefined {
    if (!nreg) {
      return undefined;
    }
    return `https://zakon.rada.gov.ua/laws/show/${encodeURIComponent(nreg)}`;
  }

  private buildStorageFileName(nreg: string, fallback?: string): string {
    const safe = nreg.replace(/[\\/]+/g, '-');
    return this.slugifySegment(safe, fallback || 'law').replace(/[^a-z0-9-]/g, '-');
  }

  buildSourceArticlesForDoc(
    doc: Document,
    relevantArticles: Article[],
    classification: QuestionClassification,
    maxArticles: number = 5
  ): string[] {
    const inlineArticles = Array.isArray(doc.articles) ? doc.articles : null;
    const hasInlineArticles = !!(inlineArticles && inlineArticles.length > 0);
    const dynamicLimit = this.determineSourceArticleLimit(classification, hasInlineArticles);
    const articleLimit = Math.max(dynamicLimit, maxArticles || 0);

    let collected: string[] | null = null;

    if (inlineArticles && inlineArticles.length > 0) {
      collected = inlineArticles
        .slice(0, articleLimit)
        .map((a: any) => String(a.number || a))
        .filter(Boolean);
    } else if (relevantArticles.length > 0) {
      collected = relevantArticles
        .slice(0, articleLimit)
        .map(article => String(article.number))
        .filter(Boolean);
    } else if (classification.articleNumber) {
      const structuredLabel = this.formatArticleReference(classification);
      return [structuredLabel || String(classification.articleNumber)];
    } else {
      return [];
    }

    if (!collected) {
      return [];
    }

    if (classification.articleNumber) {
      const structuredLabel = this.formatArticleReference(classification);
      if (structuredLabel) {
        collected = collected.map(value =>
          value === classification.articleNumber ? structuredLabel : value
        );
      }
    }

    return collected;
  }

  private determineSourceArticleLimit(
    classification: QuestionClassification,
    hasInlineArticles: boolean
  ): number {
    if (classification.articleNumber) {
      if (classification.articleSubPoint || classification.articlePoint) {
        return 2;
      }
      if (classification.articlePart) {
        return hasInlineArticles ? 6 : 4;
      }
      return hasInlineArticles ? 10 : 6;
    }
    if (classification.questionType === 'procedure' || classification.questionType === 'rights') {
      return hasInlineArticles ? 12 : 8;
    }
    if (classification.questionType === 'definition') {
      return hasInlineArticles ? 10 : 6;
    }
    return hasInlineArticles ? 8 : 5;
  }

  private formatArticleReference(classification: QuestionClassification): string | null {
    if (!classification.articleNumber) {
      return null;
    }
    const parts: string[] = [];
    if (classification.articlePart) {
      parts.push(`ч.${classification.articlePart}`);
    }
    if (classification.articlePoint) {
      parts.push(`п.${classification.articlePoint}`);
    }
    if (classification.articleSubPoint) {
      parts.push(`пп.${classification.articleSubPoint}`);
    }
    parts.push(`ст.${classification.articleNumber}`);
    return parts.join(' ');
  }

  async ensureManualLawAvailability(
    supabase: any,
    manualMatch: ManualLawMapping,
    classification: QuestionClassification,
    userMessage?: string | null
  ): Promise<Document | null> {
    const existing = await this.tryLoadStoredManualDocument(supabase, manualMatch, classification);
    if (existing) {
      return existing;
    }

    const fetched = await this.fetchLawFromRadaDirectly(
      supabase,
      manualMatch,
      classification,
      userMessage
    );
    if (fetched) {
      return fetched;
    }

    throw new Error(`manual law ${manualMatch.nreg} could not be fetched`);
  }

  async loadDocumentByNreg(
    supabase: any,
    nreg: string | null | undefined,
    classification: QuestionClassification
  ): Promise<Document | null> {
    if (!nreg) {
      return null;
    }

    const manualMatch = this.getManualLawMappingByNreg(nreg);
    if (manualMatch) {
      try {
        return await this.ensureManualLawAvailability(supabase, manualMatch, classification);
      } catch (error) {
        console.warn(`⚠️ Failed to load manual law by NREG ${nreg}:`, error);
      }
    }

    try {
      const { data, error } = await supabase
        .from('legal_documents_storage')
        .select('storage_bucket, storage_path, title, rada_nreg, law_number, category, source_url')
        .eq('rada_nreg', nreg)
        .eq('is_active', true)
        .maybeSingle();

      if (error || !data) {
        if (error) {
          console.warn(`⚠️ loadDocumentByNreg: metadata not found for ${nreg}:`, error);
        }
        return null;
      }

      return await this.loadDocumentFromStorageRecord(supabase, data, classification);
    } catch (error) {
      console.error(`❌ loadDocumentByNreg: unexpected error for ${nreg}:`, error);
      return null;
    }
  }

  private async tryLoadStoredManualDocument(
    supabase: any,
    manualMatch: ManualLawMapping,
    classification: QuestionClassification
  ): Promise<Document | null> {
    const themeCode = this.resolveThemeCode({
      manualMatch,
      classification,
      documentTitle: manualMatch.title,
      documentCategory: manualMatch.category
    });

    const folder = this.buildStorageFolder(
      manualMatch,
      themeCode,
      manualMatch.title,
      manualMatch.nreg
    );

    const bucketCandidates = Array.from(
      new Set([manualMatch.storageBucket || 'zu', 'zu', 'legal-documents'])
    );
    const safeName = this.buildStorageFileName(manualMatch.nreg, manualMatch.nreg);
    const legacyName = manualMatch.nreg;
    const legacyLower = manualMatch.nreg.toLowerCase();
    const pathCandidates = Array.from(
      new Set([
        `${folder}/${safeName}.json`,
        `${folder}/${legacyName}.json`,
        `${folder}/${legacyLower}.json`,
        manualMatch.storageFolder
          ? `${manualMatch.storageFolder.replace(/\/+$/, '')}/${safeName}.json`
          : null
      ].filter(Boolean))
    ) as string[];

    for (const bucket of bucketCandidates) {
      for (const path of pathCandidates) {
        try {
          const { data, error } = await supabase.storage.from(bucket).download(path);
          if (error || !data) {
            continue;
          }
          const parsedDocument = await this.parseStoredDocumentPayload(
            data,
            manualMatch,
            classification
          );
          if (parsedDocument) {
            console.log(`✅ Loaded manual law "${manualMatch.title}" from bucket=${bucket}, path=${path}`);
            return parsedDocument;
          }
        } catch (downloadError) {
          console.warn(`⚠️ Failed to load ${path} from bucket ${bucket}:`, downloadError);
        }
      }
    }

    return null;
  }

  private async parseStoredDocumentPayload(
    fileData: Blob,
    manualMatch: ManualLawMapping | null,
    classification: QuestionClassification,
    fallbackTitle?: string | null
  ): Promise<Document | null> {
    try {
      const text = await fileData.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch (jsonError) {
        console.warn('Stored document is not JSON, using raw text:', jsonError);
      }

      const content = parsed?.content || text;
      let articles: Article[] | null = null;

      if (Array.isArray(parsed?.articles)) {
        articles = parsed.articles;
      } else if (parsed?.jsonData?.stru) {
        articles = this.extractArticlesFromStru(parsed.jsonData.stru);
      } else if (typeof parsed?.articles === 'string') {
        try {
          const parsedArticles = JSON.parse(parsed.articles);
          if (Array.isArray(parsedArticles)) {
            articles = parsedArticles;
          }
        } catch {
          // ignore
        }
      }

      if (!articles || articles.length === 0) {
        const fallbackLawId = manualMatch?.lawNumber || manualMatch?.nreg || fallbackTitle || '';
        articles = this.parseArticlesFromText(content, fallbackLawId);
      }

      if (classification.articleNumber && articles?.length) {
        const target = String(classification.articleNumber).trim();
        articles = articles.filter(article => {
          const num = String(article.number).trim();
          return (
            num === target ||
            num === `ст. ${target}` ||
            num === `Стаття ${target}` ||
            num.replace(/[^0-9]/g, '') === target.replace(/[^0-9]/g, '')
          );
        });
      }

      const metadata = parsed?.metadata || {};
      const inferredNreg = metadata.rada_nreg || manualMatch?.nreg || metadata.law_number;
      const inferredTitle = metadata.title || manualMatch?.title || fallbackTitle || 'Документ';
      const inferredLawNumber =
        metadata.law_number || manualMatch?.lawNumber || manualMatch?.nreg || inferredNreg;
      const inferredCategory =
        metadata.category || manualMatch?.category || classification.category || 'Інше';

      const document: Document = {
        id: metadata.id || inferredNreg || inferredLawNumber || crypto.randomUUID(),
        title: inferredTitle,
        content,
        law_number: inferredLawNumber,
        rada_nreg: inferredNreg || inferredLawNumber,
        category: inferredCategory,
        source_url:
          metadata.source_url ||
          this.buildLawSourceUrl(manualMatch?.nreg || inferredNreg || inferredLawNumber),
        articles: articles || undefined
      };

      return document;
    } catch (error) {
      console.error('❌ Failed to parse stored document payload:', error);
      return null;
    }
  }

  private async fetchLawFromRadaDirectly(
    supabase: any,
    manualMatch: ManualLawMapping,
    classification: QuestionClassification,
    userMessage?: string | null
  ): Promise<Document | null> {
    try {
      console.log(`🌐 Fetching law from Rada API: ${manualMatch.nreg} (${manualMatch.title})`);
      const baseUrl = 'https://data.rada.gov.ua/laws/show';
      const encodedId = encodeURIComponent(manualMatch.nreg);
      const jsonUrl = `${baseUrl}/${encodedId}.json`;
      const txtUrl = `${baseUrl}/${encodedId}.txt`;
      const token = await this.getRadaApiToken();
      const baseHeaders: Record<string, string> = {
        'User-Agent': 'OpenData'
      };
      if (token) {
        baseHeaders['Authorization'] = `Bearer ${token}`;
      }

      const [jsonResp, txtResp] = await Promise.allSettled([
        fetch(jsonUrl, {
          headers: {
            ...baseHeaders,
            Accept: 'application/json'
          }
        }),
        fetch(txtUrl, {
          headers: {
            ...baseHeaders,
            Accept: 'text/plain'
          }
        })
      ]);

      let jsonData: any = null;
      if (jsonResp.status === 'fulfilled' && jsonResp.value.ok) {
        try {
          jsonData = await jsonResp.value.json();
        } catch (jsonError) {
          console.warn('⚠️ Failed to parse JSON from Rada API:', jsonError);
        }
      }

      let content = '';
      if (txtResp.status === 'fulfilled' && txtResp.value.ok) {
        content = await txtResp.value.text();
      } else if (jsonData?.text) {
        content = jsonData.text;
      } else if (jsonData?.content) {
        content = jsonData.content;
      }

      if (!content) {
        console.warn(`⚠️ No content fetched for ${manualMatch.nreg}`);
        content = jsonData ? JSON.stringify(jsonData) : '';
      }

      let articles: Article[] | null = null;
      if (jsonData?.stru) {
        articles = this.extractArticlesFromStru(jsonData.stru);
      }
      if (!articles || articles.length === 0) {
        articles = this.parseArticlesFromText(content, manualMatch.nreg);
      }

      const extractedTitle =
        jsonData?.meta?.doc?.title ||
        jsonData?.metadata?.nazva ||
        jsonData?.title ||
        manualMatch.title;

      const document: Document = {
        id: manualMatch.nreg,
        title: extractedTitle,
        content,
        law_number: jsonData?.metadata?.nreg || manualMatch.lawNumber || manualMatch.nreg,
        rada_nreg: manualMatch.nreg,
        category: manualMatch.category || classification.category || 'Інше',
        source_url: this.buildLawSourceUrl(manualMatch.nreg),
        articles: articles || undefined
      };

      await this.persistManualDocumentToStorage(supabase, {
        document,
        manualMatch,
        jsonStructure: jsonData,
        parsedArticles: articles,
        classification,
        userMessage
      });

      return document;
    } catch (error) {
      console.error(`❌ Failed to fetch law ${manualMatch.nreg} from Rada:`, error);
      throw (error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async persistManualDocumentToStorage(
    supabase: any,
    options: {
      document: Document;
      manualMatch: ManualLawMapping;
      jsonStructure?: any;
      parsedArticles?: Article[] | null;
      classification?: QuestionClassification | null;
      userMessage?: string | null;
    }
  ): Promise<void> {
    const themeCode = this.resolveThemeCode({
      manualMatch: options.manualMatch,
      classification: options.classification || null,
      documentTitle: options.document.title,
      documentCategory: options.document.category,
      userMessage: options.userMessage
    }).toUpperCase();

    const bucket = options.manualMatch.storageBucket || 'zu';
    const storageFolder = this.buildStorageFolder(
      options.manualMatch,
      themeCode,
      options.document.title,
      options.manualMatch.nreg
    );
    const fileName = this.buildStorageFileName(options.manualMatch.nreg, options.manualMatch.nreg);
    const storagePath = `${storageFolder}/${fileName}.json`;

    const payload = JSON.stringify({
      content: options.document.content,
      articles: options.document.articles || options.parsedArticles || [],
      jsonData: options.jsonStructure || null,
      metadata: {
        law_number: options.document.law_number,
        title: options.document.title,
        rada_nreg: options.manualMatch.nreg,
        category: options.document.category,
        theme_code: themeCode,
        synced_at: new Date().toISOString()
      }
    });

    await this.ensureBucketExists(supabase, bucket);

    const upload = await supabase.storage.from(bucket).upload(storagePath, payload, {
      contentType: 'application/json',
      upsert: true
    });

    if (upload?.error) {
      console.error(`❌ Failed to upload law ${options.manualMatch.nreg} to bucket ${bucket}:`, upload.error);
      throw upload.error;
    }

    const fileSize = new TextEncoder().encode(payload).length;
    const articlesCount = Array.isArray(options.document.articles)
      ? options.document.articles.length
      : options.parsedArticles?.length || 0;

    const keywords = Array.from(
      new Set([
        ...(options.manualMatch.keywords || []),
        ...(options.manualMatch.normalizedPatterns || []),
        themeCode
      ])
    ).filter(Boolean);

    const metadataRecord = {
      rada_dokid: options.manualMatch.radaDokid || null,
      rada_nreg: options.manualMatch.nreg,
      title: options.document.title,
      law_number: options.document.law_number,
      document_type: options.manualMatch.documentType || 'Закон',
      codex_type: options.manualMatch.codexType || null,
      is_procedural: options.manualMatch.isProcedural ?? false,
      storage_path: storagePath,
      storage_bucket: bucket,
      category: options.document.category,
      theme_code: themeCode,
      keywords: JSON.stringify(keywords),
      file_size: fileSize,
      articles_count: articlesCount,
      last_synced_at: new Date().toISOString(),
      sync_status: 'synced',
      sync_error: null,
      is_active: true,
      source_url: options.document.source_url,
      updated_at: new Date().toISOString()
    };

    const { error: metadataError } = await supabase
      .from('legal_documents_storage')
      .upsert(metadataRecord, { onConflict: 'rada_nreg' });

    if (metadataError) {
      console.error(`❌ Failed to upsert metadata for ${options.manualMatch.nreg}:`, metadataError);
    }

    await this.removeLegacyLawCopies(supabase, options.manualMatch.nreg, bucket, storagePath);
  }

  private async removeLegacyLawCopies(
    supabase: any,
    nreg: string,
    currentBucket: string,
    currentPath: string
  ): Promise<void> {
    const buckets = ['legal-documents', 'legal-documents-legacy', 'zu'];
    for (const bucket of buckets) {
      if (bucket === currentBucket) {
        continue;
      }
      const candidatePaths = [
        currentPath,
        currentPath.replace(/ZU\/legal-laws\//, ''),
        `${nreg}.json`
      ];
      for (const path of candidatePaths) {
        try {
          await supabase.storage.from(bucket).remove([path]);
        } catch (error) {
          // ignore errors for legacy buckets
        }
      }
    }
  }

  private async ensureBucketExists(supabase: any, bucket: string): Promise<void> {
    try {
      await supabase.storage.createBucket(bucket, { public: false });
    } catch (error: any) {
      const message = error?.message || '';
      if (
        message.includes('already exists') ||
        message.includes('duplicate key') ||
        error?.status === 409
      ) {
        return;
      }
      console.warn(`⚠️ Failed to create bucket ${bucket}:`, error);
    }
  }

  private buildSoftSearchSignals(
    classification: QuestionClassification,
    manualMatch: ManualLawMapping | null,
    userMessage?: string | null
  ): SoftSearchSignals {
    const tokens = new Set<string>();

    const baseKeywords = classification.searchKeywords || [];
    baseKeywords.forEach(keyword => {
      this.expandKeywordVariants(keyword).forEach(variant => tokens.add(variant));
    });

    if (userMessage) {
      this.extractMeaningfulTokens(userMessage).forEach(token => tokens.add(token));
    }

    if (manualMatch) {
      (manualMatch.normalizedPatterns || []).forEach(pattern => {
        this.extractMeaningfulTokens(pattern).forEach(token => tokens.add(token));
      });
      (manualMatch.keywords || []).forEach(keyword => {
        this.expandKeywordVariants(keyword).forEach(variant => tokens.add(variant));
      });
    }

    const themeCode = manualMatch
      ? manualMatch.themeCode || null
      : this.resolveThemeCode({
          manualMatch,
          classification,
          userMessage
        });

    return {
      tokens: Array.from(tokens).filter(Boolean).slice(0, 20),
      manualMatch,
      themeCode
    };
  }

  private extractMeaningfulTokens(text: string): string[] {
    const stopWords = new Set([
      'що', 'як', 'чому', 'де', 'коли', 'який', 'яка', 'чи', 'або', 'але', 'і', 'та',
      'для', 'від', 'про', 'між', 'без', 'під', 'над', 'у', 'в', 'на', 'з', 'до'
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-zа-яіїєґ0-9\s]/giu, ' ')
      .split(/\s+/)
      .filter(token => token.length > 3 && !stopWords.has(token))
      .slice(0, 20);
  }

  private expandKeywordVariants(keyword: string): string[] {
    const normalized = this.normalizeSearchText(keyword);
    if (!normalized) {
      return [];
    }
    const variants = new Set<string>();
    variants.add(normalized);
    variants.add(normalized.replace(/ії/g, 'і'));
    variants.add(normalized.replace(/’/g, "'"));
    variants.add(normalized.replace(/-/g, ' '));
    return Array.from(variants).filter(Boolean);
  }

  private async loadDocumentFromStorageRecord(
    supabase: any,
    record: {
      storage_bucket?: string | null;
      storage_path?: string | null;
      title?: string | null;
      rada_nreg?: string | null;
      law_number?: string | null;
      category?: string | null;
      source_url?: string | null;
    },
    classification: QuestionClassification
  ): Promise<Document | null> {
    if (!record.storage_path) {
      return null;
    }
    const bucket = record.storage_bucket || 'zu';
    try {
      const { data, error } = await supabase.storage.from(bucket).download(record.storage_path);
      if (error || !data) {
        return null;
      }
      const manualMatch = record.rada_nreg ? this.getManualLawMappingByNreg(record.rada_nreg) : null;
      const parsed = await this.parseStoredDocumentPayload(
        data,
        manualMatch,
        classification,
        record.title || null
      );
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      console.warn(`⚠️ Failed to download ${record.storage_path} from ${bucket}:`, error);
    }

    if (record.title || record.rada_nreg) {
      return {
        id: record.rada_nreg || crypto.randomUUID(),
        title: record.title || 'Документ',
        content: '',
        law_number: record.law_number || record.rada_nreg || '',
        rada_nreg: record.rada_nreg || undefined,
        category: record.category || classification.category,
        source_url: record.source_url || undefined,
        articles: []
      };
    }

    return null;
  }

  private async softSearchStorageBySignals(
    supabase: any,
    signals: SoftSearchSignals,
    classification: QuestionClassification,
    limit: number
  ): Promise<Document[]> {
    if (!signals.tokens.length) {
      return [];
    }

    const clauses: string[] = [];
    signals.tokens.slice(0, 12).forEach(token => {
      const pattern = `%${token}%`;
      clauses.push(`title.ilike.${pattern}`);
      clauses.push(`keywords.ilike.${pattern}`);
      clauses.push(`category.ilike.${pattern}`);
    });
    if (signals.manualMatch?.nreg) {
      clauses.push(`rada_nreg.eq.${signals.manualMatch.nreg}`);
    }
    if (signals.themeCode) {
      clauses.push(`theme_code.eq.${signals.themeCode}`);
    }

    if (!clauses.length) {
      return [];
    }

    const { data, error } = await supabase
      .from('legal_documents_storage')
      .select('storage_bucket, storage_path, title, rada_nreg, law_number, category, source_url')
      .eq('is_active', true)
      .limit(limit * 2)
      .or(clauses.join(','));

    if (error || !data) {
      if (error) {
        console.warn('⚠️ softSearchStorageBySignals failed:', error);
      }
      return [];
    }

    const documents: Document[] = [];
    for (const record of data) {
      const doc = await this.loadDocumentFromStorageRecord(supabase, record, classification);
      if (doc) {
        documents.push(doc);
      }
      if (documents.length >= limit) {
        break;
      }
    }

    return documents;
  }

  detectManualLawTarget(
    userMessage: string,
    classification?: QuestionClassification | null
  ): ManualLawMapping | null {
    const normalized = this.normalizeSearchText(userMessage);
    if (!normalized) {
      return null;
    }
    if (classification?.requiredCodex) {
      const directCodexMatch = this.getManualLawMappingByTitle(classification.requiredCodex);
      console.log(`[manual-detect] requiredCodex=${classification.requiredCodex} match=${directCodexMatch?.nreg || 'none'}`);
      if (directCodexMatch) {
        return directCodexMatch;
      }
    }
    const textTokens = this.tokenizeNormalizedText(normalized);
    const keywordSet = classification?.searchKeywords
      ? new Set(
          classification.searchKeywords
            .map(k => this.normalizeSearchText(k))
            .filter(Boolean)
        )
      : new Set<string>();

    let bestMatch: ManualLawMapping | null = null;
    let bestScore = 0;

    for (const mapping of this.manualLawMappings) {
      let score = 0;
      for (const pattern of mapping.normalizedPatterns) {
        score = Math.max(score, this.patternMatchScore(textTokens, pattern));
      }
      score = Math.max(score, this.patternMatchScore(textTokens, mapping.title));

      if (score > 0 && keywordSet.size > 0) {
        const keywordBonus =
          (mapping.keywords || []).reduce((acc, keyword) => {
            const normalizedKeyword = this.normalizeSearchText(keyword);
            return acc + (normalizedKeyword && keywordSet.has(normalizedKeyword) ? 0.5 : 0);
          }, 0);
        score += keywordBonus;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = mapping;
      }
    }

    if (bestMatch && bestScore > 0) {
      return bestMatch;
    }

    // 2. Перевірка за ключовими словами класифікації (fallback)
    if (keywordSet.size > 0) {
      const keywordMatch = this.manualLawMappings.find(mapping =>
        (mapping.keywords || []).some(keyword =>
          keywordSet.has(this.normalizeSearchText(keyword))
        )
      );
      if (keywordMatch) {
        return keywordMatch;
      }
    }

    return null;
  }

  enrichClassificationWithManualMatch(
    classification: QuestionClassification,
    manualMatch: ManualLawMapping,
    userMessage?: string | null
  ): QuestionClassification {
    const updated: QuestionClassification = { ...classification };
    updated.requiredCodex = manualMatch.title;
    if (manualMatch.category) {
      updated.category = manualMatch.category;
    }

    const keywordSource: string[] = [
      manualMatch.title,
      manualMatch.nreg,
      manualMatch.category,
      ...(manualMatch.keywords || [])
    ].filter(Boolean) as string[];

    if (userMessage) {
      keywordSource.push(...this.extractKeywords(userMessage));
    }

    const existing = new Set(updated.searchKeywords || []);
    keywordSource.forEach(keyword => {
      const normalized = this.normalizeSearchText(keyword);
      if (normalized) {
        existing.add(normalized);
      }
    });
    updated.searchKeywords = Array.from(existing);
    return updated;
  }

  // Багатоетапна класифікація питання
  async classifyQuestionMultiStage(
    openai: OpenAI,
    userMessage: string,
    conversationHistory: any[] = []
  ): Promise<QuestionClassification> {
    // Етап 1: Швидка перевірка чи це юридичне питання
    const isLegal = await this.quickLegalCheck(openai, userMessage, conversationHistory);
    
    if (!isLegal) {
      return {
        isLegalQuestion: false,
        confidence: 0.3,
        requiredCodex: null,
        articleNumber: null,
        articlePart: null,
        articlePoint: null,
        articleSubPoint: null,
        searchKeywords: [],
        questionType: 'general',
        category: 'загальне'
      };
    }

    // Етап 2: Детальна класифікація
    const detailed = await this.classifyQuestion(openai, userMessage);
    
    // Етап 3: Валідація класифікації
    const validated = this.validateClassification(detailed, userMessage);
    
    return validated;
  }

  // Швидка перевірка чи це юридичне питання
  private async quickLegalCheck(
    openai: OpenAI,
    userMessage: string,
    conversationHistory: any[]
  ): Promise<boolean> {
    // Аналізуємо контекст розмови
    const context = conversationHistory
      .slice(-3)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = `Визначи чи це юридичне питання про українське право.

${context ? `Контекст розмови:\n${context}\n\n` : ''}Питання: "${userMessage}"

Відповісти ТІЛЬКИ "true" або "false" без додаткових символів.`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Ти експерт з визначення юридичних питань. Відповідай ТІЛЬКИ "true" або "false".' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 10
      });

      const response = completion.choices[0]?.message?.content?.trim().toLowerCase();
      return response === 'true';
    } catch (error) {
      console.error('Quick legal check failed:', error);
      // Fallback на просту перевірку
      const legalKeywords = ['закон', 'кодекс', 'стаття', 'право', 'суд', 'відповідальність', 'порушення', 'договір'];
      return legalKeywords.some(keyword => userMessage.toLowerCase().includes(keyword));
    }
  }

  // Валідація класифікації
  private validateClassification(
    classification: QuestionClassification,
    userMessage: string
  ): QuestionClassification {
    // Перевірка логічності
    if (classification.isLegalQuestion && classification.confidence < 0.5) {
      // Якщо низька впевненість - знижуємо confidence
      classification.confidence = Math.max(0.3, classification.confidence - 0.2);
    }

    // Перевірка чи кодекс відповідає категорії
    if (classification.requiredCodex && classification.category) {
      const codexInfo = this.getCodexInfo(classification.requiredCodex);
      if (codexInfo && codexInfo.category !== classification.category) {
        // Виправляємо категорію
        classification.category = codexInfo.category;
      }
    }

    // Перевірка чи є ключові слова
    if (classification.searchKeywords.length === 0 && classification.isLegalQuestion) {
      // Додаємо ключові слова з fallback
      classification.searchKeywords = this.extractKeywords(userMessage.toLowerCase());
    }

    return this.applyArticleStructureHints(classification, userMessage);
  }

  // Маппінг конкретних злочинів на статті ККУ
  private getCrimeArticleMapping(userMessage: string): { codex: string; article: string } | null {
    const lowerMessage = userMessage.toLowerCase();
    
    // Маппінг злочинів на статті ККУ
    const crimeMappings: { [key: string]: { codex: string; article: string } } = {
      'умисне вбивство': { codex: 'ККУ', article: '115' },
      'вбивство': { codex: 'ККУ', article: '115' },
      'убивство': { codex: 'ККУ', article: '115' },
      'умисне убивство': { codex: 'ККУ', article: '115' },
      'крадіжка': { codex: 'ККУ', article: '185' },
      'викрадення': { codex: 'ККУ', article: '185' },
      'шахрайство': { codex: 'ККУ', article: '190' },
      'розбій': { codex: 'ККУ', article: '187' },
      'грабіж': { codex: 'ККУ', article: '186' },
      'вимагання': { codex: 'ККУ', article: '189' },
      'хуліганство': { codex: 'ККУ', article: '296' },
    };
    
    for (const [crime, mapping] of Object.entries(crimeMappings)) {
      if (lowerMessage.includes(crime)) {
        console.log(`🎯 Detected crime "${crime}" → ${mapping.codex} ст. ${mapping.article}`);
        return mapping;
      }
    }
    
    return null;
  }

  // Інтелектуальна класифікація питання через GPT-3.5-turbo
  async classifyQuestion(openai: OpenAI, userMessage: string): Promise<QuestionClassification> {
    try {
      // Спочатку перевіряємо маппінг злочинів
      const crimeMapping = this.getCrimeArticleMapping(userMessage);
      
      const classificationPrompt = `Ти - провідний експерт з класифікації юридичних питань українського права з 20+ роками досвіду.

ПИТАННЯ КОРИСТУВАЧА: "${userMessage}"

ТВОЄ ЗАВДАННЯ: ТОЧНО визначити:
1. Чи це юридичне питання про українське право?
2. Який саме КОДЕКС або ЗАКОН потрібен?
3. Яка СТАТТЯ (якщо згадується)?
4. Які ключові слова для пошуку?
5. Чи йдеться про конкретну ЧАСТИНУ, ПУНКТ або ПІДПУНКТ статті (наприклад, "ч. 2 ст. 65", "п. 4 ч. 2 ст. 65", "пп. 1 п. 3 ч. 5 ст. 10")?

ДОСТУПНІ КОДЕКСИ ТА КОЛИ ЇХ ВИКОРИСТОВУВАТИ:

🔴 ККУ (Кримінальний кодекс України):
   - Вбивство, крадіжка, шахрайство, злочини
   - Покарання за злочини
   - Кримінальна відповідальність
   - Приклади: "що буде за вбивство", "покарання за крадіжку", "ст. 115"

🟢 ЦК (Цивільний кодекс України):
   - Договори (купівля-продаж, оренда, позика)
   - Власність, спадщина
   - Відшкодування шкоди
   - Приклади: "як оформити договір", "права власника", "спадкування"

🟡 ТК (Трудовий кодекс України):
   - Робота, зарплата, відпустка
   - Звільнення, трудовий договір
   - Права працівника
   - Приклади: "права при звільненні", "трудовий договір", "відпустка"

🔵 СК (Сімейний кодекс України):
   - Шлюб, розлучення
   - Аліменти, діти
   - Сімейні відносини
   - Приклади: "як розлучитися", "аліменти", "права батьків"

🟠 КУпАП (Кодекс про адміністративні правопорушення):
   - Штрафи, порушення
   - Адміністративна відповідальність
   - Приклади: "штраф за швидкість", "адміністративне порушення"

⚪ Конституція України:
   - Права людини
   - Державність
   - Приклади: "права громадянина", "конституційні права"

🟣 ПК (Податковий кодекс України):
   - Податки, ПДВ
   - Податкова відповідальність
   - Приклади: "податок на прибуток", "ПДВ"

🟤 ЗК (Земельний кодекс України):
   - Земля, ділянки
   - Права на землю
   - Приклади: "права на землю", "оформлення ділянки"

ВАЖЛИВО:
- Якщо згадується конкретна стаття (напр. "стаття 115") - обов'язково вкажи articleNumber
- Якщо згадується кодекс (напр. "кримінальний кодекс") - обов'язково вкажи requiredCodex
- Використовуй ключові слова з питання для searchKeywords
- Якщо НЕ юридичне питання - isLegalQuestion: false

ВАЖЛИВО - МАППІНГ КОНКРЕТНИХ ЗЛОЧИНІВ НА СТАТТІ:
- "умисне вбивство", "вбивство", "убивство" → requiredCodex: "ККУ", articleNumber: "115"
- "крадіжка", "викрадення" → requiredCodex: "ККУ", articleNumber: "185"
- "шахрайство" → requiredCodex: "ККУ", articleNumber: "190"
- "розбій" → requiredCodex: "ККУ", articleNumber: "187"
- "грабіж" → requiredCodex: "ККУ", articleNumber: "186"

ПРИКЛАДИ:
- "що буде за умисне вбивство" → isLegalQuestion: true, requiredCodex: "ККУ", articleNumber: "115", questionType: "punishment", searchKeywords: ["вбивство", "умисне", "покарання"]
- "що передбачає стаття 115 кримінального кодексу" → isLegalQuestion: true, requiredCodex: "ККУ", articleNumber: "115", questionType: "definition"
- "як оформити договір купівлі-продажу нерухомості" → isLegalQuestion: true, requiredCodex: "ЦК", questionType: "procedure", searchKeywords: ["договір", "купівля", "продаж", "нерухомість"]
- "які права має працівник при звільненні" → isLegalQuestion: true, requiredCodex: "ТК", questionType: "rights", searchKeywords: ["права", "працівник", "звільнення"]
- "яка сьогодні погода" → isLegalQuestion: false

ВІДПОВІСТИ ТІЛЬКИ JSON БЕЗ ДОДАТКОВИХ СИМВОЛІВ:
{
  "isLegalQuestion": boolean,
  "confidence": number (0-1),
  "requiredCodex": string | null (один з: "ККУ", "ЦК", "ТК", "СК", "КУпАП", "Конституція", "ПК", "ЗК" або null),
  "articleNumber": string | null (номер статті якщо згадується, наприклад "115"),
  "articlePart": string | null (наприклад "2" якщо згадано "ч. 2", інакше null),
  "articlePoint": string | null (наприклад "4" якщо згадано "п. 4", інакше null),
  "articleSubPoint": string | null (наприклад "1" якщо згадано "пп. 1", інакше null),
  "searchKeywords": string[] (ключові слова для пошуку),
  "questionType": "punishment" | "rights" | "procedure" | "definition" | "general",
  "category": string (один з: "кримінальне", "цивільне", "трудове", "сімейне", "адміністративне", "конституційне", "податкове", "земельне", "митне" або "загальне")
}`;

      let completion;
      try {
        // Спробуємо з response_format (працює з новішими версіями)
        completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Ти експерт з класифікації юридичних питань. Відповідай ТІЛЬКИ валідним JSON без додаткових символів. Формат: {"isLegalQuestion": true/false, "confidence": 0.0-1.0, "requiredCodex": "ККУ"|null, "articleNumber": "115"|null, "articlePart": "2"|null, "articlePoint": "4"|null, "articleSubPoint": "1"|null, "searchKeywords": ["слово1"], "questionType": "punishment"|"rights"|"procedure"|"definition"|"general", "category": "кримінальне"|"цивільне"|...}' },
            { role: 'user', content: classificationPrompt }
          ],
          temperature: 0.3,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        });
      } catch (formatError) {
        // Якщо response_format не підтримується, використовуємо без нього
        console.warn('response_format not supported, using fallback');
        completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Ти експерт з класифікації юридичних питань. Відповідай ТІЛЬКИ валідним JSON без додаткових символів. Якщо в питанні згадано частину/пункт/підпункт статті, включи поля "articlePart", "articlePoint", "articleSubPoint".' },
            { role: 'user', content: classificationPrompt }
          ],
          temperature: 0.3,
          max_tokens: 200
        });
      }

      let responseText = completion.choices[0]?.message?.content || '{}';
      
      // Очищаємо від можливих markdown кодових блоків
      responseText = responseText.trim();
      if (responseText.startsWith('```json')) {
        responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      let classification: QuestionClassification;
      try {
        classification = JSON.parse(responseText) as QuestionClassification;
      } catch (parseError) {
        console.error('Failed to parse classification JSON:', responseText);
        throw new Error(`Invalid JSON response: ${responseText.substring(0, 100)}`);
      }
      
      // Якщо є маппінг злочину - застосовуємо його (перезаписуємо GPT)
      if (crimeMapping) {
        classification.requiredCodex = crimeMapping.codex;
        classification.articleNumber = crimeMapping.article;
        classification.confidence = Math.max(classification.confidence || 0.7, 0.95);
        classification.isLegalQuestion = true;
        classification.category = 'кримінальне';
        console.log(`✅ Applied crime mapping: ${crimeMapping.codex} ст. ${crimeMapping.article}`);
      }
      
      // Валідація обов'язкових полів
      if (typeof classification.isLegalQuestion !== 'boolean') {
        classification.isLegalQuestion = false;
      }
      if (typeof classification.confidence !== 'number') {
        classification.confidence = classification.isLegalQuestion ? 0.7 : 0.3;
      }
      if (!Array.isArray(classification.searchKeywords)) {
        classification.searchKeywords = [];
      }
      classification.articlePart = classification.articlePart || null;
      classification.articlePoint = classification.articlePoint || null;
      classification.articleSubPoint = classification.articleSubPoint || null;

      console.log('Question classified:', classification);

      return classification;
    } catch (error) {
      console.error('Error classifying question:', error);
      // Fallback на просту класифікацію
      return this.fallbackClassification(userMessage);
    }
  }

  // Fallback класифікація (якщо GPT не працює)
  fallbackClassification(userMessage: string): QuestionClassification {
    const lowerMessage = userMessage.toLowerCase();
    
    // Спочатку перевіряємо маппінг злочинів
    const crimeMapping = this.getCrimeArticleMapping(userMessage);
    
    const detectedCodex = this.detectSpecificCodex(lowerMessage);
    const articleMatch = lowerMessage.match(/стаття\s+(\d+)/i);
    
    // Визначення категорії
    let category = 'загальне';
    let requiredCodex: string | null = null;
    let articleNumber: string | null = null;
    let questionType: QuestionClassification['questionType'] = 'general';
    
    // Якщо є маппінг злочину - використовуємо його
    if (crimeMapping) {
      requiredCodex = crimeMapping.codex;
      articleNumber = crimeMapping.article;
      category = 'кримінальне';
      questionType = 'punishment';
    } else if (detectedCodex) {
      requiredCodex = detectedCodex.fullName;
      category = detectedCodex.category;
    } else {
      // Перевірка за ключовими словами
      if (lowerMessage.includes('вбивство') || lowerMessage.includes('крадіжка') || lowerMessage.includes('злочин')) {
        requiredCodex = 'Кримінальний кодекс України';
        category = 'кримінальне';
        questionType = 'punishment';
      } else if (lowerMessage.includes('договір') || lowerMessage.includes('власність')) {
        requiredCodex = 'Цивільний кодекс України';
        category = 'цивільне';
        questionType = 'procedure';
      } else if (lowerMessage.includes('робота') || lowerMessage.includes('працівник')) {
        requiredCodex = 'Трудовий кодекс України';
        category = 'трудове';
        questionType = 'rights';
      }
    }

    // Витягування статті з питання (якщо не встановлено через маппінг)
    if (!articleNumber && articleMatch) {
      articleNumber = articleMatch[1];
    }

    const isLegalQuestion = requiredCodex !== null || 
                           lowerMessage.includes('закон') || 
                           lowerMessage.includes('кодекс') ||
                           lowerMessage.includes('стаття');

    return {
      isLegalQuestion,
      confidence: isLegalQuestion ? 0.7 : 0.3,
      requiredCodex,
      articleNumber,
      articlePart: null,
      articlePoint: null,
      articleSubPoint: null,
      searchKeywords: this.extractKeywords(lowerMessage),
      questionType,
      category
    };
  }

  mergeClassificationWithRouterSignals(
    classification: QuestionClassification,
    decision: RouterDecision | null,
    options: { userMessage: string; whitelistIndex?: Map<string, RouterWhitelistLaw> } = {
      userMessage: ''
    }
  ): QuestionClassification {
    if (!decision) {
      return classification;
    }

    const updated: QuestionClassification = { ...classification };
    const whitelistEntry = decision.recommended_nreg
      ? options.whitelistIndex?.get(decision.recommended_nreg)
      : null;

    let normalizedBranch = decision.branch;
    if (normalizedBranch === 'other' && whitelistEntry?.branch) {
      normalizedBranch = whitelistEntry.branch;
    }

    if (normalizedBranch === 'other' && decision.confidence < 0.4) {
      updated.isLegalQuestion = false;
      updated.requiredCodex = null;
      updated.category = 'загальне';
      updated.confidence = Math.min(updated.confidence || 0.3, decision.confidence);
      return updated;
    }

    const branchMeta = branchToCategoryMeta(normalizedBranch);
    updated.isLegalQuestion = true;
    updated.category = branchMeta.category;
    if (branchMeta.defaultCodex) {
      updated.requiredCodex = branchMeta.defaultCodex;
    }
    updated.confidence = Math.max(updated.confidence || 0.5, decision.confidence);

    const manualMatch = decision.recommended_nreg
      ? this.getManualLawMappingByNreg(decision.recommended_nreg)
      : null;
    if (manualMatch) {
      return this.enrichClassificationWithManualMatch(
        updated,
        manualMatch,
        options.userMessage
      );
    }

    if (whitelistEntry) {
      updated.requiredCodex = whitelistEntry.title || updated.requiredCodex;
      if (whitelistEntry.category) {
        updated.category = whitelistEntry.category;
      }
      const keywords = new Set(updated.searchKeywords || []);
      (whitelistEntry.keywords || []).forEach(keyword => keywords.add(keyword));
      if (whitelistEntry.title) {
        keywords.add(whitelistEntry.title);
      }
      updated.searchKeywords = Array.from(keywords).filter(Boolean);
    }

    if (!updated.searchKeywords || updated.searchKeywords.length === 0) {
      updated.searchKeywords = this.extractKeywords(options.userMessage.toLowerCase());
    }

    return updated;
  }

  // Пошук статей через Supabase функцію search_relevant_articles
  async searchArticlesInDatabase(
    supabase: any,
    classification: QuestionClassification,
    limit: number = 10
  ): Promise<Article[]> {
    try {
      const searchQuery = classification.searchKeywords.join(' ');
      
      if (!searchQuery || searchQuery.trim().length === 0) {
        return [];
      }

      // Використовуємо Supabase функцію для пошуку статей
      try {
        const { data: articleResults, error: articleError } = await supabase.rpc('search_relevant_articles', {
          search_query: searchQuery,
          max_results: limit
        });

        if (!articleError && articleResults && articleResults.length > 0) {
          console.log(`Found ${articleResults.length} articles via Supabase function`);
          return articleResults.map((art: any) => ({
            number: art.article_number || '',
            title: art.title || '',
            content: art.content || ''
          }));
        }
      } catch (rpcError) {
        console.warn('Supabase RPC function failed, using direct query:', rpcError);
      }

      // Fallback: пошук в таблиці legal_articles напряму
      if (classification.articleNumber) {
        const { data: specificArticles, error: specificError } = await supabase
          .from('legal_articles')
          .select('*, legal_laws(title, law_number)')
          .eq('article_number', classification.articleNumber)
          .limit(limit);

        if (!specificError && specificArticles && specificArticles.length > 0) {
          console.log(`Found ${specificArticles.length} articles by number`);
          return specificArticles.map((art: any) => ({
            number: art.article_number || '',
            title: art.title || '',
            content: art.content || ''
          }));
        }
      }

      // Загальний пошук за ключовими словами
      const { data: keywordArticles, error: keywordError } = await supabase
        .from('legal_articles')
        .select('*, legal_laws(title, law_number)')
        .ilike('content', `%${classification.searchKeywords[0] || ''}%`)
        .limit(limit);

      if (!keywordError && keywordArticles && keywordArticles.length > 0) {
        console.log(`Found ${keywordArticles.length} articles by keywords`);
        return keywordArticles.map((art: any) => ({
          number: art.article_number || '',
          title: art.title || '',
          content: art.content || ''
        }));
      }

      return [];
    } catch (error) {
      console.error('Error searching articles in database:', error);
      return [];
    }
  }

  // Витягування конкретних статей з документів (покращена версія)
  async extractRelevantArticles(
    supabase: any,
    documents: Document[],
    classification: QuestionClassification,
    maxArticles: number = 3,
    options?: { skipDatabaseLookup?: boolean }
  ): Promise<Article[]> {
    console.log(`🔍 extractRelevantArticles: ${documents.length} documents, looking for article: ${classification.articleNumber || 'any'}`);
    
    // Спочатку спробуємо знайти статті в таблиці legal_articles
    if (!options?.skipDatabaseLookup) {
      const dbArticles = await this.searchArticlesInDatabase(supabase, classification, maxArticles);
      if (dbArticles.length > 0) {
        console.log(`✅ Using ${dbArticles.length} articles from legal_articles table`);
        return dbArticles.slice(0, maxArticles);
      }
    }

    // Якщо не знайдено в таблиці, витягуємо з документів
    const articles: Article[] = [];
    console.log(`📄 Extracting articles from ${documents.length} documents...`);

    for (const doc of documents) {
      let docArticles: Article[] = [];
      
      console.log(`📄 Processing document: ${doc.title}, has articles: ${!!doc.articles}, articles type: ${typeof doc.articles}`);
      
      // Парсинг articles (покращена версія з обробкою різних форматів)
      if (doc.articles) {
        try {
          // Спробуємо різні формати
          if (Array.isArray(doc.articles)) {
            // Вже масив
            docArticles = doc.articles;
          } else if (typeof doc.articles === 'string') {
            // JSON string
            const parsed = JSON.parse(doc.articles);
            docArticles = Array.isArray(parsed) ? parsed : [];
          } else if (typeof doc.articles === 'object' && doc.articles !== null) {
            // Може бути об'єкт (Supabase може повертати JSON як об'єкт)
            if (Array.isArray(doc.articles)) {
              docArticles = doc.articles;
            } else {
              // Спробуємо конвертувати в масив
              docArticles = [];
            }
          }
          
          // Валідація та очищення статей
          docArticles = docArticles.filter(art => 
            art && 
            typeof art === 'object' && 
            art.number && 
            art.content
          ).map(art => ({
            number: String(art.number || ''),
            title: String(art.title || ''),
            content: String(art.content || '')
          }));
          
          console.log(`Parsed ${docArticles.length} articles from ${doc.title}`);
        } catch (parseError) {
          console.warn(`Failed to parse articles for ${doc.title}, parsing from text:`, parseError);
          // Якщо не вдалося розпарсити - парсимо з тексту
          docArticles = this.parseArticlesFromText(doc.content || '', doc.law_number || '');
        }
      } else if (doc.content) {
        // Якщо articles порожній або null - парсимо з тексту
        docArticles = this.parseArticlesFromText(doc.content, doc.law_number || '');
      }
      
      // Якщо є конкретна стаття - витягуємо тільки її (покращений пошук)
      if (classification.articleNumber) {
        const targetNum = String(classification.articleNumber).trim();
        const specificArticle = docArticles.find(a => {
          const articleNum = String(a.number || '').trim();
          return articleNum === targetNum || 
                 articleNum === `ст. ${targetNum}` ||
                 articleNum === `ст ${targetNum}` ||
                 articleNum === `Стаття ${targetNum}` ||
                 articleNum === `Стаття ${targetNum}.`;
        });
        if (specificArticle) {
          articles.push(specificArticle);
          console.log(`✅ Found specific article ${classification.articleNumber} in ${doc.title}`);
          // Якщо знайшли конкретну статтю - повертаємо тільки її
          return [specificArticle];
        }
      }

      // Якщо немає конкретної статті - фільтруємо за релевантністю
      const relevantArticles = this.filterRelevantArticles(docArticles, classification);
      articles.push(...relevantArticles.slice(0, maxArticles - articles.length));
      
      if (articles.length >= maxArticles) break;
    }

    console.log(`✅ extractRelevantArticles result: ${articles.length} articles extracted`);
    return articles.slice(0, maxArticles);
  }

  // Парсинг статей з тексту (якщо articles порожній)
  private parseArticlesFromText(content: string, lawNumber: string): Article[] {
    const articles: Article[] = [];
    
    if (!content || content.length < 100) {
      return articles;
    }

    // Покращений регулярний вираз для статтей
    // Шукаємо "Стаття X" або "ст. X" з контентом до наступної статті
    const articlePattern = /(?:Стаття|ст\.?)\s+(\d+[а-я]?)\s*\.?\s*([^]*?)(?=(?:Стаття|ст\.?)\s+\d+[а-я]?|$)/gi;
    
    let match;
    while ((match = articlePattern.exec(content)) !== null) {
      const articleNumber = match[1];
      let articleText = match[2].trim();
      
      // Видаляємо зайві пробіли та переноси
      articleText = articleText.replace(/\s+/g, ' ').trim();
      
      if (articleText.length > 50) { // Мінімальна довжина статті
        // Витягуємо заголовок (перший рядок або перші 100 символів)
        const title = this.extractArticleTitle(articleText);
        
        articles.push({
          number: articleNumber,
          title: title,
          content: articleText.substring(0, 2000) // Обмежуємо розмір для економії токенів
        });
      }
    }
    
    console.log(`Parsed ${articles.length} articles from text`);
    return articles;
  }

  // Витягування заголовка статті
  private extractArticleTitle(text: string): string {
    // Шукаємо перший рядок довжиною 10-200 символів
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 10 && trimmed.length < 200 && !trimmed.match(/^\d+\./)) {
        return trimmed;
      }
    }
    // Якщо не знайшли, беремо перші 100 символів
    return text.substring(0, 100).trim() + (text.length > 100 ? '...' : '');
  }

  // Фільтрація статей за релевантністю
  private filterRelevantArticles(articles: Article[], classification: QuestionClassification): Article[] {
    if (articles.length === 0) return [];

    const keywords = classification.searchKeywords.map(k => k.toLowerCase());
    
    return articles
      .map(article => {
        const { article: refinedArticle, matchedStructure } = this.extractArticleFragment(article, classification);
        const articleText = `${refinedArticle.title} ${refinedArticle.content}`.toLowerCase();
        let score = 0;

        // Підрахунок збігів ключових слів
        keywords.forEach(keyword => {
          if (articleText.includes(keyword)) {
            score += 2;
          }
        });

        // Бонус за збіг в заголовку
        if (refinedArticle.title) {
          keywords.forEach(keyword => {
            if (refinedArticle.title.toLowerCase().includes(keyword)) {
              score += 3;
            }
          });
        }

        // Бонус за тип питання
        if (classification.questionType === 'punishment') {
          if (articleText.includes('покарання') || articleText.includes('штраф') || articleText.includes('позбавлення')) {
            score += 5;
          }
        }

        if (matchedStructure) {
          score += 5;
        }

        return { article: refinedArticle, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.article);
  }

  private extractArticleFragment(
    article: Article,
    classification: QuestionClassification
  ): { article: Article; matchedStructure: boolean } {
    if (
      !article.content ||
      (!classification.articlePart &&
        !classification.articlePoint &&
        !classification.articleSubPoint)
    ) {
      return { article, matchedStructure: false };
    }

    let fragment = article.content;
    let matched = false;

    const partLabels = ['частина', 'частини', 'частиною', 'частині', 'частину', 'ч.'];
    const pointLabels = ['пункт', 'пункти', 'пункту', 'пунктом', 'пункті', 'п.', 'пунктів'];
    const subPointLabels = ['підпункт', 'підпункту', 'підпунктом', 'підпункті', 'пп.', 'підпункти'];

    if (classification.articlePart) {
      const partFragment = this.captureArticleSegment(
        fragment,
        partLabels,
        classification.articlePart,
        partLabels
      );
      if (partFragment) {
        fragment = partFragment;
        matched = true;
      }
    }

    if (classification.articlePoint) {
      const pointFragment = this.captureArticleSegment(
        fragment,
        pointLabels,
        classification.articlePoint,
        pointLabels.concat(partLabels)
      );
      if (pointFragment) {
        fragment = pointFragment;
        matched = true;
      }
    }

    if (classification.articleSubPoint) {
      const subPointFragment = this.captureArticleSegment(
        fragment,
        subPointLabels,
        classification.articleSubPoint,
        subPointLabels.concat(pointLabels, partLabels)
      );
      if (subPointFragment) {
        fragment = subPointFragment;
        matched = true;
      }
    }

    if (!matched) {
      return { article, matchedStructure: false };
    }

    return {
      article: {
        ...article,
        content: fragment.trim()
      },
      matchedStructure: true
    };
  }

  private captureArticleSegment(
    content: string,
    labelVariants: string[],
    identifier: string,
    stopLabelVariants?: string[]
  ): string | null {
    const normalizedId = this.normalizeArticleFragmentId(identifier);
    if (!normalizedId) {
      return null;
    }

    const labelPattern = labelVariants.map(label => this.escapeRegex(label)).join('|');
    const stopLabels = stopLabelVariants && stopLabelVariants.length > 0 ? stopLabelVariants : labelVariants;
    const stopPattern = stopLabels.map(label => this.escapeRegex(label)).join('|');
    const idPattern = this.buildFragmentIdPattern(normalizedId);
    const connectorPattern = '(?:\\s+|[-–])*';
    const matchRegex = new RegExp(
      `(${labelPattern})${connectorPattern}(?:${idPattern})(?:\\b|[\\s.:;,-])`,
      'i'
    );

    const lower = content.toLowerCase();
    const match = matchRegex.exec(lower);
    if (!match) {
      return null;
    }

    const start = match.index;
    const afterStart = lower.slice(start + match[0].length);
    const stopRegex = new RegExp(
      `(${stopPattern})${connectorPattern}(?:\\d+|[ivxlcdm]+|[а-яa-z]+)`,
      'i'
    );
    const stopMatch = stopRegex.exec(afterStart);
    const end = stopMatch ? start + match[0].length + stopMatch.index : content.length;

    return content.slice(start, end).trim();
  }

  private buildFragmentIdPattern(identifier: string): string {
    const variants = [this.escapeRegex(identifier)];
    const ordinalVariants = this.getOrdinalWordVariants(identifier);
    ordinalVariants.forEach(word => variants.push(this.escapeRegex(word)));
    return variants.join('|');
  }

  private getOrdinalWordVariants(identifier: string): string[] {
    const mapping: Record<string, string[]> = {
      '1': ['перша', 'першої', 'першу', 'першою'],
      '2': ['друга', 'другій', 'другою'],
      '3': ['третя', 'третьої', 'третьою'],
      '4': ['четверта', 'четвертої', 'четвертою'],
      '5': ['п\'ята', 'п\'ятої', 'п\'ятою', 'пята', 'пятої', 'пятою'],
      '6': ['шоста', 'шостої', 'шостою'],
      '7': ['сьома', 'сьомої', 'сьомою'],
      '8': ['восьма', 'восьмої', 'восьмою'],
      '9': ['дев\'ята', 'дев\'ятої', 'дев\'ятою', 'девята', 'девятої', 'девятою'],
      '10': ['десята', 'десятої', 'десятою']
    };
    return mapping[identifier] || [];
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Пошук в Storage (новий метод - пріоритетний)
  async searchInStorage(
    supabase: any,
    classification: QuestionClassification,
    limit: number = 5,
    options?: { manualMatch?: ManualLawMapping | null }
  ): Promise<Document[]> {
    console.log(`🔍🔍🔍 searchInStorage: FUNCTION CALLED with requiredCodex="${classification.requiredCodex}", articleNumber="${classification.articleNumber}"`);
    
    try {
      // 1. Якщо є конкретний кодекс - шукаємо в Storage
      if (classification.requiredCodex) {
        console.log(`🔍 searchInStorage: requiredCodex is present: "${classification.requiredCodex}"`);
        console.log(`🔍 searchInStorage: START - requiredCodex = "${classification.requiredCodex}"`);
        console.log(`🔍 searchInStorage: classification =`, JSON.stringify({
          requiredCodex: classification.requiredCodex,
          articleNumber: classification.articleNumber,
          category: classification.category
        }, null, 2));
        
        let codexInfo = this.getCodexInfo(classification.requiredCodex);
        console.log(`🔍 searchInStorage: getCodexInfo result =`, codexInfo ? codexInfo.fullName : 'null');
        
        // Fallback: якщо не знайдено, спробуємо знайти по категорії або прямому збігу
        if (!codexInfo) {
          const normalized = classification.requiredCodex.toLowerCase();
          console.log(`🔍 searchInStorage: No codexInfo, trying fallback. Normalized = "${normalized}"`);
          if (normalized.includes('купап') || normalized.includes('адміністративн')) {
            codexInfo = this.codexMapping['купап'];
            console.log(`🔍 searchInStorage: Using fallback for КУпАП, codexInfo =`, codexInfo ? codexInfo.fullName : 'null');
          }
        }
        
        console.log(`🔍 searchInStorage: Final codexInfo =`, codexInfo ? JSON.stringify(codexInfo, null, 2) : 'null');
        if (codexInfo) {
          // Визначаємо codex_type та is_procedural
          let codexType = classification.requiredCodex;
          let isProcedural = false;
          
          // Маппінг кодексів
          const codexMap: { [key: string]: { type: string; procedural: boolean } } = {
            'ККУ': { type: 'ККУ', procedural: false },
            'Кримінальний кодекс України': { type: 'ККУ', procedural: false },
            'КПК': { type: 'КПК', procedural: true },
            'Кримінальний процесуальний кодекс України': { type: 'КПК', procedural: true },
            'ЦК': { type: 'ЦК', procedural: false },
            'Цивільний кодекс України': { type: 'ЦК', procedural: false },
            'ЦПК': { type: 'ЦПК', procedural: true },
            'Цивільний процесуальний кодекс України': { type: 'ЦПК', procedural: true },
            'ТК': { type: 'ТК', procedural: false },
            'Трудовий кодекс України': { type: 'ТК', procedural: false },
            'СК': { type: 'СК', procedural: false },
            'Сімейний кодекс України': { type: 'СК', procedural: false },
            'КУпАП': { type: 'КУпАП', procedural: false },
            'Кодекс України про адміністративні правопорушення': { type: 'КУпАП', procedural: false },
            'ПК': { type: 'ПК', procedural: false },
            'Податковий кодекс України': { type: 'ПК', procedural: false },
            'ЗК': { type: 'ЗК', procedural: false },
            'Земельний кодекс України': { type: 'ЗК', procedural: false },
            'Конституція': { type: 'Конституція', procedural: false },
            'Конституція України': { type: 'Конституція', procedural: false }
          };
          
          const mapped = codexMap[codexInfo.fullName] || codexMap[classification.requiredCodex];
          console.log(`🔍 searchInStorage: mapped codex =`, mapped);
          if (mapped) {
            codexType = mapped.type;
            isProcedural = mapped.procedural;
            console.log(`🔍 searchInStorage: Using codexType = ${codexType}, isProcedural = ${isProcedural}`);
          } else {
            console.warn(`⚠️ searchInStorage: No mapping found for ${codexInfo.fullName} or ${classification.requiredCodex}`);
          }
          
          // Fallback: якщо маппінг не спрацював, спробуємо визначити напряму
          if (!mapped || codexType === classification.requiredCodex) {
            const normalized = String(classification.requiredCodex || '').toLowerCase();
            if (normalized.includes('купап') || normalized.includes('адміністративн')) {
              codexType = 'КУпАП';
              isProcedural = false;
              console.log(`🔍 searchInStorage: Using fallback detection for КУпАП`);
            } else if (normalized.includes('кку') || normalized.includes('кримінальний кодекс')) {
              codexType = 'ККУ';
              isProcedural = false;
              console.log(`🔍 searchInStorage: Using fallback detection for ККУ`);
            } else if (normalized.includes('цк') || normalized.includes('цивільний кодекс')) {
              codexType = 'ЦК';
              isProcedural = false;
              console.log(`🔍 searchInStorage: Using fallback detection for ЦК`);
            }
          }
          
          // Додаткова перевірка: якщо codexType все ще не встановлено, спробуємо визначити з requiredCodex
          if (!codexType || codexType === classification.requiredCodex) {
            const normalized = String(classification.requiredCodex || '').toLowerCase();
            if (normalized.includes('купап') || normalized.includes('адміністративн')) {
              codexType = 'КУпАП';
              isProcedural = false;
              console.log(`🔍 searchInStorage: Detected КУпАП from requiredCodex`);
            } else if (normalized.includes('кку') || normalized.includes('кримінальний кодекс')) {
              codexType = 'ККУ';
              isProcedural = false;
            } else if (normalized.includes('цк') || normalized.includes('цивільний кодекс')) {
              codexType = 'ЦК';
              isProcedural = false;
            }
          }
          
          // Для КУпАП визначаємо конкретну частину за номером статті
          // КУпАП має дві частини: 80731-10 (статті 1-212) та 80732-10 (статті 213-330)
          let specificNreg: string | null = null;
          let searchLimit = limit;
          
          if (codexType === 'КУпАП') {
            if (classification.articleNumber) {
              // Визначаємо в якій частині знаходиться стаття
              const articleNum = parseInt(String(classification.articleNumber).replace(/[^0-9]/g, ''));
              if (!isNaN(articleNum)) {
                if (articleNum >= 1 && articleNum <= 212) {
                  specificNreg = '80731-10'; // Part 1
                  console.log(`🔍 КУпАП: Article ${articleNum} belongs to Part 1 (80731-10)`);
                } else if (articleNum >= 213 && articleNum <= 330) {
                  specificNreg = '80732-10'; // Part 2
                  console.log(`🔍 КУпАП: Article ${articleNum} belongs to Part 2 (80732-10)`);
                }
              }
            } else {
              // Якщо немає конкретної статті - завантажуємо обидві частини
              // Не передаємо specificNreg, щоб SQL повернув обидва документи
              searchLimit = limit * 2; // Збільшуємо ліміт для обох частин
              console.log(`🔍 КУпАП: No specific article, will load both parts (limit: ${searchLimit})`);
            }
          }
          
          console.log(`🔍 Calling search_documents_by_codex_article with: codexType=${codexType}, article=${classification.articleNumber || 'null'}, procedural=${isProcedural}, nreg=${specificNreg || 'null'}`);
          
          const { data: storageDocs, error } = await supabase.rpc('search_documents_by_codex_article', {
            p_codex_type: codexType,
            p_article_number: classification.articleNumber || null,
            p_is_procedural: isProcedural,
            p_rada_nreg: specificNreg // Для КУпАП: null = обидві частини, '80731-10' = частина 1, '80732-10' = частина 2
          });
          
          if (error) {
            console.error(`❌ Error searching in Storage:`, error);
            console.error(`❌ Error details:`, JSON.stringify(error, null, 2));
          } else {
            console.log(`📦 Storage search result: ${storageDocs?.length || 0} documents found for ${codexType}`);
            if (storageDocs && storageDocs.length > 0) {
              console.log(`📦 Found documents:`, storageDocs.map((d: any) => `${d.rada_nreg || 'no-nreg'} (${d.storage_path}, sync: ${d.sync_status || 'unknown'})`).join(', '));
            } else {
              console.warn(`⚠️ No documents found in Storage for codexType=${codexType}, specificNreg=${specificNreg || 'null'}`);
              // Перевіряємо чи взагалі є документи КУпАП в таблиці
              if (codexType === 'КУпАП') {
                const { data: allKuapDocs, error: checkError } = await supabase
                  .from('legal_documents_storage')
                  .select('id, rada_nreg, title, storage_path, sync_status, is_active, codex_type')
                  .eq('codex_type', 'КУпАП');
                console.log(`🔍 All КУпАП documents in table:`, allKuapDocs?.length || 0);
                if (allKuapDocs && allKuapDocs.length > 0) {
                  console.log(`📋 КУпАП documents:`, allKuapDocs.map((d: any) => 
                    `${d.rada_nreg} (sync: ${d.sync_status}, active: ${d.is_active}, path: ${d.storage_path})`
                  ).join(', '));
                }
                if (checkError) {
                  console.error(`❌ Error checking КУпАП documents:`, checkError);
                }
              }
            }
          }
          
          if (!error && storageDocs && storageDocs.length > 0) {
            console.log(`📦 Found ${storageDocs.length} documents in Storage metadata for ${codexType}`);
            
            // Для КУпАП: якщо є конкретна стаття, SQL вже відфільтрував потрібну частину
            // Якщо немає конкретної статті - завантажуємо обидві частини (до searchLimit)
            let docsToLoad = storageDocs.slice(0, searchLimit);
            
            if (codexType === 'КУпАП') {
              console.log(`🔍 КУпАП: Will load ${docsToLoad.length} document(s) (specificNreg=${specificNreg || 'both parts'})`);
              console.log(`🔍 КУпАП: Documents to load:`, docsToLoad.map((d: any) => `${d.rada_nreg} (${d.storage_path})`).join(', '));
            }
            
            // Завантажуємо документи з Storage
            const documents: Document[] = [];
            console.log(`📥 Starting to load ${docsToLoad.length} documents from Storage...`);
            
            for (const docMeta of docsToLoad) {
              try {
                // Перевіряємо чи є storage_path
                if (!docMeta.storage_path) {
                  console.warn(`⚠️ Document ${docMeta.id} has no storage_path`);
                  continue;
                }
                
                console.log(`📥 Downloading document from Storage: ${docMeta.storage_path}`);
                
                // Завантажуємо файл з Storage
                // Використовуємо той самий supabase клієнт (він вже має service_role key)
                console.log(`📥 Attempting to download: ${docMeta.storage_path}`);
                const resolvedBucket =
                  docMeta.storage_bucket ||
                  (docMeta.storage_path.startsWith('ZU/') ? 'zu' : 'legal-documents');
                const { data: fileData, error: downloadError } = await supabase.storage
                  .from(resolvedBucket)
                  .download(docMeta.storage_path);
                
                if (downloadError) {
                  console.error(`❌ Download error for ${docMeta.storage_path}:`, downloadError);
                  console.error(`❌ Error details:`, JSON.stringify(downloadError, null, 2));
                  // Спробуємо альтернативний шлях
                  const altPath = docMeta.storage_path.replace('KUAP', 'КУпАП');
                  console.log(`🔄 Trying alternative path: ${altPath}`);
                  const { data: altFileData, error: altError } = await supabase.storage
                    .from(resolvedBucket)
                    .download(altPath);
                  if (!altError && altFileData) {
                    console.log(`✅ Successfully downloaded from alternative path`);
                    // Використовуємо альтернативний файл
                    const text = await altFileData.text();
                    // Продовжуємо обробку з text
                    let parsed: any;
                    try {
                      parsed = JSON.parse(text);
                    } catch (parseError) {
                      parsed = { content: text };
                    }
                    const content = parsed.content || text;
                    let articles: Article[] | null = null;
                    if (parsed.jsonData && parsed.jsonData.stru) {
                      articles = this.extractArticlesFromStru(parsed.jsonData.stru);
                      if (classification.articleNumber && articles) {
                        const articleNum = String(classification.articleNumber).trim();
                        articles = articles.filter(art => {
                          const artNum = String(art.number).trim();
                          return artNum === articleNum || 
                                 artNum === `ст. ${articleNum}` ||
                                 artNum === `Стаття ${articleNum}` ||
                                 artNum.replace(/[^0-9]/g, '') === articleNum.replace(/[^0-9]/g, '');
                        });
                      }
                    }
                    const document: Document = {
                      id: docMeta.id,
                      title: docMeta.title || parsed.metadata?.nazva || 'Документ',
                      content: content,
                      law_number: docMeta.law_number || parsed.metadata?.nreg || '',
                      rada_nreg: docMeta.rada_nreg || parsed.metadata?.nreg || '',
                      category: docMeta.category || classification.category || 'Інше',
                      source_url: docMeta.source_url || parsed.metadata?.nreg ? 
                        `https://data.rada.gov.ua/laws/show/${parsed.metadata.nreg}` : '',
                      articles: articles || undefined
                    };
                    documents.push(document);
                    console.log(`✅ Loaded document from Storage (alt path): ${docMeta.title} (${articles?.length || 0} articles)`);
                    continue;
                  }
                  continue;
                }
                
                if (fileData) {
                  console.log(`✅ Successfully downloaded file from Storage: ${docMeta.storage_path}`);
                  const text = await fileData.text();
                  let parsed: any;
                  
                  try {
                    parsed = JSON.parse(text);
                  } catch (parseError) {
                    console.warn(`Failed to parse JSON from Storage: ${docMeta.storage_path}`, parseError);
                    // Якщо не JSON, використовуємо як текст
                    parsed = { content: text };
                  }
                  
                  // Витягуємо контент та статті
                  const content = parsed.content || text;
                  let articles: Article[] | null = null;
                  
                  // Парсимо статті з JSON структури (stru масив)
                  if (parsed.jsonData && parsed.jsonData.stru) {
                    console.log(`📖 Parsing articles from stru array (${parsed.jsonData.stru.length} items)`);
                    articles = this.extractArticlesFromStru(parsed.jsonData.stru);
                    console.log(`✅ Extracted ${articles.length} articles from stru`);
                    
                    // Якщо є конкретна стаття - фільтруємо
                    if (classification.articleNumber && articles) {
                      const articleNum = String(classification.articleNumber).trim();
                      console.log(`🔍 Filtering articles for number: ${articleNum}`);
                      const beforeFilter = articles.length;
                      articles = articles.filter(art => {
                        const artNum = String(art.number).trim();
                        const matches = artNum === articleNum || 
                               artNum === `ст. ${articleNum}` ||
                               artNum === `Стаття ${articleNum}` ||
                               artNum.replace(/[^0-9]/g, '') === articleNum.replace(/[^0-9]/g, '');
                        if (matches) {
                          console.log(`✅ Found matching article: ${artNum}`);
                        }
                        return matches;
                      });
                      console.log(`📊 Filtered: ${beforeFilter} -> ${articles.length} articles`);
                    }
                  } else {
                    console.warn(`⚠️ No jsonData.stru found in document`);
                  }
                  
                  // Формуємо Document об'єкт
                  const document: Document = {
                    id: docMeta.id,
                    title: docMeta.title || parsed.metadata?.nazva || 'Документ',
                    content: content,
                    law_number: docMeta.law_number || parsed.metadata?.nreg || '',
                    rada_nreg: docMeta.rada_nreg || parsed.metadata?.nreg || '',
                    category: docMeta.category || classification.category || 'Інше',
                    source_url: docMeta.source_url || parsed.metadata?.nreg ? 
                      `https://data.rada.gov.ua/laws/show/${parsed.metadata.nreg}` : '',
                    articles: articles || undefined
                  };
                  
                  documents.push(document);
                  console.log(`✅ Successfully loaded document from Storage: ${docMeta.title}`);
                  console.log(`   - Articles: ${articles?.length || 0}`);
                  console.log(`   - Content length: ${content.length} chars`);
                  console.log(`   - Storage path: ${docMeta.storage_path}`);
                  console.log(`   - Rada NREG: ${docMeta.rada_nreg}`);
                } else {
                  console.warn(`⚠️ No fileData returned for ${docMeta.storage_path}`);
                }
              } catch (loadError) {
                console.error(`❌ Failed to load document from Storage: ${docMeta.storage_path}`, loadError);
                console.error(`❌ Load error details:`, loadError instanceof Error ? loadError.message : String(loadError));
              }
            }
            
            console.log(`📊 Loading summary: ${documents.length} documents loaded from ${docsToLoad.length} metadata entries`);
            
            if (documents.length > 0) {
              console.log(`✅ Successfully loaded ${documents.length} documents from Storage for ${codexType}`);
              console.log(`📋 Loaded documents:`, documents.map(d => `${d.title} (${Array.isArray(d.articles) ? d.articles.length : 0} articles)`).join(', '));
              return documents;
            } else {
              console.error(`❌ CRITICAL: No documents loaded from Storage despite ${storageDocs.length} found in metadata!`);
              console.error(`❌ This means files exist in metadata but cannot be downloaded from Storage`);
            }
          } else {
            console.warn(`⚠️ No documents found in Storage for ${codexType}`);
          }
        } else {
          console.warn(`⚠️ searchInStorage: No codexInfo found for ${classification.requiredCodex}`);
        }
      } else {
        console.warn(`⚠️ searchInStorage: No requiredCodex in classification`);
      }
      
      console.log(`🔍 searchInStorage: Returning empty array (no documents found)`);
      return [];
    } catch (error) {
      console.error(`❌ searchInStorage: ERROR -`, error);
      console.error(`❌ searchInStorage: Error details:`, error instanceof Error ? error.message : String(error));
      console.error(`❌ searchInStorage: Error stack:`, error instanceof Error ? error.stack : 'No stack');
      return [];
    }
  }

  // Витягування статей з JSON структури Rada API (покращена версія)
  extractArticlesFromStru(stru: any[]): Article[] {
    if (!Array.isArray(stru)) {
      return [];
    }
    
    const articles: Article[] = [];
    const articleMap = new Map<string, { title: string; content: string; parts: string[] }>();
    
    // Сортуємо за позицією (pos) для правильного порядку
    const sortedStru = [...stru].sort((a, b) => (a.pos || 0) - (b.pos || 0));
    
    // Групуємо елементи по статтях
    for (const item of sortedStru) {
      // Перевіряємо чи це стаття (ST - стаття)
      if (item.typ === 'ST' || item.typn === 'ST') {
        // Витягуємо номер статті з різних полів
        const articleNum = item.stru || item.line || '';
        let text = item.text || '';
        
        // Очищаємо HTML теги якщо є
        if (text && typeof text === 'string') {
          text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        
        if (articleNum && text) {
          // Нормалізуємо номер статті
          const normalizedNum = articleNum.replace(/^ст\.?\s*/i, '').trim();
          
          if (!articleMap.has(normalizedNum)) {
            articleMap.set(normalizedNum, { 
              title: `Стаття ${normalizedNum}`, 
              content: '',
              parts: []
            });
          }
          
          const existing = articleMap.get(normalizedNum)!;
          existing.parts.push(text);
        }
      } else if (item.typ === 'PR' || item.typn === 'PR' || item.typ === 'PP' || item.typn === 'PP') {
        // Пункти та підпункти - додаємо до останньої статті
        const text = item.text || '';
        if (text && articleMap.size > 0) {
          const lastArticle = Array.from(articleMap.values()).pop();
          if (lastArticle) {
            lastArticle.parts.push(text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
          }
        }
      }
    }
    
    // Конвертуємо в масив Article
    for (const [number, data] of articleMap.entries()) {
      // Об'єднуємо всі частини статті
      const fullContent = data.parts.join('\n\n').trim();
      
      if (fullContent) {
        articles.push({
          number: number,
          title: data.title,
          content: fullContent
        });
      }
    }
    
    // Сортуємо статті за номером (з урахуванням підпунктів типу 115-1, 115-2)
    articles.sort((a, b) => {
      const numA = a.number.replace(/[^0-9-]/g, '');
      const numB = b.number.replace(/[^0-9-]/g, '');
      
      // Розбиваємо на основну частину та підпункт
      const [mainA, subA] = numA.split('-').map(Number);
      const [mainB, subB] = numB.split('-').map(Number);
      
      if (mainA !== mainB) {
        return mainA - mainB;
      }
      
      return (subA || 0) - (subB || 0);
    });
    
    return articles;
  }

  // Пошук в базі даних з покращеною логікою (використовує Supabase функції)
  async searchInDatabase(
    supabase: any,
    classification: QuestionClassification,
    limit: number = 5,
    options?: { manualMatch?: ManualLawMapping | null; userMessage?: string | null; targetNreg?: string | null }
  ): Promise<Document[]> {
    try {
      if (options?.manualMatch) {
        console.log(`📘 Manual law detected: ${options.manualMatch.title}`);
        const manualDoc = await this.ensureManualLawAvailability(
          supabase,
          options.manualMatch,
          classification,
          options.userMessage
        );
        if (manualDoc) {
          return [manualDoc];
        }
        console.warn('⚠️ Manual law could not be loaded, continuing with generic search');
      }

      if (options?.targetNreg) {
        const targetedDoc = await this.loadDocumentByNreg(
          supabase,
          options.targetNreg,
          classification
        );
        if (targetedDoc) {
          console.log(`🎯 Loaded router-targeted document ${options.targetNreg}`);
          return [targetedDoc];
        }
        console.warn(`⚠️ Router-targeted document ${options.targetNreg} not available in storage`);
      }

      // СПОЧАТКУ шукаємо в Storage (новий пріоритетний метод)
      console.log(`🔍 searchInDatabase: Starting search, requiredCodex: ${classification.requiredCodex}`);
      const storageResults = await this.searchInStorage(supabase, classification, limit, {
        manualMatch: options?.manualMatch || null
      });
      console.log(`📦 searchInStorage returned: ${storageResults.length} documents`);
      if (storageResults.length > 0) {
        console.log(`✅ Found ${storageResults.length} documents in Storage`);
        console.log(`📦 Documents details:`, storageResults.map(d => ({
          title: d.title,
          hasArticles: !!d.articles,
          articlesCount: Array.isArray(d.articles) ? d.articles.length : 0,
          contentLength: d.content?.length || 0
        })));
        return storageResults;
      }
      
      console.log(`⚠️ No documents found in Storage, falling back to database tables`);
      
      // Fallback на старий метод (таблиці)
      // 1. Якщо є конкретний кодекс - шукаємо його
      if (classification.requiredCodex) {
        const codexInfo = this.getCodexInfo(classification.requiredCodex);
        if (codexInfo) {
          // Спочатку спробуємо використати Supabase функцію для пошуку
          try {
            const searchQuery = codexInfo.fullName;
            const { data: functionResults, error: functionError } = await supabase.rpc('search_relevant_laws', {
              search_query: searchQuery,
              max_results: limit
            });

            if (!functionError && functionResults && functionResults.length > 0) {
              console.log(`Found ${functionResults.length} laws via Supabase function: ${codexInfo.fullName}`);
              // Отримуємо повні дані з таблиці
              const fullResults = await Promise.all(
                functionResults.map(async (law: any) => {
                  const { data: fullLaw } = await supabase
                    .from('legal_laws')
                    .select('*')
                    .eq('id', law.id)
                    .single();
                  return fullLaw || law;
                })
              );
              return fullResults.filter(l => l !== null);
            }
          } catch (rpcError) {
            console.warn('Supabase RPC function failed, using direct query:', rpcError);
          }

          // Fallback на прямий пошук (покращений - шукаємо за різними варіантами назви)
          const searchVariants = [
            codexInfo.fullName,
            ...codexInfo.searchTerms
          ];

          for (const searchTerm of searchVariants) {
            const { data: codexResults, error: codexError } = await supabase
              .from('legal_laws')
              .select('*')
              .ilike('title', `%${searchTerm}%`)
              .limit(limit);

            if (!codexError && codexResults?.length > 0) {
              console.log(`Found codex in database: ${codexInfo.fullName} (via "${searchTerm}")`, codexResults.length);
              return codexResults;
            }
          }
        }
      }

      // 2. Пошук за статтею (якщо є)
      if (classification.articleNumber) {
        try {
          // Спробуємо повнотекстовий пошук
        const { data: articleResults, error: articleError } = await supabase
          .from('legal_laws')
          .select('*')
            .textSearch('content', `стаття ${classification.articleNumber}`, {
            config: 'ukrainian',
            type: 'plain'
          })
          .limit(limit);

        if (!articleError && articleResults?.length > 0) {
            // Фільтрація по articles (покращена версія)
          const filtered = articleResults.filter((law: any) => {
            try {
              let articles = law.articles;
              
              // Обробка різних форматів
              if (Array.isArray(articles)) {
                // Вже масив
              } else if (typeof articles === 'string') {
                articles = JSON.parse(articles);
              } else if (articles && typeof articles === 'object') {
                // Може бути об'єкт (Supabase повертає JSON як об'єкт)
                if (!Array.isArray(articles)) {
                  return false;
                }
              } else {
                return false;
              }
              
              if (!Array.isArray(articles)) {
                return false;
              }
              
              // Перевірка чи є стаття з потрібним номером
              return articles.some((a: any) => {
                const articleNum = String(a?.number || '').trim();
                const targetNum = String(classification.articleNumber || '').trim();
                return articleNum === targetNum || 
                       articleNum === `ст. ${targetNum}` ||
                       articleNum === `Стаття ${targetNum}` ||
                       articleNum === `ст ${targetNum}`;
              });
            } catch (error) {
              console.warn('Error filtering articles:', error);
              return false;
            }
          });
            if (filtered.length > 0) {
              console.log(`Found article ${classification.articleNumber} in database`);
              return filtered;
            }
          }
        } catch (textSearchError) {
          // Fallback на ILIKE пошук якщо textSearch не працює
          console.warn('textSearch failed, using ILIKE fallback:', textSearchError);
          const { data: articleResults, error: articleError } = await supabase
          .from('legal_laws')
          .select('*')
            .ilike('content', `%стаття ${classification.articleNumber}%`)
          .limit(limit);

          if (!articleError && articleResults?.length > 0) {
            console.log(`Found article ${classification.articleNumber} via ILIKE`);
            return articleResults;
          }
        }
      }

      // 3. Повнотекстовий пошук за ключовими словами (використовуємо Supabase функцію)
      const searchTerms = classification.searchKeywords.join(' ');
      if (searchTerms) {
        try {
          // Спочатку спробуємо використати Supabase функцію
          const { data: functionResults, error: functionError } = await supabase.rpc('search_relevant_laws', {
            search_query: searchTerms,
            max_results: limit
          });

          if (!functionError && functionResults && functionResults.length > 0) {
            console.log(`Found ${functionResults.length} laws via Supabase function`);
            return functionResults.map((law: any) => ({
              id: law.id,
              title: law.title,
              content: law.content,
              law_number: law.law_number,
              source_url: law.source_url,
              category: classification.category
            }));
          }
        } catch (rpcError) {
          console.warn('Supabase RPC function failed, using textSearch:', rpcError);
        }

        // Fallback на textSearch
        try {
          const { data: textResults, error: textError } = await supabase
          .from('legal_laws')
          .select('*')
            .textSearch('content', searchTerms, {
            config: 'ukrainian',
            type: 'plain'
          })
          .limit(limit);

          if (!textError && textResults?.length > 0) {
            console.log(`Found ${textResults.length} documents by keywords`);
            return textResults;
          }
        } catch (textSearchError) {
          // Fallback на ILIKE пошук
          console.warn('textSearch failed, using ILIKE fallback:', textSearchError);
          const firstKeyword = classification.searchKeywords[0];
          if (firstKeyword) {
            const { data: textResults, error: textError } = await supabase
          .from('legal_laws')
          .select('*')
              .ilike('content', `%${firstKeyword}%`)
          .limit(limit);

            if (!textError && textResults?.length > 0) {
              console.log(`Found ${textResults.length} documents by ILIKE`);
              return textResults;
            }
          }
        }
      }

      // 4. Софт-пошук у Storage на основі сигналів
      const signals = this.buildSoftSearchSignals(
        classification,
        options?.manualMatch || null,
        options?.userMessage || null
      );
      const softResults = await this.softSearchStorageBySignals(
        supabase,
        signals,
        classification,
        limit
      );
      if (softResults.length > 0) {
        console.log(`✅ Soft search returned ${softResults.length} documents`);
        return softResults;
      }

      return [];
    } catch (error) {
      console.error('Error searching database:', error);
      return [];
    }
  }

  // Пошук через Backend API для Rada API (інтеграція)
  // Покращений інтелектуальний пошук через Backend API з прямим доступом до Rada API
  async searchViaBackendAPI(classification: QuestionClassification, limit: number = 5): Promise<Document[]> {
    try {
      // Інтелектуальне формування пошукового запиту
      let searchQuery = '';
      let specificLawType: any = null;
      
      // Якщо є конкретний кодекс - формуємо точний запит
      if (classification.requiredCodex) {
        const codexInfo = this.getCodexInfo(classification.requiredCodex);
        if (codexInfo) {
          // Використовуємо повну назву кодексу для кращого пошуку
          searchQuery = codexInfo.fullName;
          
          // Визначаємо тип закону для Rada API
          specificLawType = {
            type: classification.articleNumber ? 'specific_article' : 'codex',
            codex: classification.requiredCodex,
            article: classification.articleNumber || null
          };
          
          // Якщо є конкретна стаття - додаємо її
          if (classification.articleNumber) {
            searchQuery += ` стаття ${classification.articleNumber}`;
          } else {
            // Додаємо ключові слова для кращого пошуку
            const relevantKeywords = classification.searchKeywords
              .filter(k => !codexInfo.keywords.includes(k.toLowerCase()))
              .slice(0, 2);
            if (relevantKeywords.length > 0) {
              searchQuery += ' ' + relevantKeywords.join(' ');
            }
          }
        } else {
          searchQuery = classification.requiredCodex;
        }
      } else {
        // Якщо немає конкретного кодексу - використовуємо ключові слова + категорію
        const keywords = classification.searchKeywords;
        const category = classification.category !== 'загальне' ? classification.category : '';
        
        if (category) {
          searchQuery = `${category} ${keywords.slice(0, 3).join(' ')}`;
        } else {
          searchQuery = keywords.slice(0, 5).join(' ');
        }
      }

      if (!searchQuery || searchQuery.trim().length === 0) {
        return [];
      }

      // Отримуємо URL backend API з environment variables
      const backendUrl = Deno.env.get('BACKEND_API_URL') || 'http://localhost:3001';
      
      // Формуємо запит з параметрами для кращого пошуку
      const params = new URLSearchParams({
        query: searchQuery.trim(),
        limit: limit.toString()
      });
      
      // Якщо є specificLawType - додаємо його
      if (specificLawType) {
        params.append('specificLawType', JSON.stringify(specificLawType));
      }
      
      const searchUrl = `${backendUrl}/api/chat/search/laws?${params.toString()}`;

      console.log('🔍 Searching via Backend API (Rada API):', searchQuery);
      if (specificLawType) {
        console.log('   📋 Specific law type:', specificLawType);
      }

      try {
        const response = await fetch(searchUrl, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Supabase-Edge-Function/1.0'
          },
          signal: AbortSignal.timeout(10000) // 10 секунд timeout
        });

        if (!response.ok) {
          console.warn(`Backend API returned status ${response.status}`);
          return [];
        }

        const data = await response.json();
        
        if (data.success && data.data && data.data.results) {
          const laws = data.data.results;
          console.log(`✅ Found ${laws.length} laws via Backend API`);
          
          // Конвертуємо формат від backend в наш формат Document
          return laws.map((law: any) => ({
            id: law.id || crypto.randomUUID(),
            title: law.title || '',
            content: law.content || '',
            law_number: law.law_number || '',
            category: law.category || classification.category || 'Інше',
            source_url: law.source_url || law.link || '',
            articles: law.articles || null
          }));
        }

        return [];
      } catch (fetchError) {
        console.error('Error calling Backend API:', fetchError);
        return [];
      }
    } catch (error) {
      console.error('Error in searchViaBackendAPI:', error);
      return [];
    }
  }

  // Збереження закону в базу
  async saveLawToDatabase(supabase: any, law: Document): Promise<void> {
    try {
      await supabase
          .from('legal_laws')
        .upsert({
          title: law.title,
          content: law.content,
          law_number: law.law_number || '',
          source_url: law.source_url || '',
          category: law.category || 'Інше',
          articles: typeof law.articles === 'string' ? law.articles : JSON.stringify(law.articles || []),
          keywords: JSON.stringify([]),
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'source_url'
        });
      
      console.log('Law saved to database:', law.title);
    } catch (error) {
      console.error('Error saving law:', error);
    }
  }

  // Побудова професійного контексту для AI Law Agent
  buildOptimizedContext(
    userMessage: string,
    classification: QuestionClassification,
    articles: Article[],
    lawTitle?: string
  ): string {
    if (articles.length === 0) {
      return this.buildSimpleContext(userMessage);
    }

    const articlesText = articles.map((article, i) => {
      const content = article.content.length > 1200 
        ? article.content.substring(0, 1200) + '...' 
        : article.content;
      return `СТАТТЯ ${article.number}${article.title ? ` - ${article.title}` : ''}:
${content}`;
    }).join('\n\n═══════════════════════════════════════════════════════════════\n\n');

    // Формуємо інструкції залежно від типу питання
    let specificInstructions = '';
    let responseStructure = '';
    
    if (classification.questionType === 'punishment') {
      specificInstructions = `КРИТИЧНО: Користувач питає про покарання. 
- Вкажи ТОЧНО яке покарання передбачене в статті
- Вкажи строк покарання (якщо є в статті)
- Вкажи умови застосування покарання
- НЕ вигадуй покарання, яких немає в статті`;
      responseStructure = `1. Резюме: Що передбачає закон за це діяння
2. Покарання: Точне покарання зі статті (строк, штраф тощо)
3. Умови: Коли застосовується це покарання
4. Цитування: "Згідно зі ст. ${articles[0]?.number || 'X'} ${lawTitle || 'закону'}"`;
    } else if (classification.questionType === 'rights') {
      specificInstructions = `КРИТИЧНО: Користувач питає про права.
- Вкажи ТОЧНО які права передбачені в статті
- Вкажи умови реалізації прав
- Вкажи обмеження прав (якщо є)
- НЕ вигадуй права, яких немає в статті`;
      responseStructure = `1. Резюме: Які права передбачені
2. Права: Детальний опис прав зі статті
3. Умови: Коли та як можна реалізувати ці права
4. Цитування: "Згідно зі ст. ${articles[0]?.number || 'X'} ${lawTitle || 'закону'}"`;
    } else if (classification.questionType === 'procedure') {
      specificInstructions = `КРИТИЧНО: Користувач питає про процедуру.
- Опиши ТОЧНО процедуру згідно зі статтею
- Вкажи послідовність кроків
- Вкажи строки та терміни
- НЕ вигадуй процедури, яких немає в статті`;
      responseStructure = `1. Резюме: Яка процедура передбачена
2. Кроки: Детальна послідовність дій зі статті
3. Терміни: Строки виконання (якщо є)
4. Цитування: "Згідно зі ст. ${articles[0]?.number || 'X'} ${lawTitle || 'закону'}"`;
    } else {
      responseStructure = `1. Резюме: Коротка відповідь
2. Деталі: Детальна інформація зі статті
3. Практичні рекомендації: Як застосувати на практиці
4. Цитування: "Згідно зі ст. ${articles[0]?.number || 'X'} ${lawTitle || 'закону'}"`;
    }

    return `Ти - провідний український юрист з 20+ роками досвіду, експерт з українського законодавства.

═══════════════════════════════════════════════════════════════
🚨 КРИТИЧНО ВАЖЛИВІ ПРАВИЛА (ДОТРИМУЙСЯ ЇХ АБСОЛЮТНО):
═══════════════════════════════════════════════════════════════

1. ВІДПОВІДАЙ ТІЛЬКИ НА ОСНОВІ НАДАНИХ НИЖЧЕ СТАТТЕЙ
   ❌ ЗАБОРОНЕНО: Використовувати загальні знання про право
   ❌ ЗАБОРОНЕНО: Вигадувати статті, номери статей або закони
   ❌ ЗАБОРОНЕНО: Додавати інформацію, якої немає в наданих статтях
   ✅ ДОЗВОЛЕНО: Використовувати ТІЛЬКИ текст з наданих нижче статей

2. ОБОВ'ЯЗКОВО ЦИТУЙ КОНКРЕТНІ СТАТТІ
   - Формат: "Згідно зі ст. ${articles[0]?.number || 'X'} ${lawTitle || 'закону'}"
   - Використовуй точні формулювання зі статті
   - Вказуй номер статті в кожній відповіді

3. ЯКЩО НЕМАЄ ІНФОРМАЦІЇ В СТАТТЯХ
   - Чесно скажи: "В наданих статтях немає інформації про це питання"
   - НЕ вигадуй відповідь
   - НЕ використовуй загальні знання

4. СТРУКТУРА ВІДПОВІДІ (ОБОВ'ЯЗКОВО):
${responseStructure}

5. МОВА: Українська, професійна, зрозуміла

${specificInstructions}

═══════════════════════════════════════════════════════════════
📋 ПИТАННЯ КОРИСТУВАЧА: "${userMessage}"
═══════════════════════════════════════════════════════════════

${lawTitle ? `📚 ЗНАЙДЕНИЙ ЗАКОН: ${lawTitle}\n\n` : ''}📖 РЕЛЕВАНТНІ СТАТТІ ЗАКОНУ:

${articlesText}

═══════════════════════════════════════════════════════════════
💬 ТВОЯ ВІДПОВІДЬ (використовуй ТІЛЬКИ надані статті вище):
═══════════════════════════════════════════════════════════════`;
  }

  // Валідація відповіді на вигадки та неточності
  async validateResponse(
    response: string,
    providedArticles: Article[],
    providedLaws: Document[]
  ): Promise<{ valid: boolean; issues: string[]; needsRegeneration: boolean }> {
    const issues: string[] = [];
    let needsRegeneration = false;

    // Перевірка цитувань
    const citationPattern = /ст\.?\s*(\d+[а-я]?)/gi;
    const citations: string[] = [];
    let match;
    while ((match = citationPattern.exec(response)) !== null) {
      citations.push(match[1]);
    }

    // Перевірка чи всі цитування існують
    for (const citation of citations) {
      const articleExists = providedArticles.some(art => 
        art.number === citation || 
        art.number === `ст. ${citation}` ||
        art.number === `Стаття ${citation}`
      );
      
      if (!articleExists) {
        issues.push(`Цитування не існує в наданих статтях: ст. ${citation}`);
        needsRegeneration = true;
      }
    }

    // Перевірка на загальні фрази, які можуть вказувати на вигадки
    const suspiciousPhrases = [
      'загалом', 'зазвичай', 'як правило', 'в більшості випадків',
      'може бути', 'ймовірно', 'можливо'
    ];
    
    const lowerResponse = response.toLowerCase();
    for (const phrase of suspiciousPhrases) {
      if (lowerResponse.includes(phrase) && !lowerResponse.includes('в наданих статтях')) {
        // Якщо є підозрілі фрази без посилання на статті - можлива вигадка
        const hasCitation = citations.length > 0;
        if (!hasCitation) {
          issues.push(`Можлива вигадка: використання фрази "${phrase}" без цитування статей`);
        }
      }
    }

    // Перевірка чи є хоча б одне цитування (якщо є статті)
    if (providedArticles.length > 0 && citations.length === 0) {
      issues.push('Відповідь не містить цитувань статей, хоча статті надані');
      needsRegeneration = true;
    }

    return {
      valid: issues.length === 0,
      issues,
      needsRegeneration
    };
  }

  // Допоміжні методи
  private detectSpecificCodex(message: string): { fullName: string; category: string; keywords: string[]; searchTerms: string[] } | null {
    for (const [codexKey, codexInfo] of Object.entries(this.codexMapping)) {
      if (message.includes(codexKey.toLowerCase())) {
        return codexInfo;
      }
    }
    return null;
  }

  private getCodexInfo(codexName: string): { fullName: string; category: string; keywords: string[]; searchTerms: string[] } | null {
    // Нормалізуємо назву для пошуку (нижній регістр)
    const normalized = codexName.toLowerCase().trim();
    
    for (const [key, info] of Object.entries(this.codexMapping)) {
      // Перевіряємо по ключу (нормалізованому)
      if (key.toLowerCase() === normalized) {
        return info;
      }
      // Перевіряємо по fullName (нормалізованому)
      if (info.fullName.toLowerCase() === normalized) {
        return info;
      }
      // Перевіряємо чи містить назву
      if (info.fullName.toLowerCase().includes(normalized) || normalized.includes(key.toLowerCase())) {
        return info;
      }
    }
    
    // Додаткова перевірка для КУпАП (різні варіанти написання)
    if (normalized.includes('купап') || normalized.includes('адміністративн')) {
      return this.codexMapping['купап'] || null;
    }
    
    return null;
  }

  private extractKeywords(message: string): string[] {
    const legalTerms = [
      'стаття', 'статті', 'закон', 'кодекс', 'конституція', 'право', 'права',
      'договір', 'штраф', 'порушення', 'суд', 'прокурор', 'адвокат',
      'трудовий', 'сімейний', 'кримінальний', 'цивільний', 'адміністративний',
      'відповідальність', 'злочин', 'покарання', 'аліменти', 'спадщина',
      'власність', 'шлюб', 'розлучення', 'працівник', 'роботодавець',
      'вбивство', 'крадіжка', 'шахрайство', 'умисне', 'необережність'
    ];

    return legalTerms.filter(term => message.includes(term));
  }

  // Витягування релевантного контенту з документа
  extractRelevantContent(content: string, classification: QuestionClassification): string {
    if (!content || content.length < 100) {
      return content;
    }

    const keywords = classification.searchKeywords.map(k => k.toLowerCase());
    const lowerContent = content.toLowerCase();
    
    // Шукаємо релевантні фрагменти
    let relevantParts: string[] = [];
    
    // Якщо є конкретна стаття - шукаємо її
    if (classification.articleNumber) {
      const articlePattern = new RegExp(
        `(?:Стаття|ст\\.?)\\s+${classification.articleNumber}[^]*?(?=(?:Стаття|ст\\.?)\\s+\\d+|$)`,
        'i'
      );
      const match = content.match(articlePattern);
      if (match) {
        return match[0].substring(0, 1500);
      }
    }
    
    // Шукаємо фрагменти з ключовими словами
    const sentences = content.split(/[.!?]\s+/);
    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase();
      const matchCount = keywords.filter(k => lowerSentence.includes(k)).length;
      if (matchCount > 0) {
        relevantParts.push(sentence);
      }
    }
    
    if (relevantParts.length > 0) {
      return relevantParts.slice(0, 5).join('. ') + '.';
    }
    
    // Якщо нічого не знайшли, беремо початок документа
    return content.substring(0, 1500);
  }

  buildSimpleContext(userMessage: string): string {
    return `Ти - український юрист-асистент.

ПИТАННЯ: ${userMessage}

ПРАВИЛА ВІДПОВІДІ:
1. Відповідай українською мовою
2. Якщо це юридичне питання - порадь звернутися до конкретних законів
3. Давай загальні рекомендації без цитування законів
4. Будь ввічливим та професійним
5. Не вигадуй неіснуючі закони

УВАГА: Зараз у тебе немає доступу до бази законів, тому давай загальні поради.`;
  }

  // Хешування питання для кешування
  async hashQuestion(question: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(question.toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Отримання кешованої відповіді
  async getCachedResponse(supabase: any, questionHash: string): Promise<any | null> {
    try {
      const { data, error } = await supabase
        .from('response_cache')
        .select('*')
        .eq('question_hash', questionHash)
        .gt('expires_at', new Date().toISOString())
        .single();

      if (error || !data) {
        return null;
      }

      return {
        valid: true,
        answer_text: data.answer_text,
        tokens_used: data.tokens_used,
        law_references: data.law_references,
        classification: data.metadata?.classification || {}
      };
    } catch (error) {
      console.error('Error getting cached response:', error);
      return null;
    }
  }

  // Збереження відповіді в кеш
  async saveToCache(
    supabase: any,
    questionHash: string,
    questionText: string,
    answerText: string,
    tokensUsed: number,
    lawReferences: any[],
    classification: QuestionClassification
  ): Promise<void> {
    try {
      await supabase
        .from('response_cache')
        .upsert({
          question_hash: questionHash,
          question_text: questionText,
          answer_text: answerText,
          tokens_used: tokensUsed,
          law_references: lawReferences,
          metadata: { classification },
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 днів
        }, {
          onConflict: 'question_hash'
        });
      
      console.log('Response saved to cache');
    } catch (error) {
      console.error('Error saving to cache:', error);
      // Не критична помилка, продовжуємо
    }
  }

  // Збереження статей в таблицю legal_articles
  async saveArticlesToDatabase(
    supabase: any,
    lawId: string,
    articles: Article[],
    keywords: string[] = []
  ): Promise<void> {
    try {
      for (const article of articles) {
        // Перевіряємо чи стаття вже існує
        const { data: existing } = await supabase
          .from('legal_articles')
          .select('id')
          .eq('law_id', lawId)
          .eq('article_number', article.number)
          .single();

        if (!existing) {
          // Зберігаємо нову статтю
          await supabase
            .from('legal_articles')
            .insert({
              law_id: lawId,
              article_number: article.number,
              title: article.title || '',
              content: article.content,
              keywords: keywords.length > 0 ? JSON.stringify(keywords) : JSON.stringify([])
            });
          
          console.log(`Saved article ${article.number} to legal_articles`);
        }
      }
    } catch (error) {
      console.error('Error saving articles to database:', error);
      // Не критична помилка
    }
  }
}

// Initialize Legal Agent
const legalAgent = new LegalAgent();

async function buildRouterWhitelist(
  supabase: any,
  agent: LegalAgent
): Promise<RouterWhitelistPayload> {
  const manualEntries = agent.getManualWhitelistForRouter();
  let storageEntries: RouterWhitelistLaw[] = [];

  try {
    const { data, error } = await supabase
      .from('legal_documents_storage')
      .select('rada_nreg, title, category, theme_code, storage_bucket, storage_path')
      .eq('is_active', true);

    if (!error && Array.isArray(data)) {
      storageEntries = data
        .filter(record => record?.rada_nreg && record?.title)
        .map(record => ({
          nreg: record.rada_nreg,
          title: record.title,
          branch: mapCategoryToBranch(record.category),
          category: record.category,
          keywords: [],
          themeCode: record.theme_code,
          storageBucket: record.storage_bucket,
          storagePath: record.storage_path,
          source: 'storage' as const
        }));
    } else if (error) {
      console.warn('⚠️ Failed to load storage whitelist:', error);
    }
  } catch (error) {
    console.error('❌ Unexpected error while building storage whitelist:', error);
  }

  const index = new Map<string, RouterWhitelistLaw>();
  [...storageEntries, ...manualEntries].forEach(entry => {
    if (entry.nreg) {
      index.set(entry.nreg, entry);
    }
  });

  return { manual: manualEntries, storage: storageEntries, index };
}

async function runRouterModel(options: {
  client: OpenAI;
  userMessage: string;
  conversationHistory: any[];
  whitelist: RouterWhitelistPayload;
}): Promise<RouterDecision | null> {
  const { client, userMessage, conversationHistory, whitelist } = options;

  const historyContext = conversationHistory
    .slice(-2)
    .map(msg => {
      if (!msg || typeof msg !== 'object') {
        return '';
      }
      const role = msg.role || 'user';
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
          ? msg.content.map((item: any) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')
          : JSON.stringify(msg.content || '');
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join('\n');

  const formatEntries = (entries: RouterWhitelistLaw[], limit?: number) => {
    if (!entries.length) {
      return '';
    }
    const sliceEnd = limit ? Math.min(limit, entries.length) : entries.length;
    const summary = entries
      .slice(0, sliceEnd)
      .map(
        entry =>
          `${entry.nreg} — ${entry.title} — гілка: ${entry.branch}${
            entry.category ? ` — категорія: ${entry.category}` : ''
          }`
      )
      .join('\n');
    if (entries.length > sliceEnd) {
      return `${summary}\n... і ще ${entries.length - sliceEnd} документів`;
    }
    return summary;
  };

  const manualSummary = formatEntries(whitelist.manual, 60) || 'Немає ручних законів';
  const storageSummary = formatEntries(whitelist.storage, 60) || 'Немає законів у storage';

  const routerPrompt = [
    `Питання користувача: "${userMessage}"`,
    historyContext ? `Контекст діалогу:\n${historyContext}` : '',
    'Whitelist ручних законів:',
    manualSummary,
    '\nWhitelist законів зі storage:',
    storageSummary,
    '\nПоясни коротко свій вибір у полі reasoning.'
  ]
    .filter(Boolean)
    .join('\n\n');

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: routerPrompt }
      ],
      response_format: { type: 'json_object' }
    });
  } catch (error) {
    console.warn('Router JSON response_format unsupported, retrying without strict mode');
    completion = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: routerPrompt }
      ]
    });
  }

  const responseText = completion.choices[0]?.message?.content || '';
  const parsed = JSON.parse(responseText) as RouterDecision;

  const normalizedBranch = typeof parsed.branch === 'string'
    ? (parsed.branch as string).toLowerCase()
    : 'other';
  parsed.branch = ROUTER_ALLOWED_BRANCHES.includes(normalizedBranch as RouterBranch)
    ? (normalizedBranch as RouterBranch)
    : 'other';

  if (
    parsed.recommended_nreg &&
    !whitelist.index.has(parsed.recommended_nreg)
  ) {
    parsed.recommended_nreg = null;
  }
  if (parsed.recommended_nreg) {
    parsed.recommended_nreg = parsed.recommended_nreg.trim();
  }
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
  parsed.reasoning = parsed.reasoning?.trim() || '';

  return parsed;
}

type NormalizedChatMessage = { role: 'user' | 'assistant'; content: string };

interface SelectedLLM {
  provider: string;
  model: string;
  systemPrompt: string;
  sendChat: (payload: {
    system: string;
    messages: NormalizedChatMessage[];
    temperature: number;
    maxTokens: number;
  }) => Promise<{ response: string; tokensUsed: number }>;
}

async function callAnthropicMessages(apiKey: string, payload: Record<string, unknown>) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${errorBody}`);
  }

  return response.json();
}

function selectMainModel(options: {
  provider?: string | null;
  model?: string | null;
  openaiClient: OpenAI;
  anthropicApiKey?: string | null;
}): SelectedLLM {
  const provider = (options.provider || DEFAULT_MAIN_PROVIDER).toLowerCase();

  if (provider === 'anthropic') {
    if (!options.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    const model = options.model || DEFAULT_ANTHROPIC_MODEL;
    return {
      provider: 'anthropic',
      model,
      systemPrompt: SYSTEM_PROMPT_CLAUDE_HAIKU_ANSWER,
      sendChat: async ({ system, messages, temperature, maxTokens }) => {
        const anthropicMessages = messages.map(message => ({
          role: message.role,
          content: [{ type: 'text', text: message.content }]
        }));
        const payload = {
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages: anthropicMessages
        };
        const result = await callAnthropicMessages(options.anthropicApiKey!, payload);
        const text = Array.isArray(result?.content)
          ? result.content.map((block: any) => block?.text || '').join('\n').trim()
          : '';
        const usage = result?.usage || {};
        const tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);
        return { response: text, tokensUsed };
      }
    };
  }

  const model = options.model || DEFAULT_OPENAI_MODEL;
  return {
    provider: 'openai',
    model,
    systemPrompt: SYSTEM_PROMPT_GPT3_ANSWER,
    sendChat: async ({ system, messages, temperature, maxTokens }) => {
      const completion = await options.openaiClient.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: system },
          ...messages
        ],
        temperature,
        max_tokens: maxTokens
      });
      const content = completion.choices[0]?.message?.content?.trim() || '';
      const tokensUsed = completion.usage?.total_tokens || 0;
      return { response: content, tokensUsed };
    }
  };
}

function normalizeChatHistory(rawMessages: any[], limit: number = 5): NormalizedChatMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const normalized: NormalizedChatMessage[] = [];
  for (const message of rawMessages) {
    if (!message) {
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
      ? message.content.map((chunk: any) =>
          typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
        ).join(' ')
      : typeof message.content === 'object' && message.content !== null && 'text' in message.content
      ? String(message.content.text)
      : JSON.stringify(message.content ?? '');

    if (content && content.trim()) {
      normalized.push({ role, content: content.trim() });
    }
  }

  return normalized.slice(-limit);
}

// Main handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Логування вхідного запиту (детальне)
  const requestId = crypto.randomUUID();
  console.log(`\n=== Edge Function Request [${requestId}] ===`);
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', {
    'content-type': req.headers.get('content-type'),
    'authorization': req.headers.get('authorization') ? 'present' : 'missing',
    'user-agent': req.headers.get('user-agent')
  });
  
  // Оголошуємо body на рівні функції для доступу в catch
  let body: any = undefined;

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
      Deno.env.get('SERVICE_KEY_NEW_SUPABASE');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseKey = supabaseServiceKey || supabaseAnonKey;
    
    if (!supabaseUrl || !supabaseKey) {
      console.error('❌ Missing Supabase environment variables');
      throw new Error('Supabase environment variables not set');
    }
    
    const supabaseKeyType = supabaseServiceKey ? 'service' : 'anon';
    console.log('✅ Supabase configured:', {
      url: supabaseUrl,
      keyPresent: !!supabaseKey,
      keyType: supabaseKeyType
    });

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    // Initialize OpenAI
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      console.error('❌ Missing OpenAI API key');
      throw new Error('OpenAI API key not set');
    }
    
    console.log('✅ OpenAI configured');

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const routerApiKey =
      Deno.env.get('OPENAI_ROUTER_API_KEY') || Deno.env.get('GPT_ROUTER_API_KEY');
    const routerClient = routerApiKey ? new OpenAI({ apiKey: routerApiKey }) : null;
    if (!routerClient) {
      console.warn('⚠️ Router API key not provided, falling back to legacy classification');
    }
    const anthropicApiKey =
      Deno.env.get('ANTHROPIC_API_KEY') || Deno.env.get('CLAUDE_API_KEY');
    const supremeCourtService = new SupremeCourtCaseLawService({ supabase, openai });

    // Parse request body (body вже оголошено вище)
    try {
      const bodyText = await req.text();
      console.log('Request body (first 500 chars):', bodyText.substring(0, 500));
      
      if (!bodyText || bodyText.trim().length === 0) {
        console.error('❌ Empty request body');
        return new Response(
          JSON.stringify({ error: 'Request body is required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      body = JSON.parse(bodyText);
      console.log('✅ Body parsed successfully');
    } catch (error) {
      console.error('❌ Failed to parse JSON:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Invalid JSON',
          details: error instanceof Error ? error.message : 'Unknown parsing error'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { messages, sessionId, userMessage } = body;
    const isPremiumUser = Boolean(body?.isPremiumUser);

    if (!userMessage) {
      console.error('❌ Missing userMessage in request');
      return new Response(
        JSON.stringify({ error: 'userMessage is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Якщо messages не надано - створюємо базовий масив
    const messageHistory = messages || [{ role: 'user', content: userMessage }];

    console.log(`✅ [${requestId}] Chat request received:`, { 
      sessionId: sessionId || 'no-session', 
      messageLength: userMessage.length,
      hasMessages: !!messages,
      messagesCount: messageHistory.length,
      userMessagePreview: userMessage.substring(0, 100)
    });

    // КРОК 0: Перевірка кешу
    const questionHash = await legalAgent.hashQuestion(userMessage);
    const cachedResponse = await legalAgent.getCachedResponse(supabase, questionHash);
    
    if (cachedResponse && cachedResponse.valid) {
      console.log('✅ Using cached response');
      return new Response(
        JSON.stringify({
          response: cachedResponse.answer_text,
          tokensUsed: cachedResponse.tokens_used || 0,
          sessionId: sessionId || 'unknown',
          sources: cachedResponse.law_references || [],
          fromCache: true,
          classification: cachedResponse.classification || {}
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    let routerWhitelist: RouterWhitelistPayload | null = null;
    let routerDecision: RouterDecision | null = null;
    if (routerClient) {
      try {
        routerWhitelist = await buildRouterWhitelist(supabase, legalAgent);
        routerDecision = await runRouterModel({
          client: routerClient,
          userMessage,
          conversationHistory: messageHistory,
          whitelist: routerWhitelist
        });
        console.log('Router decision:', routerDecision);
      } catch (routerError) {
        console.error('Router classification failed:', routerError);
      }
    }

    let classification: QuestionClassification;
    try {
      classification = await legalAgent.classifyQuestion(openai, userMessage);
      console.log('Question classified:', classification);
    } catch (classificationError) {
      console.error('Classification failed, using fallback:', classificationError);
      classification = legalAgent.fallbackClassification(userMessage);
      console.log('Using fallback classification:', classification);
    }

    classification = legalAgent.mergeClassificationWithRouterSignals(classification, routerDecision, {
      userMessage,
      whitelistIndex: routerWhitelist?.index
    });

    const routerSuggestedNreg = routerDecision?.recommended_nreg || null;

    let manualMatch: ManualLawMapping | null = null;
    if (routerSuggestedNreg) {
      manualMatch = legalAgent.getManualLawMappingByNreg(routerSuggestedNreg);
      if (manualMatch) {
        classification = legalAgent.enrichClassificationWithManualMatch(
          classification,
          manualMatch,
          userMessage
        );
      }
    }

    if (!manualMatch && !routerSuggestedNreg) {
      const detectedManual = legalAgent.detectManualLawTarget(userMessage, classification);
      if (detectedManual) {
        manualMatch = detectedManual;
        classification = legalAgent.enrichClassificationWithManualMatch(
          classification,
          manualMatch,
          userMessage
        );
      }
    }

    if (manualMatch) {
      console.log(`📘 Detected manual law candidate: ${manualMatch.title} (${manualMatch.nreg})`);
    }

    let context: string;
    let sources: any[] = [];
    let lawTitle: string | undefined;
    let relevantArticles: Article[] = [];
    let documents: Document[] = [];
    let manualDocument: Document | null = null;
    let routerDocument: Document | null = null;
    let supremeCourtCases: any[] = [];
    let supremeCourtDurationMs = 0;

    if (manualMatch) {
      try {
        manualDocument = await legalAgent.ensureManualLawAvailability(
          supabase,
          manualMatch,
          classification,
          userMessage
        );
        if (manualDocument) {
          console.log(`📘 Manual document loaded for ${manualMatch.title}`);
        } else {
          console.warn(`⚠️ Manual document not available for ${manualMatch.title}, falling back to search`);
        }
      } catch (error) {
        console.error(`❌ Manual document fetch error for ${manualMatch.title}:`, error);
      }
    }

    if (!manualMatch && routerSuggestedNreg) {
      try {
        routerDocument = await legalAgent.loadDocumentByNreg(
          supabase,
          routerSuggestedNreg,
          classification
        );
        if (routerDocument) {
          console.log(`📘 Router document loaded for NREG ${routerSuggestedNreg}`);
        }
      } catch (error) {
        console.error(`❌ Router document fetch error for ${routerSuggestedNreg}:`, error);
      }
    }

    // КРОК 2: Якщо це юридичне питання - шукаємо закони
    if (classification.isLegalQuestion && classification.confidence > 0.5) {
      // Спочатку шукаємо в локальній базі (використовуємо Supabase функції)
      console.log(`🔍 MAIN: About to call searchInDatabase with classification:`, JSON.stringify({
        requiredCodex: classification.requiredCodex,
        articleNumber: classification.articleNumber,
        category: classification.category
      }, null, 2));
      
      if (manualDocument) {
        documents = [manualDocument];
      } else if (routerDocument) {
        documents = [routerDocument];
      } else {
        documents = await legalAgent.searchInDatabase(supabase, classification, 5, {
          manualMatch,
          userMessage,
          targetNreg: routerSuggestedNreg
        });
      }
      
      console.log(`🔍 MAIN: searchInDatabase returned ${documents.length} documents`);
      
      // Якщо не знайдено в локальній базі - викликаємо Backend API для Rada API
      // ВИКЛИКАЄМО ЗАВЖДИ для актуальних законів (якщо це юридичне питання)
      const shouldSearchAPI =
        ((!manualDocument && !routerDocument) || documents.length === 0) &&
        classification.isLegalQuestion &&
        classification.confidence > 0.6;
      
      if (shouldSearchAPI) {
        console.log('🔍 Searching via Backend API (Rada API) for fresh laws...');
        const backendLaws = await legalAgent.searchViaBackendAPI(classification, documents.length === 0 ? 5 : 3);
        
        if (backendLaws.length > 0) {
          // Зберігаємо нові закони в базу
          for (const law of backendLaws) {
            try {
              await legalAgent.saveLawToDatabase(supabase, law);
              console.log(`💾 Saved law to database: ${law.title}`);
            } catch (saveError) {
              console.warn('Failed to save law:', saveError);
            }
          }
          
          // Додаємо нові закони до існуючих (якщо є) або замінюємо
          if (documents.length === 0) {
            documents = backendLaws;
          } else {
            // Об'єднуємо, уникаючи дублікатів
            const existingIds = new Set(documents.map(d => d.id));
            const newLaws = backendLaws.filter(l => !existingIds.has(l.id));
            documents = [...documents, ...newLaws].slice(0, 5);
          }
          
          console.log(`✅ Found ${backendLaws.length} new laws via Backend API (Rada API), total: ${documents.length}`);
        } else {
          console.log('⚠️ No laws found via Backend API, using local database results');
        }
      }
      
      // Якщо все ще не знайдено - спробуємо пошук за категорією
      if (documents.length === 0 && classification.category !== 'загальне') {
        const { data: categoryResults } = await supabase
          .from('legal_laws')
          .select('*')
          .ilike('category', `%${classification.category}%`)
          .limit(3);
        
        if (categoryResults && categoryResults.length > 0) {
          documents = categoryResults;
          console.log(`Found ${documents.length} documents by category`);
        }
      }
      
      // Якщо все ще не знайдено - використовуємо загальний пошук
      if (documents.length === 0 && classification.searchKeywords.length > 0) {
        const { data: keywordResults } = await supabase
        .from('legal_laws')
        .select('*')
          .ilike('title', `%${classification.searchKeywords[0]}%`)
          .limit(3);
        
        if (keywordResults && keywordResults.length > 0) {
          documents = keywordResults;
          console.log(`Found ${documents.length} documents by keywords`);
        }
      }

      if (documents.length > 0) {
        console.log(`📚 Found ${documents.length} documents, forming sources...`);
        console.log(`📚 Documents:`, documents.map(d => `${d.title} (articles: ${Array.isArray(d.articles) ? d.articles.length : 'none'})`).join(', '));
        
        // Витягуємо конкретні статті (спочатку з legal_articles, потім з документів)
        const extractionLimit = classification.articleNumber ? 3 : 6;
        const skipDbArticles = !!manualDocument || !!routerDocument;
        relevantArticles = await legalAgent.extractRelevantArticles(
          supabase,
          documents,
          classification,
          extractionLimit,
          { skipDatabaseLookup: skipDbArticles }
        );
        
        console.log(`Extracted ${relevantArticles.length} relevant articles from ${documents.length} documents`);
        
        // Формуємо sources навіть якщо статей немає
        if (documents.length > 0) {
          // Формуємо sources з документів
          sources = documents.slice(0, 2).map(doc => {
            const docArticles = legalAgent.buildSourceArticlesForDoc(
              doc,
              relevantArticles,
              classification
            );
            if (docArticles.length > 0) {
              console.log(`📚 Source articles for ${doc.title}: ${docArticles.join(', ')}`);
            }
            return {
              title: doc.title,
              url: doc.source_url,
              lawNumber: doc.law_number || doc.rada_nreg || '',
              articles: docArticles
            };
          });
          console.log(`📚 Formed ${sources.length} sources from documents:`, JSON.stringify(sources, null, 2));
        }
        
        if (relevantArticles.length > 0) {
          lawTitle = documents[0]?.title;
          context = legalAgent.buildOptimizedContext(
            userMessage,
            classification,
            relevantArticles,
            lawTitle
          );
          
          // Sources вже сформовані вище, не перезаписуємо
          console.log(`📚 Using already formed ${sources.length} sources with articles`);
        } else {
          // Якщо статей немає, парсимо їх з тексту
          console.log('No articles found, parsing from text...');
          const parsedArticles = await legalAgent.extractRelevantArticles(
            supabase,
            documents.map(d => ({ ...d, articles: undefined })), // Примусово парсимо з тексту
            classification,
            extractionLimit,
            { skipDatabaseLookup: skipDbArticles }
          );
          
          if (parsedArticles.length > 0) {
            lawTitle = documents[0]?.title;
            context = legalAgent.buildOptimizedContext(
              userMessage,
              classification,
              parsedArticles,
              lawTitle
            );
            sources = documents.slice(0, 1).map(doc => ({
              title: doc.title,
              url: doc.source_url,
              lawNumber: doc.law_number,
              articles: legalAgent.buildSourceArticlesForDoc(doc, parsedArticles, classification)
            }));
          } else {
            // Якщо все ще немає статей, використовуємо релевантну частину документа
            lawTitle = documents[0]?.title;
            const content = legalAgent.extractRelevantContent(documents[0]?.content || '', classification);
            context = legalAgent.buildOptimizedContext(
              userMessage,
              classification,
              [{ number: '1', title: 'Релевантний фрагмент', content }],
              lawTitle
            );
            // Формуємо sources навіть якщо статей немає
            sources = documents.slice(0, 2).map(doc => ({
              title: doc.title,
              url: doc.source_url,
              lawNumber: doc.law_number || doc.rada_nreg || '',
              articles: legalAgent.buildSourceArticlesForDoc(doc, [], classification)
            }));
            console.log(`📚 Formed ${sources.length} sources from documents (no articles extracted):`, JSON.stringify(sources, null, 2));
          }
        }
        
        // КРИТИЧНО: Якщо documents.length > 0, але sources все ще порожній - формуємо sources примусово
        if (documents.length > 0 && sources.length === 0) {
          console.warn(`⚠️ CRITICAL: Documents found but sources empty! Forcing sources creation...`);
          sources = documents.slice(0, 2).map(doc => ({
            title: doc.title || 'Документ',
            url: doc.source_url || '',
            lawNumber: doc.law_number || doc.rada_nreg || '',
            articles: legalAgent.buildSourceArticlesForDoc(doc, relevantArticles, classification)
          }));
          console.log(`📚 Forced creation of ${sources.length} sources:`, JSON.stringify(sources, null, 2));
        }
      } else {
        context = legalAgent.buildSimpleContext(userMessage);
      }
    } else {
      // Якщо не юридичне питання
      context = legalAgent.buildSimpleContext(userMessage);
    }

    const supremeCourtStart = Date.now();
    try {
      const shouldUseSupremeCourt = await supremeCourtService.shouldUseSupremeCourt({
        userMessage,
        classification,
        isPremiumUser
      });

      if (shouldUseSupremeCourt) {
        supremeCourtCases = await supremeCourtService.vectorSearch({
          query: userMessage,
          isPremiumUser,
          limit: 3
        });
        const supremeCourtContext = supremeCourtService.formatCaseLawForLLM(supremeCourtCases);
        if (supremeCourtContext) {
          context = `${context}\n\n${supremeCourtContext}`;
        }
      }
    } catch (supremeError) {
      console.error('Supreme Court integration failed:', supremeError);
    } finally {
      supremeCourtDurationMs = Date.now() - supremeCourtStart;
    }

    // КРОК 3: Генерація відповіді через LLM з валідацією
    const normalizedHistory = normalizeChatHistory(messageHistory, 5);
    if (
      normalizedHistory.length === 0 ||
      normalizedHistory[normalizedHistory.length - 1].role !== 'user'
    ) {
      normalizedHistory.push({ role: 'user', content: userMessage });
    }

    let selectedModel: SelectedLLM;
    try {
      selectedModel = selectMainModel({
        provider: Deno.env.get('MAIN_LLM_PROVIDER'),
        model: Deno.env.get('MAIN_LLM_MODEL'),
        openaiClient: openai,
        anthropicApiKey
      });
    } catch (modelSelectionError) {
      console.warn('⚠️ LLM selection failed, falling back to OpenAI:', modelSelectionError);
      selectedModel = selectMainModel({
        provider: 'openai',
        model: DEFAULT_OPENAI_MODEL,
        openaiClient: openai
      });
    }

    const baseSystemMessage = `${selectedModel.systemPrompt}\n\n${context}`;
    let dynamicSystemMessage = baseSystemMessage;

    let response = '';
    let tokensUsed: number = 0;
    let validationAttempts = 0;
    const maxValidationAttempts = 2;

    while (validationAttempts <= maxValidationAttempts) {
      const result = await selectedModel.sendChat({
        system: dynamicSystemMessage,
        messages: normalizedHistory,
        temperature: validationAttempts === 0 ? 0.7 : 0.3,
        maxTokens: 1000
      });

      response = result.response || 'Вибачте, не вдалося згенерувати відповідь.';
      tokensUsed = result.tokensUsed || 0;

      // Валідація відповіді (тільки якщо є статті)
      if (sources.length > 0 && relevantArticles && relevantArticles.length > 0) {
        const validation = await legalAgent.validateResponse(
          response,
          relevantArticles,
          documents
        );

        if (validation.valid || validationAttempts >= maxValidationAttempts) {
          if (!validation.valid && validation.issues.length > 0) {
            console.warn('Response validation issues:', validation.issues);
          }
          break;
        }

        // Якщо є проблеми - додаємо більш строгі інструкції та регенеруємо
        if (validation.needsRegeneration) {
          console.log(`Regenerating response (attempt ${validationAttempts + 1}/${maxValidationAttempts})`);
          dynamicSystemMessage = `${baseSystemMessage}\n\nУВАГА: Попередня відповідь містила помилки. Відповідай ТІЛЬКИ на основі наданих статей, обов'язково цитуй конкретні статті.`;
          validationAttempts++;
          continue;
        }
      }

      break;
    }

    console.log('Response generated:', { 
      tokensUsed, 
      sourcesCount: sources.length,
      documentsFound: documents.length,
      articlesFound: relevantArticles.length,
      classification: classification.isLegalQuestion ? classification.requiredCodex : 'not legal',
      llmProvider: selectedModel.provider,
      llmModel: selectedModel.model
    });

    const supremeCourtAnswerBlock = SupremeCourtCaseLawService.formatCaseLawForAnswer(
      supremeCourtCases
    );
    if (supremeCourtAnswerBlock) {
      response = `${response}\n${supremeCourtAnswerBlock}`;
    }

    // Зберігаємо в кеш (якщо це юридичне питання)
    if (classification.isLegalQuestion && response && response.length > 50) {
      legalAgent.saveToCache(
        supabase,
        questionHash,
        userMessage,
        response,
        tokensUsed,
        sources,
        classification
      ).catch(err => console.error('Cache save error:', err));
    }

    // Зберігаємо статті в legal_articles (якщо знайдені)
    if (documents.length > 0 && relevantArticles.length > 0) {
      for (const doc of documents.slice(0, 1)) {
        if (doc.id) {
          legalAgent.saveArticlesToDatabase(
            supabase,
            doc.id,
            relevantArticles,
            classification.searchKeywords
          ).catch(err => console.error('Articles save error:', err));
        }
      }
    }

    // Детальна інформація для відлагодження
    const debugInfo = {
      classification: {
        isLegal: classification.isLegalQuestion,
        confidence: classification.confidence,
        codex: classification.requiredCodex,
        article: classification.articleNumber,
        category: classification.category,
        questionType: classification.questionType
      },
      search: {
        documentsFound: documents.length,
        articlesFound: relevantArticles.length,
        sourcesCount: sources.length
      },
      performance: {
        tokensUsed,
        fromCache: false
      },
      environment: {
        supabaseKeyType
      },
      router: routerDecision,
      supremeCourt: {
        enabled: supremeCourtCases.length > 0,
        cases: supremeCourtCases.length,
        caseIds: supremeCourtCases.map((c: any) => c.id).filter(Boolean),
        similarities: supremeCourtCases
          .map((c: any) => c.similarity)
          .filter((s: any) => typeof s === 'number'),
        durationMs: supremeCourtDurationMs,
        embeddingModel: 'text-embedding-3-small',
        datasetYear: (() => {
          const years = supremeCourtCases
            .map((c: any) => c.metadata?.datasetYear)
            .filter((y: any) => typeof y === 'number');
          return years.length ? Math.min(...years) : null;
        })(),
        classifierUsed: true
      },
      llm: {
        provider: selectedModel.provider,
        model: selectedModel.model
      }
    };

    return new Response(
      JSON.stringify({
        response,
        tokensUsed,
        sessionId: sessionId || 'unknown',
        sources,
        classification: debugInfo.classification,
        supremeCourtCases,
        fromCache: false,
        debug: debugInfo // Додаємо для тестування
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error(`\n❌ [${requestId}] Chat function error:`, error);
    console.error(`❌ [${requestId}] Error stack:`, error instanceof Error ? error.stack : 'No stack');
    
    // Спробуємо отримати body якщо він був розпарсений
    let bodyInfo = 'No body';
    try {
      if (typeof body !== 'undefined' && body !== null) {
        bodyInfo = JSON.stringify(body).substring(0, 200);
      }
    } catch {
      bodyInfo = 'Body exists but cannot be stringified';
    }
    
    console.error(`❌ [${requestId}] Error details:`, {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Unknown',
      body: bodyInfo,
      url: req.url,
      method: req.method
    });
    
    // Детальна обробка різних типів помилок
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    
    if (error instanceof Error) {
      if (error.message.includes('Supabase') || error.message.includes('environment variables')) {
        statusCode = 500;
        errorMessage = 'Database configuration error';
      } else if (error.message.includes('OpenAI') || error.message.includes('API key')) {
        statusCode = 500;
        errorMessage = 'AI service configuration error';
      } else if (error.message.includes('timeout')) {
        statusCode = 504;
        errorMessage = 'Request timeout';
      } else {
        errorMessage = error.message;
      }
    }
    
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        message: error instanceof Error ? error.message : 'Unknown error',
        type: error instanceof Error ? error.name : 'UnknownError'
      }),
      { 
        status: statusCode, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
