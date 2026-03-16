#!/usr/bin/env node
import { extractInternalR2KeyFromUrl, processAttachments } from '../../gateway/attachments.js';
import { CreateRunRequestSchema } from '../../gateway/types.js';
import { config } from '../../lib/config.js';
import { RunRepository } from '../../gateway/storage.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function testExtractInternalR2KeyFromUrl(): Promise<void> {
  const key = extractInternalR2KeyFromUrl({
    url: 'https://example-r2.test/lexery-legal-agent/tenant/t/runs/run-1/attachments/contract.docx?X-Amz-Signature=abc',
    endpoint: 'https://example-r2.test',
    allowedBuckets: ['lexery-legal-agent'],
  });
  assert(
    key === 'tenant/t/runs/run-1/attachments/contract.docx',
    `expected internal key extraction, got ${String(key)}`
  );
  console.log('[OK] gateway attachment extracts internal R2 key');
}

async function testRejectExternalPresignedUrl(): Promise<void> {
  const result = await processAttachments(
    [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        presignedUrl: 'https://evil.example.com/contract.docx?sig=abc',
      },
    ],
    'tenant-1',
    'user-1',
    'run-1'
  );
  assert(result.manifest.length === 0, `external presigned URL must be skipped, got ${result.manifest.length}`);
  assert(
    result.warnings.some((warning) => warning.includes('unsupported presigned URL source')),
    'external presigned URL must emit warning'
  );
  console.log('[OK] gateway attachment rejects external presigned URL');
}

async function testAllowSameUserMmDocRawPresignedUrl(): Promise<void> {
  const endpoint = config.r2Endpoint || 'https://example-r2.test';
  const result = await processAttachments(
    [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        presignedUrl:
          `${endpoint}/lexery-legal-agent/tenant/tenant-1/mm/docs/user/user-1/raw/doc-1/contract.docx?sig=abc`,
      },
    ],
    'tenant-1',
    'user-1',
    'run-1'
  );
  assert(result.manifest.length === 1, `same-user MM Docs raw URL must be accepted, got ${result.manifest.length}`);
  assert(result.manifest[0]?.storage === 'r2', 'same-user MM Docs raw URL should resolve to r2 storage');
  console.log('[OK] gateway attachment accepts same-user MM Docs raw URL');
}

async function testAllowSameUserRunsAttachmentPresignedUrl(): Promise<void> {
  const endpoint = config.r2Endpoint || 'https://example-r2.test';
  const original = RunRepository.prototype.findByRunId;
  try {
    RunRepository.prototype.findByRunId = async function mockedFindByRunId() {
      return {
        run_id: 'run-foreign',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
      } as Awaited<ReturnType<RunRepository['findByRunId']>>;
    };
    const result = await processAttachments(
      [
        {
          name: 'same-user-run-attachment.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          presignedUrl:
            `${endpoint}/lexery-legal-agent/tenant/tenant-1/runs/run-foreign/attachments/same-user-run-attachment.docx?sig=abc`,
        },
      ],
      'tenant-1',
      'user-1',
      'run-1'
    );
    assert(result.manifest.length === 1, `same-user runs attachment URL must be accepted, got ${result.manifest.length}`);
    assert(result.manifest[0]?.storage === 'r2', 'same-user runs attachment URL should resolve to r2 storage');
    console.log('[OK] gateway attachment accepts same-user runs attachment URL');
  } finally {
    RunRepository.prototype.findByRunId = original;
  }
}

async function testRejectForeignMmDocPresignedUrl(): Promise<void> {
  const endpoint = config.r2Endpoint || 'https://example-r2.test';
  const original = RunRepository.prototype.findByRunId;
  try {
    RunRepository.prototype.findByRunId = async function mockedFindByRunId(runId: string) {
      if (runId === 'foreign-run') {
        return {
          run_id: 'foreign-run',
          tenant_id: 'tenant-1',
          user_id: 'other-user',
        } as Awaited<ReturnType<RunRepository['findByRunId']>>;
      }
      return null;
    };
  const result = await processAttachments(
    [
      {
        name: 'foreign-contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        presignedUrl:
          `${endpoint}/lexery-legal-agent/tenant/tenant-1/mm/docs/user/other-user/raw/doc-1/foreign-contract.docx?sig=abc`,
      },
      {
        name: 'canonical.json',
        contentType: 'application/json',
        presignedUrl:
          `${endpoint}/lexery-legal-agent/tenant/tenant-1/mm/docs/user/user-1/scope/project/proj-1/doc-1/canonical.v1.json?sig=abc`,
      },
      {
        name: 'foreign-run-attachment.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        presignedUrl:
          `${endpoint}/lexery-legal-agent/tenant/tenant-1/runs/foreign-run/attachments/foreign-run-attachment.docx?sig=abc`,
      },
    ],
    'tenant-1',
    'user-1',
    'run-1'
  );
  assert(result.manifest.length === 0, `foreign/canonical MM Docs URLs must be skipped, got ${result.manifest.length}`);
  assert(
    result.warnings.filter((warning) => warning.includes('outside the caller tenant/user attachment namespace')).length === 3,
    'foreign/canonical MM Docs URLs must emit namespace warnings'
  );
  console.log('[OK] gateway attachment rejects foreign or canonical MM Docs URLs');
  } finally {
    RunRepository.prototype.findByRunId = original;
  }
}

async function testAttachmentSchemaRequiresExactlyOneSource(): Promise<void> {
  const both = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentBase64: Buffer.from('doc').toString('base64'),
        presignedUrl: 'https://example-r2.test/lexery-legal-agent/tenant/t/runs/r/attachments/contract.docx?sig=abc',
      },
    ],
  });
  assert(!both.success, 'attachment with both inline and presigned sources must fail validation');

  const neither = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ],
  });
  assert(!neither.success, 'attachment without any source must fail validation');

  const inlineOnly = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentBase64: Buffer.from('doc').toString('base64'),
      },
    ],
  });
  assert(inlineOnly.success, 'attachment with inline content must pass validation');

  const presignedOnly = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'contract.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        presignedUrl: 'https://example-r2.test/lexery-legal-agent/tenant/t/runs/r/attachments/contract.docx?sig=abc',
      },
    ],
  });
  assert(presignedOnly.success, 'attachment with presigned URL must pass validation');

  const invalidBase64 = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'broken.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentBase64: 'not-valid-base64!!!',
      },
    ],
  });
  assert(!invalidBase64.success, 'attachment with invalid base64 must fail validation');

  const urlSafeBase64 = CreateRunRequestSchema.safeParse({
    query: 'test',
    attachments: [
      {
        name: 'urlsafe.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentBase64: 'dXJsc2FmZV9kb2M',
      },
    ],
  });
  assert(urlSafeBase64.success, 'attachment with url-safe base64 payload must pass validation');
  console.log('[OK] gateway attachment schema requires exactly one source');
}

async function main(): Promise<void> {
  await testExtractInternalR2KeyFromUrl();
  await testRejectExternalPresignedUrl();
  await testAllowSameUserMmDocRawPresignedUrl();
  await testAllowSameUserRunsAttachmentPresignedUrl();
  await testRejectForeignMmDocPresignedUrl();
  await testAttachmentSchemaRequiresExactlyOneSource();
  console.log('All gateway attachment unit tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
