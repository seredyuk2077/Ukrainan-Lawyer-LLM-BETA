/**
 * Signal Extractor — витягування issuer та act-kind signals з тексту
 * 
 * Використовується для правильного визначення document_type на основі:
 * - Issuer (хто видав: КМУ/ВРУ/Президент/КСУ/НКРЕКП/ЄС/тощо)
 * - Act kind (що за тип: декрет/постанова/рішення/наказ/директива/регламент)
 */

export type IssuerSignal = 
  | 'CMU'              // Кабінет Міністрів України
  | 'VRU'              // Верховна Рада України
  | 'PRESIDENT'        // Президент України
  | 'CCU'              // Конституційний Суд України
  | 'CCU_SENATE'       // Перший/Другий сенат КСУ
  | 'CEC'              // Центральна виборча комісія
  | 'RNBO'             // Рада національної безпеки і оборони
  | 'NBU'              // Національний банк України
  | 'NERC'             // НКРЕКП
  | 'MINISTRY'         // Міністерство/ЦОВВ
  | 'EU_PARLIAMENT'    // Європейський парламент
  | 'OTHER';           // Інший орган

export type ActKindSignal =
  | 'DECREE'           // Декрет
  | 'RESOLUTION'       // Постанова
  | 'ORDER'            // Розпорядження
  | 'NAKAZ'            // Наказ
  | 'DECISION'         // Рішення
  | 'DIRECTIVE'        // Директива
  | 'REGULATION'       // Регламент
  | 'AGREEMENT'        // Угода
  | 'CONVENTION'       // Конвенція
  | 'PROTOCOL';        // Протокол

export interface ExtractedSignals {
  issuer_candidates: IssuerSignal[];
  kind_candidates: ActKindSignal[];
  confidence: 'high' | 'medium' | 'low';
  top_block: string;  // Нормалізований верхній блок тексту
}

/**
 * Нормалізує верхній текст (прибирає розрядку, надлишкові пробіли)
 */
