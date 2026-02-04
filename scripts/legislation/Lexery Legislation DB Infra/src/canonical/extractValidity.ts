/**
 * Validity Extractor — витяг чинності документа з джерела
 * 
 * PROD PIPELINE: автоматичне заповнення validity_status для всіх документів
 * 
 * Пріоритет джерел:
 * 1. radaJson.status (числове значення або текст)
 * 2. canonical topBlock (перші 1500-2500 символів тексту) — regex patterns
 * 3. fallback: unknown (НЕ NULL)
 * 
 * Нормалізація статусу:
 * - in_force: чинний, діє, набрав чинності
 * - expired: втратив чинність, припинено, скасовано
 * - not_in_force: не набрав чинності, не набув чинності
 * - suspended: зупинено дію, призупинено
 * - unknown: неможливо визначити (але НЕ NULL)
 */

export type ValidityStatus = 'in_force' | 'expired' | 'not_in_force' | 'suspended' | 'unknown';

/**
 * ValidityBundle — повний набір validity полів (НЕ NULL для текстових)
 * 
 * IDEAL DATA CONTRACT:
 * - validity_status: НЕ NULL (enum: in_force | expired | not_in_force | suspended | unknown)
 * - status_note: НЕ NULL (навіть якщо 'no_evidence' або 'derived_from_rada_status_5')
 * - source_status_text: НЕ NULL (raw код/текст або 'N/A')
 * - source_status_location: НЕ NULL (наприклад 'rada_json.status', 'canonical.topBlock', 'fallback.no_evidence')
 * - valid_from: може бути NULL якщо джерело не дає дату
 * - valid_to: може бути NULL якщо джерело не дає дату
 */
export interface ValidityResult {
  validity_status: ValidityStatus;
  valid_from: string | null;
  valid_to: string | null;
  status_note: string; // НЕ NULL
  source_status_text: string; // НЕ NULL
  source_status_location: string; // НЕ NULL
  reason_code?: string; // для debug
  confidence?: 'high' | 'medium' | 'low'; // для debug
}

/**
 * Витягує чинність з JSON даних Rada API
 * 
 * Rada API status field:
 * - Числове значення: 1 = чинний, 0 = нечинний, 5 = інше
 * - Текст: "чинний", "втратив чинність", тощо
 */
