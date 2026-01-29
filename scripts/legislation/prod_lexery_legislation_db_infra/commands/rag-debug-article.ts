/**
 * RAG Debug Article — детальна перевірка конкретної статті
 * 
 * Перевіряє:
 * - Чи правильно індексована стаття 115 в Qdrant
 * - Чи правильний текст у chunk'ів
 * - Чи правильний article_number в payload
 */

import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { generateEmbedding } from '../canonical/embeddings.js';

/**
 * Детальна перевірка статті
 */
export async function ragDebugArticle(nreg: string, articleNumber: string): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`RAG Debug Article — ${nreg} ст.${articleNumber}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, r2_key, content_hash')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // Отримуємо canonical з R2
  const canonical = await getJsonFromR2(doc.r2_key || '');
  
  // Знаходимо статтю в canonical
  const articles = canonical.content.articles || [];
  const article = articles.find((a: any) => a.number === articleNumber);
  
  if (!article) {
    throw new Error(`Article ${articleNumber} not found in canonical`);
  }
  
  console.log(`📋 Canonical Article ${articleNumber}:`);
  console.log(`   Title: ${article.title}`);
  console.log(`   Content preview: ${article.content.substring(0, 200)}...`);
  console.log(`   Content length: ${article.content.length} chars\n`);
  
  // Отримуємо chunks з Qdrant для цієї статті
  const qdrant = createQdrantClient();
  const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
        { key: 'article_number', match: { value: articleNumber } },
      ],
    },
    limit: 100,
    with_payload: true,
    with_vector: false,
  } as any);
  
  const qdrantChunks = (chunksScroll as any).points || [];
  
  console.log(`📦 Qdrant Chunks для ст.${articleNumber}:`);
  console.log(`   Count: ${qdrantChunks.length}`);
  
  for (let i = 0; i < Math.min(3, qdrantChunks.length); i++) {
    const point = qdrantChunks[i];
    const payload = point.payload as any;
    console.log(`\n   Chunk ${i + 1}:`);
    console.log(`      chunk_index: ${payload.chunk_index}`);
    console.log(`      article_number: ${payload.article_number || 'NULL'}`);
    console.log(`      unit_number: ${payload.unit_number || 'NULL'}`);
    console.log(`      unit_type: ${payload.unit_type || 'NULL'}`);
    
    // Витягуємо текст з canonical
    const canonicalChunk = canonical.content.chunks?.[payload.chunk_index];
    if (canonicalChunk) {
      console.log(`      text_preview: ${canonicalChunk.text.substring(0, 150)}...`);
    }
  }
  
  // Перевіряємо сусідні статті
  const prevArticleNum = String(parseInt(articleNumber) - 1);
  const nextArticleNum = String(parseInt(articleNumber) + 1);
  
  console.log(`\n🔍 Перевірка сусідніх статей:\n`);
  
  // Ст.114
  const prevChunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
        { key: 'article_number', match: { value: prevArticleNum } },
      ],
    },
    limit: 5,
    with_payload: true,
    with_vector: false,
  } as any);
  
  console.log(`   Ст.${prevArticleNum} chunks: ${((prevChunks as any).points || []).length}`);
  
  // Ст.116
  const nextChunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
        { key: 'article_number', match: { value: nextArticleNum } },
      ],
    },
    limit: 5,
    with_payload: true,
    with_vector: false,
  } as any);
  
  console.log(`   Ст.${nextArticleNum} chunks: ${((nextChunks as any).points || []).length}`);
  
  // Тест retrieval
  console.log(`\n🔍 Retrieval Test:\n`);
  
  const apiKey = process.env.OPEN_ROUTER_API_RAG || process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_RAG або OPEN_ROUTER_API_KEY не встановлено');
  }
  
  const query = 'умисне вбивство';
  const embeddingResult = await generateEmbedding(query, apiKey);
  const queryEmbedding = embeddingResult.embedding;
  
  const searchResults = await qdrant.search(QDRANT_COLLECTION_CHUNKS, {
    vector: queryEmbedding,
    limit: 10,
    filter: {
      must: [
        { key: 'rada_nreg', match: { value: nreg } },
        { key: 'content_hash', match: { value: doc.content_hash } },
      ],
    },
    with_payload: true,
    with_vector: false,
  } as any);
  
  console.log(`   Query: "${query}"`);
  console.log(`   Top 10 results:\n`);
  
  for (let i = 0; i < Math.min(10, (searchResults || []).length); i++) {
    const result = searchResults[i];
    const payload = result.payload as any;
    const artNum = payload.article_number || payload.unit_number || 'NULL';
    const score = typeof result.score === 'number' ? result.score : 0;
    
    const canonicalChunk = canonical.content.chunks?.[payload.chunk_index];
    const textPreview = canonicalChunk?.text?.substring(0, 100) || '';
    
    const marker = artNum === articleNumber ? '✅' : (artNum === nextArticleNum ? '❌' : '  ');
    console.log(`   ${marker} [${i + 1}] ст.${artNum} (score=${score.toFixed(4)})`);
    console.log(`      chunk_index: ${payload.chunk_index}`);
    console.log(`      text: ${textPreview}...`);
  }
}
