/**
 * Qdrant Admin helpers for Legislation RAG collections.
 * Використовує delete/count по filter rada_nreg.
 */
import dotenv from 'dotenv';
import { resolve } from 'path';
import { QdrantClient } from '@qdrant/js-client-rest';

dotenv.config({ path: resolve(process.cwd(), '.env') });

export const QDRANT_COLLECTION_CHUNKS = 'lexery_legislation_chunks';
export const QDRANT_COLLECTION_ACTS = 'lexery_legislation_acts';

export function createQdrantClient(): QdrantClient {
  const url = process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB;
  const apiKey = process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB;
  if (!url) throw new Error('qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB не встановлено');
  if (!apiKey) throw new Error('qdrant_clusterAPI_LEXERY_LEGISLATION_DB не встановлено');
  return new QdrantClient({ url: url.replace(/\/+$/, ''), apiKey, checkCompatibility: false });
}

export async function countByNreg(client: QdrantClient, collection: string, radaNreg: string): Promise<number> {
  const res = await client.count(collection, {
    exact: true,
    filter: { must: [{ key: 'rada_nreg', match: { value: radaNreg } }] },
  } as any);
  const count = (res as any)?.count;
  return typeof count === 'number' ? count : 0;
}

export async function deleteByNreg(client: QdrantClient, collection: string, radaNreg: string): Promise<void> {
  await client.delete(collection, {
    wait: true,
    filter: { must: [{ key: 'rada_nreg', match: { value: radaNreg } }] },
  } as any);
}

