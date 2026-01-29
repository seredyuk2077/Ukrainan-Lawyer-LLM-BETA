/**
 * Kind Extractor — визначення виду акта (НАКАЗ, ПОСТАНОВА, тощо) з префіксу тексту
 * 
 * KIND-FIRST логіка: спочатку визначаємо вид акта, потім issuer
 * Це запобігає хибним CMU сигналам, коли "Кабінету Міністрів" згадується як посилання
 */

export enum DocumentKind {
  NAKAZ = 'NAKAZ',
  POSTANOVA = 'POSTANOVA',
  ROZPORYADZHENNYA = 'ROZPORYADZHENNYA',
  DEKRET = 'DEKRET',
  UKAZ = 'UKAZ',
  RISHENNYA = 'RISHENNYA',
  ROZJASNENNYA = 'ROZJASNENNYA',  // Роз'яснення
  UNKNOWN = 'UNKNOWN',
}

export enum DocumentIssuer {
  CMU = 'CMU',
  VR = 'VR',
  PRESIDENT = 'PRESIDENT',
  CEC = 'CEC',
  RNBO = 'RNBO',
  NBU = 'NBU',
  NERC = 'NERC',
  MINISTRY = 'MINISTRY',
  COMMITTEE = 'COMMITTEE',
  SERVICE = 'SERVICE',
  AGENCY = 'AGENCY',
  INSPECTION = 'INSPECTION',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Нормалізує текст для перевірки (прибирає розрядку, приводить до UPPERCASE)
 * ВАЖЛИВО: зберігає переноси для regex перевірки kind
 */
function normalizePrefix(text: string | null | undefined, maxLength: number = 400, preserveNewlines: boolean = false): string {
  if (!text) return '';
  
  let normalized = text
    .trim()
    .toUpperCase();
  
  if (!preserveNewlines) {
    normalized = normalized.replace(/[\n\t\r]/g, ' ');
  } else {
    // Замінюємо тільки табуляції на пробіли, зберігаємо переноси
    normalized = normalized.replace(/\t/g, ' ');
  }
  
  normalized = normalized.replace(/["'«»]/g, '');
  
  // Прибираємо розрядку: якщо є послідовність "ЛІТЕРА ПРОБІЛ ЛІТЕРА ПРОБІЛ ЛІТЕРА..." (3+ літери)
  normalized = normalized.replace(/([А-ЯІЇЄҐ])\s+([А-ЯІЇЄҐ])\s+([А-ЯІЇЄҐ])(\s+[А-ЯІЇЄҐ])*/g, (match) => {
    return match.replace(/\s+/g, '');
  });
  
  // Після прибирання розрядки collapse whitespace (але зберігаємо переноси якщо preserveNewlines)
  if (preserveNewlines) {
    normalized = normalized.replace(/[ \t]+/g, ' ');  // Тільки пробіли та табуляції
  } else {
    normalized = normalized.replace(/\s+/g, ' ');
  }
  
  return normalized.substring(0, maxLength);
}

/**
 * Визначає вид акта (kind) з префіксу тексту
 * 
 * Правила:
 * - Шукаємо якірні слова (НАКАЗ, ПОСТАНОВА, тощо) у перших 200-400 символах
 * - Використовуємо regex для точного визначення на початку рядка або після переносу
 */
export function extractKindFromPrefix(
  raw_txt?: string | null,
  snippet?: string | null,
  summary?: string | null
): DocumentKind {
  // Для kind extraction спочатку перевіряємо оригінальний текст (для розпізнавання з розрядкою)
  const originalPrefix = (raw_txt || snippet || summary || '').substring(0, 400).toUpperCase();
  // Потім нормалізуємо для інших перевірок
  const prefix = normalizePrefix(raw_txt || snippet || summary, 400, true);
  
  // РОЗ'ЯСНЕННЯ: має найвищий пріоритет (перевіряємо ПЕРШИМ, бо може бути з розрядкою)
  // Використовуємо простий підхід: перевіряємо чи є "ЯСНЕННЯ" і перед ним є "Р", "О", "З" (з розрядкою або без)
  if (originalPrefix.includes('ЯСНЕННЯ')) {
    const yasnennyaIndex = originalPrefix.indexOf('ЯСНЕННЯ');
    const beforeYasnennya = originalPrefix.substring(Math.max(0, yasnennyaIndex - 10), yasnennyaIndex);
    // Перевіряємо чи перед "ЯСНЕННЯ" є "Р", "О", "З" (може бути з розрядкою)
    if ((beforeYasnennya.includes('Р') && beforeYasnennya.includes('О') && beforeYasnennya.includes('З')) ||
        beforeYasnennya.includes('РОЗ')) {
      return DocumentKind.ROZJASNENNYA;
    }
  }
  // Також перевіряємо нормалізований текст (після прибирання розрядки)
  if (prefix.includes('РОЗ') && prefix.includes('ЯСНЕННЯ')) {
    const rozIndex = prefix.indexOf('РОЗ');
    const yasnennyaIndex = prefix.indexOf('ЯСНЕННЯ');
    if (yasnennyaIndex > rozIndex && yasnennyaIndex - rozIndex < 15) {
      return DocumentKind.ROZJASNENNYA;
    }
  }
  
  // Якірні regex правила (починається з слова або після переносу/пробілу)
  // ВАЖЛИВО: використовуємо простіший патерн без \b (word boundary), бо він може не працювати з кирилицею
  const kindPatterns: Array<{ pattern: RegExp; kind: DocumentKind; useOriginal?: boolean }> = [
    // НАКАЗ: на початку або після переносу/пробілу, перед яким може бути назва органу
    // Шукаємо "НАКАЗ" після переносу рядка або пробілу, але не як частину іншого слова
    { pattern: /(^|[\n\r]|\s)НАКАЗ(?=\s|$|[\n\r])/, kind: DocumentKind.NAKAZ },
    // ПОСТАНОВА
    { pattern: /(^|[\n\r]|\s)ПОСТАНОВА(?=\s|$|[\n\r])/, kind: DocumentKind.POSTANOVA },
    // РОЗПОРЯДЖЕННЯ
    { pattern: /(^|[\n\r]|\s)РОЗПОРЯДЖЕННЯ(?=\s|$|[\n\r])/, kind: DocumentKind.ROZPORYADZHENNYA },
    // ДЕКРЕТ (з урахуванням розрядки)
    { pattern: /(^|[\n\r]|\s)ДЕКРЕТ(?=\s|$|[\n\r])/, kind: DocumentKind.DEKRET },
    // УКАЗ
    { pattern: /(^|[\n\r]|\s)УКАЗ(?=\s|$|[\n\r])/, kind: DocumentKind.UKAZ },
    // РІШЕННЯ
    { pattern: /(^|[\n\r]|\s)РІШЕННЯ(?=\s|$|[\n\r])/, kind: DocumentKind.RISHENNYA },
  ];
  
  // Перевіряємо в порядку пріоритету (РОЗ'ЯСНЕННЯ має найвищий пріоритет)
  for (const { pattern, kind, useOriginal } of kindPatterns) {
    const textToCheck = useOriginal ? originalPrefix : prefix;
    if (pattern.test(textToCheck)) {
      return kind;
    }
  }
  
  return DocumentKind.UNKNOWN;
}

/**
 * Визначає issuer (орган) з префіксу тексту
 * 
 * ВАЖЛИВО: працює тільки з першими 250-300 символами для "anchored" перевірки
 * Це запобігає хибним сигналам від згадок далі в тексті
 */
export function extractIssuerFromPrefix(
  raw_txt?: string | null,
  snippet?: string | null,
  summary?: string | null,
  kind?: DocumentKind
): DocumentIssuer {
  // Для anchored перевірки беремо тільки перші 300 символів
  // ВАЖЛИВО: для NAKAZ зберігаємо переноси, щоб правильно знайти індекс "НАКАЗ"
  const prefix = normalizePrefix(raw_txt || snippet || summary, 300, kind === DocumentKind.NAKAZ);
  
  // Якщо kind == NAKAZ, шукаємо issuer тільки ПЕРЕД "НАКАЗ"
  if (kind === DocumentKind.NAKAZ) {
    const nakazIndex = prefix.indexOf('НАКАЗ');
    if (nakazIndex > 0) {
      const blockBeforeNakaz = prefix.substring(0, nakazIndex);
      
      // CMU: тільки якщо "КАБІНЕТ МІНІСТРІВ" стоїть БЕЗПОСЕРЕДНЬО перед "НАКАЗ"
      if (blockBeforeNakaz.includes('КАБІНЕТУ МІНІСТРІВ') ||
          blockBeforeNakaz.includes('КАБІНЕТ МІНІСТРІВ') ||
          blockBeforeNakaz.includes('КМУ')) {
        return DocumentIssuer.CMU;
      }
      
      // Міністерство
      if (blockBeforeNakaz.includes('МІНІСТЕРСТВО')) {
        return DocumentIssuer.MINISTRY;
      }
      
      // Державний комітет
      if (blockBeforeNakaz.includes('ДЕРЖАВНИЙ КОМІТЕТ')) {
        return DocumentIssuer.COMMITTEE;
      }
      
      // Служба / Адміністрація (Державна податкова адміністрація, Державна служба тощо)
      if (blockBeforeNakaz.includes('СЛУЖБА') ||
          blockBeforeNakaz.includes('АДМІНІСТРАЦІЯ')) {
        return DocumentIssuer.SERVICE;
      }
      
      // Агентство
      if (blockBeforeNakaz.includes('АГЕНТСТВО')) {
        return DocumentIssuer.AGENCY;
      }
      
      // Інспекція
      if (blockBeforeNakaz.includes('ІНСПЕКЦІЯ')) {
        return DocumentIssuer.INSPECTION;
      }
    }
  }
  
  // Для інших видів актів перевіряємо весь префікс (але все ще обмежений 300 символами)
  // CMU (anchored: у перших 250 символах)
  const first250 = prefix.substring(0, 250);
  if (first250.includes('КАБІНЕТУ МІНІСТРІВ') ||
      first250.includes('КАБІНЕТ МІНІСТРІВ') ||
      first250.includes('КМУ')) {
    return DocumentIssuer.CMU;
  }
  
  // ВРУ
  if (prefix.includes('ВЕРХОВНА РАДА') ||
      prefix.includes('ВЕРХОВНОЇ РАДИ') ||
      prefix.includes('ВРУ')) {
    return DocumentIssuer.VR;
  }
  
  // Президент
  if (prefix.includes('ПРЕЗИДЕНТ') || prefix.includes('ПРЕЗИДЕНТА')) {
    return DocumentIssuer.PRESIDENT;
  }
  
  // ЦВК
  if (prefix.includes('ЦЕНТРАЛЬНА ВИБОРЧА') || prefix.includes('ЦВК')) {
    return DocumentIssuer.CEC;
  }
  
  // РНБО
  if (prefix.includes('РНБО') || prefix.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ')) {
    return DocumentIssuer.RNBO;
  }
  
  // НБУ
  if (prefix.includes('НАЦІОНАЛЬНИЙ БАНК') || prefix.includes('НБУ')) {
    return DocumentIssuer.NBU;
  }
  
  // НКРЕКП
  if (prefix.includes('НАЦІОНАЛЬНА КОМІСІЯ') &&
      (prefix.includes('ЕНЕРГЕТИКИ') || prefix.includes('КОМУНАЛЬНИХ'))) {
    return DocumentIssuer.NERC;
  }
  
  // Міністерство (якщо не вже визначено)
  if (prefix.includes('МІНІСТЕРСТВО')) {
    return DocumentIssuer.MINISTRY;
  }
  
  // Державний комітет
  if (prefix.includes('ДЕРЖАВНИЙ КОМІТЕТ')) {
    return DocumentIssuer.COMMITTEE;
  }
  
  return DocumentIssuer.UNKNOWN;
}
