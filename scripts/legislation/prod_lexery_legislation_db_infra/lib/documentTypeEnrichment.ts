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
  confidence: 'high' | 'medium';
  source: 'heuristics' | 'ai' | 'normalized' | 'cache';
  rationale?: string;
  decision_trace?: string[];  // PHASE 15: trace для debug (які правила спрацювали)
  validation?: {
    status: 'ok' | 'warn' | 'fail';
    issues: string[];
  };
}

// Cache version bump для document_type
// PHASE 3: VR_SPEAKER_ORDER fix → v3
// PHASE 15: KIND-FIRST logic для z**** minister orders → v4
// PHASE 15.1: typ=22 (CCU decision) fix → v5
// PHASE 15.2: validator fix для CCU decisions (не перевизначати на presidential_decree) → v6
// PHASE 15.3: typ=22 rule покращено (перевіряє raw_txt/snippet), buildCanonical передає raw_txt → v7
// PHASE 15.4: typ=9 rule покращено (SERVICE/AGENCY/INSPECTION), extractIssuerFromPrefix для АДМІНІСТРАЦІЯ → v8
// PHASE 15.5: typ=2 rule додано НБУ, validator fix для постанов КМУ/ВРУ (не перевизначати на presidential_decree) → v9
// PHASE 15.6: додано minister_explanation для роз'яснень, typ=12 rule, покращено AI fallback (raw_txt/snippet) → v10
const DOCUMENT_TYPE_CACHE_VERSION = 'doc_type_v15';

/**
 * Генерує fingerprint для кешування
 */