export function extractValidityFromJson(jsonData: any): ValidityResult {
  const result: ValidityResult = {
    validity_status: 'unknown',
    valid_from: null,
    valid_to: null,
    status_note: 'no_evidence',
    source_status_text: 'N/A',
    source_status_location: 'fallback.no_evidence',
    confidence: 'low',
  };
  
  // 0. Якщо jsonData порожній або undefined — повертаємо unknown (буде оброблено в основній функції)
  if (!jsonData || (typeof jsonData === 'object' && Object.keys(jsonData).length === 0)) {
    return result;
  }
  
  // 1. Перевіряємо jsonData.status (основне джерело)
  if (jsonData?.status !== undefined && jsonData?.status !== null) {
    const statusValue = String(jsonData.status).trim();
    result.source_status_text = statusValue;
    result.source_status_location = 'rada_json.status';
    result.confidence = 'high';
    
    // Нормалізація: числові значення
    // Rada API status codes: 1 = чинний, 0 = нечинний, 5 = інше, 6 = не набрав чинності
    const statusNum = parseInt(statusValue, 10);
    if (!isNaN(statusNum)) {
      if (statusNum === 1) {
        result.validity_status = 'in_force';
        result.status_note = 'derived_from_rada_status_1';
        return result;
      } else if (statusNum === 0) {
        result.validity_status = 'expired';
        result.status_note = 'derived_from_rada_status_0';
        return result;
      } else if (statusNum === 6) {
        result.validity_status = 'not_in_force';
        result.status_note = 'derived_from_rada_status_6';
        return result;
      } else if (statusNum === 5) {
        // 5 = інше (може бути різне), спробуємо текст fallback
        result.status_note = 'derived_from_rada_status_5';
        result.confidence = 'medium';
      }
    }
    
    // Нормалізація: текст
    const statusLower = statusValue.toLowerCase();
    if (statusLower.includes('1') || statusLower === 'active' || statusLower === 'чинний' || statusLower === 'діє' || statusLower === 'набрав чинності') {
      result.validity_status = 'in_force';
      result.status_note = 'derived_from_rada_status_text';
      return result;
    } else if (statusLower.includes('0') || statusLower === 'inactive' || statusLower === 'нечинний' || 
               statusLower.includes('втратив') || statusLower.includes('припинено') || statusLower.includes('скасовано')) {
      result.validity_status = 'expired';
      result.status_note = 'derived_from_rada_status_text';
      return result;
    } else if (statusLower.includes('не набрав') || statusLower.includes('не набув') || statusLower.includes('не набрав силу')) {
      result.validity_status = 'not_in_force';
      result.status_note = 'derived_from_rada_status_text';
      return result;
    } else if (statusLower.includes('зупинено') || statusLower.includes('призупинено')) {
      result.validity_status = 'suspended';
      result.status_note = 'derived_from_rada_status_text';
      return result;
    }
  }
  
  // 2. Перевіряємо метадані (jsonData.meta або jsonData.metadata) якщо status не дав результату
  if (result.validity_status === 'unknown') {
    const meta = jsonData?.meta || jsonData?.metadata || {};
    if (meta.status !== undefined && meta.status !== null) {
      const metaStatus = String(meta.status).trim();
      result.source_status_text = metaStatus;
      result.source_status_location = 'rada_json.meta.status';
      result.confidence = 'medium';
      
      const metaStatusLower = metaStatus.toLowerCase();
      if (metaStatusLower.includes('1') || metaStatusLower === 'active' || metaStatusLower === 'чинний') {
        result.validity_status = 'in_force';
        result.status_note = 'derived_from_rada_meta_status';
        return result;
      } else if (metaStatusLower.includes('0') || metaStatusLower === 'inactive' || metaStatusLower.includes('втратив')) {
        result.validity_status = 'expired';
        result.status_note = 'derived_from_rada_meta_status';
        return result;
      }
    }
  }
  
  // Якщо status=5 або інше — встановлюємо status_note
  if (result.validity_status === 'unknown' && result.status_note === 'no_evidence') {
    result.status_note = 'derived_from_rada_status_unknown';
  }
  
  return result;
}

/**
 * Витягує чинність з тексту документа (canonical topBlock)
 * 
 * Перевіряє перші 1500-2500 символів на ключові фрази про чинність
 */
