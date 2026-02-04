/**
 * Repair categories command — нормалізація та перекласифікація category
 * 
 * PHASE 9: Category normalization + reclassification
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { normalizeCategory, isValidCategory, guessCategoryFromKeywords, TaxonomySlug, VALID_CATEGORIES } from '../taxonomy/taxonomy.js';
import { generateEnrichment } from '../lib/aiEnrichment.js';
import { getJsonFromR2 } from '../lib/r2Json.js';

const IMPORTANT_DOCUMENT_TYPES = [
  'Постанова', 'Постанова КМУ', 'Постанова ВР',
  'Наказ', 'Указ', 'Розпорядження', 'Рішення',
  'Положення', 'Правила', 'Інструкція',
  'Закон', 'Кодекс',
];

export async function repairCategories(opts: {
  nreg?: string;
  all?: boolean;
  forceAi?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  let docs: Array<{ rada_nreg: string; title: string; document_type: string; category: string; r2_key: string; content_hash: string }> = [];
  
  if (opts.nreg) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title,document_type,category,r2_key,content_hash')
      .eq('rada_nreg', opts.nreg)
      .maybeSingle();
    
    if (error) throw new Error(`Supabase select error: ${error.message}`);
    if (data) docs = [data];
  } else if (opts.all) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title,document_type,category,r2_key,content_hash');
    
    if (error) throw new Error(`Supabase select error: ${error.message}`);
    docs = data || [];
  } else {
    throw new Error('Треба вказати --nreg або --all');
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Repair Categories`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log(`Found ${docs.length} documents\n`);
  
  let fixed = 0;
  let skipped = 0;
  const errors: Array<{ nreg: string; error: string }> = [];
  
  for (const doc of docs) {
    const currentCategory = doc.category;
    const isInvalid = !isValidCategory(currentCategory);
    const isOther = currentCategory === 'other';
    const isImportant = doc.document_type && IMPORTANT_DOCUMENT_TYPES.some(type => doc.document_type.includes(type));
    
    let needsFix = isInvalid;
    let needsReclassification = false;
    
    // Перевіряємо чи треба перекласифікувати "other" для важливих документів
    if (isOther && isImportant && opts.forceAi) {
      needsReclassification = true;
    }
    
    if (!needsFix && !needsReclassification) {
      skipped++;
      continue;
    }
    
    console.log(`\n[${doc.rada_nreg}] ${doc.title}`);
    console.log(`  Current: ${currentCategory} (invalid: ${isInvalid}, other: ${isOther})`);
    
    let newCategory: TaxonomySlug;
    
    if (needsReclassification || (opts.forceAi && isInvalid)) {
      // AI reclassification
      try {
        console.log(`  → AI reclassification...`);
        
        // Отримуємо canonical для контексту
        const canonical = doc.r2_key ? await getJsonFromR2(doc.r2_key) : null;
        
        if (canonical) {
          const enrichmentInput = {
            title: doc.title,
            documentType: doc.document_type || '',
            category: currentCategory,
            articles: canonical.content?.articles?.slice(0, 10) || [],
            units: canonical.content?.chunks?.slice(0, 10).map((c: any, i: number) => ({
              unit_type: 'article',
              number: c.article_number || String(i),
              title: c.title || null,
              text: c.text?.slice(0, 500) || '',
            })) || [],
            struDistribution: {},
          };
          
          const enrichment = await generateEnrichment(enrichmentInput);
          newCategory = normalizeCategory(enrichment.category);
        } else {
          // Fallback на rule-based
          newCategory = guessCategoryFromKeywords(doc.title, doc.document_type || '') || 'other';
        }
      } catch (e: any) {
        console.log(`  ⚠️  AI failed: ${e.message}, using rule-based`);
        newCategory = guessCategoryFromKeywords(doc.title, doc.document_type || '') || normalizeCategory(currentCategory);
      }
    } else {
      // Просто нормалізуємо
      newCategory = normalizeCategory(currentCategory);
    }
    
    console.log(`  → New: ${newCategory}`);
    
    if (opts.dryRun) {
      console.log(`  [DRY-RUN] Would update category: ${currentCategory} → ${newCategory}`);
      fixed++;
      continue;
    }
    
    // Update Supabase
    const { error: updError } = await supabase
      .from('legislation_documents')
      .update({ category: newCategory })
      .eq('rada_nreg', doc.rada_nreg);
    
    if (updError) {
      console.log(`  ❌ Supabase update failed: ${updError.message}`);
      errors.push({ nreg: doc.rada_nreg, error: `Supabase: ${updError.message}` });
      continue;
    }
    
    // Update Qdrant payloads (category field)
    try {
      const qdrant = createQdrantClient();
      
      // Update chunks
      const chunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
        filter: {
          must: [{ key: 'rada_nreg', match: { value: doc.rada_nreg } }],
        },
        limit: 1000,
      });
      
      if (chunks.points && chunks.points.length > 0) {
        for (const point of chunks.points) {
          await qdrant.setPayload(QDRANT_COLLECTION_CHUNKS, {
            payload: { category: newCategory },
            points: [point.id as string],
          });
        }
        console.log(`  → Updated ${chunks.points.length} chunks in Qdrant`);
      }
      
      // Update acts
      const acts = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
        filter: {
          must: [{ key: 'rada_nreg', match: { value: doc.rada_nreg } }],
        },
        limit: 100,
      });
      
      if (acts.points && acts.points.length > 0) {
        for (const point of acts.points) {
          await qdrant.setPayload(QDRANT_COLLECTION_ACTS, {
            payload: { category: newCategory },
            points: [point.id as string],
          });
        }
        console.log(`  → Updated ${acts.points.length} acts in Qdrant`);
      }
    } catch (e: any) {
      console.log(`  ⚠️  Qdrant update failed: ${e.message}`);
      errors.push({ nreg: doc.rada_nreg, error: `Qdrant: ${e.message}` });
    }
    
    fixed++;
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log(`\nErrors:`);
    errors.forEach(({ nreg, error }) => {
      console.log(`  - ${nreg}: ${error}`);
    });
  }
}
