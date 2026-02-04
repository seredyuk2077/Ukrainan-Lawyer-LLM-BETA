/**
 * Collect Critical Evidence — збір evidence для CRITICAL документів
 * 
 * Для кожного CRITICAL документа збирає:
 * - Supabase row (core fields + typ/organs)
 * - R2 canonical (summary_prefix, snippet200, raw.rada_api_txt)
 * - Qdrant (1 act payload + 2 chunks payload)
 */

import { resolve } from 'path';
import { workspaceRoot } from '../lib/config.js';
import { createSupabaseAdminClient } from '../lib/supabaseAdmin.js';
import { getJsonFromR2 } from '../lib/r2Json.js';
import { createQdrantClient, QDRANT_COLLECTION_CHUNKS, QDRANT_COLLECTION_ACTS } from '../lib/qdrantAdmin.js';

interface CriticalEvidence {
  nreg: string;
  supabase: {
    rada_nreg: string;
    title: string;
    document_type_slug: string | null;
    document_type: string | null;
    category: string | null;
    sync_health: string | null;
    typ: number | null;
    organs: any;
    r2_key: string | null;
  };
  r2: {
    summary_prefix: string | null;
    snippet200: string | null;
    raw_txt_prefix: string | null;  // Перші 800 символів raw.rada_api_txt
  };
  qdrant: {
    act_payload: any | null;
    chunks_payloads: Array<{
      chunk_index: number;
      document_type_slug: string | null;
      document_type: string | null;
      category: string | null;
      content_hash: string | null;
    }>;
  };
}

async function collectEvidenceForOne(nreg: string): Promise<CriticalEvidence> {
  const supabase = createSupabaseAdminClient();
  
  // Supabase
  const { data: doc, error } = await supabase
    .from('legislation_documents')
    .select('*')
    .eq('rada_nreg', nreg)
    .maybeSingle();
  
  if (error || !doc) {
    throw new Error(`Document not found: ${nreg}`);
  }
  
  // R2 canonical
  let summaryPrefix: string | null = null;
  let snippet200: string | null = null;
  let rawTxtPrefix: string | null = null;
  
  try {
    if (doc.r2_key) {
      const canonical = await getJsonFromR2(doc.r2_key);
      
      const summary = canonical.ai_enrichment?.summary || (doc.summary as string | null) || null;
      if (summary) {
        summaryPrefix = summary.substring(0, 120);
      }
      
      // snippet200 з raw.rada_api_txt (пріоритет) або chunks
      if (canonical.raw?.rada_api_txt) {
        snippet200 = canonical.raw.rada_api_txt.substring(0, 200);
        rawTxtPrefix = canonical.raw.rada_api_txt.substring(0, 800);
      } else if (canonical.content?.chunks?.[0]?.text) {
        snippet200 = canonical.content.chunks[0].text.substring(0, 200);
      }
    }
  } catch (e) {
    // Пропускаємо якщо не вдалося прочитати R2
  }
  
  // Qdrant
  const qdrant = createQdrantClient();
  let actPayload: any | null = null;
  const chunksPayloads: any[] = [];
  
  try {
    // Act payload
    const actScroll = await qdrant.scroll(QDRANT_COLLECTION_ACTS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: nreg } }],
      },
      limit: 1,
      with_payload: true,
    } as any);
    
    const actPoints = (actScroll as any).points || [];
    if (actPoints.length > 0) {
      actPayload = actPoints[0].payload;
    }
    
    // Chunks payloads (2 перші)
    const chunksScroll = await qdrant.scroll(QDRANT_COLLECTION_CHUNKS, {
      filter: {
        must: [{ key: 'rada_nreg', match: { value: nreg } }],
      },
      limit: 2,
      with_payload: true,
    } as any);
    
    const chunkPoints = (chunksScroll as any).points || [];
    for (const point of chunkPoints) {
      chunksPayloads.push({
        chunk_index: point.payload?.chunk_index || null,
        document_type_slug: point.payload?.document_type_slug || null,
        document_type: point.payload?.document_type || null,
        category: point.payload?.category || null,
        content_hash: point.payload?.content_hash || null,
      });
    }
  } catch (e) {
    // Пропускаємо якщо не вдалося прочитати Qdrant
  }
  
  return {
    nreg,
    supabase: {
      rada_nreg: doc.rada_nreg,
      title: doc.title || '',
      document_type_slug: doc.document_type_slug || null,
      document_type: doc.document_type || null,
      category: doc.category || null,
      sync_health: doc.sync_health || null,
      typ: (doc as any).typ || null,
      organs: (doc as any).organs || null,
      r2_key: doc.r2_key || null,
    },
    r2: {
      summary_prefix: summaryPrefix,
      snippet200: snippet200,
      raw_txt_prefix: rawTxtPrefix,
    },
    qdrant: {
      act_payload: actPayload,
      chunks_payloads: chunksPayloads,
    },
  };
}

