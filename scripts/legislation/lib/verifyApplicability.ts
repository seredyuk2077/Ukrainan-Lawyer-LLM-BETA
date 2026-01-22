/**
 * Verify Applicability Matrix — матриця застосовності verify checks
 * PHASE 3.6: Визначення N/A vs ERROR для різних document_type_slug
 */

import { DocumentTypeSlug } from '../documentTypes/documentTypes.js';

/**
 * Матриця застосовності: для яких document_type_slug поле/перевірка застосовна
 */
export const VERIFY_APPLICABILITY = {
  // law_number: застосовне для законів, кодексів, постанов, указів, розпоряджень
  law_number: {
    applicable: [
      'law', 'code', 'constitution',
      'cmu_resolution', 'vr_resolution', 'cec_resolution', 'nbu_resolution',
      'presidential_decree', 'presidential_order',
      'cmu_order', 'rnbo_decision',
    ] as DocumentTypeSlug[],
    notApplicable: [
      'convention', 'international_treaty', 'protocol', 'agreement',
      'ccu_opinion', 'court_opinion', 'ccu_decision', 'court_decision',
      'nbu_letter', 'unknown', 'other',
    ] as DocumentTypeSlug[],
  },
  
  // expected_chunks > 0: застосовне для ВСІХ документів, де txtContent_length > MIN_LEN
  // N/A тільки якщо джерело реально порожнє/бите (txtContent_length == 0)
  expected_chunks: {
    minTextLength: 400, // Мінімальна довжина тексту для очікування chunks > 0
    applicable: 'all' as const, // Всі документи (якщо txtLength > minTextLength)
  },
  
  // indexed_chunks == expected_chunks: застосовне для всіх indexable документів
  indexed_chunks: {
    applicable: 'all_indexable' as const, // Всі indexable документи
  },
} as const;

/**
 * Перевіряє чи поле/перевірка застосовна для даного document_type_slug
 */
export function isCheckApplicable(
  checkName: 'law_number' | 'expected_chunks' | 'indexed_chunks',
  documentTypeSlug: DocumentTypeSlug | null | undefined
): boolean {
  if (!documentTypeSlug) return false;
  
  const matrix = VERIFY_APPLICABILITY[checkName];
  
  if (checkName === 'law_number') {
    if (matrix.applicable.includes(documentTypeSlug)) return true;
    if (matrix.notApplicable.includes(documentTypeSlug)) return false;
    // Якщо не в списку - за замовчуванням застосовне (безпечніше)
    return true;
  }
  
  if (checkName === 'expected_chunks' || checkName === 'indexed_chunks') {
    // Застосовне для всіх (перевірка txtLength буде в verify)
    return true;
  }
  
  return true; // За замовчуванням застосовне
}

/**
 * Перевіряє чи документ має достатньо тексту для очікування chunks > 0
 */
export function hasEnoughTextForChunks(txtLength: number): boolean {
  return txtLength >= VERIFY_APPLICABILITY.expected_chunks.minTextLength;
}
