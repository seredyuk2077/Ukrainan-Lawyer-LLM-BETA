type OpenAIClientLike = {
  embeddings: {
    create: (args: { model: string; input: string }) => Promise<{ data: Array<{ embedding: number[] }> }>;
  };
  chat?: {
    completions: {
      create: (args: {
        model: string;
        temperature?: number;
        max_tokens?: number;
        response_format?: { type: string };
        messages: Array<{ role: 'system' | 'user'; content: string }>;
      }) => Promise<{ choices: Array<{ message?: { content?: string } }> }>;
    };
  };
};

interface SupremeClassificationInput {
  isLegalQuestion: boolean;
  confidence: number;
  category?: string | null;
  questionType?: string | null;
}

export interface SupremeCourtCase {
  id: string;
  case_number: string | null;
  court: string | null;
  chamber: string | null;
  decision_date: string | null;
  document_type: string | null;
  law_articles: string[];
  main_law_code: string | null;
  category: string | null;
  summary: string;
  legal_conclusion: string;
  edrsr_url: string | null;
  motiv_part: string | null;
  court_panel: string[];
  metadata?: { datasetYear?: number } | null;
  similarity: number;
}

interface ShouldUseOptions {
  userMessage: string;
  classification?: SupremeClassificationInput | null;
  isPremiumUser?: boolean;
}

interface VectorSearchOptions {
  query: string;
  limit?: number;
  minSimilarity?: number;
  isPremiumUser?: boolean;
}

export class SupremeCourtCaseLawService {
  private supabase: any;
  private openai: OpenAIClientLike;

  private readonly supremeKeywords = [
    'постанова вс',
    'верховн',
    'висновок верховного суду',
    'судова практика',
    'велика палата',
    'касаційний суд',
    'касація',
    'касаційна скарга',
    'прецедент',
    'позиція вс'
  ];

  private readonly proceduralSignals = [
    'оскарж',
    'перегляд',
    'строк оскарження',
    'правовий висновок',
    'застосування норм',
    'позбавлення',
    'касац'
  ];

  private readonly negativeKeywords = ['борщ', 'рецепт', 'кухн', 'приготувати', 'садівниц', 'побут'];

  private readonly complexCategories = [
    'кримінальне',
    'цивільне',
    'адміністративне',
    'господарське',
    'податкове',
    'трудове'
  ];

  private readonly categoryBoost: Record<string, number> = {
    'цивільне': 1,
    'господарське': 1,
    'адміністративне': 0.9,
    'податкове': 0.9,
    'кримінальне': 1,
    'трудове': 0.8
  };

  private readonly decisionThreshold = 2.5;
  private readonly fallbackThreshold = 1.2;

  constructor(deps: { supabase: any; openai: OpenAIClientLike }) {
    this.supabase = deps.supabase;
    this.openai = deps.openai;
  }

  async shouldUseSupremeCourt(options: ShouldUseOptions): Promise<boolean> {
    const text = options.userMessage.toLowerCase();
    const classification = options.classification;
    const confidence = classification?.confidence ?? 0;

    if (!classification?.isLegalQuestion) {
      return false;
    }

    if (this.negativeKeywords.some(keyword => text.includes(keyword))) {
      return false;
    }

    const relevanceScore = this.computeRelevanceScore(text, classification);
    if (relevanceScore >= this.decisionThreshold) {
      return true;
    }

    const keywordHit = this.supremeKeywords.some(keyword => text.includes(keyword));
    const procedureHit = this.proceduralSignals.some(keyword => text.includes(keyword));
    const hasArticlesReference = /ст\.?\s*\d+/.test(text) || text.includes('кодекс');

    if (
      keywordHit &&
      confidence >= 0.45 &&
      this.complexCategories.includes((classification?.category || '').toLowerCase())
    ) {
      return true;
    }

    if (procedureHit && confidence >= 0.35) {
      return true;
    }

    if (hasArticlesReference && confidence >= 0.6) {
      return true;
    }

    if (relevanceScore >= this.fallbackThreshold && confidence >= 0.35) {
      // rely on LLM classifier below
    } else if (relevanceScore < this.fallbackThreshold) {
      return false;
    }

    const classifierPrompt = `Визнач чи користувачу потрібні посилання на практику Верховного Суду (так/ні).
Поверни JSON {"use_supreme_court":true|false}.
Ключові ознаки "так": питання про судову практику, касацію, висновки ВС, складні спори.`;

    const classifierDecision = await this.runClassifierDecision(options.userMessage, classifierPrompt);
    if (classifierDecision !== null) {
      return classifierDecision;
    }

    return false;
  }

  private computeRelevanceScore(
    text: string,
    classification?: SupremeClassificationInput | null
  ): number {
    let score = 0;
    const category = classification?.category?.toLowerCase() || '';
    const keywordHits = this.supremeKeywords.filter(keyword => text.includes(keyword)).length;
    const procedureHits = this.proceduralSignals.filter(keyword =>
      text.includes(keyword)
    ).length;
    score += keywordHits * 1.5;
    score += procedureHits;

    if (classification?.questionType === 'procedure' || classification?.questionType === 'rights') {
      score += 0.8;
    }

    if (this.complexCategories.includes(category)) {
      score += this.categoryBoost[category] ?? 0.5;
    }

    if ((classification?.confidence ?? 0) >= 0.7) {
      score += 0.7;
    } else if ((classification?.confidence ?? 0) >= 0.45) {
      score += 0.4;
    }

    if (/касацій/.test(text)) {
      score += 0.5;
    }

    return score;
  }

