/**
 * Document Type Guessing V2 — Heuristics + AI fallback
 * 
 * PHASE 14: Document Type System V1
 */

import { DocumentTypeSlug, normalizeDocumentType, getDocumentTypeInfo } from './documentTypes.js';

export interface DocumentTypeGuessResult {
  slug: DocumentTypeSlug;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristics' | 'ai' | 'normalized';
  rationale?: string;
}

/**
 * Heuristics-first document type guessing
 */
export function guessDocumentTypeV2(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
  stru?: any[];
  snippet?: string | null;  // Для prefix-sniff
  document_number?: string | null;  // Для nreg suffix check
  summary?: string | null;  // PHASE 3.4: для перевірки ЦВК/РНБО в summary
}): DocumentTypeGuessResult {
  const { title, typ, typn, organs, stru, snippet, document_number, summary } = params;
  
  const lowerTitle = title.toLowerCase();
  
  // 0. PREFIX-SNIFF: Жорсткі правила на основі перших рядків тексту (ВИКОНУЮТЬСЯ ПЕРШИМИ)
  // Нормалізуємо snippet/summary для перевірки
  const normalizePrefix = (text: string | null | undefined): string => {
    if (!text) return '';
    return text
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')  // collapse whitespace
      .replace(/[\n\t\r]/g, ' ')
      .replace(/["'«»]/g, '')
      .substring(0, 200);  // перші 200 символів
  };
  
  const normalizedSnippet = normalizePrefix(snippet || summary || title);
  const normalizedSummary = normalizePrefix(summary);
  
  // Правило 1: Розпорядження Голови ВРУ (prefix-based)
  // ВАЖЛИВО: "ГОЛОВА" (однина) або "ГОЛОВИ" (множина) - обидва варіанти
  const hasGolovy = normalizedSnippet.includes('ГОЛОВА') || normalizedSnippet.includes('ГОЛОВИ');
  const hasVRU = normalizedSnippet.includes('ВЕРХОВНОЇ РАДИ') || normalizedSnippet.includes('ВРУ');
  
  if (normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') && hasGolovy && hasVRU) {
    return {
      slug: 'vr_speaker_order',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Розпорядження Голови ВРУ',
    };
  }
  
  // Правило 2: nreg/document_number suffix check (-РГ)
  // ВАЖЛИВО: -РГ suffix достатній сам по собі (не потребує snippet)
  if (document_number) {
    const normalizedNreg = document_number.toUpperCase().trim().replace(/[‐‑‒–—―−]/g, '-');
    if (normalizedNreg.endsWith('-РГ') || normalizedNreg.match(/-РГ\b$/i)) {
      // Якщо є snippet/summary - перевіряємо підтвердження, інакше -РГ достатній
      if (snippet || summary) {
        if (normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') && 
            (hasGolovy || normalizedSnippet.includes('ВЕРХОВНОЇ'))) {
          return {
            slug: 'vr_speaker_order',
            confidence: 'high',
            source: 'heuristics',
            rationale: 'nreg suffix -РГ + prefix confirmation',
          };
        }
      } else {
        // Немає snippet/summary, але -РГ suffix достатній
        return {
          slug: 'vr_speaker_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: 'nreg suffix -РГ (document_number-based)',
        };
      }
    }
  }
  
  // 1. Typ-based heuristics (найнадійніші)
  if (typ !== null && typ !== undefined) {
    // Typ mapping з Rada API
    // Важливо: typ=2 може бути як КМУ так і ВР, потрібно перевіряти organs
    if (typ === 216) {
      return {
        slug: 'constitution',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=216 (Конституція)`,
      };
    }
    
    if (typ === 21 || typ === 5) {
      return {
        slug: 'code',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=${typ} (Кодекс)`,
      };
    }
    
    if (typ === 1) {
      return {
        slug: 'law',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=1 (Закон)`,
      };
    }
    
    // Typ=2: Постанова — потрібно розрізнити КМУ vs ВР vs ЦВК через organs/title/summary
    if (typ === 2) {
      // ВАЖЛИВО: ЦВК має найвищий пріоритет (перевіряємо ПЕРШИМ)
      // PHASE 3.4: перевіряємо також summary (бо там може бути "Постанова Центральної виборчої комісії")
      const lowerSummary = (summary || '').toLowerCase();
      if (lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') ||
          lowerSummary.includes('цвк') || lowerSummary.includes('центральна виборча') ||
          lowerSummary.includes('центральної виборчої') ||
          (organs && JSON.stringify(organs).toLowerCase().includes('цвк'))) {
        return {
          slug: 'cec_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, title/summary/organs indicate CEC`,
        };
      }
      
      // Organs формат: "2:19950127:57" де перше число - орган (2 = КМУ, 1 = ВР)
      if (organs && typeof organs === 'string') {
        const organMatch = organs.match(/^(\d+):/);
        if (organMatch && organMatch[1] === '2') {
          return {
            slug: 'cmu_resolution',
            confidence: 'high',
            source: 'heuristics',
            rationale: `typ=2, organs=${organs} (КМУ)`,
          };
        }
        if (organMatch && organMatch[1] === '1') {
          return {
            slug: 'vr_resolution',
            confidence: 'high',
            source: 'heuristics',
            rationale: `typ=2, organs=${organs} (ВР)`,
          };
        }
      }
      // Fallback: перевіряємо title
      if (lowerTitle.includes('кабінет') || lowerTitle.includes('кму') || lowerTitle.includes('км ')) {
        return {
          slug: 'cmu_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, title indicates CMU`,
        };
      }
      if (lowerTitle.includes('верховна') || lowerTitle.includes('вр ') || lowerTitle.includes('верховної ради')) {
        return {
          slug: 'vr_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, title indicates VRU`,
        };
      }
      // Якщо не вдалося визначити — ставимо cmu_resolution як default (частіше)
      return {
        slug: 'cmu_resolution',
        confidence: 'medium',
        source: 'heuristics',
        rationale: `typ=2, default to CMU`,
      };
    }
    
    if (typ === 3) {
      // Розпоряження — потрібно перевірити чи це Президента
      if (lowerTitle.includes('президент') || 
          (organs && JSON.stringify(organs).toLowerCase().includes('президент'))) {
        return {
          slug: 'presidential_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=3, indicates Presidential Order`,
        };
      }
      return {
        slug: 'regulation',
        confidence: 'medium',
        source: 'heuristics',
        rationale: `typ=3 (Розпоряження/Положення)`,
      };
    }
    
    if (typ === 4) {
      return {
        slug: 'presidential_decree',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=4 (Указ Президента)`,
      };
    }
    
    // Typ=6: Розпорядження — потрібно перевірити чи це КМУ
    if (typ === 6) {
      if (lowerTitle.includes('кабінет') || lowerTitle.includes('кму') ||
          (organs && JSON.stringify(organs).toLowerCase().includes('кму'))) {
        return {
          slug: 'cmu_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=6, indicates CMU Order`,
        };
      }
      return {
        slug: 'regulation',
        confidence: 'medium',
        source: 'heuristics',
        rationale: `typ=6 (Розпорядження/Положення)`,
      };
    }
    
    // Інші typ значення
    const typMap: Record<number, DocumentTypeSlug> = {
      5: 'minister_order',
      7: 'rules',
      8: 'instruction',
      9: 'vr_resolution',
      10: 'charter',
    };
    
    if (typMap[typ]) {
      return {
        slug: typMap[typ],
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=${typ}`,
      };
    }
  }
  
  // 2. Title-based heuristics (regex patterns)
  
  // Конституція
  if (lowerTitle.includes('конституція') || lowerTitle.includes('конституція україни')) {
    return {
      slug: 'constitution',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title contains "конституція"',
    };
  }
  
  // Кодекс
  if (lowerTitle.includes('кодекс') && !lowerTitle.includes('окрема думка')) {
    return {
      slug: 'code',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title contains "кодекс"',
    };
  }
  
  // Закон
  if ((lowerTitle.includes('закон') && lowerTitle.includes('україни')) ||
      (lowerTitle.startsWith('про ') && !lowerTitle.includes('постанова'))) {
    // Перевіряємо що це не постанова про затвердження закону
    if (!lowerTitle.includes('постанова') && !lowerTitle.includes('затвердження')) {
      return {
        slug: 'law',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'title pattern matches law',
      };
    }
  }
  
  // Постанова ЦВК (ВАЖЛИВО: перевіряємо ПЕРЕД КМУ/ВР)
  // PHASE 3.4: перевіряємо також summary
  if ((lowerTitle.includes('постанова') || lowerSummary.includes('постанова')) &&
      (lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') ||
       lowerTitle.includes('центральної виборчої') ||
       lowerSummary.includes('цвк') || lowerSummary.includes('центральна виборча') ||
       lowerSummary.includes('центральної виборчої') ||
       (organs && JSON.stringify(organs).toLowerCase().includes('цвк')))) {
    return {
      slug: 'cec_resolution',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/summary/organs indicate CEC',
    };
  }
  
  // Постанова КМУ
  if (lowerTitle.includes('постанова') && 
      (lowerTitle.includes('кабінет') || lowerTitle.includes('кму') || 
       (organs && JSON.stringify(organs).toLowerCase().includes('кму')))) {
    return {
      slug: 'cmu_resolution',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/organs indicate CMU',
    };
  }
  
  // Постанова ВР
  if (lowerTitle.includes('постанова') && 
      (lowerTitle.includes('верховна') || lowerTitle.includes('вр') ||
       (organs && JSON.stringify(organs).toLowerCase().includes('верховна')))) {
    return {
      slug: 'vr_resolution',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/organs indicate VRU',
    };
  }
  
  // Указ Президента
  if (lowerTitle.includes('указ') && 
      (lowerTitle.includes('президент') || 
       (organs && JSON.stringify(organs).toLowerCase().includes('президент')))) {
    return {
      slug: 'presidential_decree',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/organs indicate President',
    };
  }
  
  // Розпоряження Президента
  if (lowerTitle.includes('розпоряження') && 
      (lowerTitle.includes('президент') || 
       (organs && JSON.stringify(organs).toLowerCase().includes('президент')))) {
    return {
      slug: 'presidential_order',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/organs indicate Presidential Order',
    };
  }
  
  // Наказ
  if (lowerTitle.includes('наказ') || 
      (organs && JSON.stringify(organs).toLowerCase().includes('міністерство'))) {
    return {
      slug: 'minister_order',
      confidence: 'medium',
      source: 'heuristics',
      rationale: 'title/organs indicate order',
    };
  }
  
  // Міжнародні документи
  if (lowerTitle.includes('конвенція') || lowerTitle.includes('convention')) {
    return {
      slug: 'convention',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title contains "конвенція"',
    };
  }
  
  if (lowerTitle.includes('міжнародний договір') || 
      lowerTitle.includes('договір') && lowerTitle.includes('міжнародн')) {
    return {
      slug: 'international_treaty',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates international treaty',
    };
  }
  
  if (lowerTitle.includes('протокол') || lowerTitle.includes('protocol')) {
    return {
      slug: 'protocol',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title contains "протокол"',
    };
  }
  
  // РНБО: Рішення РНБО (ВАЖЛИВО: перевіряти ПЕРЕД загальними правилами)
  // PHASE 3.4: перевіряємо також summary (бо там може бути "Рішення Ради національної безпеки")
  const lowerSummary = (summary || '').toLowerCase();
  const combinedText = `${lowerTitle} ${lowerSummary}`;
  
  if (combinedText.includes('рішення') &&
      (combinedText.includes('рнбо') || combinedText.includes('рада національної безпеки') ||
       combinedText.includes('ради національної безпеки'))) {
    return {
      slug: 'rnbo_decision',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/summary indicates RNBO Decision',
    };
  }
  
  // РНБО: загальна перевірка (якщо не в title, але в summary/snippet)
  if (combinedText.includes('рнбо') || combinedText.includes('рада національної безпеки') ||
      combinedText.includes('ради національної безпеки')) {
    return {
      slug: 'rnbo_decision',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title/summary indicates RNBO',
    };
  }
  
  // Окрема думка судді КСУ (ВАЖЛИВО: перевіряти ПЕРШИМ, перед загальним court_opinion)
  if (lowerTitle.includes('окрема думка') && 
      (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд') || 
       lowerTitle.includes('конституційного суду'))) {
    return {
      slug: 'ccu_opinion',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates CCU opinion',
    };
  }
  
  // Рішення КСУ (перевіряти перед загальним court_decision)
  if (lowerTitle.includes('рішення') && 
      (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд') || 
       lowerTitle.includes('конституційного суду'))) {
    return {
      slug: 'ccu_decision',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates CCU decision',
    };
  }
  
  // Окрема думка судді (загальна)
  if (lowerTitle.includes('окрема думка') || lowerTitle.includes('окрема думка судді')) {
    return {
      slug: 'court_opinion',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates court opinion',
    };
  }
  
  
  // Положення
  if (lowerTitle.includes('положення')) {
    return {
      slug: 'regulation',
      confidence: 'medium',
      source: 'heuristics',
      rationale: 'title contains "положення"',
    };
  }
  
  // Правила
  if (lowerTitle.includes('правила')) {
    return {
      slug: 'rules',
      confidence: 'medium',
      source: 'heuristics',
      rationale: 'title contains "правила"',
    };
  }
  
  // Інструкція
  if (lowerTitle.includes('інструкція')) {
    return {
      slug: 'instruction',
      confidence: 'medium',
      source: 'heuristics',
      rationale: 'title contains "інструкція"',
    };
  }
  
  // Fallback: нормалізація існуючого document_type
  // (якщо вже є в metadata)
  return {
    slug: 'other',
    confidence: 'low',
    source: 'heuristics',
    rationale: 'no strong heuristics match',
  };
}
