/**
 * Status command — перевірка готовності інфраструктури
 */

export async function checkReadiness() {
  const { createSupabaseAdminClient } = await import('../lib/supabaseAdmin.js');
  const { createQdrantClient, QDRANT_COLLECTION_ACTS, QDRANT_COLLECTION_CHUNKS } = await import('../lib/qdrantAdmin.js');
  const { getR2AdminClient } = await import('../lib/r2Admin.js');
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');

  console.log('## Status');

  // Supabase
  const supabase = createSupabaseAdminClient();
  const [{ count: docs }, { count: chunks }, { data: jobs }] = await Promise.all([
    supabase.from('legislation_documents').select('rada_nreg', { head: true, count: 'exact' }),
    supabase.from('legislation_chunks').select('id', { head: true, count: 'exact' }),
    supabase
      .from('legislation_import_jobs')
      .select('status, total_count, processed_count, success_count, error_count, started_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  console.log(`- supabase.documents: ${String(docs ?? 0)}`);
  console.log(`- supabase.chunks: ${String(chunks ?? 0)}`);
  console.log(`- supabase.last_jobs: ${JSON.stringify(jobs ?? [])}`);

  // Qdrant
  const qdrant = createQdrantClient();
  const [chunksInfo, actsInfo] = await Promise.all([
    qdrant.getCollection(QDRANT_COLLECTION_CHUNKS),
    qdrant.getCollection(QDRANT_COLLECTION_ACTS),
  ]);
  console.log(`- qdrant.${QDRANT_COLLECTION_CHUNKS}.points: ${String((chunksInfo as any).points_count ?? 0)}`);
  console.log(`- qdrant.${QDRANT_COLLECTION_ACTS}.points: ${String((actsInfo as any).points_count ?? 0)}`);

  // R2 (Legislation bucket only) — show few keys for sanity
  const { client: r2, bucket } = getR2AdminClient();
  const list = await r2.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'legislation/', MaxKeys: 10 }));
  const keys = (list.Contents || []).map(o => o.Key).filter(Boolean);
  console.log(`- r2.sample_keys: ${JSON.stringify(keys)}`);

  // Config (names only)
  console.log('- env_required: ["SUPABASE_LEGISLATION_URL","SUPABASE_LEGISLATION_SERVICE_ROLE_KEY","R2_ENDPOINT","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_LEGISLATION_BUCKET (or default)","qdrant_clusterENDPOINT_LEXERY_LEGISLATION_DB","qdrant_clusterAPI_LEXERY_LEGISLATION_DB","OPEN_ROUTER_API_RAG"]');
}
