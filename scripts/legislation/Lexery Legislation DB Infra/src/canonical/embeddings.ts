/**
 * Embeddings Client — генерація векторних представлень через OpenRouter
 * 
 * Використовує OpenAI text-embedding-3-small (1536 dimensions)
 */

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EXPECTED_DIMENSIONS = 1536;
const EMBEDDING_RETRY_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 700;

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
  model: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Генерує embedding для тексту через OpenRouter
 * 
 * @param text - Текст для embedding
 * @param apiKey - OpenRouter API key
 * @returns Масив чисел (вектор) довжиною 1536
 */
export async function generateEmbedding(
  text: string,
  apiKey: string
): Promise<EmbeddingResult> {
  if (!text || text.trim().length === 0) {
    throw new Error('Текст для embedding не може бути порожнім');
  }

  // OpenRouter підтримує embeddings через стандартний OpenAI-сумісний endpoint
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/legislation-rag',
      'X-Title': 'Legislation RAG',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter API помилка (${response.status}): ${errorText}`
    );
  }

  const data = await response.json() as {
    data?: Array<{ embedding?: number[] }>;
    error?: { message?: string };
  };
  
  if (data.error) {
    throw new Error(`OpenRouter API помилка: ${data.error.message || 'Unknown error'}`);
  }
  
  // OpenRouter повертає структуру: { data: [{ embedding: [...] }] }
  const embedding = data.data?.[0]?.embedding;
  
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Невалідна відповідь від OpenRouter: embedding не знайдено');
  }

  if (embedding.length !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `Невалідна розмірність embedding: очікується ${EXPECTED_DIMENSIONS}, отримано ${embedding.length}`
    );
  }

  return {
    embedding,
    dimensions: embedding.length,
    model: EMBEDDING_MODEL,
  };
}

async function generateEmbeddingWithRetry(
  text: string,
  apiKey: string,
  attempts = EMBEDDING_RETRY_ATTEMPTS
): Promise<EmbeddingResult> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await generateEmbedding(text, apiKey);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts) break;
      await sleep(EMBEDDING_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastError ?? new Error('Embedding retry failed');
}

/**
 * Генерує embeddings для масиву текстів (batch)
 * 
 * @param texts - Масив текстів
 * @param apiKey - OpenRouter API key
 * @param concurrency - Максимальна кількість одночасних запитів (default: 5)
 * @param onProgress - Optional callback для прогресу (batchIndex, totalBatches, processed)
 * @returns Масив результатів embeddings
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  apiKey: string,
  concurrency: number = 5,
  onProgress?: (batchIndex: number, totalBatches: number, processed: number) => void
): Promise<EmbeddingResult[]> {
  const results: Array<EmbeddingResult | undefined> = new Array(texts.length);
  const errors: Array<{ index: number; error: Error }> = [];
  
  const totalBatches = Math.ceil(texts.length / concurrency);
  let processed = 0;

  // Обробляємо батчами з обмеженням concurrency
  for (let i = 0; i < texts.length; i += concurrency) {
    const batch = texts.slice(i, i + concurrency);
    const batchIndex = Math.floor(i / concurrency);
    
    const batchPromises = batch.map(async (text, batchIndex) => {
      const globalIndex = i + batchIndex;
      try {
        // Невелика затримка між запитами для rate limiting
        if (batchIndex > 0) {
          await sleep(100);
        }
        return await generateEmbeddingWithRetry(text, apiKey);
      } catch (error) {
        errors.push({
          index: globalIndex,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    for (let batchOffset = 0; batchOffset < batchResults.length; batchOffset += 1) {
      const result = batchResults[batchOffset];
      if (result.status === 'fulfilled') {
        results[i + batchOffset] = result.value;
        processed++;
      }
    }
    
    // Викликаємо progress callback
    if (onProgress) {
      onProgress(batchIndex + 1, totalBatches, processed);
    }

    // Пауза між батчами
    if (i + concurrency < texts.length) {
      await sleep(500);
    }
  }

  const missingIndexes = results
    .map((item, index) => (item ? -1 : index))
    .filter((index) => index >= 0);

  if (missingIndexes.length > 0) {
    for (const index of missingIndexes) {
      try {
        results[index] = await generateEmbeddingWithRetry(texts[index], apiKey, EMBEDDING_RETRY_ATTEMPTS + 1);
        processed++;
      } catch (error) {
        errors.push({
          index,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  if (errors.length > 0) {
    const uniqueErrors = new Map<number, Error>();
    for (const { index, error } of errors) {
      uniqueErrors.set(index, error);
    }
    console.warn(`⚠️  Помилки при генерації embeddings: ${uniqueErrors.size} з ${texts.length}`);
    uniqueErrors.forEach((error, index) => {
      console.warn(`  [${index}]: ${error.message}`);
    });
  }

  if (results.some((item) => !item)) {
    throw new Error(
      `Не всі embeddings згенеровано: ${results.filter(Boolean).length}/${texts.length}`
    );
  }

  return results as EmbeddingResult[];
}
