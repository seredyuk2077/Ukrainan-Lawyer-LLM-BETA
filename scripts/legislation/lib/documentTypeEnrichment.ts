/**
 * Document Type Enrichment — Heuristics + AI Fallback + Caching
 * 
 * Production hardening для document_type_slug та document_type (UA label).
 * 
 * Принципи:
 * 1. Heuristics-first для топових типів (law, code, constitution, cmu_resolution, vr_resolution)
 * 2. AI fallback з strict whitelist (не вигадує нові типи)
 * 3. Caching в R2 (legislation/ai_cache/document_type/{fingerprint}.json)
 */

import { DocumentTypeSlug, DOCUMENT_TYPES, getDocumentTypeInfo, normalizeDocumentType } from '../documentTypes/documentTypes.js';
import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { createR2Client, getLegislationBucket } from './r2Client.js';
import { createHash } from 'crypto';

export interface DocumentTypeEnrichmentResult {
  slug: DocumentTypeSlug;
  label_uk: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'heuristics' | 'ai' | 'normalized' | 'cache';
  rationale?: string;
  validation?: {
    status: 'ok' | 'warn' | 'fail';
    issues: string[];
  };
}

/**
 * Генерує fingerprint для кешування
 */
function generateFingerprint(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
}): string {
  const key = JSON.stringify({
    title: params.title.trim().toLowerCase(),
    typ: params.typ,
    typn: params.typn,
    organs: typeof params.organs === 'string' ? params.organs : JSON.stringify(params.organs),
  });
  return createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * Читає кешований результат з R2
 */
async function getCachedDocumentType(fingerprint: string): Promise<DocumentTypeEnrichmentResult | null> {
  try {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const r2 = createR2Client();
    const bucket = getLegislationBucket();
    const cacheKey = `legislation/ai_cache/document_type/${fingerprint}.json`;
    
    const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: cacheKey }));
    if (!res.Body) return null;
    
    // Stream to string
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    
    const cached = JSON.parse(text);
    return cached as DocumentTypeEnrichmentResult;
  } catch {
    return null;
  }
}

/**
 * Зберігає результат в R2 кеш
 */
