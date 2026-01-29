/**
 * Repair consistency command — виправлення невідповідностей між Supabase/Qdrant/R2
 * 
 * PHASE 12: Post-test DB hygiene / Reconciliation toolkit
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { getR2AdminClient, headObject } from '../lib/r2Admin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { normalizeCategory } from '../taxonomy/taxonomy.js';
import { getDocumentTypeInfo } from '../documentTypes/documentTypes.js';

export async function repairConsistency(nreg: string, opts: { dryRun?: boolean }): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Repair Consistency: ${nreg}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  
  // Fetch document
  const { data: doc, error: docError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (docError) throw new Error(`Supabase read error: ${docError.message}`);
  if (!doc) {
    console.log(`❌ Document not found in Supabase`);
    return;
  }
  
  const fixes: Array<{ component: string; fix: string }> = [];
  
  // Fix 1: Normalize category
  if (doc.category && !doc.category.match(/^[a-z_]+$/)) {
    const normalizedCategory = normalizeCategory(doc.category);
    if (normalizedCategory !== doc.category) {
      console.log(`  Fixing category: ${doc.category} → ${normalizedCategory}`);
      
      if (!opts.dryRun) {
        await supabase
          .from('legislation_documents')
          .update({ category: normalizedCategory })
          .eq('rada_nreg', nreg);
      }
      
      fixes.push({ component: 'Supabase', fix: `Category normalized: ${doc.category} → ${normalizedCategory}` });
    }
  }
  
  // Fix 2: Update Qdrant payloads if category changed
  const qdrant = createQdrantClient();
  const r2Key = doc.r2_key as string;
  
  if (r2Key) {
    try {
      const canonical = await getJsonFromR2(r2Key);
      const canonicalChunks = canonical?.content?.chunks?.length || 0;
      
      // Check if canonical chunks != expected_chunks
      if (canonicalChunks > 0 && doc.expected_chunks !== canonicalChunks) {
        console.log(`  Fixing expected_chunks: ${doc.expected_chunks} → ${canonicalChunks}`);
        
        if (!opts.dryRun) {
          await supabase
            .from('legislation_documents')
            .update({ expected_chunks: canonicalChunks })
            .eq('rada_nreg', nreg);
        }
        
        fixes.push({ 
          component: 'Supabase', 
          fix: `expected_chunks updated: ${doc.expected_chunks} → ${canonicalChunks}` 
        });
      }
      
      // Update Qdrant payloads to match Supabase
      const normalizedCategory = normalizeCategory(doc.category);
      const documentTypeSlug = doc.document_type_slug;
      const documentType = doc.document_type; // UA label
      
      // Отримуємо правильний UA label з taxonomy якщо потрібно
      const correctDocumentType = documentTypeSlug ? getDocumentTypeInfo(documentTypeSlug as any).label_uk : documentType;
      
      // Validity fields для синхронізації з Supabase (IDEAL DATA CONTRACT)
      const validityStatus = doc.validity_status || 'unknown';
      const sourceStatusLocation = doc.source_status_location || 'fallback.no_evidence';
      const sourceStatusText = doc.source_status_text || 'N/A';
      const statusNote = doc.status_note || 'no_evidence';
      
      // Update chunks payloads
      const chunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
        filter: {
          must: [{ key: 'rada_nreg', match: { value: nreg } }, { key: 'content_hash', match: { value: doc.content_hash } }],
        },
        limit: 1000,
        with_payload: true,
      });
      
      if (chunks.points && chunks.points.length > 0) {
        let needsUpdate = false;
        const updatePayload: any = {};
        
        // Отримуємо canonical chunks для unit_number/unit_type
        const canonicalChunks = canonical?.content?.chunks || [];
        const chunksByIndex = new Map<number, any>();
        for (const chunk of canonicalChunks) {
          chunksByIndex.set(chunk.chunk_index, chunk);
        }
        
        for (const point of chunks.points) {
          const payload = point.payload as any;
          const chunkIndex = payload.chunk_index;
          const canonicalChunk = chunksByIndex.get(chunkIndex);
          
          if (payload.category !== normalizedCategory) {
            needsUpdate = true;
            updatePayload.category = normalizedCategory;
          }
          if (documentTypeSlug && payload.document_type_slug !== documentTypeSlug) {
            needsUpdate = true;
            updatePayload.document_type_slug = documentTypeSlug;
          }
          if (correctDocumentType && payload.document_type !== correctDocumentType) {
            needsUpdate = true;
            updatePayload.document_type = correctDocumentType;
          }
          
          // Додаємо unit_number та unit_type з canonical якщо їх немає
          if (canonicalChunk) {
            const canonicalUnitNumber = (canonicalChunk as any).unit_number || canonicalChunk.article_number || null;
            const canonicalUnitType = (canonicalChunk as any).unit_type || (canonicalChunk.article_number ? 'article' : null);
            
            if (canonicalUnitNumber && !payload.unit_number) {
              needsUpdate = true;
              updatePayload.unit_number = canonicalUnitNumber;
            }
          if (canonicalUnitType && !payload.unit_type) {
            needsUpdate = true;
            updatePayload.unit_type = canonicalUnitType;
          }
        }
        
        // Синхронізуємо validity поля (IDEAL DATA CONTRACT)
        if (payload.validity_status !== validityStatus) {
          needsUpdate = true;
          updatePayload.validity_status = validityStatus;
        }
        if (payload.source_status_location !== sourceStatusLocation) {
          needsUpdate = true;
          updatePayload.source_status_location = sourceStatusLocation;
        }
        if (payload.source_status_text !== sourceStatusText) {
          needsUpdate = true;
          updatePayload.source_status_text = sourceStatusText;
        }
        if (payload.status_note !== statusNote) {
          needsUpdate = true;
          updatePayload.status_note = statusNote;
        }
      }
        
        if (needsUpdate && !opts.dryRun) {
          // Batch update через setPayload
          const pointIds = chunks.points.map(p => p.id as string);
          await qdrant.setPayload(QDRANT_COLLECTION_CHUNKS, {
            payload: updatePayload,
            points: pointIds,
          });
          fixes.push({ 
            component: 'Qdrant', 
            fix: `Updated ${chunks.points.length} chunks payloads (${Object.keys(updatePayload).join(', ')})` 
          });
        } else if (needsUpdate && opts.dryRun) {
          fixes.push({ 
            component: 'Qdrant', 
            fix: `[DRY RUN] Would update ${chunks.points.length} chunks payloads (${Object.keys(updatePayload).join(', ')})` 
          });
        }
      }
      
      // Update acts payloads
      const acts = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
        filter: {
          must: [{ key: 'rada_nreg', match: { value: nreg } }, { key: 'content_hash', match: { value: doc.content_hash } }],
        },
        limit: 100,
        with_payload: true,
      });
      
      if (acts.points && acts.points.length > 0) {
        let needsUpdate = false;
        const updatePayload: any = {};
        
        for (const point of acts.points) {
          const payload = point.payload as any;
          if (payload.category !== normalizedCategory) {
            needsUpdate = true;
            updatePayload.category = normalizedCategory;
          }
          if (documentTypeSlug && payload.document_type_slug !== documentTypeSlug) {
            needsUpdate = true;
            updatePayload.document_type_slug = documentTypeSlug;
          }
          if (correctDocumentType && payload.document_type !== correctDocumentType) {
            needsUpdate = true;
            updatePayload.document_type = correctDocumentType;
          }
          
          // Синхронізуємо validity поля (IDEAL DATA CONTRACT)
          if (payload.validity_status !== validityStatus) {
            needsUpdate = true;
            updatePayload.validity_status = validityStatus;
          }
          if (payload.source_status_location !== sourceStatusLocation) {
            needsUpdate = true;
            updatePayload.source_status_location = sourceStatusLocation;
          }
          if (payload.source_status_text !== sourceStatusText) {
            needsUpdate = true;
            updatePayload.source_status_text = sourceStatusText;
          }
          if (payload.status_note !== statusNote) {
            needsUpdate = true;
            updatePayload.status_note = statusNote;
          }
        }
        
        if (needsUpdate && !opts.dryRun) {
          // Batch update через setPayload
          const pointIds = acts.points.map(p => p.id as string);
          await qdrant.setPayload(QDRANT_COLLECTION_ACTS, {
            payload: updatePayload,
            points: pointIds,
          });
          fixes.push({ 
            component: 'Qdrant', 
            fix: `Updated ${acts.points.length} acts payloads (${Object.keys(updatePayload).join(', ')})` 
          });
        } else if (needsUpdate && opts.dryRun) {
          fixes.push({ 
            component: 'Qdrant', 
            fix: `[DRY RUN] Would update ${acts.points.length} acts payloads (${Object.keys(updatePayload).join(', ')})` 
          });
        }
      }
      
    } catch (e: any) {
      console.log(`  ⚠️  R2/Qdrant fix failed: ${e.message}`);
    }
  }
  
  // Summary
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  
  if (fixes.length === 0) {
    console.log(`✅ No fixes needed`);
  } else {
    console.log(`${opts.dryRun ? '[DRY-RUN] ' : ''}Applied ${fixes.length} fix(es):`);
    fixes.forEach(({ component, fix }) => {
      console.log(`  - [${component}] ${fix}`);
    });
  }
}
