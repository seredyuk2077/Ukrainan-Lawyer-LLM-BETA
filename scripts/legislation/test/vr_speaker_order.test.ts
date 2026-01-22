/**
 * Unit Tests для VR_SPEAKER_ORDER document type
 * PHASE 3.4.4: Регресійні тести для перевірки правильності класифікації
 */

import { guessDocumentTypeV2 } from '../documentTypes/guessDocumentTypeV2.js';
import { enrichDocumentType } from '../lib/documentTypeEnrichment.js';

describe('VR_SPEAKER_ORDER Document Type Classification', () => {
  
  test('TEST #1: document_number = "48/26-РГ", snippet пустий, summary пустий → slug MUST be vr_speaker_order', async () => {
    const result = await enrichDocumentType({
      title: 'Про внесення змін Технологічної схеми',
      document_number: '48/26-РГ',
      snippet: null,
      summary: null,
    });
    
    expect(result.slug).toBe('vr_speaker_order');
    expect(result.label_uk).toBe('Розпорядження Голови ВРУ');
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('heuristics');
  });
  
  test('TEST #2: snippet починається з "РОЗПОРЯДЖЕННЯ ГОЛОВИ ВРУ" → slug MUST be vr_speaker_order', async () => {
    const snippet = 'ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ\nм. Київ\n№ 48';
    
    const result = await enrichDocumentType({
      title: 'Про внесення змін Технологічної схеми',
      snippet: snippet,
      document_number: '48/26-рг',
    });
    
    expect(result.slug).toBe('vr_speaker_order');
    expect(result.label_uk).toBe('Розпорядження Голови ВРУ');
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('heuristics');
  });
  
  test('TEST #3: guessDocumentTypeV2 - prefix-sniff з snippet "ГОЛОВА" (однина)', () => {
    const result = guessDocumentTypeV2({
      title: 'Про внесення змін',
      snippet: 'ГОЛОВА ВЕРХОВНОЇ РАДИ УКРАЇНИ\nРОЗПОРЯДЖЕННЯ',
      document_number: '48/26-рг',
    });
    
    expect(result.slug).toBe('vr_speaker_order');
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('heuristics');
    expect(result.rationale).toContain('prefix-sniff');
  });
  
  test('TEST #4: guessDocumentTypeV2 - nreg suffix -РГ без snippet', () => {
    const result = guessDocumentTypeV2({
      title: 'Про внесення змін',
      snippet: null,
      document_number: '48/26-РГ',
    });
    
    expect(result.slug).toBe('vr_speaker_order');
    expect(result.confidence).toBe('high');
    expect(result.source).toBe('heuristics');
    expect(result.rationale).toContain('nreg suffix');
  });
});