async function setCachedDocumentType(fingerprint: string, result: DocumentTypeEnrichmentResult): Promise<void> {
  try {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const r2 = createR2Client();
    const bucket = getLegislationBucket();
    const cacheKey = `legislation/ai_cache/document_type/${fingerprint}.json`;
    
    await r2.send(new PutObjectCommand({
      Bucket: bucket,
      Key: cacheKey,
      Body: JSON.stringify(result, null, 2),
      ContentType: 'application/json',
    }));
  } catch (error) {
    console.warn(`⚠️  Failed to cache document type: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * AI fallback з strict whitelist
 */
async function guessDocumentTypeWithAI(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
}): Promise<DocumentTypeEnrichmentResult | null> {
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  OPEN_ROUTER_API_RAG not set, skipping AI fallback');
    return null;
  }

  // Формуємо whitelist для AI
  const whitelist = Object.entries(DOCUMENT_TYPES)
    .map(([slug, info]) => `"${slug}" (${info.label_uk})`)
    .join(', ');

  const prompt = `Ти експерт з українського законодавства. Визнач тип нормативно-правового акту.

**Назва:** ${params.title}
**Typ (з Rada API):** ${params.typ || 'не вказано'}
**TypN:** ${params.typn || 'не вказано'}
**Organs:** ${typeof params.organs === 'string' ? params.organs : JSON.stringify(params.organs || {})}

**Доступні типи (whitelist):**
${whitelist}

**Завдання:**
Поверни ТІЛЬКИ один slug з whitelist. НЕ вигадуй нові типи.

Поверни STRICT JSON ONLY:
{
  "slug": "string (з whitelist)",
  "confidence": "high|medium|low",
  "rationale": "string (коротке пояснення)"
}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/legislation-rag',
        'X-Title': 'Legislation RAG',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.7-sonnet',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(`OpenRouter API error: ${data.error.message || 'Unknown error'}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Invalid response from OpenRouter: content not found');

    // Extract JSON
    let jsonString = content.trim();
    const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) jsonString = jsonMatch[1].trim();
    const jsonStart = jsonString.indexOf('{');
    const jsonEnd = jsonString.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      jsonString = jsonString.substring(jsonStart, jsonEnd + 1);
    }

    const aiResult = JSON.parse(jsonString) as {
      slug?: string;
      confidence?: string;
      rationale?: string;
    };

    // Validation: slug має бути в whitelist
    if (!aiResult.slug || !(aiResult.slug in DOCUMENT_TYPES)) {
      console.warn(`⚠️  AI returned invalid slug: ${aiResult.slug}, falling back to normalized`);
      return null;
    }

    const slug = aiResult.slug as DocumentTypeSlug;
    const info = getDocumentTypeInfo(slug);

    return {
      slug,
      label_uk: info.label_uk,
      confidence: (aiResult.confidence as 'high' | 'medium' | 'low') || 'medium',
      source: 'ai',
      rationale: aiResult.rationale || 'AI classification',
    };
  } catch (error) {
    console.warn(`⚠️  AI document type classification failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Валідація консистентності типу документа з summary/snippet
 * Повертає також suggested_slug якщо валідація виявила конфлікт
 */
function validateDocumentTypeConsistency(
  slug: DocumentTypeSlug,
  title: string,
  summary?: string | null,
  snippet?: string | null
): { status: 'ok' | 'warn' | 'fail'; issues: string[]; suggested_slug?: DocumentTypeSlug } {
  const issues: string[] = [];
  let suggestedSlug: DocumentTypeSlug | undefined;
  const lowerTitle = title.toLowerCase();
  const lowerSummary = summary?.toLowerCase() || '';
  const lowerSnippet = snippet?.toLowerCase() || '';
  const combined = `${lowerTitle} ${lowerSummary} ${lowerSnippet}`;
  
  // Правило 1: Розпорядження КМУ в summary/snippet але slug != cmu_order
  if ((lowerSummary.includes('розпорядження') && (lowerSummary.includes('кму') || lowerSummary.includes('кабінет'))) ||
      (lowerSnippet.includes('розпорядження') && (lowerSnippet.includes('кму') || lowerSnippet.includes('кабінет')))) {
    if (slug !== 'cmu_order') {
      issues.push('summary/snippet: Розпорядження КМУ, але slug != cmu_order');
      suggestedSlug = 'cmu_order';
    }
  }
  
  // Правило 2: Постанова ЦВК в summary/snippet/title але slug != cec_resolution (КРИТИЧНЕ)
  if ((lowerSummary.includes('постанова') && (lowerSummary.includes('цвк') || lowerSummary.includes('центральна виборча') || lowerSummary.includes('центральної виборчої'))) ||
      (lowerSnippet.includes('постанова') && (lowerSnippet.includes('цвк') || lowerSnippet.includes('центральна виборча') || lowerSnippet.includes('центральної виборчої'))) ||
      (lowerTitle.includes('цвк') || lowerTitle.includes('центральна виборча') || lowerTitle.includes('центральної виборчої'))) {
    if (slug !== 'cec_resolution') {
      issues.push('summary/snippet/title: Постанова ЦВК, але slug != cec_resolution');
      suggestedSlug = 'cec_resolution';
      // КРИТИЧНЕ: ЦВК не має бути cmu_resolution або vr_resolution
      if (slug === 'cmu_resolution' || slug === 'vr_resolution') {
        issues.push(`CRITICAL: ЦВК документ має slug=${slug} (має бути cec_resolution)`);
      }
    }
  }
  
  // Правило 3: НБУ в summary/snippet але slug не nbu_*
  if ((lowerSummary.includes('нбу') || lowerSummary.includes('національний банк')) ||
      (lowerSnippet.includes('нбу') || lowerSnippet.includes('національний банк'))) {
    if (!slug.startsWith('nbu_')) {
      issues.push('summary/snippet: НБУ, але slug не nbu_*');
      
      // Визначаємо suggested_slug на основі summary/snippet
      if (lowerSummary.includes('повідомлення') || lowerSummary.includes('лист') || 
          lowerSummary.includes('роз\'яснення') || lowerSummary.includes('розяснення') ||
          lowerSnippet.includes('повідомлення') || lowerSnippet.includes('лист')) {
        suggestedSlug = 'nbu_letter';
      } else if (lowerSummary.includes('постанова') || lowerSummary.includes('рішення') ||
                 lowerSummary.includes('правління') ||
                 lowerSnippet.includes('постанова') || lowerSnippet.includes('рішення')) {
        suggestedSlug = 'nbu_resolution';
      } else {
        // За замовчуванням для НБУ → nbu_letter (частіше)
        suggestedSlug = 'nbu_letter';
      }
    } else {
      // Додаткова перевірка: якщо "повідомлення/лист" але slug = nbu_resolution
      if ((lowerSummary.includes('повідомлення') || lowerSummary.includes('лист') || 
           lowerSummary.includes('роз\'яснення') || lowerSummary.includes('розяснення')) &&
          slug === 'nbu_resolution') {
        issues.push('summary: Повідомлення/Лист НБУ, але slug = nbu_resolution (має бути nbu_letter)');
        suggestedSlug = 'nbu_letter';
      }
    }
  }
  
  // Правило 4: Указ Президента в summary/snippet але slug != presidential_decree
  if ((lowerSummary.includes('указ') && lowerSummary.includes('президент')) ||
      (lowerSnippet.includes('указ') && lowerSnippet.includes('президент'))) {
    if (slug !== 'presidential_decree') {
      issues.push('summary/snippet: Указ Президента, але slug != presidential_decree');
      // "Указ про введення в дію рішення РНБО" → все одно presidential_decree (не regulation)
      suggestedSlug = 'presidential_decree';
    }
  }
  
  // Правило 5: РНБО в summary/snippet але slug != rnbo_decision
  if ((lowerSummary.includes('рнбо') || lowerSummary.includes('рада національної безпеки')) ||
      (lowerSnippet.includes('рнбо') || lowerSnippet.includes('рада національної безпеки'))) {
    // Виняток: якщо це "Указ про введення в дію рішення РНБО" → presidential_decree OK
    if (!combined.includes('указ про введення в дію') && slug !== 'rnbo_decision') {
      issues.push('summary/snippet: РНБО, але slug != rnbo_decision');
    }
  }
  
  // Правило 6: slug = law але є сигнали НБУ/ЦВК/Указ/Розпорядження/РНБО
  if (slug === 'law') {
    if (combined.includes('нбу') || combined.includes('національний банк')) {
      issues.push('slug=law, але є сигнали НБУ (має бути nbu_*)');
    }
    if (combined.includes('цвк') || combined.includes('центральна виборча')) {
      issues.push('slug=law, але є сигнали ЦВК (має бути cec_resolution)');
    }
    if (combined.includes('указ') && combined.includes('президент')) {
      issues.push('slug=law, але є сигнали Указ Президента (має бути presidential_decree)');
    }
    if (combined.includes('розпорядження') && (combined.includes('кму') || combined.includes('кабінет'))) {
      issues.push('slug=law, але є сигнали Розпорядження КМУ (має бути cmu_order)');
    }
  }
  
  // Визначаємо статус
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  if (issues.length > 0) {
    // Критичні конфлікти → fail
    if (issues.some(i => i.includes('slug=law') || i.includes('slug !='))) {
      status = 'fail';
    } else {
      status = 'warn';
    }
  }
  
  // Якщо є suggested_slug → це fail (потрібно виправити)
  if (suggestedSlug) {
    status = 'fail';
  }
  
  return { status, issues, suggested_slug: suggestedSlug };
}

/**
 * Головна функція: Heuristics → AI → Normalized fallback + Validation
 */
export async function enrichDocumentType(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
  stru?: any[];
  summary?: string | null;
  snippet?: string | null;
}): Promise<DocumentTypeEnrichmentResult> {
  const fingerprint = generateFingerprint(params);

  // 1. Перевіряємо кеш (але валідацію завжди виконуємо заново)
  const cached = await getCachedDocumentType(fingerprint);
  if (cached) {
    // Валідація консистентності для кешованого результату
    const validation = validateDocumentTypeConsistency(
      cached.slug,
      params.title,
      params.summary,
      params.snippet
    );
    
    // Якщо валідація fail → перевизначаємо slug на основі suggested_slug
    let finalSlug = cached.slug;
    let finalConfidence = cached.confidence;
    
    if (validation.status === 'fail') {
      // Якщо є suggested_slug з валідації → використовуємо його
      if (validation.suggested_slug) {
        finalSlug = validation.suggested_slug;
        finalConfidence = 'high'; // Високий confidence бо базується на summary/snippet
      } else if (validation.issues.some(i => i.includes('slug=law'))) {
        // Критичний конфлікт без suggested_slug → ставимо unknown
        finalSlug = 'unknown';
        finalConfidence = 'low';
      } else if (finalConfidence === 'high') {
        finalConfidence = 'medium';
      }
    }
    
    return {
      slug: finalSlug,
      label_uk: getDocumentTypeInfo(finalSlug).label_uk,
      confidence: finalConfidence,
      source: 'cache',
      rationale: cached.rationale,
      validation: validation.issues.length > 0 ? validation : undefined,
    };
  }

  // 2. Heuristics-first
  const heuristicsResult = guessDocumentTypeV2(params);
  
  if (heuristicsResult.confidence === 'high' || heuristicsResult.confidence === 'medium') {
    const info = getDocumentTypeInfo(heuristicsResult.slug);
    
    // Валідація консистентності
    const validation = validateDocumentTypeConsistency(
      heuristicsResult.slug,
      params.title,
      params.summary,
      params.snippet
    );
    
    // Якщо валідація fail → перевизначаємо slug на основі suggested_slug
    let finalSlug = heuristicsResult.slug;
    let finalConfidence = heuristicsResult.confidence;
    
    if (validation.status === 'fail') {
      // Якщо є suggested_slug з валідації → використовуємо його
      if (validation.suggested_slug) {
        finalSlug = validation.suggested_slug;
        finalConfidence = 'high'; // Високий confidence бо базується на summary/snippet
      } else if (validation.issues.some(i => i.includes('slug=law'))) {
        // Критичний конфлікт без suggested_slug → ставимо unknown
        finalSlug = 'unknown';
        finalConfidence = 'low';
      } else if (finalConfidence === 'high') {
        finalConfidence = 'medium';
      }
    }
    
    const result: DocumentTypeEnrichmentResult = {
      slug: finalSlug,
      label_uk: getDocumentTypeInfo(finalSlug).label_uk,
      confidence: finalConfidence,
      source: 'heuristics',
      rationale: heuristicsResult.rationale,
      validation: validation.issues.length > 0 ? validation : undefined,
    };
    
    // Кешуємо результат
    await setCachedDocumentType(fingerprint, result);
    return result;
  }

  // 3. AI fallback (якщо heuristics не впевнені)
  const aiResult = await guessDocumentTypeWithAI(params);
  if (aiResult) {
    // Валідація консистентності для AI результату
    const validation = validateDocumentTypeConsistency(
      aiResult.slug,
      params.title,
      params.summary,
      params.snippet
    );
    
    // Якщо валідація fail → перевизначаємо slug на основі suggested_slug
    let finalSlug = aiResult.slug;
    let finalConfidence = aiResult.confidence;
    
    if (validation.status === 'fail') {
      // Якщо є suggested_slug з валідації → використовуємо його
      if (validation.suggested_slug) {
        finalSlug = validation.suggested_slug;
        finalConfidence = 'high'; // Високий confidence бо базується на summary/snippet
      } else if (validation.issues.some(i => i.includes('slug=law'))) {
        // Критичний конфлікт без suggested_slug → ставимо unknown
        finalSlug = 'unknown';
        finalConfidence = 'low';
      } else if (finalConfidence === 'high') {
        finalConfidence = 'medium';
      }
    }
    
    const result: DocumentTypeEnrichmentResult = {
      slug: finalSlug,
      label_uk: getDocumentTypeInfo(finalSlug).label_uk,
      confidence: finalConfidence,
      source: 'ai',
      rationale: aiResult.rationale,
      validation: validation.issues.length > 0 ? validation : undefined,
    };
    
    // Кешуємо результат
    await setCachedDocumentType(fingerprint, result);
    return result;
  }
  
  // 4. Normalized fallback (якщо AI не спрацював)
  // Спробуємо нормалізувати з title якщо можливо
  const normalizedSlug = normalizeDocumentType(params.title);
  const info = getDocumentTypeInfo(normalizedSlug);
  
  // Валідація для normalized
  const validation = validateDocumentTypeConsistency(
    normalizedSlug,
    params.title,
    params.summary,
    params.snippet
  );
  
  // Якщо валідація fail → ставимо unknown замість normalized
  let finalSlug = normalizedSlug;
  if (validation.status === 'fail') {
    finalSlug = 'unknown';
  }
  
  const result: DocumentTypeEnrichmentResult = {
    slug: finalSlug,
    label_uk: getDocumentTypeInfo(finalSlug).label_uk,
    confidence: 'low',
    source: 'normalized',
    rationale: 'Normalized from title',
    validation: validation.issues.length > 0 ? validation : undefined,
  };
  
  // Кешуємо навіть fallback результат
  await setCachedDocumentType(fingerprint, result);
  return result;
}
