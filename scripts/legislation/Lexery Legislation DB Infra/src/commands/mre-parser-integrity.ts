/**
 * MRE (Minimal Reproducible Example) для Parser Integrity
 * 
 * Перевіряє 5 статей (1, 2, 10, 115, 116) для ККУ та КУпАП:
 * - canonical structure (articles/units)
 * - Qdrant payload (article_number)
 * - Текст chunk (перші 200-400 символів)
 * - Звіряє чи немає зсуву
 */

import { resolve } from 'path';
import { workspaceRoot } from '../lib/config.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';

interface MREArticleCheck {
  nreg: string;
  article_number: string;
  canonical: {
    article_exists: boolean;
    article_title: string | null;
    article_content_preview: string | null;
    article_index: number | null;
  };
  qdrant: {
    chunks_count: number;
    chunks_sample: Array<{
      chunk_index: number;
      article_number: string | null;
      text_preview: string;
      payload_article_number: string | null;
    }>;
  };
  consistency: {
    canonical_has_article: boolean;
    qdrant_has_chunks: boolean;
    article_number_matches: boolean;
    potential_shift: string | null;
  };
}

/**
 * Перевіряє одну статтю для документа
 */
async function checkArticleMRE(nreg: string, articleNumber: string): Promise<MREArticleCheck | null> {
  const supabase = createSupabaseAdminClient();
  
  // Отримуємо з Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg, title, r2_key, content_hash')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    return null;
  }
  
  // Отримуємо canonical з R2
  let canonical: any = null;
  try {
    if (doc.r2_key) {
      canonical = await getJsonFromR2(doc.r2_key);
    }
  } catch (e) {
    return null;
  }
  
  if (!canonical || !canonical.content) {
    return null;
  }
  
  // Знаходимо статтю в canonical
  const articles = canonical.content.articles || [];
  const article = articles.find((a: any) => a.number === articleNumber);
  
  const canonicalCheck = {
    article_exists: !!article,
    article_title: article?.title || null,
    article_content_preview: article?.content ? article.content.substring(0, 400) : null,
    article_index: article ? articles.indexOf(article) : null,
  };
  
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
    limit: 10,
    with_payload: true,
    with_vector: false,
  } as any);
  
  const qdrantChunks = (chunksScroll as any).points || [];
  
  const qdrantCheck = {
    chunks_count: qdrantChunks.length,
    chunks_sample: qdrantChunks.slice(0, 3).map((point: any) => ({
      chunk_index: point.payload?.chunk_index || -1,
      article_number: point.payload?.article_number || null,
      text_preview: '', // Треба витягти з R2 по json_path
      payload_article_number: point.payload?.article_number || null,
    })),
  };
  
  // Витягуємо текст з canonical для chunks
  for (const chunkSample of qdrantCheck.chunks_sample) {
    const jsonPath = `$.content.chunks[${chunkSample.chunk_index}].text`;
    const chunk = canonical.content.chunks?.[chunkSample.chunk_index];
    if (chunk) {
      chunkSample.text_preview = (chunk.text || '').substring(0, 400);
    }
  }
  
  // Перевірка консистентності
  const consistency = {
    canonical_has_article: canonicalCheck.article_exists,
    qdrant_has_chunks: qdrantCheck.chunks_count > 0,
    article_number_matches: qdrantCheck.chunks_sample.every(c => c.payload_article_number === articleNumber),
    potential_shift: null as string | null,
  };
  
  // Перевірка на зсув
  if (canonicalCheck.article_exists && qdrantCheck.chunks_count > 0) {
    const mismatched = qdrantCheck.chunks_sample.find(c => c.payload_article_number !== articleNumber);
    if (mismatched) {
      consistency.potential_shift = `Chunk ${mismatched.chunk_index} has article_number=${mismatched.payload_article_number}, expected=${articleNumber}`;
    }
  } else if (!canonicalCheck.article_exists && qdrantCheck.chunks_count > 0) {
    consistency.potential_shift = `Canonical has no article ${articleNumber}, but Qdrant has ${qdrantCheck.chunks_count} chunks`;
  } else if (canonicalCheck.article_exists && qdrantCheck.chunks_count === 0) {
    consistency.potential_shift = `Canonical has article ${articleNumber}, but Qdrant has no chunks`;
  }
  
  return {
    nreg,
    article_number: articleNumber,
    canonical: canonicalCheck,
    qdrant: qdrantCheck,
    consistency,
  };
}

/**
 * Головна функція — MRE для ККУ та КУпАП
 */
export async function mreParserIntegrity(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`MRE Parser Integrity — ККУ та КУпАП`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const testCases = [
    { nreg: '2341-14', articles: ['1', '2', '10', '115', '116'] }, // ККУ
    { nreg: '80731-10', articles: ['1', '2', '10', '100', '212'] }, // КУпАП частина 1
    { nreg: '80732-10', articles: ['213', '214', '220', '300', '330'] }, // КУпАП частина 2
  ];
  
  const results: MREArticleCheck[] = [];
  
  for (const testCase of testCases) {
    console.log(`\n📋 ${testCase.nreg}:`);
    
    for (const articleNum of testCase.articles) {
      process.stdout.write(`  Стаття ${articleNum}... `);
      
      try {
        const check = await checkArticleMRE(testCase.nreg, articleNum);
        if (check) {
          results.push(check);
          
          if (check.consistency.potential_shift) {
            console.log(`❌ ${check.consistency.potential_shift}`);
          } else if (check.consistency.canonical_has_article && check.consistency.qdrant_has_chunks) {
            console.log(`✅`);
          } else {
            console.log(`⚠️  canonical=${check.consistency.canonical_has_article}, qdrant=${check.consistency.qdrant_has_chunks}`);
          }
        } else {
          console.log(`⚠️  не знайдено`);
        }
      } catch (e) {
        console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  
  // Зберігаємо результати
  const fs = await import('fs/promises');
  const outputPath = resolve(workspaceRoot(), 'runs', 'audit', 'MRE_PARSER_INTEGRITY.json');
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\n✅ MRE results збережено: ${outputPath}`);
  
  // Статистика
  const withShifts = results.filter(r => r.consistency.potential_shift).length;
  const allGood = results.filter(r => 
    r.consistency.canonical_has_article && 
    r.consistency.qdrant_has_chunks && 
    r.consistency.article_number_matches &&
    !r.consistency.potential_shift
  ).length;
  
  console.log(`\n📊 Статистика:`);
  console.log(`   Всього перевірок: ${results.length}`);
  console.log(`   З потенційним зсувом: ${withShifts}`);
  console.log(`   Всі OK: ${allGood}\n`);
}
