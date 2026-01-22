/**
 * AI Enrichment — генерація summary, keywords, topics, aliases через Claude 3.7 Sonnet
 * 
 * PHASE 3: Контрольований AI з taxonomy validation + caching
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import {
  TAXONOMY_V1,
  TaxonomySlug,
  isValidCategory,
  normalizeCategory,
  guessCategoryFromKeywords,
  canBeOtherCategory,
  getCategoryLabel,
} from '../taxonomy/taxonomy.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-3.7-sonnet';

// Формуємо список категорій для prompt (українською)
const CATEGORY_LIST = Object.entries(TAXONOMY_V1)
  .map(([slug, label]) => `"${slug}" (${label})`)
  .join(', ');

export interface AIEnrichment {
  summary: string;
  keywords: string[];
  topics: string[];
  aliases: string[];
  category: string; // TaxonomySlug (обов'язково з TAXONOMY_V1)
}

export interface EnrichmentInput {
  title: string;
  documentType: string;
  category: string; // поточна category (з guessCategory)
  radaDatred?: string;
  sourceUrl?: string;
  articles: Array<{
    number: string;
    title: string;
    content: string;
  }>;
  units?: Array<{
    unit_type: string;
    number: string;
    title?: string | null;
    text: string;
  }>; // для універсальної підтримки (articles або points)
  struDistribution?: {
    articles: number;
    points: number;
    subpoints: number;
    total: number;
  }; // для контексту типу документа
}

/**
 * Генерує AI enrichment для документа
 */
