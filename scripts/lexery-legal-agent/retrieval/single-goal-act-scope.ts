import {
  areActReferenceCuesCompatible,
  extractStructuredActIdentifiers,
  extractActReferenceSignals,
  extractQuotedActTitleFragments,
  isAmendmentLikeActTitle,
  looksLikeStructuredActIdentifier,
  normalizeActReferenceCue,
  type ActMeta,
} from './act-taxonomy-store.js';
import {
  hasDistinctProceduralSupportBundleCue,
  hasExplicitActScopeCue,
  looksLikeCompactActTitleFragmentQuery,
} from './goal-splitter.js';
import {
  classifyActKind,
  hasStrongNonPrimarySupportEvidence,
  isExplicitlyHintedNonPrimaryAct,
  type ActCandidateInput,
  type BuildSelectedActsOutput,
  type SelectedActOutput,
} from './selected-acts.js';
import {
  summarizeSelectedActs,
  type FinalizeSelectedActsAfterRoutingOutput,
} from './selected-acts-finalizer.js';
import { normalizeStructuredActIdentifier } from '../lib/structured-act-identifier.js';

type SelectedActLike = {
  rada_nreg: string;
  act_title?: string;
  score?: number;
  why_selected?: string;
  reason_tag?: string;
  source_tags?: string[];
  document_type?: string | null;
  category?: string | null;
  storage_category?: string | null;
  act_kind?: string;
  flags?: SelectedActOutput['flags'];
  confidence?: number;
};

type SelectedActsSourcesBreakdownLike = BuildSelectedActsOutput['selected_acts_sources_breakdown'] & {
  from_routing_hints?: string[];
};

export interface ResolveSingleActScopeSelectionInput {
  query: string;
  domainHint?: string;
  documentTypeHints?: string[];
  selectedActsFinal: SelectedActLike[];
  selectedActsSourcesBreakdownFinal: SelectedActsSourcesBreakdownLike;
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  reasonCodes: string[];
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  actCandidatesTopHydrated: ActCandidateInput[];
  exactActNregs: string[];
  groundedActNregs: string[];
  topScore: number | null;
  getActMeta: (rada_nreg: string) => Promise<ActMeta | null>;
  metadataGroundingReasonCodes: Set<string>;
  nonPrimaryAuthoritativeKinds: Set<string>;
}

