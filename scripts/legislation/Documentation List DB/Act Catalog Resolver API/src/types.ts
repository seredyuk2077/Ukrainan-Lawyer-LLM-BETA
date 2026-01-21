export type ResolveMode = 'auto' | 'vector-only' | 'llm-rerank';

export type ActTypeFilter =
  | 'LAW'
  | 'CODE'
  | 'CONSTITUTION'
  | 'RESOLUTION'
  | 'DECREE'
  | 'ORDER'
  | 'VRU_LAW'
  | 'VRU_RESOLUTION'
  | 'KABMIN_RESOLUTION'
  | 'KABMIN_ORDER'
  | 'PRESIDENT_DECREE'
  | 'PRESIDENT_ORDER';

export type ActOrganFilter = 'VRU' | 'KMU' | 'PRESIDENT';

export interface ResolveFilters {
  types?: ActTypeFilter[];
  organs?: ActOrganFilter[];
  year_from?: number;
  year_to?: number;
}

export interface ResolveRequest {
  query: string;
  k?: number;
  candidates?: number;
  lang?: 'uk' | 'ru' | 'en';
  filters?: ResolveFilters;
  mode?: ResolveMode;
  debug?: boolean;
}

export interface ResolveStrategy {
  fast_path: 'nreg_exact' | 'nreg_partial' | 'vector';
  rerank_used: boolean;
  filters_applied: {
    types?: ActTypeFilter[];
    organs?: ActOrganFilter[];
    year_from?: number;
    year_to?: number;
  };
}

export interface ResolveResultItem {
  nreg: string;
  dokid: number;
  nazva: string;
  score: number;
  source_score: number;
  rerank_score?: number;
  why?: string;
}

export interface ResolveResponse {
  query: string;
  normalized_query: string;
  strategy: ResolveStrategy;
  results: ResolveResultItem[];
  meta: {
    candidates_requested: number;
    candidates_actual: number;
    returned: number;
    took_ms: number;
  };
  debug?: Record<string, unknown>;
}

// Qdrant payload schema contract (MUST remain compatible with Full Import / UpdaterDB).
export interface DocCardPayload {
  nreg: string;
  dokid: number;
  nazva: string;
  type: string;
  organ: string;
  status: string;
  year: number | null;
  datred: string | null; // YYYYMMDD
  minjust: boolean;
  source_system: 'rada';
  is_in_supabase: boolean;
  supabase_doc_id: string | null;
  types_raw?: string;
  organs_raw?: string;
}

