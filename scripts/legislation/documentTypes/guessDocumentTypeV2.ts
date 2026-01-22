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
}): DocumentTypeGuessResult {
  const { title, typ, typn, organs, stru } = params;
  
  const lowerTitle = title.toLowerCase();
  
  // 1. Typ-based heuristics (найнадійніші)
  if (typ !== null && typ !== undefined) {
    // Typ mapping з Rada API
    const typMap: Record<number, DocumentTypeSlug> = {
      1: 'law',           // Закон
      2: 'cmu_resolution', // Постанова КМУ
      21: 'code',         // Кодекс
      3: 'presidential_decree', // Указ Президента
      4: 'presidential_order', // Розпоряження Президента
      5: 'minister_order', // Наказ
      6: 'regulation',    // Положення
      7: 'rules',         // Правила
      8: 'instruction',   // Інструкція
      9: 'vr_resolution',  // Постанова ВР
      10: 'charter',      // Статут
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
  
  // Окрема думка судді КСУ
  if (lowerTitle.includes('окрема думка') && 
      (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд'))) {
    return {
      slug: 'ccu_opinion',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates CCU opinion',
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
  
  // Рішення КСУ
  if (lowerTitle.includes('рішення') && 
      (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд'))) {
    return {
      slug: 'ccu_decision',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates CCU decision',
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
