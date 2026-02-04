/**
 * RAG Sanity Article Test — перевірка retrieval для конкретної статті
 * 
 * Формує запит: "ККУ стаття 115 умисне вбивство"
 * Робить vector search в Qdrant
 * Перевіряє, що серед topK є chunk(и) з payload unit_number=115
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { generateEmbedding } from '../canonical/embeddings.js';

interface RAGSanityResult {
  nreg: string;
  article_number: string;
  query: string;
  topK: number;
  results: Array<{
    chunk_index: number;
    article_number: string | null;
    unit_number: string | null;
    score: number;
    text_preview: string;
  }>;
  has_correct_article: boolean;
  top_result_article_number: string | null;
  potential_shift: string | null;
}

/**
 * Перевіряє RAG retrieval для конкретної статті
 */
export async function ragSanityArticle(options: {
  nreg: string;
  article: string;
  query?: string;
  topK?: number;
}): Promise<RAGSanityResult> {
  const { nreg, article, query, topK = 5 } = options;
  
  // Формуємо запит
  const searchQuery = query || `ККУ стаття ${article} умисне вбивство`;
  
  // Отримуємо API key з .env
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');
  }
  
  // Отримуємо embedding для запиту
  const embeddingResult = await generateEmbedding(searchQuery, apiKey);
  const queryEmbedding = embeddingResult.embedding;
  
  // Отримуємо з Supabase
  const supabase = createSupabaseAdminClient();
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, content_hash')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // Робимо vector search в Qdrant
  const qdrant = createQdrantClient();
  const searchResults = await qdrant.search(QDRANT_COLLECTION_CHUNKS, {
    vector: queryEmbedding,
    limit: topK,
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
      ],
    },
    with_payload: true,
    with_vector: false,
  } as any);
  
  // Обробляємо результати
  const results = (searchResults || []).map((result: any) => ({
    chunk_index: result.payload?.chunk_index || -1,
    article_number: result.payload?.article_number || null,
    unit_number: result.payload?.unit_number || null,
    score: typeof result.score === 'number' ? result.score : 0,
    text_preview: '', // Треба витягти з R2 по json_path
  }));
  
  // Витягуємо текст з canonical для результатів
  try {
    const { getJsonFromR2 } = await import('../lib/r2Json.js');
    const canonical = await getJsonFromR2(doc.r2_key || '');
    
    for (const result of results) {
      const chunk = canonical.content?.chunks?.[result.chunk_index];
      if (chunk) {
        result.text_preview = (chunk.text || '').substring(0, 400);
      }
    }
  } catch (e) {
    // Пропускаємо якщо не вдалося прочитати R2
  }
  
  // Перевірка: чи є правильна стаття в результатах
  const hasCorrectArticle = results.some(r => 
    r.article_number === article || r.unit_number === article
  );
  
  const topResult = results[0];
  const topResultArticleNumber = topResult?.article_number || topResult?.unit_number || null;
  
  let potentialShift: string | null = null;
  if (!hasCorrectArticle && topResultArticleNumber) {
    const topNum = parseInt(topResultArticleNumber || '0', 10);
    const expectedNum = parseInt(article || '0', 10);
    if (!isNaN(topNum) && !isNaN(expectedNum)) {
      if (Math.abs(topNum - expectedNum) === 1) {
        potentialShift = `Top result has article_number=${topResultArticleNumber}, expected=${article} (off-by-one shift)`;
      } else if (topNum !== expectedNum) {
        potentialShift = `Top result has article_number=${topResultArticleNumber}, expected=${article} (mismatch)`;
      }
    }
  }
  
  return {
    nreg,
    article_number: article,
    query: searchQuery,
    topK,
    results,
    has_correct_article: hasCorrectArticle,
    top_result_article_number: topResultArticleNumber,
    potential_shift: potentialShift,
  };
}

/**
 * Головна функція — RAG sanity test для статей
 */
export async function ragSanityArticleCLI(options: {
  nreg: string;
  article: string;
  query?: string;
  topK?: number;
}): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`RAG Sanity Article Test — ${options.nreg} стаття ${options.article}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  try {
    const result = await ragSanityArticle(options);
    
    console.log(`Query: "${result.query}"`);
    console.log(`TopK: ${result.topK}\n`);
    
    console.log(`Results:`);
    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  [${i + 1}] score=${r.score.toFixed(4)}`);
      console.log(`      chunk_index: ${r.chunk_index}`);
      console.log(`      article_number: ${r.article_number || 'NULL'}`);
      console.log(`      unit_number: ${r.unit_number || 'NULL'}`);
      console.log(`      text_preview: ${r.text_preview.substring(0, 100)}...`);
    }
    
    console.log(`\n✅ Has correct article: ${result.has_correct_article}`);
    console.log(`   Top result article_number: ${result.top_result_article_number || 'NULL'}`);
    
    if (result.potential_shift) {
      console.log(`\n❌ Potential shift: ${result.potential_shift}`);
    } else {
      console.log(`\n✅ No shift detected`);
    }
  } catch (e) {
    console.error(`❌ Error: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