export async function collectCriticalEvidence(): Promise<void> {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Collect Critical Evidence`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  
  // Читаємо CRITICAL список з audit
  const fs = await import('fs/promises');
  const auditData = JSON.parse(
    await fs.readFile(resolve(workspaceRoot(), 'runs', 'audit', 'DOC_TYPE_AUDIT_190.json'), 'utf-8')
  );
  
  const criticalNregs = auditData
    .filter((r: any) => r.severity === 'CRITICAL')
    .map((r: any) => r.nreg)
    .sort();
  
  console.log(`📋 Found ${criticalNregs.length} CRITICAL documents\n`);
  
  const evidence: CriticalEvidence[] = [];
  
  for (let i = 0; i < criticalNregs.length; i++) {
    const nreg = criticalNregs[i];
    process.stdout.write(`[${i + 1}/${criticalNregs.length}] ${nreg}... `);
    
    try {
      const ev = await collectEvidenceForOne(nreg);
      evidence.push(ev);
      console.log(`✅`);
    } catch (e) {
      console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // Генеруємо Markdown звіт
  let md = `# CRITICAL 12 Evidence\n\n`;
  md += `**Дата:** ${new Date().toISOString()}\n\n`;
  
  for (const ev of evidence) {
    md += `## ${ev.nreg}\n\n`;
    md += `**Title:** ${ev.supabase.title}\n\n`;
    
    md += `### Supabase\n`;
    md += `- document_type_slug: \`${ev.supabase.document_type_slug || 'NULL'}\`\n`;
    md += `- document_type: \`${ev.supabase.document_type || 'NULL'}\`\n`;
    md += `- category: \`${ev.supabase.category || 'NULL'}\`\n`;
    md += `- sync_health: \`${ev.supabase.sync_health || 'NULL'}\`\n`;
    md += `- typ: \`${ev.supabase.typ || 'NULL'}\`\n`;
    md += `- organs: \`${JSON.stringify(ev.supabase.organs) || 'NULL'}\`\n\n`;
    
    md += `### R2 Canonical\n`;
    md += `**Summary Prefix (120):**\n\`\`\`\n${ev.r2.summary_prefix || 'N/A'}\n\`\`\`\n\n`;
    md += `**Snippet200 (200):**\n\`\`\`\n${ev.r2.snippet200 || 'N/A'}\n\`\`\`\n\n`;
    md += `**Raw TXT Prefix (800):**\n\`\`\`\n${ev.r2.raw_txt_prefix || 'N/A'}\n\`\`\`\n\n`;
    
    md += `### Qdrant\n`;
    md += `**Act Payload:**\n\`\`\`json\n${JSON.stringify(ev.qdrant.act_payload, null, 2) || 'N/A'}\n\`\`\`\n\n`;
    md += `**Chunks Payloads:**\n\`\`\`json\n${JSON.stringify(ev.qdrant.chunks_payloads, null, 2) || 'N/A'}\n\`\`\`\n\n`;
    
    md += `---\n\n`;
  }
  
  await fs.writeFile(resolve(workspaceRoot(), 'runs', 'audit', 'CRITICAL_12_EVIDENCE.md'), md, 'utf-8');
  console.log(`\n✅ Evidence збережено: runs/audit/CRITICAL_12_EVIDENCE.md`);
  
  // Також зберігаємо JSON
  await fs.writeFile(
    resolve(workspaceRoot(), 'runs', 'audit', 'CRITICAL_12_EVIDENCE.json'),
    JSON.stringify(evidence, null, 2),
    'utf-8'
  );
  console.log(`✅ Evidence JSON збережено: runs/audit/CRITICAL_12_EVIDENCE.json`);
}