export function normalizeTopBlock(text: string | null | undefined, maxLength: number = 1000): string {
  if (!text) return '';
  
  // Спочатку прибираємо розрядку між окремими літерами (наприклад "Д Е К Р Е Т" → "ДЕКРЕТ")
  // Але зберігаємо пробіли між словами (наприклад "КАБІНЕТУ МІНІСТРІВ" → "КАБІНЕТУ МІНІСТРІВ")
  let normalized = text
    .trim()
    .toUpperCase()
    .replace(/[\n\t\r]/g, ' ')
    .replace(/["'«»]/g, '');
  
  // Прибираємо розрядку: якщо є послідовність "ЛІТЕРА ПРОБІЛ ЛІТЕРА ПРОБІЛ ЛІТЕРА..." (3+ літери)
  // то це розрядка, прибираємо пробіли між ними
  normalized = normalized.replace(/([А-ЯІЇЄҐ])\s+([А-ЯІЇЄҐ])\s+([А-ЯІЇЄҐ])(\s+[А-ЯІЇЄҐ])*/g, (match) => {
    // Прибираємо всі пробіли з послідовності літер
    return match.replace(/\s+/g, '');
  });
  
  // Після прибирання розрядки collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ');
  
  return normalized.substring(0, maxLength);
}

/**
 * Витягує issuer signals з тексту
 * 
 * PRIORITY LADDER:
 * 1. raw_txt/snippet (найвищий пріоритет) - містить заголовок документа
 * 2. summary (середній пріоритет)
 * 3. title (низький пріоритет) - може містити слова "міністерство" в контексті, але не означає що це міністерство видало
 * 4. organs (fallback)
 */
export function extractIssuerSignals(params: {
  title: string;
  snippet?: string | null;
  summary?: string | null;
  organs?: any;
  raw_txt?: string | null;  // Додано для priority ladder
}): IssuerSignal[] {
  const { title, snippet, summary, organs, raw_txt } = params;
  
  // PRIORITY 1: raw_txt (найвищий пріоритет - містить заголовок документа)
  const rawTxtBlock = raw_txt ? normalizeTopBlock(raw_txt, 800) : '';
  
  // PRIORITY 2: snippet (середній пріоритет)
  const snippetBlock = snippet ? normalizeTopBlock(snippet, 600) : '';
  
  // PRIORITY 3: summary (середній пріоритет)
  const summaryBlock = summary ? normalizeTopBlock(summary, 400) : '';
  
  // PRIORITY 4: title (низький пріоритет - тільки якщо вище не знайдено)
  const titleBlock = normalizeTopBlock(title, 200);
  
  // Комбінуємо з пріоритетом: raw_txt > snippet > summary > title
  const primaryBlock = rawTxtBlock || snippetBlock || summaryBlock || titleBlock;
  const combined = `${primaryBlock} ${titleBlock}`;
  
  const signals: IssuerSignal[] = [];
  
  // КМУ / Кабінет Міністрів (перевіряємо в primaryBlock ПЕРЕД title)
  // ВАЖЛИВО: "КАБІНЕТ МІНІСТРІВ УКРАЇНИ" в raw_txt/snippet має пріоритет над "МІНІСТЕРСТВО" в title
  if (primaryBlock.includes('КАБІНЕТУ МІНІСТРІВ') || 
      primaryBlock.includes('КАБІНЕТ МІНІСТРІВ') ||
      primaryBlock.includes('КМУ') ||
      (organs && typeof organs === 'string' && organs.includes('КМУ'))) {
    signals.push('CMU');
  }
  
  // ВРУ / Верховна Рада
  if (combined.includes('ВЕРХОВНА РАДА') ||
      combined.includes('ВЕРХОВНОЇ РАДИ') ||
      combined.includes('ВРУ') ||
      (organs && typeof organs === 'string' && organs.includes('ВРУ'))) {
    signals.push('VRU');
  }
  
  // Президент
  if (combined.includes('ПРЕЗИДЕНТ') ||
      combined.includes('ПРЕЗИДЕНТА') ||
      combined.includes('ПРЕЗИДЕНТУ')) {
    signals.push('PRESIDENT');
  }
  
  // КСУ / Конституційний Суд
  if (combined.includes('КОНСТИТУЦІЙНИЙ СУД') ||
      combined.includes('КОНСТИТУЦІЙНОГО СУДУ') ||
      combined.includes('КСУ')) {
    // Перевірка на сенат
    if (combined.includes('ПЕРШИЙ СЕНАТ') || combined.includes('ДРУГИЙ СЕНАТ')) {
      signals.push('CCU_SENATE');
    } else {
      signals.push('CCU');
    }
  }
  
  // ЦВК
  if (combined.includes('ЦЕНТРАЛЬНА ВИБОРЧА') ||
      combined.includes('ЦВК')) {
    signals.push('CEC');
  }
  
  // РНБО
  if (combined.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ') ||
      combined.includes('РАДИ НАЦІОНАЛЬНОЇ БЕЗПЕКИ') ||
      combined.includes('РНБО')) {
    signals.push('RNBO');
  }
  
  // НБУ
  if (combined.includes('НАЦІОНАЛЬНИЙ БАНК') ||
      combined.includes('НБУ')) {
    signals.push('NBU');
  }
  
  // НКРЕКП
  if (combined.includes('НАЦІОНАЛЬНА КОМІСІЯ') && 
      (combined.includes('ЕНЕРГЕТИКИ') || combined.includes('КОМУНАЛЬНИХ') || combined.includes('НКРЕКП'))) {
    signals.push('NERC');
  }
  
  // Європейський парламент
  if (combined.includes('ЄВРОПЕЙСЬКИЙ ПАРЛАМЕНТ') ||
      combined.includes('ЄВРОПЕЙСЬКОГО ПАРЛАМЕНТУ') ||
      combined.includes('ЄС') ||
      combined.includes('EUROPEAN PARLIAMENT')) {
    signals.push('EU_PARLIAMENT');
  }
  
  // Міністерство (загальний сигнал)
  // ВАЖЛИВО: тільки якщо НЕ знайдено КМУ в primaryBlock
  // Якщо primaryBlock містить "КАБІНЕТ МІНІСТРІВ" - це КМУ, не MINISTRY
  if (!signals.includes('CMU')) {
    // Перевіряємо чи є "МІНІСТЕРСТВО" в primaryBlock (не в title)
    if (primaryBlock.includes('МІНІСТЕРСТВО') && !primaryBlock.includes('КАБІНЕТ МІНІСТРІВ')) {
      signals.push('MINISTRY');
    } else if (titleBlock.includes('МІНІСТЕРСТВО') && !primaryBlock.includes('КАБІНЕТ МІНІСТРІВ')) {
      // Title може містити "Міністерства" в контексті, але це не означає що міністерство видало
      // Тільки якщо primaryBlock не містить КМУ
      signals.push('MINISTRY');
    }
  }
  
  // Якщо нічого не знайдено
  if (signals.length === 0) {
    signals.push('OTHER');
  }
  
  return signals;
}

/**
 * Витягує act-kind signals з тексту
 */
export function extractActKindSignals(params: {
  title: string;
  snippet?: string | null;
  summary?: string | null;
}): ActKindSignal[] {
  const { title, snippet, summary } = params;
  
  const topBlock = normalizeTopBlock(snippet || summary || title, 600);
  const combined = `${topBlock} ${normalizeTopBlock(title, 200)}`;
  
  const signals: ActKindSignal[] = [];
  
  // Декрет (з урахуванням розрядки)
  if (combined.includes('ДЕКРЕТ') || combined.includes('ДЕКРЕТУ')) {
    signals.push('DECREE');
  }
  
  // Постанова
  if (combined.includes('ПОСТАНОВА') || combined.includes('ПОСТАНОВИ')) {
    signals.push('RESOLUTION');
  }
  
  // Розпорядження
  if (combined.includes('РОЗПОРЯДЖЕННЯ') || combined.includes('РОЗПОРЯДЖЕННЯМ')) {
    signals.push('ORDER');
  }
  
  // Наказ
  if (combined.includes('НАКАЗ') || combined.includes('НАКАЗУ')) {
    signals.push('NAKAZ');
  }
  
  // Рішення
  if (combined.includes('РІШЕННЯ') || combined.includes('РІШЕННЯМ')) {
    signals.push('DECISION');
  }
  
  // Директива
  if (combined.includes('ДИРЕКТИВА') || combined.includes('DIRECTIVE')) {
    signals.push('DIRECTIVE');
  }
  
  // Регламент
  if (combined.includes('РЕГЛАМЕНТ') || combined.includes('REGULATION')) {
    signals.push('REGULATION');
  }
  
  // Угода
  if (combined.includes('УГОДА') || combined.includes('AGREEMENT')) {
    signals.push('AGREEMENT');
  }
  
  // Конвенція
  if (combined.includes('КОНВЕНЦІЯ') || combined.includes('CONVENTION')) {
    signals.push('CONVENTION');
  }
  
  // Протокол
  if (combined.includes('ПРОТОКОЛ') || combined.includes('PROTOCOL')) {
    signals.push('PROTOCOL');
  }
  
  return signals;
}

/**
 * Головна функція — витягує всі signals
 */
export function extractSignals(params: {
  title: string;
  snippet?: string | null;
  summary?: string | null;
  organs?: any;
  raw_txt?: string | null;  // Додано для priority ladder
}): ExtractedSignals {
  const { title, snippet, summary, raw_txt } = params;
  
  const topBlock = normalizeTopBlock(raw_txt || snippet || summary || title, 1000);
  
  const issuerCandidates = extractIssuerSignals({ 
    title, 
    snippet, 
    summary, 
    organs: params.organs,
    raw_txt,  // Передаємо raw_txt для priority ladder
  });
  const kindCandidates = extractActKindSignals({ title, snippet, summary });
  
  // Визначаємо confidence
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (issuerCandidates.length === 1 && issuerCandidates[0] !== 'OTHER' && kindCandidates.length > 0) {
    confidence = 'high';
  } else if (issuerCandidates.length > 0 && kindCandidates.length > 0) {
    confidence = 'medium';
  }
  
  return {
    issuer_candidates: issuerCandidates,
    kind_candidates: kindCandidates,
    confidence,
    top_block: topBlock,
  };
}
