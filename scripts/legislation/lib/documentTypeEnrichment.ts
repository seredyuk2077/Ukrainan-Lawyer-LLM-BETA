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
 * Головна функція: Heuristics → AI → Normalized fallback
 */
export async function enrichDocumentType(params: {
  title: string;
  typ?: number | null;
  typn?: string | null;
  organs?: any;
  stru?: any[];
}): Promise<DocumentTypeEnrichmentResult> {
  const fingerprint = generateFingerprint(params);

  // 1. Перевіряємо кеш
  const cached = await getCachedDocumentType(fingerprint);
  if (cached) {
    return { ...cached, source: 'cache' };
  }

  // 2. Heuristics-first
  const heuristicsResult = guessDocumentTypeV2(params);
  
  if (heuristicsResult.confidence === 'high' || heuristicsResult.confidence === 'medium') {
    const info = getDocumentTypeInfo(heuristicsResult.slug);
    const result: DocumentTypeEnrichmentResult = {
      slug: heuristicsResult.slug,
      label_uk: info.label_uk,
      confidence: heuristicsResult.confidence,
      source: 'heuristics',
      rationale: heuristicsResult.rationale,
    };
    
    // Кешуємо результат
    await setCachedDocumentType(fingerprint, result);
    return result;
  }

  // 3. AI fallback (якщо heuristics не впевнені)
  const aiResult = await guessDocumentTypeWithAI(params);
  if (aiResult) {
    // Кешуємо результат
    await setCachedDocumentType(fingerprint, aiResult);
    return aiResult;
  }

  // 4. Normalized fallback (якщо AI не спрацював)
  // Спробуємо нормалізувати з title якщо можливо
  const normalizedSlug = normalizeDocumentType(params.title);
  const info = getDocumentTypeInfo(normalizedSlug);
  
  const result: DocumentTypeEnrichmentResult = {
    slug: normalizedSlug,
    label_uk: info.label_uk,
    confidence: 'low',
    source: 'normalized',
    rationale: 'Normalized from title',
  };
  
  // Кешуємо навіть fallback результат
  await setCachedDocumentType(fingerprint, result);
  return result;
}
