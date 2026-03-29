import {
  getActMeta,
  type TaxonomyHintsUsed,
} from './act-taxonomy-store.js';
import { isProcedureCategory } from './goal-splitter.js';
import {
  classifyActKind,
  type SelectedActOutput,
} from './selected-acts.js';

export type RetrievalEntityInput =
  | { act_abbrev?: string; law_title?: string; article_ref?: string }
  | { type?: string; value?: string };

export type NormalizedRetrievalEntity = {
  act_abbrev?: string;
  law_title?: string;
  article_ref?: string;
};

export function toLldbiHintsUsed(
  hu: TaxonomyHintsUsed | undefined
): { categories_used_count: number; doc_types_used_count: number; injected_acts_count: number } | undefined {
  if (!hu) return undefined;
  const categories_used_count = hu.categories_used?.length ?? 0;
  const doc_types_used_count = hu.document_types_used?.length ?? 0;
  const injected_acts_count =
    (hu.injected_counts?.by_category_hints ?? 0) + (hu.injected_counts?.by_doc_type_hints ?? 0);
  if (categories_used_count === 0 && doc_types_used_count === 0 && injected_acts_count === 0) {
    return undefined;
  }
  return { categories_used_count, doc_types_used_count, injected_acts_count };
}

export function hasMixedProcedureAndNonProcedureGoals(
  goalsSummary: Array<{ goal_type?: string }>
): boolean {
  const goalTypes = new Set(
    goalsSummary
      .map((goal) => String(goal.goal_type ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  return goalTypes.has('procedure') && [...goalTypes].some((goalType) => goalType !== 'procedure');
}

export function normalizeRetrievalEntities(
  entities: RetrievalEntityInput[] | undefined
): NormalizedRetrievalEntity[] {
  const normalized: NormalizedRetrievalEntity[] = [];
  for (const entity of entities ?? []) {
    if (!entity || typeof entity !== 'object') continue;
    if ('act_abbrev' in entity || 'law_title' in entity || 'article_ref' in entity) {
      normalized.push({
        act_abbrev: entity.act_abbrev?.trim(),
        law_title: entity.law_title?.trim(),
        article_ref: entity.article_ref?.trim(),
      });
      continue;
    }
    if (!('type' in entity) || !('value' in entity) || typeof entity.value !== 'string') continue;
    if (entity.type === 'act_abbrev') normalized.push({ act_abbrev: entity.value.trim() });
    else if (entity.type === 'law_title') normalized.push({ law_title: entity.value.trim() });
    else if (entity.type === 'article_ref') normalized.push({ article_ref: entity.value.trim() });
  }
  return normalized.filter((entity) => entity.act_abbrev || entity.law_title || entity.article_ref);
}

export async function prioritizeProcedureActs(nregs: string[]): Promise<string[]> {
  if (nregs.length <= 1) return nregs;
  const metas = await Promise.all(nregs.map((nreg) => getActMeta(nreg)));
  const aligned: string[] = [];
  const other: string[] = [];
  for (let index = 0; index < nregs.length; index += 1) {
    if (isProcedureCategory(metas[index]?.category)) aligned.push(nregs[index]);
    else other.push(nregs[index]);
  }
  return [...aligned, ...other];
}

/**
 * Selected acts are built from retrieval evidence first; this late pass hydrates
 * any missing LLDBI metadata so downstream policy and writer logic see a stable shape.
 */
export async function hydrateSelectedActsMeta(
  acts: SelectedActOutput[],
  confidence: number | undefined
): Promise<
  Array<{
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
  }>
> {
  const out: Array<{
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
  }> = [];

  for (const act of acts) {
    let document_type: string | null | undefined = act.document_type;
    let category: string | null | undefined = act.category;
    let storage_category: string | null | undefined = act.storage_category;
    let act_kind = act.act_kind;

    if (!document_type || !category || storage_category == null || !act_kind || act_kind === 'UNKNOWN') {
      const meta = await getActMeta(act.rada_nreg);
      if (meta) {
        const typedMeta = meta as {
          document_type?: string | null;
          category?: string | null;
          storage_category?: string | null;
          title?: string;
          document_type_slug?: string | null;
        };
        if (!document_type) document_type = typedMeta.document_type ?? null;
        if (!category) category = typedMeta.category ?? null;
        if (storage_category == null) storage_category = typedMeta.storage_category ?? null;
        if (!act_kind || act_kind === 'UNKNOWN') {
          act_kind = classifyActKind(
            typedMeta.title ?? act.act_title ?? '',
            typedMeta.document_type,
            typedMeta.category,
            typedMeta.document_type_slug
          );
        }
      } else {
        if (storage_category == null) storage_category = null;
        if (!act_kind) act_kind = 'UNKNOWN';
      }
    }

    out.push({
      rada_nreg: act.rada_nreg,
      act_title: act.act_title,
      score: act.score,
      why_selected: act.why_selected,
      reason_tag: act.reason_tag,
      source_tags: act.source_tags,
      document_type,
      category,
      storage_category,
      act_kind,
      flags: act.flags,
      confidence,
    });
  }

  return out;
}