  async vectorSearch(options: VectorSearchOptions): Promise<SupremeCourtCase[]> {
    const effectiveLimit = options.isPremiumUser ? (options.limit ?? 3) : 1;

    const queryVector = await this.getQueryEmbedding(options.query);
    if (!queryVector) {
      return [];
    }

    const { data, error } = await this.supabase.rpc('match_supreme_court_cases', {
      query_embedding: queryVector,
      match_limit: effectiveLimit,
      min_similarity: options.minSimilarity ?? 0.72
    });

    if (error) {
      console.error('Supreme Court vector search failed:', error);
      return [];
    }

    return Array.isArray(data)
      ? data.map((row: any) => ({
          ...row,
          law_articles: row.law_articles || [],
          court_panel: row.court_panel || [],
          metadata: row.metadata || null
        }))
      : [];
  }

  formatCaseLawForLLM(cases: SupremeCourtCase[]): string | null {
    if (!cases.length) {
      return null;
    }

    const lines = ['=== РЕЛЕВАНТНА ПРАКТИКА ВЕРХОВНОГО СУДУ ==='];
    cases.forEach((item, index) => {
      const parts = [
        `${index + 1}. ${item.document_type || 'Постанова'} ВС від ${
          item.decision_date || 'невідомо'
        } у справі №${item.case_number || 'N/A'}`,
        item.chamber ? `Палата: ${item.chamber}` : null,
        item.summary ? `Суть: ${item.summary}` : null,
        item.legal_conclusion ? `Висновок: ${item.legal_conclusion}` : null,
        item.law_articles?.length ? `Норми: ${item.law_articles.join(', ')}` : null
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(parts);
    });

    return lines.join('\n\n');
  }

  static formatCaseLawForAnswer(cases: SupremeCourtCase[]): string | null {
    if (!cases.length) {
      return null;
    }

    const lines: string[] = ['\n=== Практика Верховного Суду ==='];

    for (const caseItem of cases) {
      lines.push(
        `Постанова ВС, №${caseItem.case_number || 'N/A'}, дата ${caseItem.decision_date || 'невідомо'}`,
        `Фабула: ${caseItem.summary || 'немає короткого викладу'}`,
        `Правовий висновок: ${caseItem.legal_conclusion || 'немає сформульованого висновку'}`,
        `Норми: ${
          caseItem.law_articles && caseItem.law_articles.length
            ? caseItem.law_articles.join(', ')
            : 'не вказані'
        }`,
        `Посилання: ${caseItem.edrsr_url || 'немає посилання'}`
      );
      lines.push(''); // порожній рядок між справами
    }

    return lines.join('\n');
  }

  private async getQueryEmbedding(query: string): Promise<number[] | null> {
    const cleaned = query.trim();
    if (!cleaned) {
      return null;
    }
    const result = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: cleaned.slice(0, 2000)
    });
    return result.data[0]?.embedding ?? null;
  }

  private async runClassifierDecision(
    userMessage: string,
    systemPrompt: string
  ): Promise<boolean | null> {
    if (!this.openai.chat?.completions) {
      return null;
    }

    const attempts = [
      { model: 'claude-3-haiku-20240307', expectJson: true },
      { model: 'gpt-3.5-turbo', expectJson: false }
    ];

    for (const attempt of attempts) {
      try {
        const response = await this.openai.chat.completions.create({
          model: attempt.model,
          temperature: 0,
          max_tokens: 60,
          ...(attempt.expectJson ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            {
              role: 'system',
              content: attempt.expectJson
                ? systemPrompt
                : `${systemPrompt}\nВідповідай у форматі:\nRESULT: так|ні`
            },
            { role: 'user', content: userMessage }
          ]
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          continue;
        }

        const parsed = this.parseClassifierResponse(content, attempt.expectJson);
        if (parsed !== null) {
          return parsed;
        }
      } catch (error) {
        console.warn('Supreme Court classifier LLM attempt failed:', error);
      }
    }

    return null;
  }

  private parseClassifierResponse(content: string, expectJson: boolean): boolean | null {
    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }

    if (expectJson) {
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
          try {
            parsed = JSON.parse(trimmed.slice(start, end + 1));
          } catch {
            parsed = null;
          }
        }
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.use_supreme_court === 'boolean') {
          return parsed.use_supreme_court;
        }
        if (typeof parsed.useSupremeCourt === 'boolean') {
          return parsed.useSupremeCourt;
        }
      }
    }

    const match = trimmed.match(/result\s*[:\-]\s*(так|ні|yes|no|true|false)/i);
    const normalized = (match?.[1] || trimmed).toLowerCase();
    if (normalized.includes('так') || normalized.includes('yes') || normalized.includes('true')) {
      return true;
    }
    if (normalized.includes('ні') || normalized.includes('no') || normalized.includes('false')) {
      return false;
    }
    return null;
  }
}


