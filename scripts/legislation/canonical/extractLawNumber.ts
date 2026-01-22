/**
 * Extract Law Number — витягування номера закону з різних джерел
 * 
 * Джерела (у порядку пріоритету):
 * 1. JSON card/show: organs.orgnum (official source)
 * 2. nreg (якщо він містить номер закону)
 * 3. regex з назви: "№ XXX", "(XXX)", "XXX-XX"
 * 4. з назви для законів/кодексів: пошук номеру/ріку
 */

export interface LawNumberExtraction {
  law_number: string | null;
  source: 'orgnum' | 'nreg' | 'title' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Витягує номер закону з даних документу
 */
export function extractLawNumber(params: {
  nazva: string;
  nreg: string;
  jsonData: any;
}): LawNumberExtraction {
  const { nazva, nreg, jsonData } = params;

  // 1. Спробуємо з organs.orgnum (official source, найвищий пріоритет)
  const orgnum = jsonData?.orgnum || jsonData?.meta?.orgnum || jsonData?.metadata?.orgnum;
  if (orgnum && typeof orgnum === 'string' && isValidLawNumber(orgnum)) {
    // orgnum завжди має пріоритет якщо валідний
    return {
      law_number: normalizeLawNumber(orgnum),
      source: 'orgnum',
      confidence: 'high',
    };
  }

  // 2. Спробуємо з nreg (якщо він містить формат номера закону)
  if (isValidLawNumber(nreg) && !isNregOnly(nreg)) {
    return {
      law_number: normalizeLawNumber(nreg),
      source: 'nreg',
      confidence: 'high',
    };
  }

  // 3. Regex з назви (найбільш поширені формати)
  const titleMatch = nazva.match(/(?:№|номер)\s*(\d+[-\/]\d+)/i) ||
                     nazva.match(/\((\d+[-\/]\d+)\)/) ||
                     nazva.match(/\[(\d+[-\/]\d+)\]/);
  
  if (titleMatch && titleMatch[1]) {
    const extracted = titleMatch[1].trim();
    if (isValidLawNumber(extracted)) {
      return {
        law_number: normalizeLawNumber(extracted),
        source: 'title',
        confidence: 'medium',
      };
    }
  }

  // 4. Для законів/кодексів: шукаємо номер у назві
  const lowerNazva = nazva.toLowerCase();
  if (lowerNazva.includes('закон') || lowerNazva.includes('кодекс')) {
    // Паттерн "Закон України № XXX" або "XXX року"
    const lawMatch = nazva.match(/№\s*(\d+[-\/]\d+)/i) ||
                     nazva.match(/(\d+[-\/]\d+)\s+року/i) ||
                     nazva.match(/\((\d+[-\/]\d+)\)/);
    
    if (lawMatch && lawMatch[1]) {
      const extracted = lawMatch[1].trim();
      if (isValidLawNumber(extracted)) {
        return {
          law_number: normalizeLawNumber(extracted),
          source: 'title',
          confidence: 'medium',
        };
      }
    }
  }

  return {
    law_number: null,
    source: 'none',
    confidence: 'low',
  };
}

/**
 * Перевіряє чи рядок виглядає як номер закону
 */
function isValidLawNumber(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  
  const trimmed = str.trim();
  
  // Паттерни: "435-15", "2341-III", "57-95-п", "254к/96-вр", "3543-XII"
  // Підтримуємо римські цифри після дефісу/слешу
  const basePattern = /^\d+[-\/](\d+|[IVX]+)([а-яіїєa-z]|-[а-яіїєa-z])?$/i;
  
  return basePattern.test(trimmed);
}

/**
 * Перевіряє чи nreg виглядає тільки як ідентифікатор (не номер закону)
 */
function isNregOnly(nreg: string): boolean {
  // Nreg може бути просто ідентифікатором без номера закону
  // Якщо містить лише спеціальні символи без цифр-дефіс-цифри патерну
  return !/\d+[-\/]\d+/.test(nreg);
}

/**
 * Нормалізує номер закону (уніфікує формати)
 */
function normalizeLawNumber(lawNumber: string): string {
  return lawNumber.trim();
}
