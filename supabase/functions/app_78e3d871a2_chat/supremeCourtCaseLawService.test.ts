import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SupremeCourtCaseLawService } from './supremeCourtCaseLawService';

const mockOpenAI = () => ({
  embeddings: {
    create: vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }]
    })
  },
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ use_supreme_court: true }) } }]
      })
    }
  }
});

describe('SupremeCourtCaseLawService', () => {
  let supabase: { rpc: ReturnType<typeof vi.fn> };
  let openai: ReturnType<typeof mockOpenAI>;
  let service: SupremeCourtCaseLawService;

  beforeEach(() => {
    supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            id: '1',
            case_number: '123/456/78',
            court: 'Верховний Суд',
            chamber: 'Касаційний цивільний суд',
            decision_date: '2024-07-01',
            document_type: 'Постанова',
            law_articles: ['ст. 12 ЦКУ'],
            main_law_code: 'ЦКУ',
            category: 'цивільне',
            summary: 'Стислий виклад',
            legal_conclusion: 'Правова позиція',
            edrsr_url: 'https://reyestr.court.gov.ua/Review/12345678',
            motiv_part: 'Мотиви',
            court_panel: ['Іваненко І.І.'],
            metadata: { datasetYear: 2024 },
            similarity: 0.81
          }
        ],
        error: null
      })
    };
    openai = mockOpenAI();
    service = new SupremeCourtCaseLawService({ supabase, openai });
  });

  it('accepts legal question with explicit Supreme Court keywords regardless of premium', async () => {
    const result = await service.shouldUseSupremeCourt({
      userMessage: 'Потрібна постанова ВС щодо оренди',
      classification: {
        isLegalQuestion: true,
        confidence: 0.8,
        category: 'цивільне',
        questionType: 'procedure'
      },
      isPremiumUser: false
    });
    expect(result).toBe(true);
  });

  it('performs vector search for premium user and formats results', async () => {
    const cases = await service.vectorSearch({
      query: 'оренда житла та виселення',
      isPremiumUser: true
    });
    expect(supabase.rpc).toHaveBeenCalled();
    expect(cases).toHaveLength(1);

    const block = service.formatCaseLawForLLM(cases);
    expect(block).toContain('РЕЛЕВАНТНА ПРАКТИКА ВЕРХОВНОГО СУДУ');
  });

  it('limits non-premium users to at most one case in vector search', async () => {
    const cases = await service.vectorSearch({
      query: 'оренда житла та виселення',
      isPremiumUser: false,
      limit: 3
    });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    const lastCallArgs = supabase.rpc.mock.calls[0][1];
    expect(lastCallArgs.match_limit).toBe(1);
    expect(cases).toHaveLength(1);
  });
});