export function extractValidityFromText(text: string | null | undefined): Partial<ValidityResult> {
  if (!text || text.length < 50) {
    return { 
      validity_status: 'unknown',
      status_note: 'no_evidence',
      source_status_text: 'N/A',
      source_status_location: 'fallback.no_evidence',
    };
  }
  
  // Обмежуємо до перших 2500 символів (topBlock) або більше якщо передано
  const maxLength = 2500; // Може бути розширено до 20000 для status=5
  const topBlock = text.substring(0, maxLength);
  const textLower = topBlock.toLowerCase();
  const result: Partial<ValidityResult> = {
    source_status_location: 'canonical.topBlock',
    status_note: 'no_evidence',
    source_status_text: 'N/A',
    confidence: 'medium',
  };
  
  // Ключові фрази для визначення чинності (пріоритет: expired > not_in_force > suspended > in_force)
  const expiredPatterns = [
    /втратив\s+чинність/i,
    /визнано\s+таким,\s+що\s+втратив\s+чинність/i,
    /визнано\s+таким,\s+що\s+втратило\s+чинність/i,
    /визнання\s+таким,\s+що\s+втратив/i,
    /визнання\s+таким,\s+що\s+втратило/i,
    /чинність\s+втрачено/i,
    /припинено\s+чинність/i,
    /скасовано/i,
    /нечинний/i,
    /не\s+діє/i,
    /втратив\s+силу/i,
    /втратило\s+чинність/i,
    /втратили\s+чинність/i,
  ];
  
  const notInForcePatterns = [
    /не\s+набрав\s+чинності/i,
    /не\s+набув\s+чинності/i,
    /не\s+набрав\s+силу/i,
    /не\s+набув\s+силу/i,
  ];
  
  const suspendedPatterns = [
    /зупинено\s+дію/i,
    /дію\s+призупинено/i,
    /призупинено\s+чинність/i,
  ];
  
  const inForcePatterns = [
    /чинний/i,
    /діє/i,
    /набрав\s+чинності/i,
    /набув\s+чинності/i,
    /набрав\s+силу/i,
    /введено\s+в\s+дію/i,
    /вводиться\s+в\s+дію/i,
    /набирає\s+чинності/i,
    /набуває\s+чинності/i,
  ];
  
  // Перевіряємо patterns (пріоритет: expired > not_in_force > suspended > in_force)
  let foundStatus: ValidityStatus | null = null;
  let foundText: string | null = null;
  let foundMatch: RegExpMatchArray | null = null;
  
  for (const pattern of expiredPatterns) {
    const match = topBlock.match(pattern);
    if (match) {
      foundStatus = 'expired';
      foundText = match[0];
      foundMatch = match;
      break;
    }
  }
  
  if (!foundStatus) {
    for (const pattern of notInForcePatterns) {
      const match = topBlock.match(pattern);
      if (match) {
        foundStatus = 'not_in_force';
        foundText = match[0];
        foundMatch = match;
        break;
      }
    }
  }
  
  if (!foundStatus) {
    for (const pattern of suspendedPatterns) {
      const match = topBlock.match(pattern);
      if (match) {
        foundStatus = 'suspended';
        foundText = match[0];
        foundMatch = match;
        break;
      }
    }
  }
  
  if (!foundStatus) {
    for (const pattern of inForcePatterns) {
      const match = topBlock.match(pattern);
      if (match) {
        foundStatus = 'in_force';
        foundText = match[0];
        foundMatch = match;
        break;
      }
    }
  }
  
  if (foundStatus && foundText) {
    result.validity_status = foundStatus;
    result.source_status_text = foundText.substring(0, 200); // обмежуємо довжину
    result.status_note = `derived_from_text_pattern_${foundStatus}`;
    
    // Спробуємо витягти дати з контексту
    if (foundMatch && foundMatch.index !== undefined) {
      const contextStart = Math.max(0, foundMatch.index - 100);
      const contextEnd = Math.min(topBlock.length, foundMatch.index + foundMatch[0].length + 100);
      const context = topBlock.substring(contextStart, contextEnd);
      
      // Шукаємо дати в контексті (тільки валідні формати для PostgreSQL)
      // PostgreSQL приймає: YYYY-MM-DD, DD.MM.YYYY (з перевіркою)
      const datePattern = /(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/g;
      const dates = context.match(datePattern);
      if (dates && dates.length > 0) {
        // Якщо знайдено "втратив чинність з/від/згідно" + дата → valid_to
        if (foundStatus === 'expired' && /(з|від|згідно|на\s+підставі)/i.test(context)) {
          // Спробуємо парсити дату (тільки валідні формати)
          const firstDate = dates[0];
          if (firstDate) {
            // Перевіряємо формат: DD.MM.YYYY або YYYY-MM-DD
            const dateMatch = firstDate.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
            if (dateMatch) {
              const day = parseInt(dateMatch[1], 10);
              const month = parseInt(dateMatch[2], 10);
              let year = parseInt(dateMatch[3], 10);
              // Якщо рік 2-значний, конвертуємо (92 → 1992, але 30 → 2030)
              if (year < 100) {
                year = year < 50 ? 2000 + year : 1900 + year;
              }
              // Перевіряємо валідність (день 1-31, місяць 1-12, рік >= 1900)
              if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
                // Форматуємо як YYYY-MM-DD для PostgreSQL
                result.valid_to = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              }
              // Якщо формат невалідний — не зберігаємо дату
            }
          }
        }
      }
    }
    
    // Спробуємо витягти status_note (підстава)
    if (foundStatus === 'expired') {
      const noteMatch = topBlock.match(/на\s+підставі\s+([^\.]+)/i);
      if (noteMatch) {
        result.status_note = noteMatch[1].substring(0, 200).trim();
      }
    }
  } else {
    // Якщо нічого не знайдено — встановлюємо defaults
    result.validity_status = 'unknown';
    result.status_note = 'no_evidence';
    result.source_status_text = 'N/A';
  }
  
  return result;
}

