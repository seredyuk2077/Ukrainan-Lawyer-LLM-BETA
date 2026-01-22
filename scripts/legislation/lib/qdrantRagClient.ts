/**
 * Qdrant RAG Client — клієнт для роботи з Qdrant RAG колекціями
 * 
 * Підтримує:
 * - lexery_legislation_chunks (точний пошук норм)
 * - lexery_legislation_acts (абстрактний пошук актів)
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { qdrantActId, qdrantChunkId } from './qdrantIds.js';

dotenv.config({ path: resolve(process.cwd(), '.env') });

const COLLECTION_CHUNKS = 'lexery_legislation_chunks';
const COLLECTION_ACTS = 'lexery_legislation_acts';
const VECTOR_SIZE = 1536;

export interface ChunkPayload {
  rada_nreg: string;
  content_hash: string;
  chunk_index: number;
  article_number: string | null;
  token_count: number | null;
  r2_key: string;
  json_path: string;
  category: string;
  document_type: string;
  document_type_slug?: string; // PHASE 14: стандартизований EN slug
  rada_datred: string;
  title: string;
  source_url: string;
  previous_hash: string | null;
  // Act Group fields (PHASE 5)
  act_group_key?: string | null;
  act_part_label?: string | null;
}

export interface ActPayload {
  rada_nreg: string;
  content_hash: string;
  previous_hash: string | null;
  title: string;
  category: string;
  document_type: string;
  document_type_slug?: string; // PHASE 14: стандартизований EN slug
  rada_datred: string;
  source_url: string;
  r2_key: string;
  summary: string;
  keywords: string[];
  topics: string[];
  aliases: string[];
  // Act Group fields (PHASE 5)
  act_group_key?: string | null;
  act_part_label?: string | null;
}

export function generateChunkPointId(radaNreg: string, contentHash: string, chunkIndex: number): string {
  return qdrantChunkId({ radaNreg, contentHash, chunkIndex });
}

export function generateActPointId(radaNreg: string, contentHash: string): string {
  return qdrantActId({ radaNreg, contentHash });
}

export class QdrantRagClient {
  private client: QdrantClient;

  constructor() {
    const url = process.env.qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB;
    const apiKey = process.env.qdrant_clusterAPI_LEXERY_LEGISLATION_DB;

    if (!url) {
      throw new Error('qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB не встановлено');
    }
    if (!apiKey) {
      throw new Error('qdrant_clusterAPI_LEXERY_LEGISLATION_DB не встановлено');
    }

    this.client = new QdrantClient({
      url: url.replace(/\/+$/, ''),
      apiKey,
      checkCompatibility: false,
    });
  }

  /**
   * Upsert chunks в Qdrant
   * 
   * @param chunks - Масив chunks для upsert
   * @param onProgress - Optional callback для прогресу (batchIndex, totalBatches)
   */
  async upsertChunks(
    chunks: Array<{
      payload: ChunkPayload;
      vector: number[];
    }>,
    onProgress?: (batchIndex: number, totalBatches: number) => void
  ): Promise<void> {
    if (chunks.length === 0) return;

    const points = chunks.map(chunk => ({
      id: generateChunkPointId(chunk.payload.rada_nreg, chunk.payload.content_hash, chunk.payload.chunk_index),
      vector: chunk.vector,
      payload: chunk.payload,
    }));

    // Batch upsert (Qdrant підтримує до 100 points за раз)
    const batchSize = 100;
    const totalBatches = Math.ceil(points.length / batchSize);
    
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize) + 1;
      
      await this.client.upsert(COLLECTION_CHUNKS, {
        wait: true,
        points: batch,
      });
      
      // Викликаємо progress callback
      if (onProgress) {
        onProgress(batchIndex, totalBatches);
      }
    }
  }

  /**
   * Upsert act в Qdrant
   */
  async upsertAct(
    payload: ActPayload,
    vector: number[]
  ): Promise<void> {
    const pointId = generateActPointId(payload.rada_nreg, payload.content_hash);

    await this.client.upsert(COLLECTION_ACTS, {
      wait: true,
      points: [{
        id: pointId,
        vector,
        payload,
      }],
    });
  }

  /**
   * Видаляє всі points для документа за rada_nreg та content_hash
   */
  async deleteDocument(radaNreg: string, contentHash: string): Promise<{ chunksDeleted: number; actsDeleted: number }> {
    const filter = {
      must: [
        { key: 'rada_nreg', match: { value: radaNreg } },
        { key: 'content_hash', match: { value: contentHash } },
      ],
    };

    // Видаляємо chunks
    const chunksResult = await this.client.delete(COLLECTION_CHUNKS, {
      wait: true,
      filter,
    });

    // Видаляємо act
    const actsResult = await this.client.delete(COLLECTION_ACTS, {
      wait: true,
      filter,
    });

    return {
      chunksDeleted: chunksResult.operation_id ? 1 : 0, // Qdrant не повертає точну кількість
      actsDeleted: actsResult.operation_id ? 1 : 0,
    };
  }

  /**
   * Підраховує кількість points для документа
   */
  async countDocument(radaNreg: string, contentHash: string): Promise<{ chunks: number; acts: number }> {
    const filter = {
      must: [
        { key: 'rada_nreg', match: { value: radaNreg } },
        { key: 'content_hash', match: { value: contentHash } },
      ],
    };

    const chunksCountRes = await this.client.count(COLLECTION_CHUNKS, { filter, exact: true } as any);
    const actsCountRes = await this.client.count(COLLECTION_ACTS, { filter, exact: true } as any);

    return {
      chunks: (chunksCountRes as any)?.count || 0,
      acts: (actsCountRes as any)?.count || 0,
    };
  }

  /**
   * Видаляє всі points для документа за rada_nreg (всі версії)
   */
  async deleteDocumentAllVersions(radaNreg: string): Promise<void> {
    const filter = {
      must: [
        { key: 'rada_nreg', match: { value: radaNreg } },
      ],
    };

    await this.client.delete(COLLECTION_CHUNKS, {
      wait: true,
      filter,
    });

    await this.client.delete(COLLECTION_ACTS, {
      wait: true,
      filter,
    });
  }
}
