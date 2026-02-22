/**
 * Phase 5.2 — Deterministic DEV / HOLDOUT split for retrieval_real_labeled.json
 * Seed: sha256(project + date) so same date = same split. 70% DEV, 30% HOLDOUT.
 */
import { createHash } from 'crypto';

const PROJECT_SEED = 'lexery-legal-agent-phase5';
const DEV_RATIO = 0.7;

export function getSplitSeed(dateStr?: string): string {
  const date = dateStr ?? new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(PROJECT_SEED + date).digest('hex').slice(0, 16);
}

export function stableShuffle<T>(arr: T[], seedHex: string): T[] {
  const out = [...arr];
  const seed = parseInt(seedHex.slice(0, 8), 16) || 1;
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function splitLabeled<T>(rows: T[], seed?: string): { dev: T[]; holdout: T[] } {
  const seedHex = seed ?? getSplitSeed();
  const shuffled = stableShuffle(rows, seedHex);
  const devLen = Math.max(1, Math.floor(shuffled.length * DEV_RATIO));
  return {
    dev: shuffled.slice(0, devLen),
    holdout: shuffled.slice(devLen),
  };
}