/**
 * Аналізує назву документа на предмет індикаторів чинності
 */
function extractValidityFromTitle(title: string | null | undefined): Partial<ValidityResult> | null {
  if (!title) return null;
  
  const titleLower = title.toLowerCase();
  
  // Патерни expired в назві
  if (
    titleLower.includes('втратив') && titleLower.includes('чинність') ||
    titleLower.includes('визнано таким') && titleLower.includes('втратив') ||
    titleLower.includes('визнання таким') && titleLower.includes('втратило') ||
    titleLower.includes('скасування') ||
    titleLower.includes('припинення чинності')
  ) {
    return {
      validity_status: 'expired',
      status_note: 'derived_from_title_pattern',
      source_status_text: title.substring(0, 200),
      source_status_location: 'document_title',
      confidence: 'high',
    };
  }
  
  // Патерни not_in_force в назві
  if (
    titleLower.includes('не набрав') ||
    titleLower.includes('не набув')
  ) {
    return {
      validity_status: 'not_in_force',
      status_note: 'derived_from_title_pattern',
      source_status_text: title.substring(0, 200),
      source_status_location: 'document_title',
      confidence: 'high',
    };
  }
  
  return null;
}

/**
 * Policy-by-type: для певних типів документів застосовуємо дефолтну політику
 */
function applyPolicyByType(
  documentTypeSlug: string | null | undefined,
  title: string | null | undefined
): ValidityResult | null {
  if (!documentTypeSlug) return null;
  
  // Конституція та кодекси: якщо немає явних маркерів втрати чинності → in_force
  if (documentTypeSlug === 'constitution' || documentTypeSlug === 'code') {
    // Перевіряємо чи в назві немає маркерів втрати чинності
    const titleLower = title?.toLowerCase() || '';
    if (!titleLower.includes('втратив') && !titleLower.includes('скасовано')) {
      return {
        validity_status: 'in_force',
        valid_from: null,
        valid_to: null,
        status_note: `policy_by_type:${documentTypeSlug}`,
        source_status_text: documentTypeSlug,
        source_status_location: 'policy.document_type',
        confidence: 'medium',
      };
    }
  }
  
  // Судові акти (КСУ, ВСУ): якщо немає "втратив чинність" → in_force (акт застосування/тлумачення)
  if (documentTypeSlug === 'ccu_decision' || documentTypeSlug === 'ccu_opinion' || 
      documentTypeSlug === 'vsu_decision' || documentTypeSlug === 'vsu_plenum') {
    const titleLower = title?.toLowerCase() || '';
    if (!titleLower.includes('втратив') && !titleLower.includes('скасовано')) {
      return {
        validity_status: 'in_force',
        valid_from: null,
        valid_to: null,
        status_note: `policy_by_type:${documentTypeSlug}`,
        source_status_text: documentTypeSlug,
        source_status_location: 'policy.document_type',
        confidence: 'medium',
      };
    }
  }
  
  return null;
}

/**
 * Головна функція — витягує чинність з JSON + тексту + назви + policy-by-type
 * 
 * Пріоритет:
 * 1. radaJson.status (висока впевненість)
 * 2. Назва документа (висока впевненість для явних маркерів)
 * 3. canonical topBlock + extended text (середня впевненість)
 * 4. Policy-by-type (середня впевненість для кодексів/конституції/судових актів)
 * 5. НЕ повертаємо unknown — завжди визначаємо статус
 */
