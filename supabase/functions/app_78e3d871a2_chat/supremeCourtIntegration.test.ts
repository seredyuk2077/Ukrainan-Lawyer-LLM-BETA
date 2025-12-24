import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SupremeCourtCaseLawService } from './supremeCourtCaseLawService';

const buildMockOpenAI = () => ({
  embeddings: {
    create: vi.fn().mockResolvedValue({
      data: [{ embedding: Array(1536).fill(0.01) }]
    })
  },
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({ use_supreme_court: true })
            }
          }
        ]
      })
    }
  }
});

describe('Supreme Court RAG integration (service-level)', () => {
  let supabase: { rpc: ReturnType<typeof vi.fn> };
  let openai: ReturnType<typeof buildMockOpenAI>;
  let service: SupremeCourtCaseLawService;

  beforeEach(() => {
    supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            id: '1',
            case_number: '111/222/33',
            court: 'Верховний Суд',
            chamber: 'Касаційний цивільний суд',
            decision_date: '2024-01-10',
            document_type: 'Постанова',
            law_articles: ['ст. 12 ЦКУ'],
            main_law_code: 'ЦКУ',
            category: 'цивільне',
            summary: 'Фабула справи 1',
            legal_conclusion: 'Висновок 1',
            edrsr_url: 'https://reyestr.court.gov.ua/Review/11111111',
            motiv_part: 'Мотиви 1',
            court_panel: ['Іваненко І.І.'],
            metadata: { datasetYear: 2023 },
            similarity: 0.91
          },
          {
            id: '2',
            case_number: '222/333/44',
            court: 'Верховний Суд',
            chamber: 'Велика Палата Верховного Суду',
            decision_date: '2023-11-05',
            document_type: 'Постанова',
            law_articles: ['ст. 19 ККУ'],
            main_law_code: 'ККУ',
            category: 'кримінальне',
            summary: 'Фабула справи 2',
            legal_conclusion: 'Висновок 2',
            edrsr_url: 'https://reyestr.court.gov.ua/Review/22222222',
            motiv_part: 'Мотиви 2',
            court_panel: ['Петренко П.П.'],
            metadata: { datasetYear: 2022 },
            similarity: 0.88
          }
        ],
        error: null
      })
    };
    openai = buildMockOpenAI();
    service = new SupremeCourtCaseLawService({ supabase, openai });
  });

  it('returns up to 3 cases for premium users in vectorSearch and formats block', async () => {
    const cases = await service.vectorSearch({
      query: 'касаційна скарга у цивільній справі про виселення',
      isPremiumUser: true,
      limit: 3
    });

    expect(supabase.rpc).toHaveBeenCalledWith('match_supreme_court_cases', expect.objectContaining({
      match_limit: 3
    }));
    expect(cases.length).toBeGreaterThanOrEqual(2);

    const answerBlock = SupremeCourtCaseLawService.formatCaseLawForAnswer(cases);
    expect(answerBlock).toContain('=== Практика Верховного Суду ===');
    expect(answerBlock).toContain('Постанова ВС, №111/222/33');
  });

  it('limits non-premium users to at most one case', async () => {
    const cases = await service.vectorSearch({
      query: 'касаційна скарга у цивільній справі про виселення',
      isPremiumUser: false,
      limit: 3
    });

    expect(supabase.rpc).toHaveBeenCalledWith('match_supreme_court_cases', expect.objectContaining({
      match_limit: 1
    }));
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });

  it('does not use Supreme Court for non-legal questions', async () => {
    const shouldUse = await service.shouldUseSupremeCourt({
      userMessage: 'Як приготувати борщ?',
      classification: {
        isLegalQuestion: false,
        confidence: 0.1,
        category: 'загальне',
        questionType: 'general'
      },
      isPremiumUser: true
    });

    expect(shouldUse).toBe(false);
  });
}
);


