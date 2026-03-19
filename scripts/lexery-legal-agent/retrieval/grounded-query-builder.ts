import { extractQueryCitationSelectors } from './structural-citation.js';

const BROAD_PROCEDURAL_SIGNALS = new Set([
  'оскарження',
  'строк',
  'порядок',
  'подання',
]);

function uniqueSignals(signals: string[]): string[] {
  return [...new Set(signals.map((signal) => signal.trim()).filter(Boolean))];
}

function shouldKeepSignalForGroundedQuery(signal: string): boolean {
  const normalized = signal.normalize('NFC').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes(' ')) return true;
  return !BROAD_PROCEDURAL_SIGNALS.has(normalized);
}

export function filterGroundingSignalsForQuery(query: string, signals: string[]): string[] {
  const unique = uniqueSignals(signals);
  if (unique.length === 0) return [];
  const selectors = extractQueryCitationSelectors(query);
  if (selectors.explicitSelectorCount === 0 && !selectors.noteMentioned) return unique;
  return unique.filter(shouldKeepSignalForGroundedQuery);
}

export function buildGroundedRetrievalQuery(input: {
  subquery: string;
  mustHaveSignals?: string[];
}): { queryForRetrieval: string; appliedSignals: string[] } {
  const appliedSignals = filterGroundingSignalsForQuery(
    input.subquery,
    input.mustHaveSignals ?? []
  );
  return {
    queryForRetrieval:
      appliedSignals.length > 0
        ? `${input.subquery} ${appliedSignals.join(' ')}`
        : input.subquery,
    appliedSignals,
  };
}