export function extractValidity(
  jsonData?: any, 
  txtData?: string | null,
  canonicalTopBlock?: string | null,
  documentTypeSlug?: string | null,
  title?: string | null
): ValidityResult {
  // 1. Спочатку з JSON (найвищий пріоритет)
  const jsonResult = extractValidityFromJson(jsonData || {});
  
  // Якщо отримали впевнений результат з JSON (НЕ unknown) — повертаємо
  // ВАЖЛИВО: status=0/1/6 мають абсолютний пріоритет (висока впевненість)
  if (jsonResult.validity_status !== 'unknown' && jsonResult.confidence === 'high') {
    return jsonResult;
  }
  
  // Якщо JSON дав unknown з confidence='high' (наприклад, status=5) — продовжуємо пошук
  // Або якщо confidence='low' (немає статусу в JSON) — продовжуємо пошук
  
  // 2. Аналіз назви документа (висока впевненість для явних маркерів)
  const titleResult = extractValidityFromTitle(title || jsonData?.nazva);
  if (titleResult && titleResult.validity_status && titleResult.validity_status !== 'unknown') {
    return {
      validity_status: titleResult.validity_status,
      valid_from: titleResult.valid_from || null,
      valid_to: titleResult.valid_to || null,
      status_note: titleResult.status_note || 'derived_from_title',
      source_status_text: titleResult.source_status_text || 'N/A',
      source_status_location: titleResult.source_status_location || 'document_title',
      confidence: titleResult.confidence || 'high',
    };
  }
  
  // 3. Policy-by-type (високий пріоритет для кодексів/конституції/судових актів, якщо JSON не дав однозначної відповіді)
  // Для document_type_slug = 'code' / 'constitution' / 'ccu_*' ми довіряємо policy більше,
  // ніж евристикам по тексту, коли Rada JSON повертає status=5 (\"інше\") або нічого.
  const policyEarly = applyPolicyByType(documentTypeSlug, title || jsonData?.nazva);
  if (policyEarly) {
    return policyEarly;
  }
  
  // 4. Якщо статус все ще unknown — спробуємо з тексту (canonical topBlock або txtData)
  // Розширюємо пошук до 20k символів якщо status=5 або немає статусу
  const textSource = canonicalTopBlock || txtData || null;
  if (jsonResult.validity_status === 'unknown' && textSource) {
    // Для status=5 або відсутнього статусу — більш агресивний пошук
    const extendedText = textSource.length > 2500 && (jsonResult.source_status_text === '5' || jsonResult.source_status_text === 'N/A')
      ? textSource.substring(0, 20000) // Розширюємо до 20k для status=5
      : textSource.substring(0, 2500); // Стандартний topBlock
    
    const textResult = extractValidityFromText(extendedText);
    if (textResult.validity_status && textResult.validity_status !== 'unknown') {
      return {
        validity_status: textResult.validity_status,
        valid_from: textResult.valid_from || null,
        valid_to: textResult.valid_to || null,
        status_note: textResult.status_note || 'derived_from_text_pattern',
        source_status_text: textResult.source_status_text || 'N/A',
        source_status_location: jsonResult.source_status_location 
          ? `${jsonResult.source_status_location} + ${textResult.source_status_location}`
          : textResult.source_status_location || 'canonical.extended_text',
        confidence: textResult.confidence || 'medium',
      };
    }
  }
  
  // 5. Фінальний fallback: ZERO-UNKNOWN — завжди визначаємо статус
  // Застосовуємо консервативну політику: якщо немає маркерів втрати чинності → in_force
  // (бо більшість документів є чинними, якщо немає явних маркерів втрати чинності)
  const titleLower = (title || jsonData?.nazva || '').toLowerCase();
  const textLower = (textSource || '').toLowerCase();
  
  const hasExpiredMarkers = (
    titleLower.includes('втратив') ||
    titleLower.includes('втратило') ||
    titleLower.includes('втратили') ||
    titleLower.includes('скасовано') ||
    titleLower.includes('припинено') ||
    textLower.includes('втратив чинність') ||
    textLower.includes('втратило чинність') ||
    textLower.includes('втратили чинність') ||
    textLower.includes('скасовано') ||
    textLower.includes('припинено чинність')
  );
  
  // ZERO-UNKNOWN: завжди визначаємо статус (ніколи не повертаємо unknown)
  if (!hasExpiredMarkers) {
    // Для документів без маркерів втрати чинності → in_force (консервативна політика)
    return {
      validity_status: 'in_force',
      valid_from: null,
      valid_to: null,
      status_note: jsonResult.source_status_text === '5' 
        ? 'derived_from_rada_status_5_without_expired_markers'
        : (jsonResult.source_status_text && jsonResult.source_status_text !== 'N/A'
            ? `derived_from_rada_status_${jsonResult.source_status_text}_without_expired_markers`
            : 'default_in_force_no_markers'),
      source_status_text: jsonResult.source_status_text || 'N/A',
      source_status_location: jsonResult.source_status_location || 'fallback.conservative_policy',
      confidence: 'low',
    };
  }
  
  // Якщо є маркери втрати чинності, але не знайдені в тексті — expired
  return {
    validity_status: 'expired',
    valid_from: null,
    valid_to: null,
    status_note: 'derived_from_expired_markers',
    source_status_text: jsonResult.source_status_text || 'N/A',
    source_status_location: jsonResult.source_status_location || 'fallback.expired_markers',
    confidence: 'low',
  };
}