export async function generateEnrichment(input: EnrichmentInput): Promise<AIEnrichment> {
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');
  }

  // Формуємо контекст з units або articles
  const units = input.units || input.articles.map(a => ({
    unit_type: 'article',
    number: a.number,
    title: a.title,
    text: a.content,
  }));
  
  const unitsPreview = units.slice(0, 5).map(u => {
    const typeLabel = u.unit_type === 'article' ? 'Стаття' : 
                     u.unit_type === 'point' ? 'Пункт' : 
                     u.unit_type === 'subpoint' ? 'Підпункт' : 'Елемент';
    return `${typeLabel} ${u.number}: ${u.title || ''}\n${u.text.substring(0, 500)}...`;
  }).join('\n\n');

  // Формуємо інформацію про структуру
  const struInfo = input.struDistribution ? 
    `Структура: ${input.struDistribution.articles} статей, ${input.struDistribution.points} пунктів, ${input.struDistribution.subpoints} підпунктів (всього ${input.struDistribution.total} елементів)` :
    '';

  const promptBase = `Ти експерт з українського законодавства. Проаналізуй наступний нормативно-правовий акт та надай структуровану інформацію.

**Назва:** ${input.title}
**Тип:** ${input.documentType}
**Поточна категорія:** ${input.category} (може бути неточна, використай свій експертний аналіз)
**Дата редакції:** ${input.radaDatred || 'UNKNOWN'}
**Source URL:** ${input.sourceUrl || 'UNKNOWN'}
${struInfo ? `**${struInfo}**` : ''}

**Попередження елементів:**
${unitsPreview}

**Завдання:**
1. **summary** (1-3 речення): Короткий, юридично нейтральний опис акту українською мовою. НЕ вигадуй норм, НЕ роби юридичних висновків.
2. **category** (обов'язково один з наступних slug-ів): ${CATEGORY_LIST}. ВИБЕРИ найточнішу категорію на основі змісту. Якщо тип документа "Кодекс" або "Закон" — НЕ використовуй "other", завжди знайди точнішу категорію.
3. **keywords** (10-40 елементів): Ключові слова/словосполучення для пошуку (українською). Уникай дублювання та синонімів.
4. **topics** (3-10 елементів): Тематичні категорії (українською). Уникай дублювання ("оборона" та "військова справа" — це один топик).
5. **aliases** (5-15 елементів): Варіанти назв/скорочень, як акт можуть шукати (напр. "ККУ", "КУпАП", "ЗУ про мобілізацію").

Поверни STRICT JSON ONLY (без markdown, без пояснень):
{
  "summary": "string",
  "category": "string (slug з наведеного списку)",
  "keywords": ["string", ...],
  "topics": ["string", ...],
  "aliases": ["string", ...]
}`;

  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const prompt = attempt === 1 ? promptBase : `${promptBase}\n\nIMPORTANT: Return JSON only. No markdown.`;
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/legislation-rag',
          'X-Title': 'Legislation RAG',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API помилка (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`OpenRouter API помилка: ${data.error.message || 'Unknown error'}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Невалідна відповідь від OpenRouter: content не знайдено');

      // Extract JSON (defensive)
      let jsonString = content.trim();
      const jsonMatch = jsonString.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) jsonString = jsonMatch[1].trim();
      const jsonStart = jsonString.indexOf('{');
      const jsonEnd = jsonString.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) jsonString = jsonString.substring(jsonStart, jsonEnd + 1);

      const enrichment = JSON.parse(jsonString) as AIEnrichment;

      // Validation + bounds
      if (!enrichment.summary || typeof enrichment.summary !== 'string') throw new Error('AI повернув невалідний summary');
      if (!Array.isArray(enrichment.keywords)) throw new Error('AI повернув невалідні keywords');
      if (!Array.isArray(enrichment.topics)) throw new Error('AI повернув невалідні topics');
      if (!Array.isArray(enrichment.aliases)) throw new Error('AI повернув невалідні aliases');
      
      // Category validation (strict taxonomy)
      let aiCategorySlug: TaxonomySlug | null = null;
      if (enrichment.category) {
        // Спробуємо нормалізувати (AI може повернути slug або label)
        const normalized = normalizeCategory(enrichment.category);
        if (normalized) {
          aiCategorySlug = normalized;
        } else {
          // Fallback: спробуємо знайти за label
          const foundSlug = Object.entries(TAXONOMY_V1).find(
            ([_, label]) => label.toLowerCase() === enrichment.category.toLowerCase()
          )?.[0] as TaxonomySlug | undefined;
          if (foundSlug) aiCategorySlug = foundSlug;
        }
      }
      
      // Якщо AI не повернув валідну category або повернув "other" для Кодексу/Закону
      if (!aiCategorySlug || (aiCategorySlug === 'other' && !canBeOtherCategory(input.documentType))) {
        // Rule-based fallback
        const fallbackCategory = guessCategoryFromKeywords(input.title, input.documentType);
        if (fallbackCategory) {
          aiCategorySlug = fallbackCategory;
        } else if (canBeOtherCategory(input.documentType)) {
          aiCategorySlug = 'other';
        } else {
          // Якщо не знайшли і це Кодекс/Закон — використовуємо поточну або "other" як останній fallback
          aiCategorySlug = normalizeCategory(input.category) || 'other';
        }
      }
      
      // Deduplication topics/keywords (простий підхід: lowercase + trim)
      const kw = enrichment.keywords
        .filter(Boolean)
        .map(k => k.trim())
        .filter((k, i, arr) => arr.slice(0, i).every(e => e.toLowerCase() !== k.toLowerCase()));
      
      const tp = enrichment.topics
        .filter(Boolean)
        .map(t => t.trim())
        .filter((t, i, arr) => arr.slice(0, i).every(e => e.toLowerCase() !== t.toLowerCase()));
      
      const al = enrichment.aliases.filter(Boolean).map(a => a.trim());
      
      if (kw.length < 10 || kw.length > 40) throw new Error(`keywords count out of bounds: ${kw.length}`);
      if (tp.length < 3 || tp.length > 10) throw new Error(`topics count out of bounds: ${tp.length}`);
      if (al.length < 5 || al.length > 15) throw new Error(`aliases count out of bounds: ${al.length}`);

      return { 
        summary: enrichment.summary.trim(), 
        category: aiCategorySlug, // Повертаємо slug
        keywords: kw, 
        topics: tp, 
        aliases: al 
      };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxAttempts) continue;
    }
  }

  throw lastErr || new Error('AI enrichment failed (unknown)');
}
