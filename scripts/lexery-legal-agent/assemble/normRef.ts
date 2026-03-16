/**
 * U9 normRef extraction from law snippet text (DEV RUN v14).
 * Extracts act title, article number, part number, heading for focus/triage.
 * When uncertain, leave field null — do not invent.
 */
import type { NormRef } from '../lib/pipeline/contracts.js';

/** Match "Стаття 115" or "ст. 115" or "статті 115" */
const ARTICLE_PATTERNS = [
  /Стаття\s+(\d+)/i,
  /ст\.\s*(\d+)/i,
  /статті\s+(\d+)/i,
  /article\s+(\d+)/i,
];

/** Match "Частина перша" or "ч. 1" or "частини 1" */
const PART_PATTERNS = [
  /Частина\s+(перша|друга|третя|четверта|п\'ята|\d+)/i,
  /ч\.\s*(\d+)/i,
  /частини\s+(\d+)/i,
];

const PART_MAP: Record<string, string> = {
  перша: '1',
  друга: '2',
  третя: '3',
  четверта: '4',
  "п'ята": '5',
};

/**
 * Extract NormRef from snippet text.
 * Uses existing act_title / article_number from RawHit when provided.
 */
export function extractNormRef(
  snippetText: string,
  existing?: { act_title?: string; article_number?: string | null }
): NormRef | null {
  if (!snippetText || typeof snippetText !== 'string') return null;

  const text = snippetText.slice(0, 2000);
  const out: NormRef = {};

  if (existing?.act_title) out.actTitle = existing.act_title;
  if (existing?.article_number) {
    const n = parseInt(existing.article_number, 10);
    out.articleNumber = Number.isFinite(n) ? n : null;
  }

  // Article number from text (override or fill)
  for (const re of ARTICLE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        out.articleNumber = n;
        break;
      }
    }
  }

  // Part number from text
  for (const re of PART_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const raw = m[1].trim();
      out.partNumber = PART_MAP[raw.toLowerCase()] ?? raw;
      break;
    }
  }

  // Heading: from same line "Стаття N. Heading text" or next line after "Стаття N"
  const line1 = text.split(/\n/)[0]?.trim() ?? '';
  const matchArticleLine = line1.match(/^Стаття\s+\d+\.?\s*(.+)$/i) ?? line1.match(/^ст\.\s*\d+\.?\s*(.+)$/i);
  if (matchArticleLine?.[1]) {
    out.heading = matchArticleLine[1].trim().slice(0, 200);
  }
  if (!out.heading) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/^Стаття\s+\d+\.?\s*$/i.test(lines[i]) && lines[i + 1]) {
        out.heading = lines[i + 1].slice(0, 200);
        break;
      }
      if (/^ст\.\s*\d+\.?\s*$/i.test(lines[i]) && lines[i + 1]) {
        out.heading = lines[i + 1].slice(0, 200);
        break;
      }
    }
  }
  if (!out.heading && line1 && !/^Стаття\s+\d+/i.test(line1)) {
    out.heading = line1.slice(0, 200);
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** Build a short summary for lawIndex (meta). */
export function normRefSummary(norm: NormRef | null): { articleNumber?: number; heading?: string; actTitle?: string } {
  if (!norm) return {};
  return {
    ...(norm.articleNumber != null && { articleNumber: norm.articleNumber }),
    ...(norm.heading && { heading: norm.heading.slice(0, 80) }),
    ...(norm.actTitle && { actTitle: norm.actTitle }),
  };
}
