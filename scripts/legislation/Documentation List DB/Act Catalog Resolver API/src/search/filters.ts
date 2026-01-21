import type { ActOrganFilter, ActTypeFilter, ResolveFilters } from '../types';

export interface AppliedFilters {
  types?: ActTypeFilter[];
  organs?: ActOrganFilter[];
  year_from?: number;
  year_to?: number;
}

export interface QdrantFilterResult {
  qdrantFilter: any | null;
  applied: AppliedFilters;
  debug?: {
    type_codes?: string[];
    organ_codes?: string[];
  };
}

export const ORGAN_CODE: Record<ActOrganFilter, string> = {
  VRU: '1',
  KMU: '2',
  PRESIDENT: '4',
};

// Minimal type codes we confirmed via live Rada card samples.
export const TYPE_CODE = {
  LAW: ['1', '21', '216'], // include codes & constitution as "law-ish" for recall
  CODE: ['21'],
  CONSTITUTION: ['216'],
  RESOLUTION: ['2'],
  DECREE: ['3'],
  ORDER: ['6'],
} as const;

function expandTypeFilter(t: ActTypeFilter): { typeCodes: string[]; organCodes?: string[] } {
  switch (t) {
    case 'LAW':
      return { typeCodes: [...TYPE_CODE.LAW] };
    case 'CODE':
      return { typeCodes: [...TYPE_CODE.CODE] };
    case 'CONSTITUTION':
      return { typeCodes: [...TYPE_CODE.CONSTITUTION] };
    case 'RESOLUTION':
      return { typeCodes: [...TYPE_CODE.RESOLUTION] };
    case 'DECREE':
      return { typeCodes: [...TYPE_CODE.DECREE] };
    case 'ORDER':
      return { typeCodes: [...TYPE_CODE.ORDER] };
    case 'VRU_LAW':
      return { typeCodes: [...TYPE_CODE.LAW], organCodes: [ORGAN_CODE.VRU] };
    case 'VRU_RESOLUTION':
      return { typeCodes: [...TYPE_CODE.RESOLUTION], organCodes: [ORGAN_CODE.VRU] };
    case 'KABMIN_RESOLUTION':
      return { typeCodes: [...TYPE_CODE.RESOLUTION], organCodes: [ORGAN_CODE.KMU] };
    case 'KABMIN_ORDER':
      return { typeCodes: [...TYPE_CODE.ORDER], organCodes: [ORGAN_CODE.KMU] };
    case 'PRESIDENT_DECREE':
      return { typeCodes: [...TYPE_CODE.DECREE], organCodes: [ORGAN_CODE.PRESIDENT] };
    case 'PRESIDENT_ORDER':
      return { typeCodes: [...TYPE_CODE.ORDER], organCodes: [ORGAN_CODE.PRESIDENT] };
    default:
      return { typeCodes: [] };
  }
}

function clampYear(y: number | undefined): number | undefined {
  if (y === undefined) return undefined;
  if (!Number.isFinite(y)) return undefined;
  if (y < 1800) return 1800;
  if (y > 2100) return 2100;
  return Math.trunc(y);
}

export function buildQdrantFilterFromFilters(filters: ResolveFilters | undefined): QdrantFilterResult {
  const applied: AppliedFilters = {};
  const typeCodes = new Set<string>();
  const organCodes = new Set<string>();

  const yearFrom = clampYear(filters?.year_from);
  const yearTo = clampYear(filters?.year_to);

  if (filters?.types?.length) {
    applied.types = filters.types;
    for (const t of filters.types) {
      const exp = expandTypeFilter(t);
      for (const c of exp.typeCodes) typeCodes.add(String(c));
      for (const oc of exp.organCodes || []) organCodes.add(String(oc));
    }
  }

  if (filters?.organs?.length) {
    applied.organs = filters.organs;
    for (const o of filters.organs) organCodes.add(ORGAN_CODE[o]);
  }

  if (yearFrom !== undefined) applied.year_from = yearFrom;
  if (yearTo !== undefined) applied.year_to = yearTo;

  const must: any[] = [];

  if (typeCodes.size > 0) {
    const arr = Array.from(typeCodes);
    must.push(arr.length === 1 ? { key: 'type', match: { value: arr[0] } } : { key: 'type', match: { any: arr } });
  }

  if (organCodes.size > 0) {
    const arr = Array.from(organCodes);
    must.push(arr.length === 1 ? { key: 'organ', match: { value: arr[0] } } : { key: 'organ', match: { any: arr } });
  }

  if (yearFrom !== undefined || yearTo !== undefined) {
    must.push({
      key: 'year',
      range: {
        ...(yearFrom !== undefined ? { gte: yearFrom } : {}),
        ...(yearTo !== undefined ? { lte: yearTo } : {}),
      },
    });
  }

  const qdrantFilter = must.length > 0 ? { must } : null;
  return {
    qdrantFilter,
    applied,
    debug: {
      type_codes: typeCodes.size ? Array.from(typeCodes) : undefined,
      organ_codes: organCodes.size ? Array.from(organCodes) : undefined,
    },
  };
}

export function humanizeTypeCode(code: string): string {
  switch (String(code)) {
    case '1':
      return 'Закон';
    case '2':
      return 'Постанова';
    case '3':
      return 'Указ';
    case '6':
      return 'Розпорядження';
    case '21':
      return 'Кодекс';
    case '216':
      return 'Конституція';
    default:
      return `Тип(${code})`;
  }
}

export function humanizeOrganCode(code: string): string {
  switch (String(code)) {
    case '1':
      return 'ВРУ';
    case '2':
      return 'КМУ';
    case '4':
      return 'Президент';
    default:
      return `Орган(${code})`;
  }
}