function generateFingerprint(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
  summary?: string | null;
  snippet?: string | null;
  document_number?: string | null;
  raw_txt?: string | null;  // Додано для priority ladder
}): string {
  // ВАЖЛИВО: fingerprint має включати summary/snippet/raw_txt hash, щоб не кешувати помилки
  const summaryHash = params.summary ? createHash('sha256').update(params.summary.substring(0, 200), 'utf-8').digest('hex').slice(0, 8) : '';
  const snippetHash = params.snippet ? createHash('sha256').update(params.snippet.substring(0, 200), 'utf-8').digest('hex').slice(0, 8) : '';
  const rawTxtHash = params.raw_txt ? createHash('sha256').update(params.raw_txt.substring(0, 400), 'utf-8').digest('hex').slice(0, 8) : '';
  const docNumHash = params.document_number ? createHash('sha256').update(params.document_number.trim().toUpperCase(), 'utf-8').digest('hex').slice(0, 8) : '';
  
  const key = JSON.stringify({
    version: DOCUMENT_TYPE_CACHE_VERSION,  // Cache version bump
    title: params.title.trim().toLowerCase(),
    typ: params.typ,
    typn: params.typn,
    organs: typeof params.organs === 'string' ? params.organs : JSON.stringify(params.organs),
    summary_hash: summaryHash,
    snippet_hash: snippetHash,
    raw_txt_hash: rawTxtHash,  // Додано для priority ladder
    document_number_hash: docNumHash,  // Додано для prefix-sniff правил
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
  snippet?: string | null;
  raw_txt?: string | null;
  summary?: string | null;
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

  // Формуємо контекст для AI (перші 800 символів raw_txt або snippet)
  const contextText = params.raw_txt?.substring(0, 800) || 
                      params.snippet?.substring(0, 400) || 
                      params.summary?.substring(0, 200) || 
                      '';

  const prompt = `Ти експерт з українського законодавства. Визнач тип нормативно-правового акту.

**Назва:** ${params.title}
**Typ (з Rada API):** ${params.typ || 'не вказано'}
**TypN:** ${params.typn || 'не вказано'}
**Organs:** ${typeof params.organs === 'string' ? params.organs : JSON.stringify(params.organs || {})}
${contextText ? `**Початок тексту документа:**\n${contextText.substring(0, 600)}` : ''}

**Доступні типи (whitelist):**
${whitelist}

**Завдання:**
Поверни ТІЛЬКИ один slug з whitelist. НЕ вигадуй нові типи.
ВАЖЛИВО: якщо в тексті є "РОЗ'ЯСНЕННЯ" (з розрядкою або без) → використовуй minister_explanation.
Якщо в тексті є "НАКАЗ" + назва органу (міністерство/комітет/служба/агентство/інспекція) → використовуй minister_order.
Якщо в тексті є "НАКАЗ" + "КАБІНЕТ МІНІСТРІВ" → використовуй cmu_order.

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
      confidence: aiResult.confidence === 'high' ? 'high' : 'medium',
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
export async function validateDocumentTypeConsistency(
  slug: DocumentTypeSlug,
  title: string,
  summary?: string | null,
  snippet?: string | null
): Promise<{ status: 'ok' | 'warn' | 'fail'; issues: string[]; suggested_slug?: DocumentTypeSlug }> {
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
  
  // Правило 3.1: Декрет КМУ в snippet/summary але slug != cmu_decree (КРИТИЧНЕ)
  // Використовуємо normalizeTopBlock з signalExtractor для правильного прибирання розрядки
  const { normalizeTopBlock } = await import('./signalExtractor.js');
  const normalizedSnippetForDekret = normalizeTopBlock(snippet || '', 600);
  const hasDekret = normalizedSnippetForDekret.includes('ДЕКРЕТ') || normalizedSnippetForDekret.includes('ДЕКРЕТУ');
  const hasCabmin = normalizedSnippetForDekret.includes('КАБІНЕТУ МІНІСТРІВ') || 
                     normalizedSnippetForDekret.includes('КАБІНЕТ МІНІСТРІВ') ||
                     normalizedSnippetForDekret.includes('КМУ');
  
  if (hasDekret && hasCabmin && slug !== 'cmu_decree') {
    issues.push('CRITICAL: Декрет КМУ в snippet, але slug != cmu_decree');
    suggestedSlug = 'cmu_decree';
  }
  
  // Правило 3.2: EU Directive в title/snippet але slug != eu_directive (КРИТИЧНЕ)
  const hasEuDirective = (lowerTitle.includes('директива') && lowerTitle.includes('європейського парламенту')) ||
                         (lowerSnippet.includes('директива') && lowerSnippet.includes('європейського парламенту')) ||
                         (lowerSummary.includes('директива') && lowerSummary.includes('європейського парламенту'));
  if (hasEuDirective && slug !== 'eu_directive') {
    issues.push('CRITICAL: Директива Європейського парламенту, але slug != eu_directive');
    suggestedSlug = 'eu_directive';
  }
  
  // Правило 3.3: EU Regulation в title/snippet але slug != eu_regulation (КРИТИЧНЕ)
  const hasEuRegulation = (lowerTitle.includes('регламент') && lowerTitle.includes('європейського парламенту')) ||
                          (lowerSnippet.includes('регламент') && lowerSnippet.includes('європейського парламенту')) ||
                          (lowerSummary.includes('регламент') && lowerSummary.includes('європейського парламенту'));
  if (hasEuRegulation && slug !== 'eu_regulation') {
    issues.push('CRITICAL: Регламент Європейського парламенту, але slug != eu_regulation');
    suggestedSlug = 'eu_regulation';
  }
  
  // Правило 3.4: НКРЕКП Постанова в snippet але slug != nerc_resolution (КРИТИЧНЕ)
  const hasNerc = normalizedSnippetForDekret.includes('НАЦІОНАЛЬНА КОМІСІЯ') &&
                   (normalizedSnippetForDekret.includes('ЕНЕРГЕТИКИ') || 
                    normalizedSnippetForDekret.includes('КОМУНАЛЬНИХ') ||
                    normalizedSnippetForDekret.includes('НКРЕКП'));
  const hasPostanovaNerc = normalizedSnippetForDekret.includes('ПОСТАНОВА') && hasNerc;
  if (hasPostanovaNerc && slug !== 'nerc_resolution') {
    issues.push('CRITICAL: Постанова НКРЕКП в snippet, але slug != nerc_resolution');
    suggestedSlug = 'nerc_resolution';
  }
  
  // Правило 3.5: Issuer mismatch (постанова не КМУ але slug=cmu_resolution)
  const { extractIssuerSignals } = await import('./signalExtractor.js');
  const issuerSignals = extractIssuerSignals({
    title,
    snippet: snippet || null,
    summary: summary || null,
    organs: null,
  });
  
  if (slug === 'cmu_resolution' && issuerSignals.length > 0 && 
      issuerSignals[0] !== 'CMU' && issuerSignals[0] !== 'OTHER') {
    issues.push(`CRITICAL: issuer=${issuerSignals[0]}, але slug=cmu_resolution`);
    // Визначаємо suggested_slug на основі issuer
    if (issuerSignals[0] === 'NERC') {
      suggestedSlug = 'nerc_resolution';
    } else if (issuerSignals[0] === 'VRU') {
      suggestedSlug = 'vr_resolution';
    } else if (issuerSignals[0] === 'CEC') {
      suggestedSlug = 'cec_resolution';
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
  // ВАЖЛИВО: винятки для:
  // 1) рішень КСУ про указ президента (не перевизначаємо ccu_decision)
  // 2) постанов КМУ/ВРУ, які містять згадку про указ президента як посилання (не перевизначаємо)
  const isCcuDecision = slug === 'ccu_decision' ||
                        combined.includes('рішення') && 
                        (combined.includes('ксу') || combined.includes('конституційний суд') ||
                         combined.includes('конституційного суду') || combined.includes('сенат'));
  
  // Перевіряємо чи це постанова КМУ/ВРУ з посиланням на указ президента
  const isResolutionWithReference = (slug === 'cmu_resolution' || slug === 'vr_resolution') &&
                                     (lowerSnippet.includes('кабінет') || lowerSnippet.includes('верховна') ||
                                      lowerSnippet.includes('постанова')) &&
                                     (lowerSnippet.includes('постанова') || lowerSummary.includes('постанова'));
  
  if ((lowerSummary.includes('указ') && lowerSummary.includes('президент')) ||
      (lowerSnippet.includes('указ') && lowerSnippet.includes('президент'))) {
    if (slug !== 'presidential_decree' && !isCcuDecision && !isResolutionWithReference) {
      issues.push('summary/snippet: Указ Президента, але slug != presidential_decree');
      // "Указ про введення в дію рішення РНБО" → все одно presidential_decree (не regulation)
      suggestedSlug = 'presidential_decree';
    }
  }

  // Правило 4.5: Розпорядження Президента в summary/snippet/title але slug != presidential_order (КРИТИЧНЕ)
  // Використовуємо normalizePrefix з Правила 6 (визначено нижче)
  const normalizePrefixForPres = (text: string | null | undefined): string => {
    if (!text) return '';
    return text
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/[\n\t\r]/g, ' ')
      .replace(/["'«»]/g, '')
      .substring(0, 200);
  };
  const normalizedSnippetForPres = normalizePrefixForPres(snippet || title);
  const hasPresident = normalizedSnippetForPres.includes('ПРЕЗИДЕНТ') || normalizedSnippetForPres.includes('ПРЕЗИДЕНТА');
  if ((normalizedSnippetForPres.includes('РОЗПОРЯДЖЕННЯ') && hasPresident) ||
      (lowerSummary.includes('розпорядження') && lowerSummary.includes('президент')) ||
      (lowerSnippet.includes('розпорядження') && lowerSnippet.includes('президент'))) {
    if (slug !== 'presidential_order') {
      issues.push('summary/snippet/title: Розпорядження Президента, але slug != presidential_order');
      suggestedSlug = 'presidential_order';
      // КРИТИЧНЕ: Розпорядження Президента не має бути regulation
      if (slug === 'regulation') {
        issues.push(`CRITICAL: Розпорядження Президента має slug=${slug} (має бути presidential_order)`);
      }
    }
  }
  
  // Правило 5: РНБО в summary/snippet/title але slug != rnbo_decision (КРИТИЧНЕ)
  // ВАЖЛИВО: snippet-first priority - перевіряємо чи topBlock починається з "РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ... РІШЕННЯ" або "УКАЗ ПРЕЗИДЕНТА"
  const topBlockForRnbo = (snippet || title || '').toUpperCase().trim();
  const topBlockFirst400 = topBlockForRnbo.substring(0, 400);
  const hasRnboPrefix = topBlockFirst400.includes('РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ') || topBlockFirst400.includes('РАДИ НАЦІОНАЛЬНОЇ БЕЗПЕКИ');
  const hasRishennyaInPrefix = topBlockFirst400.includes('РІШЕННЯ');
  const hasUkazStartsWith = topBlockForRnbo.startsWith('УКАЗ') || topBlockForRnbo.startsWith('УКАЗОМ');
  const hasPresidentInPrefix = topBlockForRnbo.substring(0, 200).includes('ПРЕЗИДЕНТ');
  const hasRnboInText = (lowerSummary.includes('рнбо') || lowerSummary.includes('рада національної безпеки') || lowerSummary.includes('ради національної безпеки')) ||
                        (lowerSnippet.includes('рнбо') || lowerSnippet.includes('рада національної безпеки') || lowerSnippet.includes('ради національної безпеки')) ||
                        (lowerTitle.includes('рнбо') || lowerTitle.includes('рада національної безпеки') || lowerTitle.includes('ради національної безпеки'));
  
  if (hasRnboInText) {
    // Якщо topBlock починається з "РАДА НАЦІОНАЛЬНОЇ БЕЗПЕКИ... РІШЕННЯ" → це справжнє рішення РНБО
    // ВАЖЛИВО: перевіряємо перші 400 символів, щоб не плутати з "Введено в дію Указом" далі в тексті
    if (hasRnboPrefix && hasRishennyaInPrefix && !hasUkazStartsWith) {
      if (slug !== 'rnbo_decision') {
        issues.push('CRITICAL: Рішення РНБО (topBlock починається з РНБО+РІШЕННЯ в перших 400 символах), але slug != rnbo_decision');
        suggestedSlug = 'rnbo_decision';
      }
    }
    // Виняток: якщо snippet/title починається з "УКАЗ ПРЕЗИДЕНТА" і містить "рішення РНБО" → presidential_decree OK
    // ВАЖЛИВО: перевіряємо чи topBlock починається з "УКАЗ", а не просто містить "Указом" далі
    else if (hasUkazStartsWith && hasPresidentInPrefix) {
      // Це указ про введення в дію рішення РНБО → presidential_decree правильний
      // НЕ видаємо помилку, бо це правильна класифікація
      if (slug !== 'presidential_decree') {
        issues.push('CRITICAL: Указ Президента про рішення РНБО (topBlock починається з УКАЗ), але slug != presidential_decree');
        suggestedSlug = 'presidential_decree';
      }
      // Якщо slug = presidential_decree → все OK, не додаємо issues
    } else if (slug !== 'rnbo_decision') {
      issues.push('summary/snippet/title: РНБО, але slug != rnbo_decision');
      suggestedSlug = 'rnbo_decision';
      // КРИТИЧНЕ: РНБО не має бути law/code
      if (slug === 'law' || slug === 'code') {
        issues.push(`CRITICAL: РНБО документ має slug=${slug} (має бути rnbo_decision)`);
      }
    }
  }
  
  // Правило 6: Розпорядження Голови ВРУ (prefix-based, КРИТИЧНЕ)
  const normalizePrefix = (text: string | null | undefined): string => {
    if (!text) return '';
    return text
      .trim()
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .replace(/[\n\t\r]/g, ' ')
      .replace(/["'«»]/g, '')
      .substring(0, 200);
  };
  
  const normalizedSnippet = normalizePrefix(snippet || title);
  const normalizedTitle = normalizePrefix(title);
  
  // ВАЖЛИВО: "ГОЛОВА" (однина) або "ГОЛОВИ" (множина) - обидва варіанти
  const hasGolovySnippet = normalizedSnippet.includes('ГОЛОВА') || normalizedSnippet.includes('ГОЛОВИ');
  const hasGolovyTitle = normalizedTitle.includes('ГОЛОВА') || normalizedTitle.includes('ГОЛОВИ');
  const hasVRUSnippet = normalizedSnippet.includes('ВЕРХОВНОЇ РАДИ') || normalizedSnippet.includes('ВРУ');
  const hasVRUTitle = normalizedTitle.includes('ВЕРХОВНОЇ РАДИ') || normalizedTitle.includes('ВРУ');
  
  if ((normalizedSnippet.includes('РОЗПОРЯДЖЕННЯ') && hasGolovySnippet && hasVRUSnippet) ||
      (normalizedTitle.includes('РОЗПОРЯДЖЕННЯ') && hasGolovyTitle && hasVRUTitle)) {
    if (slug !== 'vr_speaker_order') {
      issues.push('CRITICAL: Розпорядження Голови ВРУ (prefix-based), але slug != vr_speaker_order');
      suggestedSlug = 'vr_speaker_order';
      // КРИТИЧНЕ: не може бути regulation/position
      if (slug === 'regulation') {
        issues.push(`CRITICAL: Розпорядження Голови ВРУ має slug=regulation (має бути vr_speaker_order)`);
      }
    }
  }
  
  // Правило 6: slug = law але є сигнали НБУ/ЦВК/Указ/Розпорядження/РНБО (КРИТИЧНЕ)
  if (slug === 'law') {
    if (combined.includes('нбу') || combined.includes('національний банк')) {
      issues.push('slug=law, але є сигнали НБУ (має бути nbu_*)');
      suggestedSlug = combined.includes('повідомлення') || combined.includes('лист') ? 'nbu_letter' : 'nbu_resolution';
    }
    if (combined.includes('цвк') || combined.includes('центральна виборча')) {
      issues.push('slug=law, але є сигнали ЦВК (має бути cec_resolution)');
      suggestedSlug = 'cec_resolution';
    }
    if (combined.includes('указ') && combined.includes('президент')) {
      issues.push('slug=law, але є сигнали Указ Президента (має бути presidential_decree)');
      suggestedSlug = 'presidential_decree';
    }
    if (combined.includes('розпорядження') && (combined.includes('кму') || combined.includes('кабінет'))) {
      issues.push('slug=law, але є сигнали Розпорядження КМУ (має бути cmu_order)');
      suggestedSlug = 'cmu_order';
    }
    // КРИТИЧНЕ: РНБО не може бути law
    if (combined.includes('рнбо') || combined.includes('рада національної безпеки') || combined.includes('ради національної безпеки')) {
      issues.push('CRITICAL: slug=law, але є сигнали РНБО (має бути rnbo_decision)');
      suggestedSlug = 'rnbo_decision';
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
  document_number?: string | null;  // PHASE 1: для suffix check (-РП, -РГ)
  raw_txt?: string | null;  // Додано для priority ladder (raw.rada_api_txt)
}): Promise<DocumentTypeEnrichmentResult> {
  const fingerprint = generateFingerprint(params);

  // 1. Перевіряємо кеш (але валідацію завжди виконуємо заново)
  const cached = await getCachedDocumentType(fingerprint);
  if (cached) {
    // Валідація консистентності для кешованого результату
    const validation = await validateDocumentTypeConsistency(
      cached.slug,
      params.title,
      params.summary,
      params.snippet
    );
    
    // Якщо валідація fail → перевизначаємо slug на основі suggested_slug (КРИТИЧНЕ override)
    let finalSlug = cached.slug;
    let finalConfidence = cached.confidence;
    
    if (validation.status === 'fail') {
      // Якщо є suggested_slug з валідації → використовуємо його (КРИТИЧНЕ override)
      if (validation.suggested_slug) {
        finalSlug = validation.suggested_slug;
        finalConfidence = 'high'; // Високий confidence бо базується на summary/snippet/title
        // КРИТИЧНЕ: якщо є CRITICAL issues (RNBO_AS_LAW, CEC_AS_CMU, etc) → завжди override
        if (validation.issues.some(i => i.includes('CRITICAL') || i.includes('slug=law') || i.includes('slug=code'))) {
          finalConfidence = 'high';
        }
      } else if (validation.issues.some(i => i.includes('slug=law') || i.includes('slug=code'))) {
        // Критичний конфлікт без suggested_slug → ставимо unknown
        finalSlug = 'unknown';
        finalConfidence = 'medium';
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
  // PRIORITY LADDER: передаємо raw_txt окремо в guessDocumentTypeV2 (якщо доступний)
  // ВАЖЛИВО: raw_txt має пріоритет над snippet для визначення типу
  const heuristicsResult = guessDocumentTypeV2({
    title: params.title,
    typ: params.typ,
    typn: params.typn,
    organs: params.organs,
    snippet: params.snippet,  // snippet (без raw_txt)
    raw_txt: params.raw_txt,  // raw_txt окремо (має найвищий пріоритет)
    document_number: params.document_number,
    summary: params.summary,  // PHASE 3.4: передаємо summary для перевірки ЦВК/РНБО
  });
  
  if (heuristicsResult.confidence === 'high' || heuristicsResult.confidence === 'medium') {
    const info = getDocumentTypeInfo(heuristicsResult.slug);
    
    // Валідація консистентності
    const validation = await validateDocumentTypeConsistency(
      heuristicsResult.slug,
      params.title,
      params.summary,
      params.snippet
    );
    
    // Якщо валідація fail → перевизначаємо slug на основі suggested_slug
    let finalSlug = heuristicsResult.slug;
    let finalConfidence = heuristicsResult.confidence;
    const decisionTrace = heuristicsResult.decision_trace || [];
    
    if (validation.status === 'fail') {
      // Якщо є suggested_slug з валідації → використовуємо його (КРИТИЧНЕ override)
      if (validation.suggested_slug) {
        finalSlug = validation.suggested_slug;
        finalConfidence = 'high'; // Високий confidence бо базується на summary/snippet/title
        // КРИТИЧНЕ: якщо є CRITICAL issues (RNBO_AS_LAW, CEC_AS_CMU, etc) → завжди override
        if (validation.issues.some(i => i.includes('CRITICAL') || i.includes('slug=law') || i.includes('slug=code'))) {
          finalConfidence = 'high';
        }
      } else if (validation.issues.some(i => i.includes('slug=law') || i.includes('slug=code'))) {
        // Критичний конфлікт без suggested_slug → ставимо unknown
        finalSlug = 'unknown';
        finalConfidence = 'medium';
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
      decision_trace: decisionTrace.length > 0 ? decisionTrace : undefined,
      validation: validation.issues.length > 0 ? validation : undefined,
    };
    
    // Кешуємо результат
    await setCachedDocumentType(fingerprint, result);
    return result;
  }

  // 3. AI fallback (якщо heuristics не впевнені)
  const aiResult = await guessDocumentTypeWithAI({
    title: params.title,
    typ: params.typ,
    typn: params.typn,
    organs: params.organs,
    snippet: params.snippet,
    raw_txt: params.raw_txt,
    summary: params.summary,
  });
  if (aiResult) {
    // Валідація консистентності для AI результату
    const validation = await validateDocumentTypeConsistency(
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
        finalConfidence = 'medium';
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
  const validation = await validateDocumentTypeConsistency(
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
    confidence: 'medium',
    source: 'normalized',
    rationale: 'Normalized from title',
    validation: validation.issues.length > 0 ? validation : undefined,
  };
  
  // Кешуємо навіть fallback результат
  await setCachedDocumentType(fingerprint, result);
  return result;
}
