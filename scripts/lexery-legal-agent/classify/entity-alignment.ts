import type { ExtractedEntity } from './types.js';

function normalizeLoose(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[«»"'`]/g, ' ')
    .replace(/[\s()]+/g, ' ')
    .trim();
}

function normalizeCompact(value: string | null | undefined): string {
  return normalizeLoose(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenizeLoose(value: string | null | undefined): string[] {
  return normalizeLoose(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4);
}

function sanitizeCitationAtom(value: string | null | undefined): string | undefined {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^0-9a-zа-яіїєґ.-]+/giu, '')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function entityKey(entity: ExtractedEntity): string {
  return `${entity.type}:${normalizeLoose(entity.value)}`;
}

function articleSignature(entity: ExtractedEntity): string | null {
  if (entity.type !== 'article_ref') return null;
  const article = sanitizeCitationAtom(entity.norm?.article);
  if (!article) return null;
  const part = sanitizeCitationAtom(entity.norm?.part);
  return part ? `${article}|${part}` : article;
}

function queryContainsEntitySurface(query: string, entity: ExtractedEntity): boolean {
  const queryLoose = normalizeLoose(query);
  const queryCompact = normalizeCompact(query);
  const entityLoose = normalizeLoose(entity.value);
  const entityCompact = normalizeCompact(entity.value);

  if (entityLoose && queryLoose.includes(entityLoose)) return true;
  if (entityCompact && queryCompact.includes(entityCompact)) return true;

  if (entity.type === 'act_abbrev') {
    const actTitleLoose = normalizeLoose(entity.norm?.act);
    const actTitleCompact = normalizeCompact(entity.norm?.act);
    if (actTitleLoose && queryLoose.includes(actTitleLoose)) return true;
    if (actTitleCompact && queryCompact.includes(actTitleCompact)) return true;
  }

  return false;
}

function hasAlignedPreLawTitle(preEntities: ExtractedEntity[], entity: ExtractedEntity): boolean {
  if (entity.type !== 'law_title') return false;
  const entityCompact = normalizeCompact(entity.value);
  const entityTokens = new Set(tokenizeLoose(entity.value));
  if (!entityCompact) return false;
  return preEntities.some((candidate) => {
    if (candidate.type !== 'law_title') return false;
    const candidateCompact = normalizeCompact(candidate.value);
    const overlap = tokenizeLoose(candidate.value).filter((token) => entityTokens.has(token)).length;
    return (
      candidateCompact === entityCompact ||
      candidateCompact.includes(entityCompact) ||
      entityCompact.includes(candidateCompact) ||
      overlap >= 2
    );
  });
}

function isSurfaceAlignedStructuralEntity(
  query: string,
  preEntities: ExtractedEntity[],
  entity: ExtractedEntity
): boolean {
  const queryHasArticleCue = /(?:^|[\s\W])(?:ст\.?|статт(?:я|і|ю|ею)|ч\.?|частин(?:а|и|і|ою)|п\.?|пункт(?:а|у|ом|і)?)(?:[\s\W]|$)/iu.test(
    query
  );
  const preEntityKeys = new Set(preEntities.map(entityKey));
  const preArticleSignatures = new Set(
    preEntities
      .map((candidate) => articleSignature(candidate))
      .filter((candidate): candidate is string => Boolean(candidate))
  );

  if (preEntityKeys.has(entityKey(entity))) return true;
  if (hasAlignedPreLawTitle(preEntities, entity)) return true;

  if (entity.type === 'article_ref') {
    const signature = articleSignature(entity);
    if (!queryHasArticleCue) return false;
    if (!signature) return false;
    if (preArticleSignatures.has(signature)) return true;
    return queryContainsEntitySurface(query, entity);
  }

  if (entity.type === 'act_abbrev' || entity.type === 'law_title' || entity.type === 'authority') {
    return queryContainsEntitySurface(query, entity);
  }

  return true;
}

export function alignLlmEntitiesToSurface(
  query: string,
  preEntities: ExtractedEntity[],
  llmEntities: ExtractedEntity[]
): ExtractedEntity[] {
  return llmEntities.filter((entity) => isSurfaceAlignedStructuralEntity(query, preEntities, entity));
}
