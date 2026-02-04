/**
 * Repair act groups command — перерахунок act_group полів
 * 
 * PHASE 10: Act Group semantics fix + backfill
 */
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } from '../lib/qdrantAdmin.js';
import { determineActGroup } from '../canonical/actGrouping.js';

export async function repairActGroups(opts: {
  nreg?: string;
  all?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  
  let docs: Array<{ rada_nreg: string; title: string; document_type: string; law_number: string | null }> = [];
  
  if (opts.nreg) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title,document_type,law_number')
      .eq('rada_nreg', opts.nreg)
      .maybeSingle();
    
    if (error) throw new Error(`Supabase select error: ${error.message}`);
    if (data) docs = [data];
  } else if (opts.all) {
    const { data, error } = await supabase
      .from('legislation_documents')
      .select('rada_nreg,title,document_type,law_number');
    
    if (error) throw new Error(`Supabase select error: ${error.message}`);
    docs = data || [];
  } else {
    throw new Error('Треба вказати --nreg або --all');
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Repair Act Groups`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  console.log(`Found ${docs.length} documents\n`);
  
  let updated = 0;
  let nulled = 0;
  let unchanged = 0;
  const errors: Array<{ nreg: string; error: string }> = [];
  
  for (const doc of docs) {
    const actGroup = determineActGroup({
      title: doc.title,
      documentType: doc.document_type || '',
      lawNumber: doc.law_number,
    });
    
    // Перевіряємо чи щось змінилось
    const { data: current } = await supabase
      .from('legislation_documents')
      .select('act_group_key,act_is_part,act_part_label,act_group_title')
      .eq('rada_nreg', doc.rada_nreg)
      .single();
    
    if (!current) {
      errors.push({ nreg: doc.rada_nreg, error: 'Document not found' });
      continue;
    }
    
    const hasChanges = 
      (current.act_group_key || '') !== (actGroup.act_group_key || '') ||
      current.act_is_part !== actGroup.act_is_part ||
      (current.act_part_label || '') !== (actGroup.act_part_label || '') ||
      (current.act_group_title || '') !== (actGroup.act_group_title || '');
    
    if (!hasChanges) {
      unchanged++;
      continue;
    }
    
    console.log(`\n[${doc.rada_nreg}] ${doc.title}`);
    console.log(`  Old: group_key=${current.act_group_key || 'NULL'}, is_part=${current.act_is_part}, label=${current.act_part_label || 'NULL'}`);
    console.log(`  New: group_key=${actGroup.act_group_key || 'NULL'}, is_part=${actGroup.act_is_part}, label=${actGroup.act_part_label || 'NULL'}`);
    
    if (opts.dryRun) {
      console.log(`  [DRY-RUN] Would update act_group fields`);
      if (actGroup.act_group_key) {
        updated++;
      } else {
        nulled++;
      }
      continue;
    }
    
    // Update Supabase
    const { error: updError } = await supabase
      .from('legislation_documents')
      .update({
        act_group_key: actGroup.act_group_key || null,
        act_is_part: actGroup.act_is_part,
        act_part_label: actGroup.act_part_label,
        act_group_title: actGroup.act_group_title,
      })
      .eq('rada_nreg', doc.rada_nreg);
    
    if (updError) {
      console.log(`  ❌ Supabase update failed: ${updError.message}`);
      errors.push({ nreg: doc.rada_nreg, error: `Supabase: ${updError.message}` });
      continue;
    }
    
    // Update Qdrant payloads
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
            payload: {
              act_group_key: actGroup.act_group_key || null,
              act_part_label: actGroup.act_part_label,
            },
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
            payload: {
              act_group_key: actGroup.act_group_key || null,
              act_part_label: actGroup.act_part_label,
            },
            points: [point.id as string],
          });
        }
        console.log(`  → Updated ${acts.points.length} acts in Qdrant`);
      }
    } catch (e: any) {
      console.log(`  ⚠️  Qdrant update failed: ${e.message}`);
      errors.push({ nreg: doc.rada_nreg, error: `Qdrant: ${e.message}` });
    }
    
    if (actGroup.act_group_key) {
      updated++;
    } else {
      nulled++;
    }
  }
  
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Summary`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Updated (with act_group_key): ${updated}`);
  console.log(`Nulled (removed act_group_key): ${nulled}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log(`\nErrors:`);
    errors.forEach(({ nreg, error }) => {
      console.log(`  - ${nreg}: ${error}`);
    });
  }
}
