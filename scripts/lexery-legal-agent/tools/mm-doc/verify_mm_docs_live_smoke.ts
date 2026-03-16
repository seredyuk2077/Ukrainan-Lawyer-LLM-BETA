#!/usr/bin/env node
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import * as XLSX from 'xlsx';
import { buildTextImagePngBuffer, canBuildTextImagePng } from './image-fixture.js';
import { buildMinimalXlsxBuffer } from './xlsx-fixture.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), 'scripts/lexery-legal-agent/.env') });

process.env.MM_DOCS_ENABLED ??= 'true';

function normalizeEndpoint(value: string | undefined | null): string {
  return (value || '').trim().replace(/\/+$/, '').toLowerCase();
}

type ScopeSpec = {
  tenantId: string;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
  requestedScope?: 'conversation' | 'project' | 'user_global';
};

type IngestedDoc = {
  label: string;
  docId: string;
  canonicalR2Key: string;
  rawR2Key: string;
  query: string;
  expectedNeedle: string;
  scope: ScopeSpec;
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contains(text: string, needle: string): boolean {
  return normalize(text).includes(normalize(needle));
}

async function buildContractDocx(params: {
  title: string;
  clause: string;
  counterparty: string;
  amount: string;
  note: string;
}): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: params.title, bold: true })],
          }),
          new Paragraph(`Контрагент: ${params.counterparty}`),
          new Paragraph(`Ключова умова: ${params.clause}`),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Показник')] }),
                  new TableCell({ children: [new Paragraph('Значення')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Сума')] }),
                  new TableCell({ children: [new Paragraph(params.amount)] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Примітка')] }),
                  new TableCell({ children: [new Paragraph(params.note)] }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function main(): Promise<void> {
  const { config } = await import('../../lib/config.js');
  const { getSupabaseClient } = await import('../../lib/supabase.js');
  const { putMmDocRaw, getMmDocCanonical } = await import('../../mm/doc/r2.js');
  const { ingestMmDocFromRawR2 } = await import('../../mm/doc/ingest.js');
  const { retrieveMmDocsForQuery } = await import('../../mm/doc/retrieve.js');
  const { listMmDocsForScope, ensureMmDocTablesReady } = await import('../../mm/doc/store.js');
  const { ensureMmDocsCollection } = await import('../../mm/doc/qdrant.js');
  const resolvedDocsQdrantEndpoint = normalizeEndpoint(config.mmDocsQdrantUrl);

  const dedicatedQdrantConfigured = Boolean(
    process.env.MM_DOCS_QDRANT_URL ||
      process.env.QDRANT_DOCS_URL ||
      process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA_DOCS
  );
  const qdrantSharedWithMemory = Boolean(
    resolvedDocsQdrantEndpoint &&
      normalizeEndpoint(
        process.env.QDRANT_MEMORY_URL ||
          process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
          process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
          process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
          ''
      ) &&
      resolvedDocsQdrantEndpoint ===
        normalizeEndpoint(
          process.env.QDRANT_MEMORY_URL ||
            process.env.QDRANT_CLUSTER_ENDPOINT_LEXERY_LA ||
            process.env.qdrant_clusterENDPOINT_LEXERY_LA ||
            process.env.Qdrant_clusterENDPOINT_LEXERY_LA ||
            ''
        )
  );

  assert(config.mmDocsEnabled, 'MM Docs must be enabled');
  assert(config.mmDocsQdrantUrl && config.mmDocsQdrantApiKey, 'MM Docs Qdrant must be configured');

  await ensureMmDocTablesReady();
  await ensureMmDocsCollection();

  const sb = getSupabaseClient();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const projectA = randomUUID();
  const conversationA1 = randomUUID();
  const conversationA2 = randomUUID();
  const conversationA3 = randomUUID();
  const conversationB1 = randomUUID();
  const conversationTenantB = randomUUID();

  const docs: IngestedDoc[] = [];

  const createDoc = async (params: {
    label: string;
    filename: string;
    contentType: string;
    buffer: Buffer;
    scope: ScopeSpec;
    sourceKind: 'chat_attachment' | 'project_upload' | 'user_upload';
    query: string;
    expectedNeedle: string;
  }): Promise<void> => {
    const rawDocId = randomUUID();
    const { r2Key: rawR2Key } = await putMmDocRaw({
      tenantId: params.scope.tenantId,
      userId: params.scope.userId,
      docId: rawDocId,
      filename: params.filename,
      contentType: params.contentType,
      buffer: params.buffer,
    });

    const ingested = await ingestMmDocFromRawR2({
      tenantId: params.scope.tenantId,
      userId: params.scope.userId,
      conversationId: params.scope.conversationId ?? null,
      projectId: params.scope.projectId ?? null,
      requestedScope: params.scope.requestedScope ?? null,
      sourceKind: params.sourceKind,
      rawR2Key,
      filename: params.filename,
      contentType: params.contentType,
    });

    const canonical = await getMmDocCanonical(ingested.canonicalR2Key);
    assert(canonical.doc_id === ingested.docId, `${params.label}: canonical doc id mismatch`);
    assert(canonical.original_filename === params.filename, `${params.label}: canonical filename mismatch`);

    const { data: row, error: rowError } = await sb
      .from('mm_doc_records')
      .select('id,status,scope_type,scope_id,chunk_count,canonical_r2_key')
      .eq('id', ingested.docId)
      .maybeSingle();
    if (rowError) throw new Error(`${params.label}: mm_doc_records query failed: ${rowError.message}`);
    assert(row?.status === 'indexed', `${params.label}: record must be indexed`);
    assert((row?.chunk_count ?? 0) > 0, `${params.label}: chunk_count must be > 0`);
    assert(row?.canonical_r2_key === ingested.canonicalR2Key, `${params.label}: canonical key mismatch in DB`);

    const { data: logs, error: logError } = await sb
      .from('mm_doc_ingest_log')
      .select('stage,status')
      .eq('doc_id', ingested.docId)
      .order('created_at', { ascending: true });
    if (logError) throw new Error(`${params.label}: mm_doc_ingest_log query failed: ${logError.message}`);
    const stages = new Set((logs ?? []).map((item) => `${item.stage}:${item.status}`));
    assert(stages.has('ingest_started:ok'), `${params.label}: missing ingest_started log`);
    assert(stages.has('indexed:ok'), `${params.label}: missing indexed log`);

    docs.push({
      label: params.label,
      docId: ingested.docId,
      canonicalR2Key: ingested.canonicalR2Key,
      rawR2Key,
      query: params.query,
      expectedNeedle: params.expectedNeedle,
      scope: params.scope,
    });
  };

  const convDoc = await buildContractDocx({
    title: 'Договір поставки яблук',
    clause: 'штраф за прострочення поставки яблук становить 12 відсотків за кожен день затримки',
    counterparty: 'ТОВ Альфа Сад',
    amount: '120000 грн',
    note: 'кодова фраза CHAT_SCOPE_NEEDLE',
  });
  await createDoc({
    label: 'conversation-doc',
    filename: 'chat-contract.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: convDoc,
    scope: {
      tenantId: tenantA,
      userId: userA,
      conversationId: conversationA1,
      projectId: projectA,
      requestedScope: 'conversation',
    },
    sourceKind: 'chat_attachment',
    query: 'Який штраф за прострочення поставки яблук?',
    expectedNeedle: '12 відсотків за кожен день затримки',
  });

  const projectCsv = Buffer.from(
    [
      'field,value',
      'guarantee_term,гарантійний платіж повертається за 7 банківських днів',
      'price,48000 грн',
      'marker,PROJECT_SCOPE_NEEDLE',
    ].join('\n'),
    'utf8'
  );
  const projectSheet = buildMinimalXlsxBuffer({
    sheetName: 'ProjectTerms',
    rows: [
      ['Показник', 'Значення'],
      ['Передсудове врегулювання', '15 робочих днів'],
      ['Маркер', 'PROJECT_XLSX_NEEDLE'],
    ],
  });
  const legacyWorkbook = XLSX.utils.book_new();
  const legacySheet = XLSX.utils.aoa_to_sheet([
    ['Показник', 'Значення'],
    ['Строк усунення дефекту', '48 годин'],
    ['Маркер', 'PROJECT_XLS_NEEDLE'],
  ]);
  XLSX.utils.book_append_sheet(legacyWorkbook, legacySheet, 'LegacyTerms');
  const legacyProjectSheet = Buffer.from(XLSX.write(legacyWorkbook, { type: 'buffer', bookType: 'biff8' }) as Uint8Array);
  await createDoc({
    label: 'project-doc',
    filename: 'project-terms.csv',
    contentType: 'text/csv',
    buffer: projectCsv,
    scope: {
      tenantId: tenantA,
      userId: userA,
      projectId: projectA,
      requestedScope: 'project',
    },
    sourceKind: 'project_upload',
    query: 'Коли повертається гарантійний платіж?',
    expectedNeedle: 'повертається за 7 банківських днів',
  });

  const globalText = Buffer.from(
    [
      'Внутрішня політика користувача.',
      'Арбітражна обмовка: усі спори розглядаються за правилами ICC у Парижі англійською мовою.',
      'GLOBAL_SCOPE_NEEDLE',
    ].join('\n'),
    'utf8'
  );
  await createDoc({
    label: 'project-xlsx-doc',
    filename: 'project-terms.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: projectSheet,
    scope: {
      tenantId: tenantA,
      userId: userA,
      projectId: projectA,
      requestedScope: 'project',
    },
    sourceKind: 'project_upload',
    query: 'Який строк передсудового врегулювання у моїй проектній таблиці?',
    expectedNeedle: '15 робочих днів',
  });
  await createDoc({
    label: 'project-xls-doc',
    filename: 'legacy-project-terms.xls',
    contentType: 'application/vnd.ms-excel',
    buffer: legacyProjectSheet,
    scope: {
      tenantId: tenantA,
      userId: userA,
      projectId: projectA,
      requestedScope: 'project',
    },
    sourceKind: 'project_upload',
    query: 'Який строк усунення дефекту у моїй старій excel таблиці?',
    expectedNeedle: '48 годин',
  });

  await createDoc({
    label: 'global-doc',
    filename: 'global-policy.txt',
    contentType: 'text/plain',
    buffer: globalText,
    scope: {
      tenantId: tenantA,
      userId: userA,
      requestedScope: 'user_global',
    },
    sourceKind: 'user_upload',
    query: 'Яка арбітражна обмовка в моїх документах?',
    expectedNeedle: 'за правилами ICC у Парижі англійською мовою',
  });

  const foreignConvText = Buffer.from(
    'У цій іншій розмові є унікальна умова: штраф 99 відсотків за манго. FOREIGN_CHAT_NEEDLE',
    'utf8'
  );
  await createDoc({
    label: 'foreign-chat-doc',
    filename: 'foreign-chat.txt',
    contentType: 'text/plain',
    buffer: foreignConvText,
    scope: {
      tenantId: tenantA,
      userId: userA,
      conversationId: conversationA2,
      projectId: projectA,
      requestedScope: 'conversation',
    },
    sourceKind: 'chat_attachment',
    query: 'манго 99 відсотків',
    expectedNeedle: 'манго',
  });

  const foreignUserText = Buffer.from(
    'Документ іншого користувача: депозит повертається через 90 днів. FOREIGN_USER_NEEDLE',
    'utf8'
  );
  await createDoc({
    label: 'foreign-user-doc',
    filename: 'foreign-user.txt',
    contentType: 'text/plain',
    buffer: foreignUserText,
    scope: {
      tenantId: tenantA,
      userId: userB,
      conversationId: conversationB1,
      requestedScope: 'conversation',
    },
    sourceKind: 'chat_attachment',
    query: 'депозит 90 днів',
    expectedNeedle: '90 днів',
  });

  const foreignTenantText = Buffer.from(
    'Той самий користувач, але інший tenant: аванс повертається через 33 дні. FOREIGN_TENANT_NEEDLE',
    'utf8'
  );
  if (canBuildTextImagePng()) {
    await createDoc({
      label: 'image-doc',
      filename: 'scan.png',
      contentType: 'image/png',
      buffer: buildTextImagePngBuffer({
        filenameBase: 'scan',
        text: ['Арбітраж ICC зі скану', 'Строк | 15 робочих днів', 'IMAGE_SCOPE_NEEDLE'].join('\n'),
      }),
      scope: {
        tenantId: tenantA,
        userId: userA,
        conversationId: conversationA3,
        requestedScope: 'conversation',
      },
      sourceKind: 'chat_attachment',
      query: 'Який строк у моєму сканованому документі?',
      expectedNeedle: '15 робочих днів',
    });
  }

  await createDoc({
    label: 'foreign-tenant-doc',
    filename: 'foreign-tenant.txt',
    contentType: 'text/plain',
    buffer: foreignTenantText,
    scope: {
      tenantId: tenantB,
      userId: userA,
      conversationId: conversationTenantB,
      requestedScope: 'conversation',
    },
    sourceKind: 'chat_attachment',
    query: 'аванс 33 дні',
    expectedNeedle: '33 дні',
  });

  const docsByLabel = new Map(docs.map((doc) => [doc.label, doc]));

  const ownScopeDocs = await listMmDocsForScope({
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
  });
  const ownScopeIds = new Set(ownScopeDocs.map((row) => row.id));
  assert(ownScopeIds.has(docsByLabel.get('conversation-doc')!.docId), 'scope list must include conversation doc');
  assert(ownScopeIds.has(docsByLabel.get('project-doc')!.docId), 'scope list must include project doc');
  assert(ownScopeIds.has(docsByLabel.get('project-xlsx-doc')!.docId), 'scope list must include project xlsx doc');
  assert(ownScopeIds.has(docsByLabel.get('project-xls-doc')!.docId), 'scope list must include project xls doc');
  assert(ownScopeIds.has(docsByLabel.get('global-doc')!.docId), 'scope list must include global doc');
  assert(!ownScopeIds.has(docsByLabel.get('foreign-chat-doc')!.docId), 'scope list must exclude foreign chat doc');
  assert(!ownScopeIds.has(docsByLabel.get('foreign-user-doc')!.docId), 'scope list must exclude foreign user doc');
  assert(!ownScopeIds.has(docsByLabel.get('foreign-tenant-doc')!.docId), 'scope list must exclude foreign tenant doc');

  const expectOwnHit = async (params: {
    label: string;
    tenantId: string;
    userId: string;
    conversationId?: string | null;
    projectId?: string | null;
    forbiddenDocLabels?: string[];
  }): Promise<void> => {
    const doc = docsByLabel.get(params.label);
    if (!doc) throw new Error(`Unknown doc label ${params.label}`);
    const hits = await retrieveMmDocsForQuery({
      queryText: doc.query,
      tenantId: params.tenantId,
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      projectId: params.projectId ?? null,
      topK: 6,
    });
    assert(hits.length > 0, `${params.label}: expected at least one retrieval hit`);
    assert(hits.some((hit) => hit.doc_id === doc.docId), `${params.label}: expected own doc in retrieval hits`);
    assert(
      hits.some((hit) => contains(hit.text, doc.expectedNeedle)),
      `${params.label}: expected retrieved text to contain target clause`
    );
    for (const foreignLabel of params.forbiddenDocLabels ?? []) {
      const foreign = docsByLabel.get(foreignLabel);
      if (!foreign) continue;
      assert(
        !hits.some((hit) => hit.doc_id === foreign.docId),
        `${params.label}: retrieval leaked foreign doc ${foreignLabel}`
      );
    }
  };

  const expectNoForeignLeak = async (params: {
    queryingLabel: string;
    tenantId: string;
    userId: string;
    conversationId?: string | null;
    projectId?: string | null;
  }): Promise<void> => {
    const foreignDoc = docsByLabel.get(params.queryingLabel);
    if (!foreignDoc) throw new Error(`Unknown doc label ${params.queryingLabel}`);
    const hits = await retrieveMmDocsForQuery({
      queryText: foreignDoc.query,
      tenantId: params.tenantId,
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      projectId: params.projectId ?? null,
      topK: 6,
    });
    assert(
      !hits.some((hit) => hit.doc_id === foreignDoc.docId),
      `${params.queryingLabel}: foreign doc leaked into retrieval`
    );
  };

  await expectOwnHit({
    label: 'conversation-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
    forbiddenDocLabels: ['foreign-chat-doc', 'foreign-user-doc', 'foreign-tenant-doc'],
  });
  await expectOwnHit({
    label: 'project-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
    forbiddenDocLabels: ['foreign-user-doc', 'foreign-tenant-doc'],
  });
  await expectOwnHit({
    label: 'project-xlsx-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
    forbiddenDocLabels: ['foreign-user-doc', 'foreign-tenant-doc'],
  });
  await expectOwnHit({
    label: 'project-xls-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
    forbiddenDocLabels: ['foreign-user-doc', 'foreign-tenant-doc'],
  });
  await expectOwnHit({
    label: 'global-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
    forbiddenDocLabels: ['foreign-user-doc', 'foreign-tenant-doc'],
  });
  if (canBuildTextImagePng()) {
    await expectOwnHit({
      label: 'image-doc',
      tenantId: tenantA,
      userId: userA,
      conversationId: conversationA3,
      projectId: null,
      forbiddenDocLabels: ['foreign-user-doc', 'foreign-tenant-doc'],
    });
  }
  await expectOwnHit({
    label: 'foreign-tenant-doc',
    tenantId: tenantB,
    userId: userA,
    conversationId: conversationTenantB,
    projectId: null,
    forbiddenDocLabels: ['conversation-doc', 'project-doc', 'global-doc'],
  });

  await expectNoForeignLeak({
    queryingLabel: 'foreign-chat-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
  });
  await expectNoForeignLeak({
    queryingLabel: 'foreign-user-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
  });
  await expectNoForeignLeak({
    queryingLabel: 'foreign-tenant-doc',
    tenantId: tenantA,
    userId: userA,
    conversationId: conversationA1,
    projectId: projectA,
  });

  console.log('MM Docs live smoke: PASS');
  console.log(
    JSON.stringify(
      {
        bucket: config.mmDocsBucket,
        qdrant_collection: config.mmDocsQdrantCollection,
        dedicated_qdrant_configured: dedicatedQdrantConfigured,
        qdrant_shared_with_memory: qdrantSharedWithMemory,
        docs_indexed: docs.length,
        tenant_a: tenantA,
        tenant_b: tenantB,
        user_a: userA,
        user_b: userB,
        conversation_a1: conversationA1,
        conversation_a2: conversationA2,
        conversation_a3: conversationA3,
        project_a: projectA,
        indexed_doc_ids: docs.map((doc) => ({ label: doc.label, doc_id: doc.docId })),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('MM Docs live smoke: FAIL');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