/**
 * Асинхронна версія — використовує Rada resolver як primary джерело
 * 
 * Пріоритет:
 * 1. Rada resolver (authoritative: card/status object) — PRIMARY
 * 2. Текстові regex (тільки якщо HTTP впав) — FALLBACK
 * 3. НЕ повертаємо unknown — завжди визначаємо статус
 */
export async function extractValidityAsync(
  nreg: string,
  radaClient: any, // RadaClient
  jsonData?: any,
  txtData?: string | null,
  canonicalTopBlock?: string | null,
  documentTypeSlug?: string | null,
  title?: string | null
): Promise<ValidityResult> {
  // 1. PRIMARY: Rada resolver (authoritative source)
  try {
    const { resolveValidityByNreg, bundleToResult } = await import('../lib/radaValidityResolver.js');
    const bundle = await resolveValidityByNreg(nreg, radaClient, true);
    const resolverResult = bundleToResult(bundle);
    
    // Якщо resolver дав впевнений результат (не fallback) — повертаємо
    if (!resolverResult.status_note.includes('fallback_api_error')) {
      return resolverResult;
    }
    
    // Якщо resolver дав fallback через помилку API — продовжуємо до текстового fallback
  } catch (error) {
    // Якщо resolver впав — продовжуємо до текстового fallback
    console.warn(`⚠️  Resolver error for ${nreg}: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // 2. FALLBACK: Текстові regex (тільки якщо HTTP впав)
  const textSource = canonicalTopBlock || txtData || null;
  if (textSource) {
    const textResult = extractValidityFromText(textSource.substring(0, 20000));
    if (textResult.validity_status && textResult.validity_status !== 'unknown') {
      return {
        validity_status: textResult.validity_status,
        valid_from: textResult.valid_from || null,
        valid_to: textResult.valid_to || null,
        status_note: `fallback_text_after_resolver_error`,
        source_status_text: textResult.source_status_text || 'N/A',
        source_status_location: textResult.source_status_location || 'canonical.topBlock',
        confidence: 'medium',
      };
    }
  }
  
  // 3. Фінальний fallback: ZERO-UNKNOWN
  return {
    validity_status: 'in_force',
    valid_from: null,
    valid_to: null,
    status_note: 'fallback_conservative_after_all_errors',
    source_status_text: 'N/A',
    source_status_location: 'fallback.conservative',
    confidence: 'low',
  };
}
