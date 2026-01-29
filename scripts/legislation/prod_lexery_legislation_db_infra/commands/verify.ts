/**
 * Verify command — перевірка консистентності Supabase ↔ Qdrant ↔ R2
 * 
 * PHASE 18: Final Production Hardening — Invariants V1
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, countByNreg, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { getR2AdminClient, headObject } from '../lib/r2Admin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { isValidCategory } from '../taxonomy/taxonomy.js';
import { DocumentTypeSlug } from '../documentTypes/documentTypes.js';
import { isCheckApplicable, hasEnoughTextForChunks, VERIFY_APPLICABILITY } from '../lib/verifyApplicability.js';

export interface VerifyResult {
  nreg: string;
  pass: boolean;
  issues: Array<{ 
    component: string; 
    check: string; 
    status: 'PASS' | 'FAIL' | 'WARN' | 'NA'; 
    reason?: string;
    reasonCode?: string; // PHASE 3.6.5: standardized reason codes
  }>;
}

export async function verifyDocument(nreg: string, options?: { writeHealth?: boolean }): Promise<VerifyResult> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Verify: ${nreg}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const supabase = createSupabaseAdminClient();
  const checks: Array<{ component: string; check: string; status: 'PASS' | 'FAIL' | 'WARN' | 'NA'; reason?: string; reasonCode?: string }> = [];
  
  // 1. Supabase
  const { data: doc, error: docError } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (docError) {
    throw new Error(`Supabase read error: ${docError.message}`);
  }
  
  if (!doc) {
    checks.push({ component: 'Supabase', check: 'Document exists', status: 'FAIL', reason: 'Not found' });
    return { nreg, pass: false, issues: checks };
  }
  
  console.log(`✅ Supabase: Found`);
  console.log(`  title: ${doc.title}`);
  
  // A) Supabase core invariants
  
  // document_type_slug NOT NULL
  if (!doc.document_type_slug) {
    checks.push({ component: 'Supabase', check: 'document_type_slug NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ document_type_slug: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'document_type_slug NOT NULL', status: 'PASS' });
    console.log(`  ✅ document_type_slug: ${doc.document_type_slug}`);
  }
  
  // category_slug NOT NULL (EN taxonomy)
  if (!doc.category || !isValidCategory(doc.category)) {
    checks.push({ component: 'Supabase', check: 'category_slug NOT NULL (EN)', status: 'FAIL', reason: `Invalid: ${doc.category || 'NULL'}` });
    console.log(`  ❌ category: ${doc.category || 'NULL'}`);
  } else {
    checks.push({ component: 'Supabase', check: 'category_slug NOT NULL (EN)', status: 'PASS' });
    console.log(`  ✅ category: ${doc.category}`);
  }
  
  // document_number NOT NULL
  if (!doc.document_number) {
    checks.push({ component: 'Supabase', check: 'document_number NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ document_number: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'document_number NOT NULL', status: 'PASS' });
    console.log(`  ✅ document_number: ${doc.document_number}`);
  }
  
  // storage_category NOT NULL
  if (!doc.storage_category) {
    checks.push({ component: 'Supabase', check: 'storage_category NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ storage_category: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'storage_category NOT NULL', status: 'PASS' });
    console.log(`  ✅ storage_category: ${doc.storage_category}`);
  }
  
  // validity_status NOT NULL (PROD PIPELINE: інваріант)
  if (!doc.validity_status) {
    checks.push({ component: 'Supabase', check: 'validity_status NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ validity_status: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'validity_status NOT NULL', status: 'PASS' });
    console.log(`  ✅ validity_status: ${doc.validity_status}`);
  }
  
  // status_note NOT NULL (IDEAL DATA CONTRACT)
  if (!doc.status_note) {
    checks.push({ component: 'Supabase', check: 'status_note NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ status_note: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'status_note NOT NULL', status: 'PASS' });
    console.log(`  ✅ status_note: ${doc.status_note}`);
  }
  
  // source_status_text NOT NULL (IDEAL DATA CONTRACT)
  if (!doc.source_status_text) {
    checks.push({ component: 'Supabase', check: 'source_status_text NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ source_status_text: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'source_status_text NOT NULL', status: 'PASS' });
    console.log(`  ✅ source_status_text: ${doc.source_status_text.substring(0, 50)}...`);
  }
  
  // source_status_location NOT NULL (IDEAL DATA CONTRACT)
  if (!doc.source_status_location) {
    checks.push({ component: 'Supabase', check: 'source_status_location NOT NULL', status: 'FAIL', reason: 'NULL' });
    console.log(`  ❌ source_status_location: NULL`);
  } else {
    checks.push({ component: 'Supabase', check: 'source_status_location NOT NULL', status: 'PASS' });
    console.log(`  ✅ source_status_location: ${doc.source_status_location}`);
  }
  
  // sync_health NOT NULL (PHASE 6.2: інваріант)
  // Перевіряємо після того як встановимо health (якщо writeHealth)
  // Тому цей check виконується в кінці, після встановлення health
  
  // act_is_part=false ⇒ act_group_key IS NULL
  const actIsPart = doc.act_is_part === true;
  if (!actIsPart && (doc.act_group_key !== null || doc.act_part_label !== null)) {
    checks.push({ 
      component: 'Supabase', 
      check: 'act_is_part=false ⇒ act_group_key IS NULL', 
      status: 'FAIL', 
      reason: `act_group_key=${doc.act_group_key}, act_part_label=${doc.act_part_label}` 
    });
    console.log(`  ❌ Act group sanity: single act has act_group_key`);
  } else {
    checks.push({ component: 'Supabase', check: 'act_is_part=false ⇒ act_group_key IS NULL', status: 'PASS' });
    console.log(`  ✅ Act group sanity: OK`);
  }
  
  // expected_chunks >= 0, indexed_chunks >= 0
  if (doc.expected_chunks === null || doc.expected_chunks < 0) {
    checks.push({ component: 'Supabase', check: 'expected_chunks >= 0', status: 'FAIL', reason: `value=${doc.expected_chunks}` });
    console.log(`  ❌ expected_chunks: ${doc.expected_chunks}`);
  } else {
    checks.push({ component: 'Supabase', check: 'expected_chunks >= 0', status: 'PASS' });
  }
  
  if (doc.indexed_chunks === null || doc.indexed_chunks < 0) {
    checks.push({ component: 'Supabase', check: 'indexed_chunks >= 0', status: 'FAIL', reason: `value=${doc.indexed_chunks}` });
    console.log(`  ❌ indexed_chunks: ${doc.indexed_chunks}`);
  } else {
    checks.push({ component: 'Supabase', check: 'indexed_chunks >= 0', status: 'PASS' });
  }
  
  // qdrant_status=indexed ⇒ indexed_chunks == expected_chunks
  const isIndexable = doc.document_type_slug && 
    !['other'].includes(doc.document_type_slug as DocumentTypeSlug);
  
  if (doc.qdrant_status === 'indexed' && doc.expected_chunks !== doc.indexed_chunks) {
    checks.push({ 
      component: 'Supabase', 
      check: 'qdrant_status=indexed ⇒ indexed_chunks == expected_chunks', 
      status: 'FAIL', 
      reason: `expected=${doc.expected_chunks}, indexed=${doc.indexed_chunks}` 
    });
    console.log(`  ❌ Chunks mismatch: expected=${doc.expected_chunks}, indexed=${doc.indexed_chunks}`);
  } else if (doc.qdrant_status === 'indexed') {
    checks.push({ component: 'Supabase', check: 'qdrant_status=indexed ⇒ indexed_chunks == expected_chunks', status: 'PASS' });
    console.log(`  ✅ Chunks match: ${doc.expected_chunks}`);
  }
  
  // chunks==0 для indexable=true ⇒ FAIL (але тільки якщо є текст)
  // PHASE 3.6: перевіряємо txtLength з canonical перед тим як FAIL
  // ВАЖЛИВО: r2Key ще не визначено тут, тому перемістимо цю перевірку після R2 секції
  // Тимчасово пропускаємо цю перевірку тут
  
  // PHASE 3.6: перевірка chunks=0 для indexable перенесена в R2 секцію (після отримання canonical)
  
  // B) R2 invariants
  const r2Key = doc.r2_key as string;
  if (!r2Key) {
    checks.push({ 
      component: 'R2', 
      check: 'r2_key exists', 
      status: 'FAIL', 
      reason: 'NULL',
      reasonCode: 'ERROR_R2_KEY_NULL'
    });
    console.log(`  ❌ R2: r2_key is NULL`);
  } else {
    const { client: r2, bucket } = getR2AdminClient();
    const head = await headObject(r2, bucket, r2Key);
    
    if (!head.exists) {
      checks.push({ 
        component: 'R2', 
        check: 'r2_key exists in bucket', 
        status: 'FAIL', 
        reason: `Not found: ${r2Key}`,
        reasonCode: 'ERROR_R2_MISSING'
      });
      console.log(`  ❌ R2: Canonical not found: ${r2Key}`);
    } else {
      checks.push({ component: 'R2', check: 'r2_key exists in bucket', status: 'PASS' });
      console.log(`  ✅ R2: Canonical exists (${head.size || 0} bytes)`);
      
      // Verify canonical content
      try {
        const canonical = await getJsonFromR2(r2Key);
        
        if (!canonical || !canonical.content) {
          checks.push({ component: 'R2', check: 'canonical JSON valid', status: 'FAIL', reason: 'Missing content' });
          console.log(`  ❌ R2: Invalid canonical structure`);
        } else {
          checks.push({ component: 'R2', check: 'canonical JSON valid', status: 'PASS' });
          
          const canonicalChunks = canonical.content.chunks?.length || 0;
          const canonicalTxtLength = (canonical.raw?.rada_api_txt || '').length;
          
          if (isIndexable && canonicalChunks === 0) {
            // PHASE 3.6: перевіряємо txtLength перед FAIL
            if (canonicalTxtLength > 0 && hasEnoughTextForChunks(canonicalTxtLength)) {
              checks.push({ 
                component: 'R2', 
                check: 'canonical has chunks > 0 (if indexable)', 
                status: 'FAIL', 
                reason: `canonical chunks=0 but text exists (txtLength=${canonicalTxtLength})` 
              });
              console.log(`  ❌ R2: Indexable document has 0 chunks in canonical but text exists (${canonicalTxtLength} chars)`);
            } else if (canonicalTxtLength === 0) {
              checks.push({ 
                component: 'R2', 
                check: 'canonical has chunks > 0 (if indexable)', 
                status: 'PASS',  // N/A
                reason: 'N/A: empty source (txtLength=0)' 
              });
              console.log(`  ⚠️  R2: Indexable document has 0 chunks but source is empty (N/A)`);
            } else {
              checks.push({ 
                component: 'R2', 
                check: 'canonical has chunks > 0 (if indexable)', 
                status: 'PASS',  // N/A - текст занадто короткий
                reason: `N/A: text too short (txtLength=${canonicalTxtLength})` 
              });
            }
          } else if (isIndexable) {
            checks.push({ component: 'R2', check: 'canonical has chunks > 0 (if indexable)', status: 'PASS' });
          }
          
          if (canonicalChunks !== doc.expected_chunks) {
            checks.push({ 
              component: 'R2', 
              check: 'canonical chunks count == expected_chunks', 
              status: 'FAIL', 
              reason: `canonical=${canonicalChunks}, expected=${doc.expected_chunks}`,
              reasonCode: 'ERROR_CANONICAL_CHUNKS_MISMATCH'
            });
            console.log(`  ⚠️  Canonical chunks: ${canonicalChunks} (expected: ${doc.expected_chunks})`);
          } else {
            checks.push({ component: 'R2', check: 'canonical chunks count == expected_chunks', status: 'PASS' });
            console.log(`  ✅ Canonical chunks match: ${canonicalChunks}`);
          }
          
          // PHASE 3.6: перевірка chunks=0 для indexable (після отримання canonical)
          if (isIndexable && doc.expected_chunks === 0) {
            // PHASE 3.6: якщо txtLength достатній → FAIL, якщо txtLength=0 → N/A (empty source)
            if (canonicalTxtLength > 0 && hasEnoughTextForChunks(canonicalTxtLength)) {
              checks.push({ 
                component: 'Supabase', 
                check: 'indexable document has chunks > 0', 
                status: 'FAIL', 
                reason: `expected_chunks=0 for indexable document with text (txtLength=${canonicalTxtLength})`,
                reasonCode: 'ERROR_ZERO_CHUNKS_WITH_TEXT'
              });
              console.log(`  ❌ Indexable document has 0 chunks but text exists (${canonicalTxtLength} chars)`);
            } else if (canonicalTxtLength === 0) {
              // N/A: джерело порожнє
              checks.push({ 
                component: 'Supabase', 
                check: 'indexable document has chunks > 0', 
                status: 'NA',  // N/A - не застосовне для порожніх джерел
                reason: 'N/A: empty source (txtLength=0)' 
              });
              console.log(`  ⚠️  Indexable document has 0 chunks but source is empty (N/A)`);
            } else {
              checks.push({ 
                component: 'Supabase', 
                check: 'indexable document has chunks > 0', 
                status: 'NA',  // N/A - текст занадто короткий
                reason: `N/A: text too short (txtLength=${canonicalTxtLength} < ${VERIFY_APPLICABILITY.expected_chunks.minTextLength})` 
              });
            }
          } else if (isIndexable && doc.expected_chunks > 0) {
            checks.push({ component: 'Supabase', check: 'indexable document has chunks > 0', status: 'PASS' });
          }
        }
      } catch (e: any) {
        checks.push({ 
          component: 'R2', 
          check: 'canonical JSON readable', 
          status: 'FAIL', 
          reason: e.message,
          reasonCode: 'ERROR_CANONICAL_READ_FAILED'
        });
        console.log(`  ❌ Failed to read canonical: ${e.message}`);
      }
    }
  }
  
  // C) Qdrant invariants
  const qdrant = createQdrantClient();
  // PHASE 3.6.7: рахуємо тільки CURRENT версію (по content_hash) - використовуємо QdrantRagClient.countDocument
  const { QdrantRagClient } = await import('../lib/qdrantRagClient.js');
  const qdrantRag = new QdrantRagClient();
  const qCounts = await qdrantRag.countDocument(nreg, doc.content_hash);
  const qActs = qCounts.acts;
  const qChunks = qCounts.chunks;
  
  console.log(`\n✅ Qdrant: Found`);
  console.log(`  acts: ${qActs}`);
  console.log(`  chunks: ${qChunks}`);
  
  // Acts count MUST be exactly 1 (PHASE 18.1b: BLOCKER)
  // PHASE 3.6.7: перевіряємо тільки CURRENT версію (по content_hash)
  if (qActs !== 1) {
    checks.push({ 
      component: 'Qdrant', 
      check: 'Qdrant acts count == 1 (CURRENT version)', 
      status: 'FAIL', 
      reason: `Qdrant=${qActs}, expected=1 (content_hash=${doc.content_hash?.substring(0, 8)}...)`,
      reasonCode: qActs > 1 ? 'ERROR_QDRANT_ACTS_DUPLICATE' : 'ERROR_QDRANT_ACT_MISSING'
    });
    console.log(`  ❌ Acts count mismatch: Qdrant=${qActs}, expected=1 (CURRENT version)`);
  } else {
    checks.push({ component: 'Qdrant', check: 'Qdrant acts count == 1 (CURRENT version)', status: 'PASS' });
    console.log(`  ✅ Acts count match: ${qActs}`);
  }
  
  // Qdrant points count == indexed_chunks (PHASE 3.6.7: тільки CURRENT версія)
  if (qChunks !== doc.indexed_chunks) {
    checks.push({ 
      component: 'Qdrant', 
      check: 'Qdrant chunks count == indexed_chunks (CURRENT version)', 
      status: 'FAIL', 
      reason: `Qdrant=${qChunks}, indexed_chunks=${doc.indexed_chunks} (content_hash=${doc.content_hash?.substring(0, 8)}...)`,
      reasonCode: 'ERROR_QDRANT_CHUNKS_COUNT_MISMATCH'
    });
    console.log(`  ❌ Chunks count mismatch: Qdrant=${qChunks}, indexed_chunks=${doc.indexed_chunks} (CURRENT version)`);
  } else {
    checks.push({ component: 'Qdrant', check: 'Qdrant chunks count == indexed_chunks (CURRENT version)', status: 'PASS' });
    console.log(`  ✅ Chunks count match: ${qChunks}`);
  }
  
  // Check payloads (PHASE 3.6.7: перевіряємо тільки CURRENT версію)
  if (qChunks > 0) {
    // PHASE 3.6.7: фільтруємо по content_hash щоб перевірити тільки CURRENT версію
    const chunks = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
      filter: {
        must: [
          { key: 'rada_nreg', match: { value: nreg } },
          { key: 'content_hash', match: { value: doc.content_hash } } // Тільки CURRENT версія
        ],
      },
      limit: 1,
      with_payload: true,
    });
    
    if (chunks.points && chunks.points.length > 0) {
      const payload = chunks.points[0].payload as any;
      
      // Required payload fields
      // PHASE 3.6.7: chunk_index може бути 0, тому перевіряємо через 'in' operator, а не truthy check
      const requiredFields = ['rada_nreg', 'r2_key', 'json_path', 'content_hash'];
      for (const field of requiredFields) {
        if (!payload[field]) {
          checks.push({ 
            component: 'Qdrant', 
            check: `payload has ${field}`, 
            status: 'FAIL', 
            reason: `Missing ${field}`,
            reasonCode: `ERROR_QDRANT_PAYLOAD_FIELD_MISSING`
          });
        } else {
          checks.push({ component: 'Qdrant', check: `payload has ${field}`, status: 'PASS' });
        }
      }
      
      // chunk_index: окрема перевірка (може бути 0)
      if (!('chunk_index' in payload)) {
        checks.push({ 
          component: 'Qdrant', 
          check: 'payload has chunk_index', 
          status: 'FAIL', 
          reason: 'Missing chunk_index',
          reasonCode: 'ERROR_QDRANT_PAYLOAD_FIELD_MISSING'
        });
      } else {
        checks.push({ component: 'Qdrant', check: 'payload has chunk_index', status: 'PASS' });
      }
      
      // document_type_slug in payload
      if (payload.document_type_slug !== doc.document_type_slug) {
        checks.push({ 
          component: 'Qdrant', 
          check: 'payload document_type_slug matches Supabase', 
          status: 'FAIL', 
          reason: `Supabase=${doc.document_type_slug}, Qdrant=${payload.document_type_slug}` 
        });
        console.log(`  ⚠️  Payload document_type_slug mismatch`);
      } else {
        checks.push({ component: 'Qdrant', check: 'payload document_type_slug matches Supabase', status: 'PASS' });
      }
      
      // Validity fields in payload (IDEAL DATA CONTRACT)
      if (!payload.validity_status) {
        checks.push({ 
          component: 'Qdrant', 
          check: 'payload has validity_status', 
          status: 'FAIL', 
          reason: 'Missing validity_status',
          reasonCode: 'ERROR_QDRANT_PAYLOAD_VALIDITY_MISSING'
        });
      } else {
        checks.push({ component: 'Qdrant', check: 'payload has validity_status', status: 'PASS' });
        if (payload.validity_status !== doc.validity_status) {
          checks.push({ 
            component: 'Qdrant', 
            check: 'payload validity_status matches Supabase', 
            status: 'FAIL', 
            reason: `Supabase=${doc.validity_status}, Qdrant=${payload.validity_status}` 
          });
        } else {
          checks.push({ component: 'Qdrant', check: 'payload validity_status matches Supabase', status: 'PASS' });
        }
      }
      
      if (!payload.source_status_location) {
        checks.push({ 
          component: 'Qdrant', 
          check: 'payload has source_status_location', 
          status: 'FAIL', 
          reason: 'Missing source_status_location',
          reasonCode: 'ERROR_QDRANT_PAYLOAD_VALIDITY_MISSING'
        });
      } else {
        checks.push({ component: 'Qdrant', check: 'payload has source_status_location', status: 'PASS' });
      }
      
      // category in payload
      if (payload.category !== doc.category) {
        checks.push({ 
          component: 'Qdrant', 
          check: 'payload category matches Supabase', 
          status: 'FAIL', 
          reason: `Supabase=${doc.category}, Qdrant=${payload.category}` 
        });
        console.log(`  ⚠️  Payload category mismatch: Supabase=${doc.category}, Qdrant=${payload.category}`);
      } else {
        checks.push({ component: 'Qdrant', check: 'payload category matches Supabase', status: 'PASS' });
        console.log(`  ✅ Payload category matches: ${payload.category}`);
      }
    }
  }
  
  // D) Cross-store invariants
  // canonical chunks count == expected_chunks (вже перевірено в R2 секції)
  // Qdrant points count == indexed_chunks (вже перевірено вище)
  
  // E) Semantic type consistency (PHASE 22)
  // Перевірка консистентності типу документа з summary/snippet
  if (doc.summary) {
    const summary = (doc.summary as string).toLowerCase();
    const title = doc.title.toLowerCase();
    
    // НБУ але slug = law
    if ((summary.includes('нбу') || summary.includes('національний банк') ||
         title.includes('нбу') || title.includes('національний банк')) &&
        doc.document_type_slug === 'law') {
      checks.push({
        component: 'Supabase',
        check: 'semantic type consistency: НБУ не має бути law',
        status: 'FAIL',
        reason: 'НБУ документ має slug=law (має бути nbu_letter або nbu_resolution)',
      });
    }
    
    // ЦВК але slug = cmu_resolution
    if ((summary.includes('цвк') || summary.includes('центральна виборча') ||
         title.includes('цвк') || title.includes('центральна виборча')) &&
        doc.document_type_slug === 'cmu_resolution') {
      checks.push({
        component: 'Supabase',
        check: 'semantic type consistency: ЦВК не має бути cmu_resolution',
        status: 'FAIL',
        reason: 'ЦВК документ має slug=cmu_resolution (має бути cec_resolution)',
      });
    }
    
    // Указ Президента але slug = regulation
    if ((summary.includes('указ') && summary.includes('президент') ||
         title.includes('указ') && title.includes('президент')) &&
        doc.document_type_slug === 'regulation') {
      checks.push({
        component: 'Supabase',
        check: 'semantic type consistency: Указ не має бути regulation',
        status: 'FAIL',
        reason: 'Указ Президента має slug=regulation (має бути presidential_decree)',
      });
    }
    
    // Розпорядження КМУ але slug = regulation
    if ((summary.includes('розпорядження') && (summary.includes('кму') || summary.includes('кабінет'))) &&
        doc.document_type_slug === 'regulation') {
      checks.push({
        component: 'Supabase',
        check: 'semantic type consistency: Розпорядження КМУ не має бути regulation',
        status: 'FAIL',
        reason: 'Розпорядження КМУ має slug=regulation (має бути cmu_order)',
      });
    }
  }
  
  // Calculate sync_health if writeHealth enabled (PHASE 19)
  // ВАЖЛИВО: рахуємо failCount БЕЗ sync_health NOT NULL check (бо він виконується після встановлення health)
  const failCountBeforeHealth = checks.filter(c => c.status === 'FAIL' && c.check !== 'sync_health NOT NULL').length;
  const hasR2 = checks.find(c => c.component === 'R2' && c.check === 'r2_key exists in bucket')?.status === 'PASS';
  const hasQdrantMatch = checks.find(c => c.component === 'Qdrant' && c.check?.includes('Qdrant chunks count == indexed_chunks'))?.status === 'PASS';
  const hasActsMatch = checks.find(c => c.component === 'Qdrant' && c.check?.includes('Qdrant acts count == 1'))?.status === 'PASS';
  const chunksMatch = doc.expected_chunks === doc.indexed_chunks;
  
  // Calculate sync_health
  let syncHealth: 'green' | 'yellow' | 'red' | 'unknown' | null = null;
  let syncIssue: string | null = null;
  // legacy: legal_status column removed, validity now driven by validity_status
  
  // GREEN: всі інваріанти PASS (без sync_health check)
  if (failCountBeforeHealth === 0 && hasR2 && hasQdrantMatch && hasActsMatch && chunksMatch && 
      doc.sync_status === 'synced' && doc.qdrant_status === 'indexed' &&
      doc.document_type_slug && doc.category && doc.document_number) {
    syncHealth = 'green';
    syncIssue = null;
  } 
  // RED: критичні помилки
  else if (failCountBeforeHealth > 0 && (
    doc.sync_status === 'error' || 
    doc.qdrant_status === 'error' ||
    !hasR2 ||
    !hasQdrantMatch ||
    !hasActsMatch ||
    (isIndexable && doc.expected_chunks === 0)
  )) {
    syncHealth = 'red';
    const failChecks = checks.filter(c => c.status === 'FAIL' && c.check !== 'sync_health NOT NULL');
    syncIssue = failChecks.map(c => `${c.check}${c.reason ? `: ${c.reason}` : ''}`).join('; ');
  } 
  // YELLOW: часткові проблеми або warnings
  else if (failCountBeforeHealth > 0 || !chunksMatch || doc.sync_status !== 'synced' || doc.qdrant_status !== 'indexed') {
    syncHealth = 'yellow';
    if (doc.sync_status !== 'synced') syncIssue = `sync_status=${doc.sync_status}`;
    else if (doc.qdrant_status !== 'indexed') syncIssue = `qdrant_status=${doc.qdrant_status}`;
    else if (!chunksMatch) syncIssue = `chunks mismatch: expected=${doc.expected_chunks}, indexed=${doc.indexed_chunks}`;
    else {
      const failChecks = checks.filter(c => c.status === 'FAIL' && c.check !== 'sync_health NOT NULL');
      syncIssue = failChecks.length > 0 ? failChecks.map(c => c.check).join(', ') : 'partial issues';
    }
  }
  // UNKNOWN: недостатньо даних
  else {
    syncHealth = 'unknown';
    syncIssue = null;
  }
  
  // Write health if requested
  if (options?.writeHealth && syncHealth) {
    const updateData: any = {
      sync_health: syncHealth,
      sync_issue: syncIssue,
    };
    
    const { data: updateResult, error: updateError } = await supabase
      .from('legislation_documents')
      .update(updateData)
      .eq('rada_nreg', nreg)
      .select('rada_nreg, sync_health, sync_issue')
      .maybeSingle();
    
    if (updateError) {
      console.log(`  ⚠️  Failed to update health: ${updateError.message}`);
    } else if (updateResult) {
      console.log(`  📝 Updated sync_health: ${syncHealth}${syncIssue ? ` (${syncIssue.substring(0, 50)}${syncIssue.length > 50 ? '...' : ''})` : ''}`);
    }
  }
  
  // Summary
  const passCount = checks.filter(c => c.status === 'PASS').length;
  const failCountFinal = checks.filter(c => c.status === 'FAIL').length;
  const naCount = checks.filter(c => c.status === 'NA').length;
  const warnCount = checks.filter(c => c.status === 'WARN').length;
  // PHASE 3.6.5: allPass = тільки якщо немає FAIL (NA/WARN не вважаються за FAIL)
  const allPass = failCountFinal === 0;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`PASS: ${passCount} / FAIL: ${failCountFinal}`);
  
  if (allPass) {
    console.log(`✅ All checks passed!`);
  } else {
    console.log(`❌ Found ${failCountFinal} FAIL(s):`);
    checks.filter(c => c.status === 'FAIL').forEach(({ component, check, reason }) => {
      console.log(`  - [${component}] ${check}${reason ? `: ${reason}` : ''}`);
    });
  }
  
  return {
    nreg,
    pass: allPass,
    issues: checks.filter(c => c.status === 'FAIL'),
  };
}

export async function printEvidenceQueries(): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`SQL Evidence Queries`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // A) NULL stats
  const { data: docs } = await supabase.from('legislation_documents').select('document_type_slug,category,document_number,storage_category');
  if (docs) {
    const total = docs.length;
    const nullDocType = docs.filter(d => !d.document_type_slug).length;
    const nullCategory = docs.filter(d => !d.category).length;
    const nullDocNumber = docs.filter(d => !d.document_number).length;
    const nullStorage = docs.filter(d => !d.storage_category).length;
    console.log(`A) NULL Stats (total=${total}):`);
    console.log(`   null_doc_type_slug: ${nullDocType}`);
    console.log(`   null_category: ${nullCategory}`);
    console.log(`   null_document_number: ${nullDocNumber}`);
    console.log(`   null_storage_category: ${nullStorage}`);
  }
  
  // B) act_group sanity
  const { data: actGroupDocs } = await supabase
    .from('legislation_documents')
    .select('act_is_part,act_group_key,act_part_label');
  
  if (actGroupDocs) {
    const invalidActGroup = actGroupDocs.filter(d => 
      d.act_is_part === false && (d.act_group_key !== null || d.act_part_label !== null)
    ).length;
    console.log(`\nB) Act Group Sanity:`);
    console.log(`   invalid_act_group (single act has group fields): ${invalidActGroup}`);
  }
  
  // C) qdrant/indexing sanity
  const { data: syncDocs } = await supabase
    .from('legislation_documents')
    .select('sync_status,qdrant_status,expected_chunks,indexed_chunks');
  
  if (syncDocs) {
    const notSynced = syncDocs.filter(d => 
      d.sync_status !== 'synced' || 
      d.qdrant_status !== 'indexed' || 
      d.expected_chunks !== d.indexed_chunks
    ).length;
    console.log(`\nC) Sync/Indexing Sanity:`);
    console.log(`   not_synced (sync_status != 'synced' OR qdrant_status != 'indexed' OR chunks mismatch): ${notSynced}`);
  }
  
  // D) Total counts
  const { count: totalCount } = await supabase
    .from('legislation_documents')
    .select('*', { count: 'exact', head: true });
  
  console.log(`\nD) Total Documents: ${totalCount || 0}`);
}

export async function verifyAll(options?: { writeHealth?: boolean; page?: number; pageSize?: number; evidence?: boolean }): Promise<{ total: number; pass: number; fail: number; results: VerifyResult[] }> {
  const { writeHealth = false, page = 0, pageSize = 100 } = options || {};
  
  const supabase = createSupabaseAdminClient();
  
  // Get all nregs with pagination
  const { data: docs, error } = await supabase
    .from('legislation_documents')
    .select('rada_nreg')
    .range(page * pageSize, (page + 1) * pageSize - 1)
    .order('rada_nreg');
  
  if (error) throw new Error(`Supabase query error: ${error.message}`);
  if (!docs || docs.length === 0) {
    return { total: 0, pass: 0, fail: 0, results: [] };
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Verify All (page ${page + 1}, ${docs.length} documents)`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  const results: VerifyResult[] = [];
  
  for (const doc of docs) {
    try {
      const result = await verifyDocument(doc.rada_nreg, { writeHealth });
      results.push(result);
    } catch (e: any) {
      results.push({
        nreg: doc.rada_nreg,
        pass: false,
        issues: [{ component: 'System', check: 'verify execution', status: 'FAIL', reason: e.message }],
      });
    }
  }
  
  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass).length;
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Batch Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Total: ${results.length}`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  
  if (fail > 0) {
    console.log(`\nTop FAIL reasons:`);
    const failReasons = new Map<string, number>();
    results.filter(r => !r.pass).forEach(r => {
      r.issues.forEach(i => {
        const key = `${i.component}: ${i.check}`;
        failReasons.set(key, (failReasons.get(key) || 0) + 1);
      });
    });
    Array.from(failReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([reason, count]) => {
        console.log(`  - ${reason}: ${count}`);
      });
  }
  
  // Evidence mode: SQL queries
  if (options?.evidence) {
    await printEvidenceQueries();
  }
  
  return { total: results.length, pass, fail, results };
}
