/**
 * DB Import — функції для імпорту canonical документів в Supabase
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CanonicalDocument, generateRagChunks } from './buildCanonical.js';

/**
 * Створює Supabase клієнт для Legislation RAG проєкту
 */
export function createLegislationSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_LEGISLATION_URL || process.env.SUPABASE_LEGISLATION_RAG_URL;
  const key = process.env.SUPABASE_LEGISLATION_SERVICE_ROLE_KEY || 
              process.env.SUPABASE_LEGISLATION_ANON_KEY ||
              process.env.SUPABASE_LEGISLATION_RAG_SERVICE_ROLE_KEY ||
              process.env.SUPABASE_LEGISLATION_RAG_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Відсутні змінні оточення для Supabase Legislation RAG.\n' +
      'Потрібні: SUPABASE_LEGISLATION_URL (або SUPABASE_LEGISLATION_RAG_URL) та\n' +
      '          SUPABASE_LEGISLATION_SERVICE_ROLE_KEY (або SUPABASE_LEGISLATION_ANON_KEY)\n' +
      '\n' +
      'Альтернатива: використайте MCP напряму для вставки даних через SQL.'
    );
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Імпортує canonical документ в БД
 */
export async function importCanonicalDocument(
  supabase: SupabaseClient,
  canonical: CanonicalDocument
): Promise<{
  documentInserted: boolean;
  chunksInserted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let documentInserted = false;
  let chunksInserted = 0;

  try {
    // 1. Вставляємо документ
    const { data: docData, error: docError } = await supabase
      .from('legislation_documents')
      .upsert({
        rada_nreg: canonical.metadata.rada_nreg,
        rada_dokid: canonical.metadata.rada_dokid,
        title: canonical.metadata.title,
        document_type: canonical.metadata.document_type,
        category: canonical.metadata.category,
        law_number: canonical.metadata.law_number,
        rada_datred: canonical.metadata.rada_datred,
        content_hash: canonical.metadata.content_hash,
        previous_hash: canonical.metadata.previous_hash,
        r2_key: canonical.metadata.r2_key,
        source_url: canonical.metadata.source_url,
        articles_count: canonical.content.articles.length,
        imported_at: canonical.metadata.imported_at,
        updated_at: canonical.metadata.updated_at,
        is_active: true,
        sync_status: 'synced',
        keywords: canonical.ai_enrichment?.keywords || [],
        topics: canonical.ai_enrichment?.topics || [],
      }, {
        onConflict: 'rada_nreg',
      })
      .select();

    if (docError) {
      errors.push(`Помилка вставки документа: ${docError.message}`);
    } else {
      documentInserted = true;
      console.log(`✅ Документ вставлено: ${canonical.metadata.rada_nreg}`);
    }

    // 2. Вставляємо чанки (chunks)
    // ПРИМІТКА: Ця функція потребує оновлення для роботи з chunks
    // Зараз закоментовано, оскільки:
    // - Таблиця legislation_articles видалена
    // - Потрібна реалізація chunking та embedding generation
    // - Потрібна інтеграція з R2 для завантаження canonical JSON
    // 
    // TODO: Реалізувати:
    // 1. Chunking логіку (розбиття тексту на семантичні чанки)
    // 2. Генерацію embeddings через OpenAI API
    // 3. Завантаження canonical JSON в R2
    // 4. Вставку чанків в legislation_chunks з r2_key та json_path
    
    /*
    if (canonical.content.articles.length > 0) {
      // TODO: Реалізувати chunking та embedding generation
      // const chunks = await generateRagChunks(canonical);
      // 
      // const { error: chunksError } = await supabase
      //   .from('legislation_chunks')
      //   .upsert(chunks, {
      //     onConflict: 'id',
      //   });
      
      console.log('⚠️  Chunks insertion not yet implemented. Requires:');
      console.log('   - Chunking logic');
      console.log('   - Embedding generation');
      console.log('   - R2 upload');
    }
    */

  } catch (error) {
    errors.push(`Критична помилка: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    documentInserted,
    chunksInserted,
    errors,
  };
}

/**
 * Перевіряє чи документ вже існує в БД
 */
export async function checkDocumentExists(
  supabase: SupabaseClient,
  nreg: string
): Promise<{ exists: boolean; contentHash?: string }> {
  const { data, error } = await supabase
    .from('legislation_documents')
    .select('content_hash')
    .eq('rada_nreg', nreg)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    throw error;
  }

  return {
    exists: !!data,
    contentHash: data?.content_hash,
  };
}

