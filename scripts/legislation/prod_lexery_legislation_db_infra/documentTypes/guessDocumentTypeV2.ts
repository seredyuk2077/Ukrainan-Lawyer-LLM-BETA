/**
 * Document Type Guessing V2 — Heuristics + AI fallback
 * 
 * PHASE 14: Document Type System V1
 * PHASE 15: KIND-FIRST logic — визначаємо вид акта перед issuer для запобігання хибним CMU сигналам
 */

import { DocumentTypeSlug, normalizeDocumentType, getDocumentTypeInfo } from './documentTypes.js';
import { extractKindFromPrefix, extractIssuerFromPrefix, DocumentKind, DocumentIssuer } from '../lib/kindExtractor.js';

export interface DocumentTypeGuessResult {
  slug: DocumentTypeSlug;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristics' | 'ai' | 'normalized';
  rationale?: string;
  decision_trace?: string[];  // PHASE 15: trace для debug (які правила спрацювали)
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
  raw_txt?: string | null;  // PRIORITY LADDER: raw_txt має найвищий пріоритет для prefix-sniff
  document_number?: string | null;  // Для nreg suffix check
  summary?: string | null;  // PHASE 3.4: для перевірки ЦВК/РНБО в summary
}): DocumentTypeGuessResult {
  const { title, typ, typn, organs, stru, snippet, raw_txt, document_number, summary } = params;
  
  const lowerTitle = title.toLowerCase();
  
  // PRIORITY LADDER: нормалізація тексту з пріоритетом raw_txt > snippet > summary > title
  const normalizePrefix = (text: string | null | undefined, maxLength: number = 200): string => {
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
  };
  
  // PRIORITY LADDER: raw_txt > snippet > summary > title
  const primaryText = raw_txt || snippet || summary || title;
  const normalizedSnippet = normalizePrefix(primaryText);
  const normalizedSummary = normalizePrefix(summary);
  const normalizedSnippetExtended = normalizePrefix(raw_txt || snippet || summary || title, 800);
  
  // ============================================================================
  // PRIORITY 0: Спеціальні випадки (ПЕРЕД KIND-FIRST GATE)
  // ============================================================================
  
  // Правило 0.0: Пленум Верховного Суду (ПЕРЕД KIND-FIRST, бо може бути kind=ROZJASNENNYA)
  const hasPlenum = normalizedSnippetExtended.includes('ПЛЕНУМ ВЕРХОВНОГО СУДУ') ||
                     normalizedSnippetExtended.includes('ПЛЕНУМУ ВЕРХОВНОГО СУДУ');
  if (hasPlenum && normalizedSnippetExtended.includes('ПОСТАНОВА')) {
    return {
      slug: 'court_explanation',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Постанова Пленуму Верховного Суду (ПЕРЕД KIND-FIRST gate)',
    };
  }
  
  // ============================================================================
  // KIND-FIRST GATE: визначаємо вид акта перед issuer (запобігає хибним CMU сигналам)
  // ВАЖЛИВО: виконується ПЕРЕД suffix rules для z****, щоб не пропустити НАКАЗ
  // ============================================================================
  
  const kind = extractKindFromPrefix(raw_txt, snippet, summary);
  const issuer = extractIssuerFromPrefix(raw_txt, snippet, summary, kind);
  const decisionTrace: string[] = [];
  
  decisionTrace.push(`kind=${kind}, issuer=${issuer}`);
  decisionTrace.push(`has_raw_txt=${!!raw_txt}, has_snippet=${!!snippet}, has_summary=${!!summary}`);
  if (raw_txt) {
    decisionTrace.push(`raw_txt_prefix_len=${raw_txt.substring(0, 400).length}`);
  }
  
  // КРИТИЧНО: якщо kind == ROZJASNENNYA → це роз'яснення, не наказ
  if (kind === DocumentKind.ROZJASNENNYA) {
    decisionTrace.push('rule: KIND_ROZJASNENNYA_GATE');
    
    // Роз'яснення міністерства/комітету/служби/агентства/інспекції → minister_explanation
    if (issuer === DocumentIssuer.MINISTRY ||
        issuer === DocumentIssuer.COMMITTEE ||
        issuer === DocumentIssuer.SERVICE ||
        issuer === DocumentIssuer.AGENCY ||
        issuer === DocumentIssuer.INSPECTION) {
      decisionTrace.push(`rule: KIND_ROZJASNENNYA_ISSUER=${issuer} → minister_explanation`);
      return {
        slug: 'minister_explanation',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'KIND_ROZJASNENNYA + issuer=MINISTRY/COMMITTEE/SERVICE/AGENCY/INSPECTION',
        decision_trace: decisionTrace,
      };
    }
    
    // Default для роз'яснень → minister_explanation
    decisionTrace.push('rule: KIND_ROZJASNENNYA_DEFAULT → minister_explanation');
    return {
      slug: 'minister_explanation',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'KIND_ROZJASNENNYA (default to minister_explanation)',
      decision_trace: decisionTrace,
    };
  }
  
  // КРИТИЧНО: якщо kind == NAKAZ → НЕ МОЖНА повертати cmu_order або cmu_resolution
  // навіть якщо в тексті є згадка "Кабінету Міністрів України" як посилання
  if (kind === DocumentKind.NAKAZ) {
    decisionTrace.push('rule: KIND_NAKAZ_GATE');
    
    // Для z**** pattern + НАКАЗ → перевіряємо issuer тільки з перших рядків перед "НАКАЗ"
    if (document_number && /^z\d{4}-\d{2}/.test(document_number.toUpperCase().trim())) {
      decisionTrace.push('rule: SUFFIX_Z_PATTERN');
      
      // z**** + НАКАЗ → майже гарантовано minister_order (якщо не CMU безпосередньо перед НАКАЗ)
      if (issuer === DocumentIssuer.CMU) {
        // CMU order: тільки якщо "КАБІНЕТ МІНІСТРІВ" стоїть БЕЗПОСЕРЕДНЬО перед "НАКАЗ"
        return {
          slug: 'cmu_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: 'z**** pattern + KIND_NAKAZ + issuer=CMU (anchored before НАКАЗ)',
          decision_trace: decisionTrace,
        };
      }
      
      // Міністерство/комітет/служба/агентство/інспекція → minister_order
      if (issuer === DocumentIssuer.MINISTRY ||
          issuer === DocumentIssuer.COMMITTEE ||
          issuer === DocumentIssuer.SERVICE ||
          issuer === DocumentIssuer.AGENCY ||
          issuer === DocumentIssuer.INSPECTION) {
        decisionTrace.push(`rule: KIND_NAKAZ_Z_PATTERN_ISSUER=${issuer} → minister_order`);
        return {
          slug: 'minister_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: 'z**** pattern + KIND_NAKAZ + issuer=MINISTRY/COMMITTEE/SERVICE/AGENCY/INSPECTION',
          decision_trace: decisionTrace,
        };
      }
      
      // Default для z**** + НАКАЗ → minister_order (якщо issuer не визначено)
      decisionTrace.push('rule: KIND_NAKAZ_Z_PATTERN_DEFAULT → minister_order');
      return {
        slug: 'minister_order',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'z**** pattern + KIND_NAKAZ (default to minister_order)',
        decision_trace: decisionTrace,
      };
    }
    
    // Загальний випадок: НАКАЗ (не z****)
    if (issuer === DocumentIssuer.CMU) {
      return {
        slug: 'cmu_order',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'KIND_NAKAZ + issuer=CMU (anchored before НАКАЗ)',
        decision_trace: decisionTrace,
      };
    }
    
    if (issuer === DocumentIssuer.MINISTRY ||
        issuer === DocumentIssuer.COMMITTEE ||
        issuer === DocumentIssuer.SERVICE ||
        issuer === DocumentIssuer.AGENCY ||
        issuer === DocumentIssuer.INSPECTION) {
      return {
        slug: 'minister_order',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'KIND_NAKAZ + issuer=MINISTRY/COMMITTEE/SERVICE/AGENCY/INSPECTION',
        decision_trace: decisionTrace,
      };
    }
  }
  
  // ============================================================================
  // PRIORITY 1: document_number suffix rules (НАЙСИЛЬНІШІ)
  // ============================================================================
  if (document_number) {
    const normalizedNreg = document_number.toUpperCase().trim().replace(/[‐‑‒–—―−]/g, '-');
    
    // -РП suffix → presidential_order
    if (normalizedNreg.endsWith('-РП') || normalizedNreg.match(/-РП\b$/i)) {
      if (snippet || summary || raw_txt) {
        const topBlock = normalizePrefix(raw_txt || snippet || summary, 600);
        if (topBlock.includes('РОЗПОРЯДЖЕННЯ') && 
            (topBlock.includes('ПРЕЗИДЕНТ') || topBlock.includes('ПРЕЗИДЕНТА'))) {
          return {
            slug: 'presidential_order',
            confidence: 'high',
            source: 'heuristics',
            rationale: 'nreg suffix -РП + prefix confirmation',
          };
        }
        if (normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') || normalizedSummary.includes('РОЗПОРЯДЖЕННЯ')) {
          return {
            slug: 'presidential_order',
            confidence: 'high',
            source: 'heuristics',
            rationale: 'nreg suffix -РП + розпорядження в summary/snippet',
          };
        }
      }
      return {
        slug: 'presidential_order',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg suffix -РП (document_number-based)',
      };
    }
    
    // -РГ suffix → vr_speaker_order
    if (normalizedNreg.endsWith('-РГ') || normalizedNreg.match(/-РГ\b$/i)) {
      if (snippet || summary || raw_txt) {
        const topBlock = normalizePrefix(raw_txt || snippet || summary, 600);
        if (topBlock.includes('РОЗПОРЯДЖЕННЯ') && 
            (topBlock.includes('ГОЛОВА') || topBlock.includes('ГОЛОВИ') || topBlock.includes('ВЕРХОВНОЇ'))) {
          return {
            slug: 'vr_speaker_order',
            confidence: 'high',
            source: 'heuristics',
            rationale: 'nreg suffix -РГ + prefix confirmation',
          };
        }
      }
      return {
        slug: 'vr_speaker_order',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg suffix -РГ (document_number-based)',
      };
    }
    
    // z****-** pattern → vr_resolution (АЛЕ з KIND-FIRST override)
    // ВАЖЛИВО: KIND-FIRST gate (вище) обробляє z**** + НАКАЗ випадки
    // Тут обробляємо тільки z**** без НАКАЗ (default → vr_resolution)
    if (/^z\d{4}-\d{2}/.test(normalizedNreg)) {
      // KIND-FIRST gate вже обробив випадки з НАКАЗ
      // Якщо дійшли сюди → це не НАКАЗ, default до vr_resolution
      return {
        slug: 'vr_resolution',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg pattern z****-** (document_number-based, not НАКАЗ)',
      };
    }
    
    // 995_* pattern → international_treaty
    if (normalizedNreg.startsWith('995_')) {
      return {
        slug: 'international_treaty',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg pattern 995_* (document_number-based)',
      };
    }
    
    // 984_* pattern → EU law (перевіряється далі в PREFIX-SNIFF)
    // (не повертаємо тут, бо потрібна перевірка directive vs regulation)
  }
  
  // ============================================================================
  // PRIORITY 2-3: raw_txt/snippet prefix sniff (PREFIX-SNIFF правила)
  // ============================================================================
  
  // Правило 0.1: Декрет КМУ (ПЕРЕД іншими правилами)
  // ВАЖЛИВО: ловить "Д Е К Р Е Т" з розрядкою через normalizePrefix
  const hasDekret = normalizedSnippetExtended.includes('ДЕКРЕТ') || normalizedSnippetExtended.includes('ДЕКРЕТУ');
  const hasCabmin = normalizedSnippetExtended.includes('КАБІНЕТУ МІНІСТРІВ') || 
                     normalizedSnippetExtended.includes('КАБІНЕТ МІНІСТРІВ') ||
                     normalizedSnippetExtended.includes('КМУ');
  
  if (hasDekret && hasCabmin) {
    return {
      slug: 'cmu_decree',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Декрет КМУ (з урахуванням розрядки)',
    };
  }
  
  // Правило 0.2: Декларація ВРУ (prefix-based, ПЕРЕД EU law)
  const hasDeklaratsiya = normalizedSnippetExtended.includes('ДЕКЛАРАЦІЯ') || 
                           normalizedSnippetExtended.includes('ДЕКЛАРАЦІЇ');
  const hasVRUForDeklaratsiya = normalizedSnippetExtended.includes('ВЕРХОВНА РАДА') ||
                                 normalizedSnippetExtended.includes('ВЕРХОВНОЇ РАДИ') ||
                                 normalizedSnippetExtended.includes('ВРУ');
  
  if (hasDeklaratsiya && hasVRUForDeklaratsiya) {
    return {
      slug: 'declaration',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Декларація ВРУ',
    };
  }
  
  // Правило 0.3: EU Directive (nreg pattern + title/snippet)
  if (document_number && (document_number.startsWith('984_011-') || document_number.startsWith('984_006-'))) {
    const hasDirective = normalizedSnippet.includes('ДИРЕКТИВА') || 
                         normalizedSnippet.includes('DIRECTIVE') ||
                         lowerTitle.includes('директива');
    const hasEuParliament = normalizedSnippet.includes('ЄВРОПЕЙСЬКИЙ ПАРЛАМЕНТ') ||
                            normalizedSnippet.includes('ЄВРОПЕЙСЬКОГО ПАРЛАМЕНТУ') ||
                            lowerTitle.includes('європейського парламенту');
    
    if (hasDirective && hasEuParliament) {
      return {
        slug: 'eu_directive',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg pattern 984_011-xx/984_006-xx + Директива Європейського парламенту',
      };
    }
    
    // Правило 0.3: EU Regulation (nreg pattern + title/snippet)
    const hasRegulation = normalizedSnippet.includes('РЕГЛАМЕНТ') ||
                          normalizedSnippet.includes('REGULATION') ||
                          lowerTitle.includes('регламент');
    
    if (hasRegulation && hasEuParliament) {
      return {
        slug: 'eu_regulation',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'nreg pattern 984_011-xx/984_006-xx + Регламент Європейського парламенту',
      };
    }
  }
  
  // Правило 0.4: НКРЕКП Постанова (prefix-based, ПЕРЕД загальним cmu_resolution)
  // Використовуємо більший блок тексту для перевірки (до 800 символів)
  const hasNerc = normalizedSnippetExtended.includes('НАЦІОНАЛЬНА КОМІСІЯ') &&
                   (normalizedSnippetExtended.includes('ЕНЕРГЕТИКИ') || 
                    normalizedSnippetExtended.includes('КОМУНАЛЬНИХ') ||
                    normalizedSnippetExtended.includes('НКРЕКП') ||
                    normalizedSnippetExtended.includes('РЕГУЛЮВАННЯ У СФЕРАХ'));
  const hasPostanova = normalizedSnippetExtended.includes('ПОСТАНОВА');
  
  if (hasNerc && hasPostanova) {
    return {
      slug: 'nerc_resolution',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Постанова НКРЕКП',
    };
  }
  
  // Правило 0.5: Ухвала КСУ (prefix-based, ПЕРЕД typ=22)
  const hasUkhvala = normalizedSnippetExtended.includes('УХВАЛА') && 
                      normalizedSnippetExtended.includes('КОНСТИТУЦІЙНОГО СУДУ');
  if (hasUkhvala) {
    return {
      slug: 'ccu_ruling',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Ухвала Конституційного Суду України',
    };
  }
  
  // Правило 0.6: Фонд безробіття (prefix-based, ПЕРЕД typ=2)
  const hasFondBezrobittya = normalizedSnippetExtended.includes('ФОНДУ ЗАГАЛЬНООБОВ\'ЯЗКОВОГО ДЕРЖАВНОГО СОЦІАЛЬНОГО СТРАХУВАННЯ') ||
                              normalizedSnippetExtended.includes('ФОНД ЗАГАЛЬНООБОВ\'ЯЗКОВОГО ДЕРЖАВНОГО СОЦІАЛЬНОГО СТРАХУВАННЯ') ||
                              (normalizedSnippetExtended.includes('ФОНДУ') && normalizedSnippetExtended.includes('БЕЗРОБІТТЯ'));
  if (hasFondBezrobittya && normalizedSnippetExtended.includes('ПОСТАНОВА')) {
    return {
      slug: 'regulation',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Постанова Фонду безробіття',
    };
  }
  
  // Правило 0.7: Наказ міністерства/комітету (prefix-based, ПЕРЕД typ-based)
  // ВАЖЛИВО: ловить "НАКАЗ" + "МІНІСТЕРСТВО"/"ДЕРЖАВНИЙ КОМІТЕТ", але НЕ "КАБІНЕТ МІНІСТРІВ"
  const hasNakaz = normalizedSnippetExtended.includes('НАКАЗ');
  const hasMinistryOrCommittee = normalizedSnippetExtended.includes('МІНІСТЕРСТВО') ||
                                  normalizedSnippetExtended.includes('ДЕРЖАВНИЙ КОМІТЕТ') ||
                                  normalizedSnippetExtended.includes('КОМІТЕТ') ||
                                  normalizedSnippetExtended.includes('УПРАВЛІННЯ ДЕРЖАВНОЇ ОХОРОНИ');
  const hasCabminInSnippet = normalizedSnippetExtended.includes('КАБІНЕТУ МІНІСТРІВ') ||
                              normalizedSnippetExtended.includes('КАБІНЕТ МІНІСТРІВ') ||
                              normalizedSnippetExtended.includes('КМУ');
  
  if (hasNakaz && hasMinistryOrCommittee && !hasCabminInSnippet) {
    return {
      slug: 'minister_order',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Наказ міністерства/комітету/УДО (не КМУ)',
    };
  }
  
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
  
  // Правило 2: Розпорядження Президента (prefix-based)
  // ВАЖЛИВО: перевіряємо ПЕРЕД -РГ, щоб не плутати з Розпорядженням Голови ВРУ
  const hasPresident = normalizedSnippet.includes('ПРЕЗИДЕНТ') || normalizedSnippet.includes('ПРЕЗИДЕНТА');
  if (normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') && hasPresident) {
    return {
      slug: 'presidential_order',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'prefix-sniff: Розпорядження Президента',
    };
  }
  
  // 0.5. PREFIX-SNIFF для РНБО/ЦВК (ПЕРЕД typ-based, бо typ=1 може бути помилковим)
  // PHASE 3.4: перевіряємо summary ПЕРЕД typ=1, щоб не пропустити РНБО/ЦВК
  const lowerSummary = (summary || '').toLowerCase();
  const combinedText = `${lowerTitle} ${lowerSummary}`;
  
  // РНБО: має найвищий пріоритет (навіть перед typ=1)
  // ВАЖЛИВО: snippet-first priority - перевіряємо чи topBlock починається з "РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ... РІШЕННЯ" або "УКАЗ ПРЕЗИДЕНТА"
  const topBlockForRnbo = (raw_txt || snippet || title || '').toUpperCase().trim();
  const topBlockFirst400 = topBlockForRnbo.substring(0, 400);
  const hasRnboPrefix = topBlockFirst400.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ') || topBlockFirst400.includes('РАДИ НАЦІОНАЛЬНОЇ БЕЗПЕКИ');
  const hasRishennyaInPrefix = topBlockFirst400.includes('РІШЕННЯ');
  const hasUkazStartsWith = topBlockForRnbo.startsWith('УКАЗ') || topBlockForRnbo.startsWith('УКАЗОМ');
  const hasPresidentInPrefix = topBlockForRnbo.substring(0, 200).includes('ПРЕЗИДЕНТ');
  
  if (combinedText.includes('рішення') &&
      (combinedText.includes('рнбо') || combinedText.includes('рада національної безпеки') ||
       combinedText.includes('ради національної безпеки'))) {
    // Якщо topBlock починається з "РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ... РІШЕННЯ" → це справжнє рішення РНБО
    // ВАЖЛИВО: перевіряємо перші 400 символів, щоб не плутати з "Введено в дію Указом" далі в тексті
    if (hasRnboPrefix && hasRishennyaInPrefix && !hasUkazStartsWith) {
      return {
        slug: 'rnbo_decision',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'prefix-sniff: Рішення РНБО (topBlock починається з РНБО+РІШЕННЯ в перших 400 символах)',
      };
    }
    // Виняток: "Указ Президента про рішення РНБО" → presidential_decree (snippet-first)
    // ВАЖЛИВО: перевіряємо чи topBlock починається з "УКАЗ", а не просто містить "Указом" далі
    if (hasUkazStartsWith && hasPresidentInPrefix && (combinedText.includes('рішення') || combinedText.includes('рішенням'))) {
      return {
        slug: 'presidential_decree',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'prefix-sniff: Указ Президента про рішення РНБО (topBlock починається з УКАЗ)',
      };
    }
    // Якщо НЕ указ президента і є РНБО+рішення → rnbo_decision
    if (!hasUkazStartsWith || !hasPresidentInPrefix) {
      return {
        slug: 'rnbo_decision',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'title/summary indicates RNBO Decision (prefix-sniff before typ)',
      };
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
    
    // Typ=22: Рішення КСУ (перевіряємо ПЕРЕД кодексом)
    if (typ === 22) {
      // Перевіряємо чи title/summary/snippet/raw_txt явно каже про КСУ
      // PRIORITY LADDER: raw_txt > snippet > summary > title
      const rawTxtLower = (raw_txt || '').toLowerCase();
      const snippetLower = (snippet || '').toLowerCase();
      const summaryLower = (summary || '').toLowerCase();
      const combinedText = `${lowerTitle} ${summaryLower} ${snippetLower} ${rawTxtLower}`;
      
      // Перевіряємо сигнали КСУ в пріоритетному порядку
      const hasRishennya = combinedText.includes('рішення');
      const hasCcuSignals = combinedText.includes('ксу') || 
                            combinedText.includes('конституційний суд') ||
                            combinedText.includes('конституційного суду') ||
                            combinedText.includes('сенат') ||
                            rawTxtLower.includes('конституційного суду') ||
                            snippetLower.includes('конституційного суду');
      
      if (hasRishennya && hasCcuSignals) {
        return {
          slug: 'ccu_decision',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=22, title/summary/snippet/raw_txt indicates CCU decision`,
        };
      }
      // Якщо не знайдено явних сигналів КСУ, але typ=22 → все одно ccu_decision (typ=22 = рішення КСУ)
      return {
        slug: 'ccu_decision',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=22 (Рішення КСУ)`,
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
    
    // Typ=1: Закон - АЛЕ перевіряємо РНБО/ЦВК перед цим
    if (typ === 1) {
      // Додаткова перевірка: чи це не РНБО/ЦВК (які інколи мають typ=1 помилково)
      if (combinedText.includes('рнбо') || combinedText.includes('рада національної безпеки') ||
          combinedText.includes('ради національної безпеки')) {
        // Виняток: "Указ про введення в дію рішення РНБО" → presidential_decree
        if (!combinedText.includes('указ про введення в дію') && !combinedText.includes('указом президента')) {
          return {
            slug: 'rnbo_decision',
            confidence: 'high',
            source: 'heuristics',
            rationale: `typ=1, але title/summary indicates RNBO (override typ)`,
          };
        }
      }
      
      return {
        slug: 'law',
        confidence: 'high',
        source: 'heuristics',
        rationale: `typ=1 (Закон)`,
      };
    }
    
    // Typ=2: Постанова — потрібно розрізнити КМУ vs ВР vs ЦВК через PRIORITY LADDER
    // ВАЖЛИВО: snippet/raw_txt ПЕРЕД organs/typ (priority ladder)
    if (typ === 2) {
      // PRIORITY 1: Пленум Верховного Суду (перевіряємо ПЕРШИМ, бо organs=71 може бути помилковим)
      const topBlock = normalizePrefix(raw_txt || snippet || summary || title, 600);
      const hasPlenum = topBlock.includes('ПЛЕНУМ ВЕРХОВНОГО СУДУ') ||
                        topBlock.includes('ПЛЕНУМУ ВЕРХОВНОГО СУДУ');
      if (hasPlenum && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'court_explanation',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet/raw_txt indicates Plenum of Supreme Court (priority: prefix-first)`,
        };
      }
      
      // PRIORITY 2-3: snippet/raw_txt prefix sniff (ПЕРЕД organs)
      // ЦВК має найвищий пріоритет (перевіряємо ПЕРШИМ)
      const lowerSummary = (summary || '').toLowerCase();
      if (topBlock.includes('ЦЕНТРАЛЬНА ВИБОРЧА') || topBlock.includes('ЦВК') ||
          lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') ||
          lowerSummary.includes('цвк') || lowerSummary.includes('центральна виборча') ||
          lowerSummary.includes('центральної виборчої') ||
          (organs && JSON.stringify(organs).toLowerCase().includes('цвк'))) {
        return {
          slug: 'cec_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet/title/summary/organs indicate CEC (priority: snippet-first)`,
        };
      }
      
      // PRIORITY 2.5: Фонд безробіття (перевіряємо ПЕРЕД КМУ/ВРУ)
      const hasFondBezrobittya = topBlock.includes('ФОНДУ ЗАГАЛЬНООБ\'ЯЗКОВОГО ДЕРЖАВНОГО СОЦІАЛЬНОГО СТРАХУВАННЯ') ||
                                  topBlock.includes('ФОНД ЗАГАЛЬНООБ\'ЯЗКОВОГО ДЕРЖАВНОГО СОЦІАЛЬНОГО СТРАХУВАННЯ') ||
                                  (topBlock.includes('ФОНДУ') && topBlock.includes('БЕЗРОБІТТЯ'));
      if (hasFondBezrobittya && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'regulation',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet/raw_txt indicates Fund for Unemployment (priority: prefix-first)`,
        };
      }
      
      // НКРЕКП (перевіряємо ПЕРЕД organs)
      const hasNerc = topBlock.includes('НАЦІОНАЛЬНА КОМІСІЯ') &&
                       (topBlock.includes('ЕНЕРГЕТИКИ') || 
                        topBlock.includes('КОМУНАЛЬНИХ') ||
                        topBlock.includes('НКРЕКП') ||
                        topBlock.includes('РЕГУЛЮВАННЯ У СФЕРАХ'));
      if (hasNerc && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'nerc_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet indicates NERC (priority: snippet-first)`,
        };
      }
      
      // НБУ (перевіряємо ПЕРЕД КМУ/ВРУ)
      const hasNbu = topBlock.includes('НАЦІОНАЛЬНИЙ БАНК') ||
                     topBlock.includes('НАЦІОНАЛЬНОГО БАНКУ') ||
                     topBlock.includes('ПРАВЛІННЯ НАЦІОНАЛЬНОГО БАНКУ') ||
                     topBlock.includes('НБУ');
      if (hasNbu && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'nbu_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet indicates NBU (priority: snippet-first)`,
        };
      }
      
      // КМУ vs ВРУ (перевіряємо snippet ПЕРЕД organs)
      const hasCabminInSnippet = topBlock.includes('КАБІНЕТУ МІНІСТРІВ') || 
                                  topBlock.includes('КАБІНЕТ МІНІСТРІВ') ||
                                  topBlock.includes('КМУ');
      const hasVRUInSnippet = topBlock.includes('ВЕРХОВНА РАДА') || 
                               topBlock.includes('ВЕРХОВНОЇ РАДИ') ||
                               topBlock.includes('ВРУ');
      
      if (hasCabminInSnippet && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'cmu_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet indicates CMU (priority: snippet-first)`,
        };
      }
      
      if (hasVRUInSnippet && topBlock.includes('ПОСТАНОВА')) {
        return {
          slug: 'vr_resolution',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=2, snippet indicates VRU (priority: snippet-first)`,
        };
      }
      
      // PRIORITY 5: Organs формат (ЛИШЕ ЯК fallback, якщо snippet не дав результату)
      // "2:19950127:57" де перше число - орган (2 = КМУ, 1 = ВР)
      if (organs && typeof organs === 'string') {
        const organMatch = organs.match(/^(\d+):/);
        if (organMatch && organMatch[1] === '2') {
          // Перевіряємо чи snippet не суперечить (якщо snippet каже ВРУ/НКРЕКП/ЦВК - не довіряємо organs)
          if (!hasVRUInSnippet && !hasNerc && !topBlock.includes('ЦВК')) {
            return {
              slug: 'cmu_resolution',
              confidence: 'high',
              source: 'heuristics',
              rationale: `typ=2, organs=${organs} (КМУ) - snippet не суперечить`,
            };
          }
        }
        if (organMatch && organMatch[1] === '1') {
          // Перевіряємо чи snippet не суперечить
          if (!hasCabminInSnippet && !hasNerc && !topBlock.includes('ЦВК')) {
            return {
              slug: 'vr_resolution',
              confidence: 'high',
              source: 'heuristics',
              rationale: `typ=2, organs=${organs} (ВР) - snippet не суперечить`,
            };
          }
        }
      }
      
      // PRIORITY 6: Fallback - перевіряємо title
      if (lowerTitle.includes('кабінет') || lowerTitle.includes('кму') || lowerTitle.includes('км ')) {
        return {
          slug: 'cmu_resolution',
          confidence: 'medium',
          source: 'heuristics',
          rationale: `typ=2, title indicates CMU (fallback)`,
        };
      }
      if (lowerTitle.includes('верховна') || lowerTitle.includes('вр ') || lowerTitle.includes('верховної ради')) {
        return {
          slug: 'vr_resolution',
          confidence: 'medium',
          source: 'heuristics',
          rationale: `typ=2, title indicates VRU (fallback)`,
        };
      }
      
      // PRIORITY 7: Default (тільки якщо issuer не визначено)
      // ВАЖЛИВО: не дефолтимо на cmu_resolution якщо issuer явно не КМУ
      if (hasNerc) {
        return {
          slug: 'unknown',
          confidence: 'low',
          source: 'heuristics',
          rationale: `typ=2, issuer=NERC (not CMU), requires AI fallback`,
        };
      }
      if (hasVRUInSnippet) {
        return {
          slug: 'vr_resolution',
          confidence: 'medium',
          source: 'heuristics',
          rationale: `typ=2, issuer=VRU (not CMU)`,
        };
      }
      if (topBlock.includes('ЦЕНТРАЛЬНА ВИБОРЧА') || topBlock.includes('ЦВК')) {
        return {
          slug: 'cec_resolution',
          confidence: 'medium',
          source: 'heuristics',
          rationale: `typ=2, issuer=CEC (not CMU)`,
        };
      }
      
      // Якщо issuer не визначено або це КМУ — дефолт на cmu_resolution
      return {
        slug: 'cmu_resolution',
        confidence: 'medium',
        source: 'heuristics',
        rationale: `typ=2, default to CMU (issuer not specified or CMU)`,
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
    
    // Typ=9: Наказ — потрібно перевірити чи це міністерство/комітет/служба/агентство/інспекція або КМУ
    // PRIORITY LADDER: snippet/raw_txt ПЕРЕД typ-based default
    // ВАЖЛИВО: KIND-FIRST gate вже обробив випадки з НАКАЗ + z**** pattern
    // Тут обробляємо тільки typ=9 без z**** pattern або якщо KIND-FIRST не спрацював
    if (typ === 9) {
      // Якщо KIND-FIRST gate вже обробив (kind=NAKAZ + z****) → не доходимо сюди
      // Але якщо kind=UNKNOWN або document_number не z**** → обробляємо тут
      
      const topBlockForTyp9 = normalizePrefix(raw_txt || snippet || summary || title, 800);
      const hasNakaz = topBlockForTyp9.includes('НАКАЗ');
      const hasCabmin = topBlockForTyp9.includes('КАБІНЕТУ МІНІСТРІВ') ||
                        topBlockForTyp9.includes('КАБІНЕТ МІНІСТРІВ') ||
                        topBlockForTyp9.includes('КМУ');
      const hasMinistryOrCommittee = topBlockForTyp9.includes('МІНІСТЕРСТВО') ||
                                      topBlockForTyp9.includes('ДЕРЖАВНИЙ КОМІТЕТ') ||
                                      topBlockForTyp9.includes('КОМІТЕТ');
      const hasServiceOrAgency = topBlockForTyp9.includes('СЛУЖБА') ||
                                  topBlockForTyp9.includes('АДМІНІСТРАЦІЯ') ||
                                  topBlockForTyp9.includes('АГЕНТСТВО') ||
                                  topBlockForTyp9.includes('ІНСПЕКЦІЯ');
      
      // Якщо snippet/raw_txt явно каже "НАКАЗ" + "МІНІСТЕРСТВО"/"ДЕРЖАВНИЙ КОМІТЕТ"/"СЛУЖБА"/"АДМІНІСТРАЦІЯ" (не КМУ) → minister_order
      if (hasNakaz && (hasMinistryOrCommittee || hasServiceOrAgency) && !hasCabmin) {
        return {
          slug: 'minister_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=9, snippet/raw_txt indicates minister_order (priority: text-first)`,
        };
      }
      
      // Якщо snippet/raw_txt явно каже "НАКАЗ" + "КМУ" → cmu_order
      if (hasNakaz && hasCabmin) {
        return {
          slug: 'cmu_order',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=9, snippet/raw_txt indicates CMU order`,
        };
      }
      
      // Default для typ=9 → minister_order (не vr_resolution, бо typ=9 = Наказ)
      return {
        slug: 'minister_order',
        confidence: 'medium',
        source: 'heuristics',
        rationale: `typ=9 (Наказ), default to minister_order`,
      };
    }
    
    // Typ=12: Роз'яснення — перевіряємо чи це дійсно роз'яснення
    if (typ === 12) {
      // Перевіряємо чи prefix містить "РОЗ'ЯСНЕННЯ" (з урахуванням розрядки)
      const topBlockForTyp12 = normalizePrefix(raw_txt || snippet || summary || title, 400);
      // normalizePrefix прибирає розрядку, тому шукаємо "РОЗ'ЯСНЕННЯ" або "РОЗЯСНЕННЯ"
      const hasRozjasnennya = topBlockForTyp12.includes('РОЗ') && 
                              (topBlockForTyp12.includes('ЯСНЕННЯ') || 
                               topBlockForTyp12.includes('ЯСНЕННЯ'));
      
      // Перевіряємо чи kind вже визначено як ROZJASNENNYA (через KIND-FIRST gate)
      // ВАЖЛИВО: kind може бути ROZJASNENNYA тільки якщо KIND-FIRST gate спрацював
      // TypeScript: використовуємо type assertion для обходу type narrowing (kind може бути ROZJASNENNYA)
      const kindAsAny = kind as any;
      const isRozjasnennya = kindAsAny === DocumentKind.ROZJASNENNYA;
      if (hasRozjasnennya || isRozjasnennya) {
        // Визначаємо issuer для роз'яснення
        if (issuer === DocumentIssuer.MINISTRY ||
            issuer === DocumentIssuer.COMMITTEE ||
            issuer === DocumentIssuer.SERVICE ||
            issuer === DocumentIssuer.AGENCY ||
            issuer === DocumentIssuer.INSPECTION) {
          return {
            slug: 'minister_explanation',
            confidence: 'high',
            source: 'heuristics',
            rationale: `typ=12, snippet/raw_txt indicates minister_explanation`,
          };
        }
        
        // Default для typ=12 → minister_explanation
        return {
          slug: 'minister_explanation',
          confidence: 'high',
          source: 'heuristics',
          rationale: `typ=12 (Роз'яснення), default to minister_explanation`,
        };
      }
      
      // Якщо typ=12 але не знайдено "РОЗ'ЯСНЕННЯ" → можливо це інший тип
      // Fallback до minister_order (якщо є issuer) або unknown
      if (issuer === DocumentIssuer.MINISTRY ||
          issuer === DocumentIssuer.COMMITTEE ||
          issuer === DocumentIssuer.SERVICE ||
          issuer === DocumentIssuer.AGENCY ||
          issuer === DocumentIssuer.INSPECTION) {
        return {
          slug: 'minister_order',
          confidence: 'medium',
          source: 'heuristics',
          rationale: `typ=12, але не знайдено "РОЗ'ЯСНЕННЯ", fallback до minister_order`,
        };
      }
    }
    
    // Інші typ значення
    const typMap: Record<number, DocumentTypeSlug> = {
      5: 'minister_order',
      7: 'rules',
      8: 'instruction',
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
  
  // Рішення КСУ (ВАЖЛИВО: перевіряти ПЕРЕД кодексом, бо в title може бути "Житлового кодексу" як згадка)
  if (lowerTitle.includes('рішення') && 
      (lowerTitle.includes('ксу') || lowerTitle.includes('конституційний суд') || 
       lowerTitle.includes('конституційного суду') || lowerTitle.includes('сенат'))) {
    return {
      slug: 'ccu_decision',
      confidence: 'high',
      source: 'heuristics',
      rationale: 'title indicates CCU decision (checked before code)',
    };
  }
  
  // Кодекс (перевіряємо після КСУ, щоб не плутати з рішеннями КСУ про кодекси)
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
  
  // РНБО: загальна перевірка (якщо не в title, але в summary/snippet)
  // Використовуємо вже оголошені lowerSummary та combinedText з секції 0.5
  if (combinedText.includes('рнбо') || combinedText.includes('рада національної безпеки') ||
      combinedText.includes('ради національної безпеки')) {
    // Перевіряємо чи це не "Указ про введення в дію рішення РНБО"
    if (!combinedText.includes('указ про введення в дію') && !combinedText.includes('указом президента')) {
      return {
        slug: 'rnbo_decision',
        confidence: 'high',
        source: 'heuristics',
        rationale: 'title/summary indicates RNBO',
      };
    }
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
