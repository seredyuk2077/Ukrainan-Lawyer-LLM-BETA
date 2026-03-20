import type { RawHit } from './types.js';

export type GoalSupportByAct = Map<string, Set<string>>;

function addGoalSupport(target: GoalSupportByAct, radaNreg: string | null | undefined, goalId: string | null | undefined): void {
  const normalizedNreg = String(radaNreg ?? '').trim();
  const normalizedGoalId = String(goalId ?? '').trim();
  if (!normalizedNreg || !normalizedGoalId) return;
  const existing = target.get(normalizedNreg) ?? new Set<string>();
  existing.add(normalizedGoalId);
  target.set(normalizedNreg, existing);
}

export function buildGoalSupportByActFromHits(hits: RawHit[]): GoalSupportByAct {
  const out: GoalSupportByAct = new Map();
  for (const hit of hits) addGoalSupport(out, hit.rada_nreg, hit.goal_id);
  return out;
}

export function buildGoalSupportByActFromGoalsSummary(
  goalsSummary: Array<{ goal_id: string; act_candidates_top3?: string[] }>
): GoalSupportByAct {
  const out: GoalSupportByAct = new Map();
  for (const goal of goalsSummary) {
    for (const radaNreg of goal.act_candidates_top3 ?? []) addGoalSupport(out, radaNreg, goal.goal_id);
  }
  return out;
}

export function mergeGoalSupportMaps(...maps: GoalSupportByAct[]): GoalSupportByAct {
  const out: GoalSupportByAct = new Map();
  for (const map of maps) {
    for (const [radaNreg, goalIds] of map.entries()) {
      for (const goalId of goalIds) addGoalSupport(out, radaNreg, goalId);
    }
  }
  return out;
}

export function serializeGoalSupportMap(map: GoalSupportByAct): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [radaNreg, goalIds] of map.entries()) {
    const serialized = [...goalIds].sort();
    if (serialized.length > 0) out[radaNreg] = serialized;
  }
  return out;
}

export function deserializeGoalSupportMap(
  serialized: Record<string, string[]> | undefined | null
): GoalSupportByAct {
  const out: GoalSupportByAct = new Map();
  if (!serialized) return out;
  for (const [radaNreg, goalIds] of Object.entries(serialized)) {
    for (const goalId of goalIds) addGoalSupport(out, radaNreg, goalId);
  }
  return out;
}

export function collectCoveredGoalIdsForActs(
  acts: Array<{ rada_nreg: string }>,
  goalSupportByAct: GoalSupportByAct
): Set<string> {
  const coveredGoalIds = new Set<string>();
  for (const act of acts) {
    const goalIds = goalSupportByAct.get(act.rada_nreg);
    if (!goalIds) continue;
    for (const goalId of goalIds) coveredGoalIds.add(goalId);
  }
  return coveredGoalIds;
}

export function countGoalSupportSignals(goalSupportByAct: GoalSupportByAct): number {
  let total = 0;
  for (const goalIds of goalSupportByAct.values()) total += goalIds.size;
  return total;
}
