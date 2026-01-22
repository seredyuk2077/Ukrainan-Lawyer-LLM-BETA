/**
 * AI Parsing Assist — контрольований AI fallback для "weird docs"
 * 
 * PHASE 11: AI-assisted fallback parsing для документів без чіткої структури
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { ParsingStrategy } from './contentUnits.js';

config({ path: resolve(process.cwd(), '.env') });

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-3.7-sonnet';

export interface AIParsePlan {
  indexable: boolean;
  strategy: ParsingStrategy;
  unit_rules: {
    detect_headings: string[];
    detect_units: string[];
    numbering: 'arabic' | 'roman' | 'mixed' | 'none';
    merge_rules?: Record<string, any>;
  };
  chunking: {
    target_tokens: number;
    max_tokens: number;
    include_header_context: boolean;
  };
  confidence: number; // 0..1
  notes: string;
}

export interface AIParsingAssistInput {
  title: string;
  documentType: string;
  nreg: string;
  lawNumber?: string | null;
  struDistribution?: {
    articles?: number;
    points?: number;
    chapters?: number;
    sections?: number;
    total?: number;
  };
  struSamples?: Array<{
    typ?: string;
    typn?: string;
    tree_id?: string;
    line?: string;
  }>;
  textSamples?: Array<{
    content: string;
    offset: number;
  }>;
}

/**
 * Генерує parse plan через AI для документів без чіткої структури
 */
export async function generateAIParsePlan(input: AIParsingAssistInput): Promise<AIParsePlan | null> {
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');
  }
  
  // Підготовка тексту для AI
  const textSample = input.textSamples
    ?.map(s => s.content.slice(0, 500))
    .join('\n\n---\n\n')
    .slice(0, 3000) || '';
  
  const struInfo = input.struDistribution
    ? `STRU distribution: articles=${input.struDistribution.articles || 0}, points=${input.struDistribution.points || 0}, chapters=${input.struDistribution.chapters || 0}, sections=${input.struDistribution.sections || 0}, total=${input.struDistribution.total || 0}`
    : 'No stru data available';
  
  const struSamples = input.struSamples
    ?.slice(0, 10)
    .map(s => `- typ=${s.typ}, typn=${s.typn}, tree_id=${s.tree_id}, line="${(s.line || '').slice(0, 60)}"`)
    .join('\n') || 'No stru samples';
  
  const prompt = `Ти аналізуєш нормативно-правовий документ, який не підпадає під стандартні евристики парсингу.

МЕТАДАНІ:
- Назва: ${input.title}
- Тип: ${input.documentType}
- NREG: ${input.nreg}
${input.lawNumber ? `- Номер закону: ${input.lawNumber}` : ''}

СТРУКТУРА:
${struInfo}

Зразки stru елементів:
${struSamples}

Зразок тексту:
${textSample.slice(0, 2000)}

ТВОЄ ЗАВДАННЯ: Визначити parse plan (як індексувати документ) в межах ДОЗВОЛЕНИХ стратегій.

ДОЗВОЛЕНІ СТРАТЕГІЇ (whitelist):
- "article-based" — якщо є статті (ST) або можна витягти статті з тексту
- "point-based" — якщо є пункти (PU) або нумеровані пункти
- "chapter-based" — якщо є глави/розділи (GL/RZ) з підрозділами
- "annex-based" — якщо документ складається з додатків/форм
- "fallback" — останній варіант (regex/text-based)

ВАЖЛИВО:
1. Документ МАЄ БУТИ індексованим (indexable=true), якщо він містить змістовний текст
2. strategy має бути з whitelist вище
3. confidence 0..1 (високий = впевнений у стратегії)

Поверни ТІЛЬКИ JSON (без markdown, без пояснень):
{
  "indexable": true,
  "strategy": "article-based" | "point-based" | "chapter-based" | "annex-based" | "fallback",
  "unit_rules": {
    "detect_headings": ["список", "патернів", "для", "заголовків"],
    "detect_units": ["список", "патернів", "для", "units"],
    "numbering": "arabic" | "roman" | "mixed" | "none",
    "merge_rules": {}
  },
  "chunking": {
    "target_tokens": 800,
    "max_tokens": 1000,
    "include_header_context": true
  },
  "confidence": 0.8,
  "notes": "короткий опис логіки"
}`;
  
  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/your-repo',
        'X-Title': 'Legislation RAG Parser',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    
    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('No content in AI response');
    }
    
    // Parse JSON (може бути обгорнутий в markdown code block)
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    const plan: AIParsePlan = JSON.parse(jsonStr);
    
    // Валідація
    const validStrategies: ParsingStrategy[] = ['article-based', 'point-based', 'chapter-based', 'annex-based', 'fallback'];
    if (!validStrategies.includes(plan.strategy)) {
      console.warn(`⚠️  AI returned invalid strategy: ${plan.strategy}, falling back to 'fallback'`);
      plan.strategy = 'fallback';
    }
    
    if (plan.confidence < 0 || plan.confidence > 1) {
      plan.confidence = Math.max(0, Math.min(1, plan.confidence));
    }
    
    return plan;
    
  } catch (e: any) {
    console.warn(`⚠️  AI parsing assist failed: ${e.message}`);
    return null;
  }
}