export interface ResolveSingleActScopeSelectionOutput {
  selectedActsFinal: SelectedActLike[];
  selectedActsSourcesBreakdownFinal: SelectedActsSourcesBreakdownLike;
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
  reasonCodes: string[];
  exactActNregSet: Set<string>;
  exactSingleActConverged: boolean;
  groundedActNregSet: Set<string>;
  groundedSingleActConverged: boolean;
  explicitActScopeCueQuery: boolean;
  metadataSingleActConverged: boolean;
  evidenceSingleActConverged: boolean;
  evidenceSingleActNreg: string | null;
  calendarScopedRecurringActAmbiguous: boolean;
  topActCandidate?: ActCandidateInput;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function pushUnique(reasonCodes: string[], code: string): void {
  if (!reasonCodes.includes(code)) reasonCodes.push(code);
}

function normalizeRadaNreg(value: string | null | undefined): string {
  const raw = String(value ?? '').normalize('NFC').trim();
  if (!raw) return '';
  const normalized = normalizeStructuredActIdentifier(raw);
  return normalized || raw.toLowerCase();
}

function sameRadaNreg(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeRadaNreg(left);
  const normalizedRight = normalizeRadaNreg(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

function buildNormalizedNregMap<T extends { rada_nreg?: string | null }>(items: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = normalizeRadaNreg(item.rada_nreg);
    if (!key || out.has(key)) continue;
    out.set(key, item);
  }
  return out;
}

function getByNormalizedNreg<T>(map: Map<string, T>, radaNreg: string | null | undefined): T | undefined {
  const key = normalizeRadaNreg(radaNreg);
  return key ? map.get(key) : undefined;
}

function hasActWithNreg(
  acts: Array<{ rada_nreg: string | null | undefined }>,
  radaNreg: string | null | undefined
): boolean {
  return acts.some((act) => sameRadaNreg(act.rada_nreg, radaNreg));
}

function countResidualQueryTokensAfterStructuredIds(query: string): number {
  const stripped = query
    .normalize('NFC')
    .replace(/[\p{L}\p{N}_/‐‑–—−-]{4,32}/gu, (match) =>
      looksLikeStructuredActIdentifier(match) ? ' ' : match
    );
  return stripped.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

function countQueryTokens(query: string): number {
  return query.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

function tokenizeGroundingWords(value: string): string[] {
  return uniqueStrings(
    value
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
    .map((part) => normalizeActReferenceCue(part) ?? part)
  );
}

const GENERIC_METADATA_GROUNDING_TOKENS = new Set([
  'яким',
  'яка',
  'яке',
  'який',
  'якою',
  'ким',
  'хто',
  'коли',
  'що',
  'цим',
  'цю',
  'цього',
  'регулює',
  'оформлюється',
  'оформлюється',
  'оформлено',
  'затверджено',
  'затверджує',
  'прийнято',
  'прийняв',
  'визнано',
  'таким',
  'втратив',
  'чинність',
]);

const GENERIC_SUPPORT_HINT_TOKENS = new Set([
  ...GENERIC_METADATA_GROUNDING_TOKENS,
  'кодекс',
  'закону',
  'закон',
  'порядок',
  'порядку',
  'постанова',
  'постанови',
  'наказ',
  'розпорядження',
  'правила',
  'правил',
  'інструкція',
  'інструкції',
  'положення',
]);

const GENERIC_SUPPORT_HINT_CUES = new Set(
  [...GENERIC_SUPPORT_HINT_TOKENS]
    .map((token) => normalizeActReferenceCue(token))
    .filter(Boolean) as string[]
);

const GENERIC_PERSON_IDENTITY_TOKENS = new Set([
  'верховної',
  'кабінету',
  'міністра',
  'міністерства',
  'міністрів',
  'президента',
  'ради',
  'суду',
  'суддя',
  'судді',
  'україни',
]);

const PERSON_SIGNATURE_REGEX =
  /(?:^|[^\p{L}\p{N}])([\p{Lu}][\p{Ll}'’-]{3,})\s+([\p{Lu}])\.\s*([\p{Lu}])\.(?=$|[^\p{L}\p{N}])/gu;

const CAPITALIZED_IDENTITY_TOKEN_REGEX =
  /(?:^|[^\p{L}\p{N}])([А-ЯІЇЄҐ][а-яіїєґ'’-]{3,})(?=$|[^\p{L}\p{N}])/gu;

const PRIMARY_LAW_LIKE_ACT_CUES = new Set([
  'закон',
  'кодекс',
  'конвенція',
  'договір',
  'статут',
]);

const INTERROGATIVE_PRIMARY_LAW_LOCATOR_REGEX =
  /(?:^|[?!.]\s*)я(?:кий|ка|ке|кі|кого|кої|кому|кими|ких)(?:\s+саме)?\s+(?:(?:спеціальн|профільн)\p{L}*\s+)?(?:закон\p{L}*|кодекс\p{L}*|конвенц\p{L}*|договор\p{L}*|статут\p{L}*)(?=$|\s)/iu;
const SPECIALIZED_PRIMARY_LAW_LOCATOR_REGEX =
  /(?:^|[?!.]\s*)я(?:кий|ка|ке|кі|кого|кої|кому|кими|ких)(?:\s+саме)?\s+(?:(?:спеціальн|профільн)\p{L}*\s+)(?:закон\p{L}*|кодекс\p{L}*|конвенц\p{L}*|договор\p{L}*|статут\p{L}*)(?=$|\s)/iu;

function documentTypeHintRequestsPrimaryLawLikeAct(hint: string | undefined | null): boolean {
  const normalized = String(hint ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return false;
  if (['law', 'code', 'constitution', 'treaty', 'convention', 'charter'].includes(normalized)) {
    return true;
  }
  return (
    normalized.includes('закон') ||
    normalized.includes('кодекс') ||
    normalized.includes('конвенц') ||
    normalized.includes('догов') ||
    normalized.includes('статут')
  );
}

export function queryRequestsPrimaryLawLikeAct(
  query: string,
  documentTypeHints?: string[]
): boolean {
  const requestedCue =
    [
      ...extractActReferenceSignals(query).map((signal) => normalizeActReferenceCue(signal)),
      normalizeActReferenceCue(query),
    ].find((cue): cue is string => Boolean(cue) && PRIMARY_LAW_LIKE_ACT_CUES.has(cue));
  if (requestedCue) return true;
  return (documentTypeHints ?? []).some((hint) => documentTypeHintRequestsPrimaryLawLikeAct(hint));
}

export function isInterrogativePrimaryLawLocatorQuery(query: string): boolean {
  return INTERROGATIVE_PRIMARY_LAW_LOCATOR_REGEX.test(query.normalize('NFC'));
}

function isSpecializedPrimaryLawLocatorQuery(query: string): boolean {
  return SPECIALIZED_PRIMARY_LAW_LOCATOR_REGEX.test(query.normalize('NFC'));
}

function tokensSoftMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  return left.startsWith(right.slice(0, 5)) || right.startsWith(left.slice(0, 5));
}

function hasSoftTokenMatch(token: string, candidates: string[]): boolean {
  return candidates.includes(token) || candidates.some((candidateToken) => tokensSoftMatch(token, candidateToken));
}

function buildDocumentCueTokens(documentType: string | undefined | null): string[] {
  const tokens = tokenizeGroundingWords(documentType ?? '');
  const cues = tokens.map((token) => normalizeActReferenceCue(token)).filter(Boolean) as string[];
  return uniqueStrings([...tokens, ...cues]);
}

function normalizeIdentityToken(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

type PersonIdentitySignature = {
  surname: string;
  initials: string | null;
};

function extractPersonIdentitySignatures(value: string): PersonIdentitySignature[] {
  const out = new Map<string, PersonIdentitySignature>();
  const normalized = value.normalize('NFC');
  for (const match of normalized.matchAll(PERSON_SIGNATURE_REGEX)) {
    const surname = normalizeIdentityToken(match[1]);
    const initials = normalizeIdentityToken(`${match[2] ?? ''}${match[3] ?? ''}`) || null;
    if (!surname) continue;
    const key = `${surname}:${initials ?? ''}`;
    if (!out.has(key)) {
      out.set(key, { surname, initials });
    }
  }
  return [...out.values()];
}

function extractCapitalizedIdentityTokens(value: string): string[] {
  const out = new Set<string>();
  const normalizedValue = value.normalize('NFC');
  for (const match of normalizedValue.matchAll(CAPITALIZED_IDENTITY_TOKEN_REGEX)) {
    const normalized = normalizeIdentityToken(match[1]);
    if (!normalized || GENERIC_PERSON_IDENTITY_TOKENS.has(normalized)) continue;
    out.add(normalized);
  }
  return [...out];
}

function candidateMatchesExplicitPersonIdentityQuery(
  candidateTitle: string | undefined | null,
  query: string
): boolean {
  const requestedSignatures = extractPersonIdentitySignatures(query);
  if (requestedSignatures.length === 0) return true;

  const candidateSignatures = extractPersonIdentitySignatures(candidateTitle ?? '');
  const candidateIdentityTokens = new Set([
    ...candidateSignatures.map((signature) => signature.surname),
    ...extractCapitalizedIdentityTokens(candidateTitle ?? ''),
  ]);

  return requestedSignatures.every((requestedSignature) => {
    if (!candidateIdentityTokens.has(requestedSignature.surname)) return false;
    const sameSurnameSignature = candidateSignatures.find(
      (candidateSignature) => candidateSignature.surname === requestedSignature.surname
    );
    if (!sameSurnameSignature) return true;
    if (!requestedSignature.initials || !sameSurnameSignature.initials) return true;
    return requestedSignature.initials === sameSurnameSignature.initials;
  });
}

function isGenericSupportCueToken(token: string, documentCueTokens: string[]): boolean {
  if (GENERIC_SUPPORT_HINT_TOKENS.has(token)) return true;
  const normalizedCue = normalizeActReferenceCue(token);
  if (normalizedCue && GENERIC_SUPPORT_HINT_CUES.has(normalizedCue)) return true;
  if (documentCueTokens.includes(token)) return true;
  if (normalizedCue && documentCueTokens.includes(normalizedCue)) return true;
  return false;
}

export function hasActTitleSupportOverlap(
  query: string,
  title: string | undefined | null,
  documentType: string | undefined | null
): boolean {
  const documentCueTokens = buildDocumentCueTokens(documentType);
  const queryTokens = tokenizeGroundingWords(query).filter(
    (token) => !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (queryTokens.length < 2) return false;
  const titleTokens = tokenizeGroundingWords(title ?? '').filter(
    (token) => !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (titleTokens.length < 2) return false;
  const discriminativeTitleTokens = titleTokens.filter((token) => !isGenericSupportCueToken(token, documentCueTokens));
  if (discriminativeTitleTokens.length < 2) return false;
  const matches = discriminativeTitleTokens.filter((token) => hasSoftTokenMatch(token, queryTokens)).length;
  return matches >= 2 && matches / discriminativeTitleTokens.length >= 0.4;
}

function trimActReferenceSignalTail(signal: string): string {
  return signal
    .replace(/\s+(?:чи|коли|який|яка|яке|які|хто|як|де|куди|звідки|скільки|у\s+який|в\s+який)(?=\s|$).*$/iu, '')
    .trim()
    .replace(/[.,;:!?]+$/u, '')
    .trim();
}

function hasCompactCueSignalOverlap(
  signals: string[],
  title: string | undefined | null,
  documentType: string | undefined | null
): boolean {
  const documentCueTokens = buildDocumentCueTokens(documentType);
  const titleTokens = tokenizeGroundingWords(title ?? '').filter(
    (token) => !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (titleTokens.length === 0) return false;
  const discriminativeTitleTokens = titleTokens.filter(
    (token) => token.length >= 5 && !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (discriminativeTitleTokens.length === 0) return false;
  for (const signal of signals) {
    const trimmedSignal = trimActReferenceSignalTail(signal);
    const signalTokens = tokenizeGroundingWords(trimmedSignal).filter(
      (token) => !isGenericSupportCueToken(token, documentCueTokens)
    );
    if (signalTokens.length === 0 || signalTokens.length > 2) continue;
    const matchedTokens = signalTokens.filter((token) => token.length >= 5 && hasSoftTokenMatch(token, discriminativeTitleTokens));
    if (matchedTokens.length === signalTokens.length) return true;
  }
  return false;
}

function hasSingleDiscriminativeCueTokenOverlap(
  signals: string[],
  title: string | undefined | null,
  documentType: string | undefined | null
): boolean {
  const documentCueTokens = buildDocumentCueTokens(documentType);
  const titleTokens = tokenizeGroundingWords(title ?? '').filter(
    (token) => token.length >= 5 && !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (titleTokens.length === 0) return false;
  for (const signal of signals) {
    const trimmedSignal = trimActReferenceSignalTail(signal);
    const signalTokens = tokenizeGroundingWords(trimmedSignal).filter(
      (token) => token.length >= 5 && !isGenericSupportCueToken(token, documentCueTokens)
    );
    if (signalTokens.length !== 1) continue;
    if (hasSoftTokenMatch(signalTokens[0]!, titleTokens)) return true;
  }
  return false;
}

function hasPreCueDiscriminativeTitleTokenOverlap(
  query: string,
  title: string | undefined | null,
  documentType: string | undefined | null
): boolean {
  const documentCueTokens = buildDocumentCueTokens(documentType);
  if (documentCueTokens.length === 0) return false;
  const titleTokens = tokenizeGroundingWords(title ?? '').filter(
    (token) => token.length >= 5 && !isGenericSupportCueToken(token, documentCueTokens)
  );
  if (titleTokens.length === 0) return false;

  const orderedTokens = query
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  for (let index = 0; index < orderedTokens.length; index += 1) {
    const token = orderedTokens[index] ?? '';
    if (!hasSoftTokenMatch(token, documentCueTokens)) continue;
    for (const offset of [1, 2]) {
      const previousToken = orderedTokens[index - offset] ?? '';
      if (previousToken.length < 5) continue;
      if (isGenericSupportCueToken(previousToken, documentCueTokens)) continue;
      if (hasSoftTokenMatch(previousToken, titleTokens)) return true;
    }
  }
  return false;
}

function collectExplicitActTitleSignals(query: string): string[] {
  const extractedSignals = uniqueStrings([
    ...extractQuotedActTitleFragments(query),
    ...extractActReferenceSignals(query).map((signal) => trimActReferenceSignalTail(signal)),
  ]).filter((signal) => tokenizeGroundingWords(signal).length >= 2);
  if (extractedSignals.length > 0) return extractedSignals;
  if (looksLikeCompactActTitleFragmentQuery(query)) return [query];
  return [];
}

function collectRequestedStructuredActIdentifiers(query: string): string[] {
  return uniqueStrings(
    extractStructuredActIdentifiers(query).map((value) => normalizeStructuredActIdentifier(value))
  );
}

function candidateMatchesRequestedStructuredActIdentifiers(
  candidate:
    | Pick<ActCandidateInput, 'rada_nreg' | 'title' | 'document_type'>
    | undefined,
  query: string
): boolean {
  const requestedIdentifiers = collectRequestedStructuredActIdentifiers(query);
  if (requestedIdentifiers.length === 0) return true;
  const candidateIdentifiers = new Set(
    uniqueStrings([
      candidate?.rada_nreg ? normalizeStructuredActIdentifier(candidate.rada_nreg) : null,
      ...(candidate?.title
        ? extractStructuredActIdentifiers(candidate.title).map((value) => normalizeStructuredActIdentifier(value))
        : []),
      ...(candidate?.document_type
        ? extractStructuredActIdentifiers(candidate.document_type).map((value) => normalizeStructuredActIdentifier(value))
        : []),
    ])
  );
  return requestedIdentifiers.some((identifier) => candidateIdentifiers.has(identifier));
}

function queryRequiresAmendmentLikeTitleMatch(query: string): boolean {
  return collectExplicitActTitleSignals(query).some((signal) => isAmendmentLikeActTitle(signal));
}

function candidateMatchesStrictExplicitActScopeQuery(
  candidate:
    | Pick<ActCandidateInput, 'rada_nreg' | 'title' | 'document_type'>
    | undefined,
  query: string
): boolean {
  if (!candidateMatchesRequestedStructuredActIdentifiers(candidate, query)) return false;
  if (queryRequiresAmendmentLikeTitleMatch(query) && !isAmendmentLikeActTitle(candidate?.title ?? '')) {
    return false;
  }
  if (!candidateMatchesExplicitPersonIdentityQuery(candidate?.title, query)) {
    return false;
  }
  return true;
}

function isTrustedExplicitGroundedActScopeCandidate(
  candidate:
    | Pick<ActCandidateInput, 'rada_nreg' | 'title' | 'document_type' | 'document_type_slug' | 'reasons' | 'score'>
    | undefined,
  query: string,
  metadataGroundingReasonCodes: Set<string>
): boolean {
  if (!candidateMatchesStrictExplicitActScopeQuery(candidate, query)) return false;
  if (isMetadataGroundedActCandidate(candidate, query, metadataGroundingReasonCodes)) return true;

  const explicitActTitleSignals = collectExplicitActTitleSignals(query);
  const actReferenceSignals = extractActReferenceSignals(query);
  const signals = uniqueStrings([
    ...explicitActTitleSignals,
    ...actReferenceSignals,
    query,
  ]);
  if (signals.length === 0) return false;

  return (
    hasExplicitActTitleSignalOverlap(signals, candidate?.title, candidate?.document_type) ||
    hasCompactCueSignalOverlap(signals, candidate?.title, candidate?.document_type) ||
    hasSingleDiscriminativeCueTokenOverlap(signals, candidate?.title, candidate?.document_type) ||
    hasPreCueDiscriminativeTitleTokenOverlap(query, candidate?.title, candidate?.document_type)
  );
}

function hasExplicitActTitleSignalOverlap(
  signals: string[],
  title: string | undefined | null,
  documentType: string | undefined | null
): boolean {
  if (signals.length === 0) return false;
  return (
    signals.some((signal) => hasActTitleSupportOverlap(signal, title, documentType)) ||
    hasCompactCueSignalOverlap(signals, title, documentType) ||
    hasSingleDiscriminativeCueTokenOverlap(signals, title, documentType)
  );
}

function normalizeFamilyKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
}

function normalizeDomainHintKey(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
  if (normalized === 'admin') return 'administrative';
  return normalized;
}

function isSpecificDomainHint(domainHint: string | null | undefined): boolean {
  const normalized = normalizeDomainHintKey(domainHint);
  return normalized.length > 0 && normalized !== 'general' && normalized !== 'unknown';
}

function isDomainHintAlignedFamily(domainHint: string | null | undefined, familyKey: string | null | undefined): boolean {
  const normalizedDomain = normalizeDomainHintKey(domainHint);
  const normalizedFamily = normalizeFamilyKey(familyKey);
  if (!isSpecificDomainHint(normalizedDomain) || !normalizedFamily || normalizedFamily === 'unknown') return false;
  if (normalizedFamily === normalizedDomain) return true;
  if (normalizedFamily.startsWith(`${normalizedDomain}_`) || normalizedDomain.startsWith(`${normalizedFamily}_`)) {
    return true;
  }
  if (normalizedDomain === 'tax_customs' && normalizedFamily.startsWith('tax')) return true;
  if (normalizedDomain === 'tax' && normalizedFamily.startsWith('tax')) return true;
  if (normalizedDomain === 'labor_social' && normalizedFamily.startsWith('labor')) return true;
  if (normalizedDomain === 'labor' && normalizedFamily.startsWith('labor')) return true;
  if (normalizedDomain === 'civil' && (normalizedFamily === 'civil' || normalizedFamily === 'civil_procedure')) {
    return true;
  }
  if (normalizedDomain === 'family' && (normalizedFamily === 'family' || normalizedFamily === 'civil')) {
    return true;
  }
  if (
    normalizedDomain === 'criminal' &&
    (normalizedFamily === 'criminal' || normalizedFamily === 'criminal_procedure')
  ) {
    return true;
  }
  if (
    normalizedDomain === 'administrative' &&
    (normalizedFamily === 'administrative' || normalizedFamily === 'administrative_offenses')
  ) {
    return true;
  }
  return false;
}

function isProceduralFamilyKey(value: string | null | undefined): boolean {
  const familyKey = normalizeFamilyKey(value);
  return familyKey.includes('procedure') || familyKey === 'judiciary_justice';
}

function hasStrongProceduralSupportEvidence(
  evidence: BuildSelectedActsOutput['chunks_evidence_top_acts'][number] | undefined
): boolean {
  if (!evidence) return false;
  return (
    (
      (evidence.count_in_top30 ?? 0) >= 3 &&
      (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 15
    ) ||
    (
      (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 8 &&
      (evidence.max_ordering_score ?? 0) >= 0.3
    ) ||
    (
      (evidence.rank_mass_top30 ?? 0) >= 0.35 &&
      (evidence.max_ordering_score ?? 0) >= 0.3
    )
  );
}

function hasDominantSingleActEvidenceSupport(input: {
  radaNreg: string | null | undefined;
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts'];
}): boolean {
  if (!input.radaNreg) return false;
  const rankedEvidence = [...input.chunksEvidenceTopActs]
    .filter((item) => !!item.rada_nreg)
    .sort((left, right) => {
      const rankMassDiff = (right.rank_mass_top30 ?? 0) - (left.rank_mass_top30 ?? 0);
      if (rankMassDiff !== 0) return rankMassDiff;
      const bestRankDiff =
        (left.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) -
        (right.best_rank_in_top30 ?? Number.POSITIVE_INFINITY);
      if (bestRankDiff !== 0) return bestRankDiff;
      const orderingDiff = (right.max_ordering_score ?? 0) - (left.max_ordering_score ?? 0);
      if (orderingDiff !== 0) return orderingDiff;
      return (right.count_in_top30 ?? 0) - (left.count_in_top30 ?? 0);
    });
  const targetEvidence = rankedEvidence.find((item) => sameRadaNreg(item.rada_nreg, input.radaNreg));
  if (!targetEvidence) return false;
  if ((targetEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) > 3) return false;
  if ((targetEvidence.count_in_top30 ?? 0) < 5) return false;
  if ((targetEvidence.rank_mass_top30 ?? 0) < 0.6) return false;
  if ((targetEvidence.max_ordering_score ?? 0) < 0.4) return false;

  const runnerUpEvidence = rankedEvidence.find((item) => !sameRadaNreg(item.rada_nreg, input.radaNreg));
  if (!runnerUpEvidence) return true;
  return (
    (targetEvidence.rank_mass_top30 ?? 0) >= ((runnerUpEvidence.rank_mass_top30 ?? 0) + 0.35) ||
    (targetEvidence.count_in_top30 ?? 0) >= ((runnerUpEvidence.count_in_top30 ?? 0) + 4) ||
    (
      (targetEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
      (runnerUpEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) >= 8
    ) ||
    (targetEvidence.max_ordering_score ?? 0) >= ((runnerUpEvidence.max_ordering_score ?? 0) + 0.07)
  );
}

function getLeadEvidenceActNreg(
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts']
): string | null {
  return (
    [...chunksEvidenceTopActs]
      .filter((item) => !!item.rada_nreg)
      .sort((left, right) => {
        const rankMassDiff = (right.rank_mass_top30 ?? 0) - (left.rank_mass_top30 ?? 0);
        if (rankMassDiff !== 0) return rankMassDiff;
        const bestRankDiff =
          (left.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) -
          (right.best_rank_in_top30 ?? Number.POSITIVE_INFINITY);
        if (bestRankDiff !== 0) return bestRankDiff;
        const orderingDiff = (right.max_ordering_score ?? 0) - (left.max_ordering_score ?? 0);
        if (orderingDiff !== 0) return orderingDiff;
        return (right.count_in_top30 ?? 0) - (left.count_in_top30 ?? 0);
      })[0]?.rada_nreg ?? null
  );
}

function sortEvidenceByRankMass(
  items: BuildSelectedActsOutput['chunks_evidence_top_acts']
): BuildSelectedActsOutput['chunks_evidence_top_acts'] {
  return [...items]
    .filter((item) => !!item.rada_nreg)
    .sort((left, right) => {
      const rankMassDiff = (right.rank_mass_top30 ?? 0) - (left.rank_mass_top30 ?? 0);
      if (rankMassDiff !== 0) return rankMassDiff;
      const bestRankDiff =
        (left.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) -
        (right.best_rank_in_top30 ?? Number.POSITIVE_INFINITY);
      if (bestRankDiff !== 0) return bestRankDiff;
      const orderingDiff = (right.max_ordering_score ?? 0) - (left.max_ordering_score ?? 0);
      if (orderingDiff !== 0) return orderingDiff;
      return (right.count_in_top30 ?? 0) - (left.count_in_top30 ?? 0);
    });
}

function sortEvidenceByCoverageWeighted(
  items: BuildSelectedActsOutput['chunks_evidence_top_acts']
): BuildSelectedActsOutput['chunks_evidence_top_acts'] {
  return [...items]
    .filter((item) => !!item.rada_nreg)
    .sort((left, right) => {
      const leftCoverageMass = (left.count_in_top30 ?? 0) * (left.avg_score_in_top30 ?? 0);
      const rightCoverageMass = (right.count_in_top30 ?? 0) * (right.avg_score_in_top30 ?? 0);
      const coverageMassDiff = rightCoverageMass - leftCoverageMass;
      if (coverageMassDiff !== 0) return coverageMassDiff;
      const maxScoreDiff = (right.max_score ?? 0) - (left.max_score ?? 0);
      if (maxScoreDiff !== 0) return maxScoreDiff;
      const bestRankDiff =
        (left.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) -
        (right.best_rank_in_top30 ?? Number.POSITIVE_INFINITY);
      if (bestRankDiff !== 0) return bestRankDiff;
      const orderingDiff = (right.max_ordering_score ?? 0) - (left.max_ordering_score ?? 0);
      if (orderingDiff !== 0) return orderingDiff;
      const rankMassDiff = (right.rank_mass_top30 ?? 0) - (left.rank_mass_top30 ?? 0);
      if (rankMassDiff !== 0) return rankMassDiff;
      return (right.count_in_top30 ?? 0) - (left.count_in_top30 ?? 0);
    });
}

const UKRAINIAN_MONTH_GENITIVE_REGEX =
  /(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)/iu;

function queryHasExplicitCalendarDate(query: string): boolean {
  return (
    /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/u.test(query) ||
    new RegExp(`\\b\\d{1,2}\\s+${UKRAINIAN_MONTH_GENITIVE_REGEX.source}\\s+\\d{4}(?:\\s*р(?:оку)?\\b)?`, 'iu').test(query)
  );
}

function collectCalendarScopedAlignedEvidence(input: {
  rankedEvidence: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  actCandidatesTopHydrated: ActCandidateInput[];
  query: string;
}): Array<{
  evidence: BuildSelectedActsOutput['chunks_evidence_top_acts'][number];
  candidate: ActCandidateInput;
}> {
  if (!queryHasExplicitCalendarDate(input.query)) return [];
  const out: Array<{
    evidence: BuildSelectedActsOutput['chunks_evidence_top_acts'][number];
    candidate: ActCandidateInput;
  }> = [];
  for (const evidence of input.rankedEvidence) {
    if (!evidence?.rada_nreg) continue;
    const candidate = input.actCandidatesTopHydrated.find((item) =>
      sameRadaNreg(item.rada_nreg, evidence.rada_nreg)
    );
    if (!candidate) continue;
    if (!candidateMatchesStrictExplicitActScopeQuery(candidate, input.query)) continue;
    if (!hasActTitleSupportOverlap(input.query, candidate.title, candidate.document_type)) continue;
    out.push({ evidence, candidate });
  }
  return out;
}

function shouldPreferRelevanceLeaderForSpecializedPrimaryLawLocator(input: {
  coverageLeader: BuildSelectedActsOutput['chunks_evidence_top_acts'][number] | undefined;
  relevanceLeader: BuildSelectedActsOutput['chunks_evidence_top_acts'][number] | undefined;
  actCandidatesTopHydrated: ActCandidateInput[];
  query: string;
  metadataGroundingReasonCodes: Set<string>;
}): boolean {
  const { coverageLeader, relevanceLeader, actCandidatesTopHydrated, query, metadataGroundingReasonCodes } = input;
  if (!coverageLeader?.rada_nreg || !relevanceLeader?.rada_nreg) return false;
  if (sameRadaNreg(coverageLeader.rada_nreg, relevanceLeader.rada_nreg)) return false;

  const coverageCandidate = actCandidatesTopHydrated.find((candidate) =>
    sameRadaNreg(candidate.rada_nreg, coverageLeader.rada_nreg)
  );
  const relevanceCandidate = actCandidatesTopHydrated.find((candidate) =>
    sameRadaNreg(candidate.rada_nreg, relevanceLeader.rada_nreg)
  );
  const coverageKind = classifyActKind(
    coverageCandidate?.title ?? '',
    coverageCandidate?.document_type ?? null,
    coverageCandidate?.category ?? null,
    coverageCandidate?.document_type_slug ?? null
  );
  const relevanceKind = classifyActKind(
    relevanceCandidate?.title ?? '',
    relevanceCandidate?.document_type ?? null,
    relevanceCandidate?.category ?? null,
    relevanceCandidate?.document_type_slug ?? null
  );
  if (coverageKind !== 'PRIMARY_LAW' || relevanceKind !== 'PRIMARY_LAW') return false;

  const coverageMetadataGrounded = isMetadataGroundedActCandidate(
    coverageCandidate,
    query,
    metadataGroundingReasonCodes
  );
  const relevanceMetadataGrounded = isMetadataGroundedActCandidate(
    relevanceCandidate,
    query,
    metadataGroundingReasonCodes
  );
  if (coverageMetadataGrounded && !relevanceMetadataGrounded) return false;

  const relevanceRankMass = relevanceLeader.rank_mass_top30 ?? 0;
  const coverageRankMass = coverageLeader.rank_mass_top30 ?? 0;
  const relevanceBestRank = relevanceLeader.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const coverageBestRank = coverageLeader.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
  const relevanceOrdering = relevanceLeader.max_ordering_score ?? 0;
  const coverageOrdering = coverageLeader.max_ordering_score ?? 0;

  return (
    relevanceBestRank <= 3 &&
    relevanceOrdering >= 0.42 &&
    (
      relevanceRankMass >= coverageRankMass + 0.35 ||
      relevanceRankMass >= coverageRankMass * 1.8 ||
      (
        relevanceOrdering >= coverageOrdering + 0.03 &&
        relevanceBestRank + 4 <= coverageBestRank
      )
    )
  );
}

function deriveEvidenceSingleActConvergence(input: {
  chunksEvidenceTopActs: BuildSelectedActsOutput['chunks_evidence_top_acts'];
  actCandidatesTopHydrated: ActCandidateInput[];
  query: string;
  domainHint?: string;
  topScore: number | null;
  metadataGroundingReasonCodes: Set<string>;
}): string | null {
  const explicitActTitleSignals = collectExplicitActTitleSignals(input.query);
  const extractedActReferenceSignals = extractActReferenceSignals(input.query);
  const referenceSignals =
    explicitActTitleSignals.length > 0 ? explicitActTitleSignals : extractedActReferenceSignals;
  const explicitActScopeCueQuery =
    hasExplicitActScopeCue(input.query) ||
    extractStructuredActIdentifiers(input.query).length >= 1 ||
    explicitActTitleSignals.length > 0 ||
    extractedActReferenceSignals.length > 0;
  const interrogativePrimaryLawLocatorQuery =
    explicitActScopeCueQuery &&
    isInterrogativePrimaryLawLocatorQuery(input.query) &&
    queryRequestsPrimaryLawLikeAct(input.query);
  const specializedPrimaryLawLocatorQuery =
    explicitActScopeCueQuery &&
    isSpecializedPrimaryLawLocatorQuery(input.query) &&
    queryRequestsPrimaryLawLikeAct(input.query);
  const relevanceRankedEvidence = sortEvidenceByRankMass(input.chunksEvidenceTopActs);
  const coverageWeightedRankedEvidence = specializedPrimaryLawLocatorQuery
    ? sortEvidenceByCoverageWeighted(input.chunksEvidenceTopActs)
    : relevanceRankedEvidence;
  let rankedEvidence = coverageWeightedRankedEvidence;
  if (
    specializedPrimaryLawLocatorQuery &&
    shouldPreferRelevanceLeaderForSpecializedPrimaryLawLocator({
      coverageLeader: coverageWeightedRankedEvidence[0],
      relevanceLeader: relevanceRankedEvidence[0],
      actCandidatesTopHydrated: input.actCandidatesTopHydrated,
      query: input.query,
      metadataGroundingReasonCodes: input.metadataGroundingReasonCodes,
    })
  ) {
    const relevanceLeader = relevanceRankedEvidence[0];
    rankedEvidence = relevanceLeader
      ? [
          relevanceLeader,
          ...coverageWeightedRankedEvidence.filter(
            (item) => !sameRadaNreg(item.rada_nreg, relevanceLeader.rada_nreg)
          ),
        ]
      : coverageWeightedRankedEvidence;
  }
  const topEvidence = rankedEvidence[0];
  const runnerUpEvidence = rankedEvidence[1];
  if (!topEvidence?.rada_nreg) return null;
  const calendarScopedAlignedEvidence = collectCalendarScopedAlignedEvidence({
    rankedEvidence,
    actCandidatesTopHydrated: input.actCandidatesTopHydrated,
    query: input.query,
  });
  if (queryHasExplicitCalendarDate(input.query) && calendarScopedAlignedEvidence.length > 1) {
    return null;
  }
  const topEvidenceCandidate = input.actCandidatesTopHydrated.find((candidate) =>
    sameRadaNreg(candidate.rada_nreg, topEvidence.rada_nreg)
  );
  const hasReferenceSignalOverlap = referenceSignals.some((signal) =>
    hasActTitleSupportOverlap(
      signal,
      topEvidenceCandidate?.title,
      topEvidenceCandidate?.document_type
    )
  );
  const hasQueryTitleOverlap =
    explicitActTitleSignals.length === 0 &&
    hasActTitleSupportOverlap(
      input.query,
      topEvidenceCandidate?.title,
      topEvidenceCandidate?.document_type
    );
  const hasDistinctiveCueOverlap =
    explicitActScopeCueQuery &&
    hasCompactCueSignalOverlap(
      referenceSignals,
      topEvidenceCandidate?.title,
      topEvidenceCandidate?.document_type
    );
  const domainAlignedTopEvidenceCandidate =
    !!topEvidenceCandidate?.rada_nreg &&
    isDomainHintAlignedFamily(input.domainHint, topEvidenceCandidate.category);
  const topActCandidate = input.actCandidatesTopHydrated[0];
  const runnerUpActCandidate = input.actCandidatesTopHydrated[1];
  const topEvidenceCandidateActKind = classifyActKind(
    topEvidenceCandidate?.title ?? '',
    topEvidenceCandidate?.document_type ?? null,
    topEvidenceCandidate?.category ?? null,
    topEvidenceCandidate?.document_type_slug ?? null
  );
  if (!candidateMatchesStrictExplicitActScopeQuery(topEvidenceCandidate, input.query)) {
    return null;
  }
  const hasWeakSemanticSupport =
    isMetadataGroundedActCandidate(
      topEvidenceCandidate,
      input.query,
      input.metadataGroundingReasonCodes
    ) ||
    hasReferenceSignalOverlap ||
    hasQueryTitleOverlap ||
    hasDistinctiveCueOverlap ||
    (
      !explicitActScopeCueQuery &&
      referenceSignals.length === 0 &&
      domainAlignedTopEvidenceCandidate
    ) ||
    (
      interrogativePrimaryLawLocatorQuery &&
      topEvidenceCandidateActKind === 'PRIMARY_LAW'
    );
  if (
    !hasWeakSemanticSupport
  ) {
    return null;
  }
  const densePrimaryLawLocatorEvidence =
    interrogativePrimaryLawLocatorQuery &&
    topEvidenceCandidateActKind === 'PRIMARY_LAW' &&
    sameRadaNreg(topEvidenceCandidate?.rada_nreg, topActCandidate?.rada_nreg) &&
    (topEvidence.count_in_top30 ?? 0) >= 6 &&
    (topEvidence.rank_mass_top30 ?? 0) >= 1.8 &&
    (topEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (topEvidence.max_ordering_score ?? 0) >= 0.39 &&
    (topEvidenceCandidate?.score ?? 0) >= ((runnerUpActCandidate?.score ?? 0) + 0.6);
  if ((input.topScore ?? 0) < (densePrimaryLawLocatorEvidence ? 0.42 : 0.48)) return null;
  if ((topEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) > 8) return null;
  if (
    (topEvidence.count_in_top30 ?? 0) < 5 &&
    (topEvidence.rank_mass_top30 ?? 0) < (hasDistinctiveCueOverlap ? 0.22 : 0.45)
  ) {
    return null;
  }
  if ((topEvidence.max_ordering_score ?? 0) < 0.42) return null;
  if (!runnerUpEvidence) return topEvidence.rada_nreg;

  const dominantByRankMass =
    (topEvidence.rank_mass_top30 ?? 0) >= ((runnerUpEvidence.rank_mass_top30 ?? 0) + 0.28);
  const dominantByCount =
    (topEvidence.count_in_top30 ?? 0) >= ((runnerUpEvidence.count_in_top30 ?? 0) + 3);
  const dominantByRankWindow =
    (topEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
    (runnerUpEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) >= 9;
  const dominantByOrdering =
    (topEvidence.max_ordering_score ?? 0) >= ((runnerUpEvidence.max_ordering_score ?? 0) + 0.08);
  const dominantByExplicitCueHead =
    hasDistinctiveCueOverlap &&
    (topEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (topEvidence.count_in_top30 ?? 0) >= 3 &&
    (topEvidence.max_ordering_score ?? 0) >= 0.38;
  const dominantByPeakEvidence =
    interrogativePrimaryLawLocatorQuery &&
    (topEvidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 1 &&
    (topEvidence.count_in_top30 ?? 0) >= 3 &&
    (topEvidence.max_ordering_score ?? 0) >= 0.45 &&
    (
      !runnerUpEvidence ||
      (
        (topEvidence.max_ordering_score ?? 0) >= ((runnerUpEvidence.max_ordering_score ?? 0) + 0.03) &&
        (topEvidence.rank_mass_top30 ?? 0) >= ((runnerUpEvidence.rank_mass_top30 ?? 0) * 0.6)
      )
    );

  return dominantByRankMass ||
    dominantByCount ||
    dominantByRankWindow ||
    dominantByOrdering ||
    dominantByExplicitCueHead ||
    dominantByPeakEvidence
    ? topEvidence.rada_nreg
    : null;
}

export function isMetadataGroundedActCandidate(
  candidate:
    | Pick<ActCandidateInput, 'rada_nreg' | 'reasons' | 'title' | 'document_type' | 'document_type_slug' | 'score'>
    | undefined,
  query: string,
  metadataGroundingReasonCodes: Set<string>
): boolean {
  if (!candidate) return false;
  if (!candidateMatchesStrictExplicitActScopeQuery(candidate, query)) return false;
  const explicitActTitleSignals = collectExplicitActTitleSignals(query);
  const strictExplicitActTitleQuery =
    extractQuotedActTitleFragments(query).length > 0 || looksLikeCompactActTitleFragmentQuery(query);
  const explicitActTitleAligned = hasExplicitActTitleSignalOverlap(
    explicitActTitleSignals,
    candidate.title,
    candidate.document_type
  );
  const requestedCue =
    extractActReferenceSignals(query)
      .map((signal) => normalizeActReferenceCue(signal))
      .find(Boolean) ??
    normalizeActReferenceCue(query);
  if (requestedCue) {
    const candidateCueMatches = [candidate.document_type, candidate.document_type_slug, candidate.title].some(
      (value) => areActReferenceCuesCompatible(requestedCue, normalizeActReferenceCue(value), query)
    );
    if (!candidateCueMatches) return false;
  }
  const reasons = new Set(candidate.reasons ?? []);
  if (reasons.has('exact_alias_match') || reasons.has('exact_title_match')) return true;
  const strongAliasBackedExplicitCue =
    reasons.has('alias_match') &&
    explicitActTitleSignals.length > 0 &&
    requestedCue != null &&
    (candidate.score ?? 0) >= 2.2;
  if (strongAliasBackedExplicitCue) return true;
  if (
    (reasons.has('alias_match') || reasons.has('title_match')) &&
    explicitActTitleSignals.length > 0 &&
    strictExplicitActTitleQuery
  ) {
    return explicitActTitleAligned;
  }
  if ([...metadataGroundingReasonCodes].some((reasonCode) => reasons.has(reasonCode))) {
    if (strictExplicitActTitleQuery && explicitActTitleSignals.length > 0) {
      return explicitActTitleAligned;
    }
    return true;
  }
  if (
    requestedCue &&
    (candidate.score ?? 0) >= 2 &&
    (
      hasExplicitActTitleSignalOverlap([query], candidate.title, candidate.document_type) ||
      hasSingleDiscriminativeCueTokenOverlap([query], candidate.title, candidate.document_type) ||
      hasPreCueDiscriminativeTitleTokenOverlap(query, candidate.title, candidate.document_type)
    )
  ) {
    return true;
  }
  if (!reasons.has('title_match')) return false;

  const candidateTitleTokens = tokenizeGroundingWords(candidate.title ?? '');
  const candidateDocumentTypeTokens = tokenizeGroundingWords(candidate.document_type ?? '');
  if (candidateTitleTokens.length === 0) return false;

  const actReferenceSignals = extractActReferenceSignals(query);
  const signalsToCheck =
    actReferenceSignals.length > 0 || !looksLikeCompactActTitleFragmentQuery(query)
      ? uniqueStrings([...actReferenceSignals, query])
      : [query];

  for (const signal of signalsToCheck) {
    const signalTokens = tokenizeGroundingWords(signal);
    if (signalTokens.length < 2) continue;

    const signalTitleTokens = signalTokens.filter(
      (token) =>
        !hasSoftTokenMatch(token, candidateDocumentTypeTokens) &&
        !GENERIC_METADATA_GROUNDING_TOKENS.has(token)
    );
    if (signalTitleTokens.length < 2) continue;

    let titleMatches = 0;
    for (const token of signalTitleTokens) {
      if (hasSoftTokenMatch(token, candidateTitleTokens)) titleMatches += 1;
    }

    if (titleMatches >= 2 && titleMatches / signalTitleTokens.length >= 0.5) return true;
  }
  return false;
}

export function isExplicitlyHintedSupportActCandidate(input: {
  query: string;
  act: Pick<SelectedActOutput, 'act_title'>;
  candidate: Pick<ActCandidateInput, 'title' | 'document_type' | 'category' | 'document_type_slug'> | undefined;
  documentTypeHints: string[];
}): boolean {
  const kind = classifyActKind(
    input.candidate?.title ?? input.act.act_title ?? '',
    input.candidate?.document_type ?? null,
    input.candidate?.category ?? null,
    input.candidate?.document_type_slug ?? null
  );
  if (kind === 'PRIMARY_LAW' || kind === 'UNKNOWN') return false;
  if (isExplicitlyHintedNonPrimaryAct(input.act as SelectedActOutput, input.candidate as ActCandidateInput | undefined, input.documentTypeHints)) {
    return true;
  }
  return hasActTitleSupportOverlap(
    input.query,
    input.candidate?.title ?? input.act.act_title ?? '',
    input.candidate?.document_type ?? null
  );
}

function buildRecoveredSupportAct(input: {
  radaNreg: string;
  candidate: ActCandidateInput | undefined;
  evidence: BuildSelectedActsOutput['chunks_evidence_top_acts'][number] | undefined;
  selectedActsFinalMeta: FinalizeSelectedActsAfterRoutingOutput;
}): SelectedActLike | null {
  const { radaNreg, candidate, evidence, selectedActsFinalMeta } = input;
  if (!candidate || !evidence) return null;
  const actTitle = candidate.title ?? radaNreg;
  return {
    rada_nreg: radaNreg,
    act_title: actTitle,
    score: evidence.max_ordering_score || candidate.score,
    why_selected: `scope_support best_rank=${evidence.best_rank_in_top30} max_score=${(evidence.max_ordering_score ?? 0).toFixed(2)}`,
    reason_tag: 'CHUNKS_EVIDENCE',
    source_tags: ['CHUNKS_EVIDENCE', 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT'],
    document_type: candidate.document_type ?? null,
    category: candidate.category ?? null,
    act_kind: classifyActKind(
      actTitle,
      candidate.document_type ?? null,
      candidate.category ?? null,
      candidate.document_type_slug ?? null
    ),
    flags: {
      recovered: true,
      keep_one: false,
      draft: false,
      opinion: false,
    },
    confidence: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.6),
  };
}

export async function resolveSingleActScopeSelection(
  input: ResolveSingleActScopeSelectionInput
): Promise<ResolveSingleActScopeSelectionOutput> {
  const {
    query,
    domainHint,
    documentTypeHints,
    chunksEvidenceTopActs,
    actCandidatesTopHydrated,
    exactActNregs,
    groundedActNregs,
    topScore,
    getActMeta,
    metadataGroundingReasonCodes,
    nonPrimaryAuthoritativeKinds,
  } = input;

  let selectedActsFinal = [...input.selectedActsFinal];
  let selectedActsSourcesBreakdownFinal = {
    ...input.selectedActsSourcesBreakdownFinal,
    from_taxonomy: [...input.selectedActsSourcesBreakdownFinal.from_taxonomy],
    from_acts_search: [...input.selectedActsSourcesBreakdownFinal.from_acts_search],
    from_chunks_evidence: [...input.selectedActsSourcesBreakdownFinal.from_chunks_evidence],
    from_routing_hints: input.selectedActsSourcesBreakdownFinal.from_routing_hints
      ? [...input.selectedActsSourcesBreakdownFinal.from_routing_hints]
      : undefined,
  };
  let selectedActsFinalMeta = input.selectedActsFinalMeta;
  const reasonCodes = [...input.reasonCodes];

  const exactActNregSet = new Set(exactActNregs.map((value) => normalizeRadaNreg(value)).filter(Boolean));
  const exactSingleActConverged = exactActNregSet.size === 1;
  const rawGroundedActNregSet = new Set(groundedActNregs.map((value) => normalizeRadaNreg(value)).filter(Boolean));
  const rawGroundedSingleActConverged = rawGroundedActNregSet.size === 1;
  const explicitActTitleSignals = collectExplicitActTitleSignals(query);
  const extractedActReferenceSignals = extractActReferenceSignals(query);
  const explicitActScopeCueQuery =
    hasExplicitActScopeCue(query) ||
    extractStructuredActIdentifiers(query).length >= 1 ||
    explicitActTitleSignals.length > 0 ||
    extractedActReferenceSignals.length > 0;
  const compactTitleFragmentQuery = looksLikeCompactActTitleFragmentQuery(query);
  const descriptiveActScopeQuery = explicitActScopeCueQuery || compactTitleFragmentQuery;
  const candidateByNreg = buildNormalizedNregMap(actCandidatesTopHydrated);
  const trustedGroundedScopeNreg =
    rawGroundedSingleActConverged
      ? [...rawGroundedActNregSet][0]
      : null;
  const trustedGroundedScopeCandidate =
    trustedGroundedScopeNreg
      ? getByNormalizedNreg(candidateByNreg, trustedGroundedScopeNreg)
      : undefined;
  const trustedGroundedScopeActKind = classifyActKind(
    trustedGroundedScopeCandidate?.title ?? '',
    trustedGroundedScopeCandidate?.document_type ?? null,
    trustedGroundedScopeCandidate?.category ?? null,
    trustedGroundedScopeCandidate?.document_type_slug ?? null
  );
  const requireTrustedExplicitGroundedScopeCandidate =
    descriptiveActScopeQuery &&
    trustedGroundedScopeActKind !== 'PRIMARY_LAW';
  const groundedActNregSet =
    rawGroundedSingleActConverged &&
    (
      !requireTrustedExplicitGroundedScopeCandidate ||
      isTrustedExplicitGroundedActScopeCandidate(
        trustedGroundedScopeCandidate,
        query,
        metadataGroundingReasonCodes
      )
    ) &&
    trustedGroundedScopeNreg
      ? new Set([normalizeRadaNreg(trustedGroundedScopeNreg)].filter(Boolean))
      : new Set<string>();
  const groundedSingleActConverged = groundedActNregSet.size === 1;
  const topActCandidate = actCandidatesTopHydrated[0];
  const runnerUpActCandidate = actCandidatesTopHydrated[1];
  const metadataGroundedActCandidates = actCandidatesTopHydrated.filter((candidate) =>
    isMetadataGroundedActCandidate(candidate, query, metadataGroundingReasonCodes)
  );
  const metadataScopeActCandidate =
    metadataGroundedActCandidates.length > 0 ? metadataGroundedActCandidates[0] : undefined;
  const metadataScopeRunnerUpCandidate = metadataScopeActCandidate
    ? actCandidatesTopHydrated.find((candidate) => !sameRadaNreg(candidate.rada_nreg, metadataScopeActCandidate.rada_nreg))
    : undefined;
  const metadataScopeEvidence = metadataScopeActCandidate
    ? chunksEvidenceTopActs.find((item) => sameRadaNreg(item.rada_nreg, metadataScopeActCandidate.rada_nreg))
    : undefined;
  const metadataTopActGrounded = isMetadataGroundedActCandidate(
    topActCandidate,
    query,
    metadataGroundingReasonCodes
  );
  const dominantMetadataScopeEvidenceSupport =
    !!metadataScopeActCandidate?.rada_nreg &&
    hasDominantSingleActEvidenceSupport({
      radaNreg: metadataScopeActCandidate.rada_nreg,
      chunksEvidenceTopActs,
    });
  const uniqueMetadataScopeEarlyEvidenceSupport =
    metadataGroundedActCandidates.length === 1 &&
    !!metadataScopeActCandidate?.rada_nreg &&
    (metadataScopeEvidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
    (metadataScopeEvidence?.max_ordering_score ?? 0) >= 0.4;
  const evidenceDominantSingleActNregPreMetadata =
    descriptiveActScopeQuery &&
    !exactSingleActConverged &&
    !groundedSingleActConverged
      ? deriveEvidenceSingleActConvergence({
          chunksEvidenceTopActs,
          actCandidatesTopHydrated,
          query,
          domainHint,
          topScore,
          metadataGroundingReasonCodes,
        })
      : null;
  const calendarScopedRecurringActAmbiguous =
    queryHasExplicitCalendarDate(query) &&
    collectCalendarScopedAlignedEvidence({
      rankedEvidence: sortEvidenceByCoverageWeighted(chunksEvidenceTopActs),
      actCandidatesTopHydrated,
      query,
    }).length > 1;
  const metadataSingleActConverged =
    (explicitActScopeCueQuery || compactTitleFragmentQuery) &&
    !exactSingleActConverged &&
    !groundedSingleActConverged &&
    !!metadataScopeActCandidate?.rada_nreg &&
    (
      evidenceDominantSingleActNregPreMetadata == null ||
      sameRadaNreg(evidenceDominantSingleActNregPreMetadata, metadataScopeActCandidate.rada_nreg)
    ) &&
    (
      metadataTopActGrounded ||
      metadataGroundedActCandidates.length === 1
    ) &&
    (
      (metadataScopeActCandidate?.score ?? 0) >= ((metadataScopeRunnerUpCandidate?.score ?? 0) + 2) ||
      dominantMetadataScopeEvidenceSupport ||
      uniqueMetadataScopeEarlyEvidenceSupport
    );
  const leadEvidenceActNreg = getLeadEvidenceActNreg(chunksEvidenceTopActs);
  const consensusSingleActEvidenceConverged =
    explicitActScopeCueQuery &&
    !exactSingleActConverged &&
    !groundedSingleActConverged &&
    !metadataSingleActConverged &&
    !!topActCandidate?.rada_nreg &&
    sameRadaNreg(topActCandidate.rada_nreg, leadEvidenceActNreg) &&
    hasDominantSingleActEvidenceSupport({
      radaNreg: topActCandidate.rada_nreg,
      chunksEvidenceTopActs,
    }) &&
    (topActCandidate.score ?? 0) >= Math.max(3, (runnerUpActCandidate?.score ?? 0) + 0.4);
  const evidenceSingleActNreg =
    descriptiveActScopeQuery &&
    !exactSingleActConverged &&
    !groundedSingleActConverged &&
    !metadataSingleActConverged
      ? evidenceDominantSingleActNregPreMetadata ?? (consensusSingleActEvidenceConverged ? topActCandidate?.rada_nreg ?? null : null)
      : null;
  const evidenceSingleActConverged = !!evidenceSingleActNreg;

  const explicitIdentifierScopedQuery =
    exactSingleActConverged &&
    extractStructuredActIdentifiers(query).length >= 1 &&
    countResidualQueryTokensAfterStructuredIds(query) <= 2;
  const compactGroundedActScopedQuery =
    !explicitIdentifierScopedQuery &&
    groundedSingleActConverged &&
    countQueryTokens(query) <= 6;
  const chunksEvidenceByNreg = buildNormalizedNregMap(chunksEvidenceTopActs);
  const scopeAnchorNreg =
    exactSingleActConverged && exactActNregSet.size === 1
      ? [...exactActNregSet][0]
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? [...groundedActNregSet][0]
        : metadataSingleActConverged && metadataScopeActCandidate?.rada_nreg
          ? metadataScopeActCandidate.rada_nreg
          : evidenceSingleActConverged && evidenceSingleActNreg
            ? evidenceSingleActNreg
          : null;
  const scopeAnchorFamilyKey = scopeAnchorNreg
    ? normalizeFamilyKey(
        getByNormalizedNreg(candidateByNreg, scopeAnchorNreg)?.category ??
          selectedActsFinal.find((act) => sameRadaNreg(act.rada_nreg, scopeAnchorNreg))?.category
      )
    : '';
  const scopeAnchorActKind = scopeAnchorNreg
    ? classifyActKind(
        getByNormalizedNreg(candidateByNreg, scopeAnchorNreg)?.title ??
          selectedActsFinal.find((act) => sameRadaNreg(act.rada_nreg, scopeAnchorNreg))?.act_title ??
          '',
        getByNormalizedNreg(candidateByNreg, scopeAnchorNreg)?.document_type ??
          selectedActsFinal.find((act) => sameRadaNreg(act.rada_nreg, scopeAnchorNreg))?.document_type ??
          null,
        getByNormalizedNreg(candidateByNreg, scopeAnchorNreg)?.category ??
          selectedActsFinal.find((act) => sameRadaNreg(act.rada_nreg, scopeAnchorNreg))?.category ??
          null,
        getByNormalizedNreg(candidateByNreg, scopeAnchorNreg)?.document_type_slug ?? null
      )
    : 'UNKNOWN';
  const preservedProceduralSupportAct =
    scopeAnchorNreg &&
    hasDistinctProceduralSupportBundleCue(query) &&
    !isProceduralFamilyKey(scopeAnchorFamilyKey)
      ? [...selectedActsFinal]
          .filter((act) => act.rada_nreg !== scopeAnchorNreg)
          .map((act) => {
            const candidate = getByNormalizedNreg(candidateByNreg, act.rada_nreg);
            const evidence = getByNormalizedNreg(chunksEvidenceByNreg, act.rada_nreg);
            const familyKey = normalizeFamilyKey(candidate?.category ?? act.category);
            return { act, candidate, evidence, familyKey };
          })
          .filter(
            ({ act, candidate, evidence, familyKey }) =>
              (act.act_kind ?? classifyActKind(
                candidate?.title ?? act.act_title ?? '',
                candidate?.document_type ?? act.document_type ?? null,
                candidate?.category ?? act.category ?? null,
                candidate?.document_type_slug ?? null
              )) === 'PRIMARY_LAW' &&
              isProceduralFamilyKey(familyKey) &&
              hasStrongProceduralSupportEvidence(evidence)
          )
          .sort((left, right) => {
            const leftRank = left.evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
            const rightRank = right.evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
            if (leftRank !== rightRank) return leftRank - rightRank;
            return (right.evidence?.max_ordering_score ?? 0) - (left.evidence?.max_ordering_score ?? 0);
          })[0]?.act
      : undefined;
  const preservedHintedSupportAct =
    scopeAnchorNreg &&
    scopeAnchorActKind === 'PRIMARY_LAW' &&
      (
        [
          ...selectedActsFinal.map((act) => ({
            act,
            candidate: candidateByNreg.get(act.rada_nreg),
            evidence: chunksEvidenceByNreg.get(act.rada_nreg),
          })),
          ...actCandidatesTopHydrated
            .filter(
              (candidate) =>
                !hasActWithNreg(selectedActsFinal, candidate.rada_nreg)
            )
            .map((candidate) => ({
              act:
                buildRecoveredSupportAct({
                  radaNreg: candidate.rada_nreg,
                  candidate,
                  evidence: getByNormalizedNreg(chunksEvidenceByNreg, candidate.rada_nreg),
                  selectedActsFinalMeta,
                }) ?? {
                  rada_nreg: candidate.rada_nreg,
                  act_title: candidate.title,
                  score: candidate.score,
                  document_type: candidate.document_type ?? null,
                  category: candidate.category ?? null,
                  act_kind: classifyActKind(
                    candidate.title ?? '',
                    candidate.document_type ?? null,
                    candidate.category ?? null,
                    candidate.document_type_slug ?? null
                  ),
                },
              candidate,
              evidence: getByNormalizedNreg(chunksEvidenceByNreg, candidate.rada_nreg),
            })),
        ]
          .filter(
            ({ act }) =>
              !sameRadaNreg(act.rada_nreg, scopeAnchorNreg) &&
              !sameRadaNreg(act.rada_nreg, preservedProceduralSupportAct?.rada_nreg)
          )
          .filter(
            ({ act, candidate, evidence }) =>
              isExplicitlyHintedSupportActCandidate({
                query,
                act: act as SelectedActOutput,
                candidate,
                documentTypeHints: documentTypeHints ?? [],
              }) &&
              hasStrongNonPrimarySupportEvidence(evidence)
          )
          .sort((left, right) => {
            const leftRank = left.evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
            const rightRank = right.evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY;
            if (leftRank !== rightRank) return leftRank - rightRank;
            const orderingDiff =
              (right.evidence?.max_ordering_score ?? 0) - (left.evidence?.max_ordering_score ?? 0);
            if (orderingDiff !== 0) return orderingDiff;
            return (right.act.score ?? 0) - (left.act.score ?? 0);
          })[0]?.act
      ) || undefined;
  if (
    preservedHintedSupportAct &&
    hasActWithNreg(selectedActsFinal, preservedHintedSupportAct.rada_nreg)
  ) {
    pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
  }

  if (
    (
      explicitIdentifierScopedQuery ||
      compactGroundedActScopedQuery ||
      metadataSingleActConverged ||
      evidenceSingleActConverged
    ) &&
    selectedActsFinal.length > 1 &&
    selectedActsFinal.some((act) =>
        explicitIdentifierScopedQuery
          ? exactActNregSet.has(normalizeRadaNreg(act.rada_nreg))
        : compactGroundedActScopedQuery
          ? groundedActNregSet.has(normalizeRadaNreg(act.rada_nreg))
          : metadataSingleActConverged
            ? sameRadaNreg(act.rada_nreg, metadataScopeActCandidate?.rada_nreg)
            : sameRadaNreg(act.rada_nreg, evidenceSingleActNreg)
    )
  ) {
    const scopedActs = selectedActsFinal
      .filter((act) =>
        explicitIdentifierScopedQuery
          ? exactActNregSet.has(normalizeRadaNreg(act.rada_nreg))
        : compactGroundedActScopedQuery
            ? groundedActNregSet.has(normalizeRadaNreg(act.rada_nreg))
            : metadataSingleActConverged
              ? sameRadaNreg(act.rada_nreg, metadataScopeActCandidate?.rada_nreg)
              : sameRadaNreg(act.rada_nreg, evidenceSingleActNreg)
      )
      .slice(0, 1);
    if (
      preservedProceduralSupportAct &&
      !hasActWithNreg(scopedActs, preservedProceduralSupportAct.rada_nreg)
    ) {
      scopedActs.push(preservedProceduralSupportAct);
      pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT');
    }
    if (
      preservedHintedSupportAct &&
      !hasActWithNreg(scopedActs, preservedHintedSupportAct.rada_nreg)
    ) {
      scopedActs.push(preservedHintedSupportAct);
      pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
    }
    selectedActsFinal = scopedActs;
    pushUnique(
      reasonCodes,
      explicitIdentifierScopedQuery
        ? 'EXACT_ACT_SCOPE_TRIMMED'
        : compactGroundedActScopedQuery
          ? 'GROUNDED_ACT_SCOPE_TRIMMED'
          : metadataSingleActConverged
            ? 'METADATA_ACT_SCOPE_TRIMMED'
            : 'EVIDENCE_ACT_SCOPE_TRIMMED'
    );
  }

  const leadSelectedActBeforeScopeTrim = selectedActsFinal[0];
  const secondSelectedActBeforeScopeTrim = selectedActsFinal[1];
  const leadSelectedEvidenceBeforeScopeTrim = leadSelectedActBeforeScopeTrim
    ? chunksEvidenceByNreg.get(leadSelectedActBeforeScopeTrim.rada_nreg)
    : undefined;
  const secondSelectedEvidenceBeforeScopeTrim = secondSelectedActBeforeScopeTrim
    ? chunksEvidenceByNreg.get(secondSelectedActBeforeScopeTrim.rada_nreg)
    : undefined;
  const dominantExplicitNonPrimaryScope =
    explicitActScopeCueQuery &&
    !queryRequestsPrimaryLawLikeAct(query, documentTypeHints) &&
    selectedActsFinal.length > 1 &&
    !selectedActsFinal.some((act) => act.act_kind === 'PRIMARY_LAW') &&
    nonPrimaryAuthoritativeKinds.has(leadSelectedActBeforeScopeTrim?.act_kind ?? '') &&
    (selectedActsFinalMeta.selected_acts_confidence_final ?? 0) >= 0.75 &&
    (leadSelectedEvidenceBeforeScopeTrim?.count_in_top30 ?? 0) >= 5 &&
    (leadSelectedEvidenceBeforeScopeTrim?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 2 &&
    (topScore ?? 0) >= 0.5 &&
    (
      secondSelectedEvidenceBeforeScopeTrim == null ||
      (leadSelectedEvidenceBeforeScopeTrim?.rank_mass_top30 ?? 0) >=
        (secondSelectedEvidenceBeforeScopeTrim.rank_mass_top30 ?? 0) + 0.35 ||
      (leadSelectedEvidenceBeforeScopeTrim?.count_in_top30 ?? 0) >=
        (secondSelectedEvidenceBeforeScopeTrim.count_in_top30 ?? 0) + 3
    );
  if (dominantExplicitNonPrimaryScope && leadSelectedActBeforeScopeTrim) {
    selectedActsFinal = [leadSelectedActBeforeScopeTrim];
    pushUnique(reasonCodes, 'AUTHORITATIVE_NON_PRIMARY_SCOPE_TRIMMED');
    const summary = summarizeSelectedActs(selectedActsFinal as SelectedActOutput[]);
    selectedActsFinalMeta = {
      ...selectedActsFinalMeta,
      selected_acts_final: selectedActsFinal as SelectedActOutput[],
      selected_acts_confidence_final: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.75),
      selected_acts_decision_final: {
        ...selectedActsFinalMeta.selected_acts_decision_final,
        reason_codes: uniqueStrings([
          ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
          'AUTHORITATIVE_NON_PRIMARY_SCOPE_TRIMMED',
        ]),
      },
      selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
      selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
    };
  }

  const scopeConstrainedNregSet =
    exactSingleActConverged && exactActNregSet.size === 1
      ? exactActNregSet
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? groundedActNregSet
        : metadataSingleActConverged && metadataScopeActCandidate?.rada_nreg
          ? new Set([metadataScopeActCandidate.rada_nreg])
          : evidenceSingleActConverged && evidenceSingleActNreg
            ? new Set([evidenceSingleActNreg])
        : null;
  const scopeAllowedNregSet =
    scopeConstrainedNregSet == null
      ? null
      : new Set([
          ...scopeConstrainedNregSet,
          ...(preservedProceduralSupportAct ? [preservedProceduralSupportAct.rada_nreg] : []),
          ...(preservedHintedSupportAct ? [preservedHintedSupportAct.rada_nreg] : []),
        ]);
  const scopeConstraintCode =
    exactSingleActConverged && exactActNregSet.size === 1
      ? 'EXACT_ACT_SCOPE_FORCED'
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? 'GROUNDED_ACT_SCOPE_FORCED'
        : metadataSingleActConverged && metadataScopeActCandidate?.rada_nreg
          ? 'METADATA_ACT_SCOPE_FORCED'
          : evidenceSingleActConverged && evidenceSingleActNreg
            ? 'EVIDENCE_ACT_SCOPE_FORCED'
        : null;
  const scopeRecoveredCode =
    exactSingleActConverged && exactActNregSet.size === 1
      ? 'EXACT_ACT_SCOPE_RECOVERED'
      : groundedSingleActConverged && groundedActNregSet.size === 1
        ? 'GROUNDED_ACT_SCOPE_RECOVERED'
        : metadataSingleActConverged && metadataScopeActCandidate?.rada_nreg
          ? 'METADATA_ACT_SCOPE_RECOVERED'
          : evidenceSingleActConverged && evidenceSingleActNreg
            ? 'EVIDENCE_ACT_SCOPE_RECOVERED'
        : null;

  if (scopeConstrainedNregSet && scopeAllowedNregSet) {
    const scopedSelectedActs = selectedActsFinal.filter((act) => scopeAllowedNregSet.has(act.rada_nreg));
    const hadOutOfScopeActs = scopedSelectedActs.length !== selectedActsFinal.length;
    if (hadOutOfScopeActs) {
      selectedActsFinal = scopedSelectedActs;
      if (scopeConstraintCode) pushUnique(reasonCodes, scopeConstraintCode);
    }
    if (
      selectedActsFinal.length > 0 &&
      preservedHintedSupportAct &&
      !hasActWithNreg(selectedActsFinal, preservedHintedSupportAct.rada_nreg)
    ) {
      selectedActsFinal = [...selectedActsFinal, preservedHintedSupportAct];
      pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
    }
    const hasScopeAnchorSelectedAct = selectedActsFinal.some((act) =>
      scopeConstrainedNregSet.has(normalizeRadaNreg(act.rada_nreg))
    );
    if (!hasScopeAnchorSelectedAct) {
      const scopeNreg = [...scopeConstrainedNregSet][0];
      const evidence = getByNormalizedNreg(chunksEvidenceByNreg, scopeNreg);
      const scopeCandidate = getByNormalizedNreg(candidateByNreg, scopeNreg);
      const runnerUpCandidate = actCandidatesTopHydrated.find((item) => !sameRadaNreg(item.rada_nreg, scopeNreg));
      const metadataGroundedScopeCandidate = isMetadataGroundedActCandidate(
        scopeCandidate,
        query,
        metadataGroundingReasonCodes
      );
      const trustedGroundedScopeCandidate =
        groundedSingleActConverged &&
        isTrustedExplicitGroundedActScopeCandidate(
          scopeCandidate,
          query,
          metadataGroundingReasonCodes
        );
      const dominantMetadataGroundedScopeCandidate =
        metadataGroundedScopeCandidate &&
        (
          (scopeCandidate?.score ?? 0) >= ((runnerUpCandidate?.score ?? 0) + 2) ||
          hasDominantSingleActEvidenceSupport({
            radaNreg: scopeNreg,
            chunksEvidenceTopActs,
          }) ||
          (
            metadataGroundedActCandidates.length === 1 &&
            (evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 3 &&
            (evidence?.max_ordering_score ?? 0) >= 0.4
          )
        );
      const recoverableScopedTaxonomy =
        sameRadaNreg(scopeCandidate?.rada_nreg, scopeNreg) &&
        descriptiveActScopeQuery &&
        (
          exactSingleActConverged ||
          dominantMetadataGroundedScopeCandidate ||
          trustedGroundedScopeCandidate
        ) &&
        (
          (scopeCandidate?.score ?? 0) >= Math.max(3, (runnerUpCandidate?.score ?? 0) + 1.5) ||
          (
            trustedGroundedScopeCandidate &&
            (
              (scopeCandidate?.score ?? 0) >= Math.max(2.5, (runnerUpCandidate?.score ?? 0) - 1) ||
              (
                (evidence?.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 20 &&
                (evidence?.max_ordering_score ?? 0) >= 0.5
              )
            )
          )
        );
      const recoverableScopedEvidence =
        evidence != null &&
        (
          (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 8 ||
          (
            explicitIdentifierScopedQuery &&
            (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 30 &&
            (evidence.max_ordering_score ?? 0) >= 0.25
          ) ||
          (
            (groundedSingleActConverged || metadataSingleActConverged) &&
            (dominantMetadataGroundedScopeCandidate || trustedGroundedScopeCandidate) &&
            (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 15 &&
            (evidence.max_ordering_score ?? 0) >= 0.33
          ) ||
          (
            evidenceSingleActConverged &&
            (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 8 &&
            (evidence.count_in_top30 ?? 0) >= 5 &&
            (evidence.max_ordering_score ?? 0) >= 0.42
          ) ||
          (
            trustedGroundedScopeCandidate &&
            (evidence.best_rank_in_top30 ?? Number.POSITIVE_INFINITY) <= 20 &&
            (evidence.max_ordering_score ?? 0) >= 0.5
          )
        );
      if (recoverableScopedEvidence && evidence) {
        const meta =
          scopeCandidate?.title && scopeCandidate.document_type !== undefined && scopeCandidate.category !== undefined
            ? null
            : await getActMeta(scopeNreg);
        const actTitle = scopeCandidate?.title ?? meta?.title ?? scopeNreg;
        selectedActsFinal = [
          {
            rada_nreg: scopeNreg,
            act_title: actTitle,
            score: evidence.max_ordering_score || scopeCandidate?.score,
            why_selected: `scope_recovery best_rank=${evidence.best_rank_in_top30} max_score=${evidence.max_ordering_score.toFixed(2)}`,
            reason_tag: 'CHUNKS_EVIDENCE',
            source_tags: uniqueStrings(['CHUNKS_EVIDENCE', ...(scopeRecoveredCode ? [scopeRecoveredCode] : [])]),
            document_type: scopeCandidate?.document_type ?? meta?.document_type ?? null,
            category: scopeCandidate?.category ?? meta?.category ?? null,
            storage_category: meta?.storage_category ?? null,
            act_kind: classifyActKind(
              actTitle,
              scopeCandidate?.document_type ?? meta?.document_type ?? null,
              scopeCandidate?.category ?? meta?.category ?? null
            ),
            flags: {
              recovered: true,
              keep_one: false,
              draft: false,
              opinion: false,
            },
            confidence: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.6),
          },
        ];
        if (
          preservedProceduralSupportAct &&
          !hasActWithNreg(selectedActsFinal, preservedProceduralSupportAct.rada_nreg)
        ) {
          selectedActsFinal.push(preservedProceduralSupportAct);
          pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT');
        }
        if (
          preservedHintedSupportAct &&
          !hasActWithNreg(selectedActsFinal, preservedHintedSupportAct.rada_nreg)
        ) {
          selectedActsFinal.push(preservedHintedSupportAct);
          pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
        }
        if (scopeRecoveredCode) pushUnique(reasonCodes, scopeRecoveredCode);
        selectedActsSourcesBreakdownFinal = {
          from_taxonomy: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_taxonomy, scopeNreg]),
          from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter(Boolean),
          from_chunks_evidence: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_chunks_evidence, scopeNreg]),
          from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter(Boolean),
        };
      } else if (recoverableScopedTaxonomy && scopeCandidate) {
        const meta =
          scopeCandidate.title && scopeCandidate.document_type !== undefined && scopeCandidate.category !== undefined
            ? null
            : await getActMeta(scopeNreg);
        const actTitle = scopeCandidate.title ?? meta?.title ?? scopeNreg;
        selectedActsFinal = [
          {
            rada_nreg: scopeNreg,
            act_title: actTitle,
            score: scopeCandidate.score,
            why_selected: `scope_grounding candidate_score=${(scopeCandidate.score ?? 0).toFixed(2)}`,
            reason_tag: 'TAXONOMY',
            source_tags: uniqueStrings(['TAXONOMY', 'EMPTY_RECOVERED', ...(scopeRecoveredCode ? [scopeRecoveredCode] : [])]),
            document_type: scopeCandidate.document_type ?? meta?.document_type ?? null,
            category: scopeCandidate.category ?? meta?.category ?? null,
            storage_category: meta?.storage_category ?? null,
            act_kind: classifyActKind(
              actTitle,
              scopeCandidate.document_type ?? meta?.document_type ?? null,
              scopeCandidate.category ?? meta?.category ?? null
            ),
            flags: {
              recovered: true,
              keep_one: false,
              draft: false,
              opinion: false,
            },
            confidence: Math.max(selectedActsFinalMeta.selected_acts_confidence_final, 0.45),
          },
        ];
        if (
          preservedProceduralSupportAct &&
          !hasActWithNreg(selectedActsFinal, preservedProceduralSupportAct.rada_nreg)
        ) {
          selectedActsFinal.push(preservedProceduralSupportAct);
          pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_PROCEDURAL_SUPPORT');
        }
        if (
          preservedHintedSupportAct &&
          !hasActWithNreg(selectedActsFinal, preservedHintedSupportAct.rada_nreg)
        ) {
          selectedActsFinal.push(preservedHintedSupportAct);
          pushUnique(reasonCodes, 'ACT_SCOPE_PRESERVED_HINTED_SUPPORT_ACT');
        }
        pushUnique(reasonCodes, 'EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY');
        if (scopeRecoveredCode) pushUnique(reasonCodes, scopeRecoveredCode);
        selectedActsSourcesBreakdownFinal = {
          from_taxonomy: uniqueStrings([...selectedActsSourcesBreakdownFinal.from_taxonomy, scopeNreg]),
          from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter(Boolean),
          from_chunks_evidence: selectedActsSourcesBreakdownFinal.from_chunks_evidence.filter(Boolean),
          from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter(Boolean),
        };
      }
    }
    if (hadOutOfScopeActs || selectedActsFinal.length > 0) {
      const summary = summarizeSelectedActs(selectedActsFinal as SelectedActOutput[]);
      selectedActsFinalMeta = {
        ...selectedActsFinalMeta,
        selected_acts_final: selectedActsFinal as SelectedActOutput[],
        selected_acts_confidence_final:
          selectedActsFinal.length > 0
            ? Math.max(
                selectedActsFinalMeta.selected_acts_confidence_final,
                reasonCodes.includes('EMPTY_SELECTED_ACTS_RECOVERED_FROM_TAXONOMY') ? 0.45 : 0.6
              )
            : Math.min(selectedActsFinalMeta.selected_acts_confidence_final, 0.5),
        selected_acts_decision_final: {
          ...selectedActsFinalMeta.selected_acts_decision_final,
          reason_codes: uniqueStrings([
            ...(selectedActsFinalMeta.selected_acts_decision_final.reason_codes ?? []),
            ...(scopeConstraintCode ? [scopeConstraintCode] : []),
            ...(selectedActsFinal.length > 0 && scopeRecoveredCode ? [scopeRecoveredCode] : []),
          ]),
        },
        selected_acts_kinds_count_final: summary.selected_acts_kinds_count,
        selected_acts_document_types_top_final: summary.selected_acts_document_types_top,
      };
    }
  }

  const finalSelectedActNregs = new Set(selectedActsFinal.map((act) => normalizeRadaNreg(act.rada_nreg)).filter(Boolean));
  selectedActsSourcesBreakdownFinal = {
    from_taxonomy: selectedActsSourcesBreakdownFinal.from_taxonomy.filter((radaNreg) =>
      finalSelectedActNregs.has(normalizeRadaNreg(radaNreg))
    ),
    from_acts_search: selectedActsSourcesBreakdownFinal.from_acts_search.filter((radaNreg) =>
      finalSelectedActNregs.has(normalizeRadaNreg(radaNreg))
    ),
    from_chunks_evidence: selectedActsSourcesBreakdownFinal.from_chunks_evidence.filter((radaNreg) =>
      finalSelectedActNregs.has(normalizeRadaNreg(radaNreg))
    ),
    from_routing_hints: selectedActsSourcesBreakdownFinal.from_routing_hints?.filter((radaNreg) =>
      finalSelectedActNregs.has(normalizeRadaNreg(radaNreg))
    ),
  };

  return {
    selectedActsFinal,
    selectedActsSourcesBreakdownFinal,
    selectedActsFinalMeta,
    reasonCodes,
    exactActNregSet,
    exactSingleActConverged,
    groundedActNregSet,
    groundedSingleActConverged,
    explicitActScopeCueQuery,
    metadataSingleActConverged,
    evidenceSingleActConverged,
    evidenceSingleActNreg,
    calendarScopedRecurringActAmbiguous,
    topActCandidate: metadataScopeActCandidate ?? topActCandidate,
  };
}
