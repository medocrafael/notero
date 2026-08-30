import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  NoteTransactionCoordinator,
  type NoteTransactionSource,
} from '../coordinator';
import {
  NoteSyncTransactionExecutor,
  type RemoteOperationAdapter,
  type TransactionEventSelector,
} from '../executor';
import { JsonMetadataStoreAdapter } from '../metadata-store-adapter';
import { transition } from '../reducer';
import {
  serializeNoteSyncRecord,
  validateTransactionInvariants,
} from '../schema';
import type {
  NoteSyncRecordV3,
  SourceSnapshot,
  UploadAssetRecord,
} from '../types';

import {
  candidate,
  intent,
  now,
  record,
  resource,
  target,
  version,
} from './fixtures';

function source(sourceVersion: string): NoteTransactionSource {
  const batch: BlockObjectRequest[] = [
    {
      object: 'block',
      paragraph: { rich_text: [] },
      type: 'paragraph',
    },
  ];
  const snapshot: SourceSnapshot = {
    batches: [batch],
    featurePolicy: 'text-only-v1',
    imageAssets: [],
    manifestDigest: `manifest-${sourceVersion}`,
    sourceVersion,
    title: `Title ${sourceVersion}`,
  };
  return {
    buildBatches: vi.fn<NoteTransactionSource['buildBatches']>(() => [batch]),
    descriptors: [],
    registerAppendPayload:
      vi.fn<NoteTransactionSource['registerAppendPayload']>(),
    snapshot,
    title: snapshot.title,
  };
}

function readProductionSource(relativePath: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      'src/content/sync/note-sync-transaction',
      relativePath,
    ),
    'utf8',
  );
}

describe('FSM v2 independent-review regressions', () => {
  it('H-01 consumes a changed source snapshot once instead of re-emitting SOURCE_CHANGED', () => {
    const current = record('ACTIVE_COMMITTED');
    const coordinator = new NoteTransactionCoordinator(
      source('source-version-0002'),
      target,
      false,
      { now: () => now, randomUUID: () => 'next-operation' },
    );
    const selector = coordinator.selector();
    const first = selector(current);
    if (!first) throw new Error('Expected a source observation');

    const afterFirst = transition(current, first).nextState;
    const second = selector(afterFirst);

    expect(first.type).toBe('SOURCE_CHANGED');
    expect(second?.type).not.toBe('SOURCE_CHANGED');
  });

  it('H-02 keeps uncertain cleanup orthogonal to a newer main generation', () => {
    const cleaning = record('CLEANING');
    const existingCleanupID = cleaning.cleanup.targets[0]?.resource.blockID;

    const next = transition(cleaning, {
      now,
      requestedSourceVersion: 'source-version-0002',
      type: 'SOURCE_CHANGED',
    }).nextState;

    expect(next.state).not.toBe('CLEANING');
    expect(
      next.cleanup.targets.some(
        ({ resource: cleanupResource }) =>
          cleanupResource.blockID === existingCleanupID,
      ),
    ).toBe(true);
  });

  it.each([
    [
      'operation details reference another candidate',
      () => {
        const appendIntent = intent('APPEND_BATCH');
        if (appendIntent.kind !== 'APPEND_BATCH')
          throw new Error('bad fixture');
        return {
          ...record('CANDIDATE_WRITING'),
          operationIntent: {
            ...appendIntent,
            details: {
              ...appendIntent.details,
              candidate: resource('candidate', 'another-candidate'),
            },
          },
        };
      },
    ],
    [
      'candidate completion references another finalization operation',
      () => {
        const durable = candidate('durable');
        if (!durable.completionEvidence) throw new Error('bad fixture');
        return {
          ...record('CANDIDATE_DURABLE'),
          candidate: {
            ...durable,
            completionEvidence: {
              ...durable.completionEvidence,
              finalization: {
                ...durable.completionEvidence.finalization,
                operationID: 'foreign-finalization-operation',
              },
            },
          },
        };
      },
    ],
    [
      'active completion references another finalization operation',
      () => {
        const active = version();
        return record('IDLE', {
          active: {
            ...active,
            completionEvidence: {
              ...active.completionEvidence,
              finalization: {
                ...active.completionEvidence.finalization,
                operationID: 'foreign-active-finalization',
              },
            },
          },
        });
      },
    ],
    [
      'cleanup evidence belongs to another transaction',
      () => {
        const cleaning = record('CLEANING');
        return {
          ...cleaning,
          cleanup: {
            ...cleaning.cleanup,
            targets: cleaning.cleanup.targets.map((cleanup) => ({
              ...cleanup,
              transactionID: 'foreign-cleanup-transaction',
            })),
          },
          operationIntent: intent('DELETE_BLOCK'),
        };
      },
    ],
    [
      'upload intent and upload evidence identify different bytes',
      () => {
        const uploadIntent = intent('UPLOAD_SEND');
        const upload: UploadAssetRecord = {
          attachedAt: null,
          attachmentKey: 'OTHER_IMAGE',
          contentHash: 'other-image-content-hash',
          contentLength: 99,
          contentType: 'image/png',
          createOperationID: 'other-create-operation',
          expiryTime: '2026-08-30T01:05:00.000Z',
          fileUploadID: 'upload-test',
          filename: 'other-image.png',
          generation: 1,
          sendOperationID: uploadIntent.operationID,
          sourceVersion: 'source-version-0001',
          status: 'send-intended',
          targetIdentity: target,
          transactionID: 'transaction-test',
        };
        return {
          ...record('PREPARING'),
          operationIntent: uploadIntent,
          uploads: [upload],
        };
      },
    ],
  ])('H-04 rejects cross-field mismatch: %s', (_label, buildRecord) => {
    expect(validateTransactionInvariants(buildRecord())).not.toStrictEqual([]);
  });

  it('H-05 requires the production Zotero store to use one real DB transaction', () => {
    const metadataStore = readProductionSource('metadata-store-adapter.ts');

    expect([
      metadataStore.includes('Zotero.DB.executeTransaction'),
      metadataStore.includes('await freshAttachment.save('),
    ]).toStrictEqual([true, true]);
  });

  it('M-01 exposes one production transition registry to runtime and tests', () => {
    const registryPath = resolve(
      process.cwd(),
      'src/content/sync/note-sync-transaction/transition-registry.ts',
    );

    expect(existsSync(registryPath)).toBe(true);
  });

  it('M-02 halts the run after one proven permanent rejection', async () => {
    const createIntent = intent('CREATE_CONTAINER');
    const initial: NoteSyncRecordV3 = {
      ...record('PREPARING'),
      container: null,
    };
    let raw = serializeNoteSyncRecord(initial);
    const store = new JsonMetadataStoreAdapter(
      {
        read: async () => raw,
        write: async (nextRaw) => {
          raw = nextRaw;
        },
      },
      () => now,
    );
    const remote = {
      execute: vi.fn<RemoteOperationAdapter['execute']>(async () => ({
        type: 'proven-unexecuted',
      })),
      observe: vi.fn<RemoteOperationAdapter['observe']>(async () => ({
        type: 'proven-unexecuted',
      })),
    } satisfies RemoteOperationAdapter;
    const selector: TransactionEventSelector = () => ({
      intent: createIntent,
      type: 'CONTAINER_REQUIRED',
    });

    await expect(
      new NoteSyncTransactionExecutor(store, remote, {
        maxSteps: 4,
      }).runUntilStable(selector),
    ).resolves.toBeDefined();
    expect(remote.execute).toHaveBeenCalledTimes(1);
  });

  it('M-04 schedules remote liveness validation for an unverified IDLE active', () => {
    const active = version();
    const coordinator = new NoteTransactionCoordinator(
      source(active.sourceVersion),
      target,
      false,
      { now: () => now, randomUUID: () => 'liveness-operation' },
    );

    const event = coordinator.selector()(
      record('IDLE', { active, featurePolicy: 'text-only-v1' }),
    );

    expect(event).not.toBeNull();
  });

  it('M-05 seals the complete operation intent when entering quarantine', () => {
    const appendIntent = intent('APPEND_BATCH');
    const writing = {
      ...record('CANDIDATE_WRITING'),
      operationIntent: appendIntent,
    };

    const next = transition(writing, {
      diagnostic: {
        actionable: true,
        code: 'AMBIGUOUS_REMOTE_RESULT',
        createdAt: now,
        evidenceDigest: 'm05-evidence-digest',
        message: 'Synthetic append uncertainty',
        operationID: appendIntent.operationID,
      },
      type: 'OPERATION_UNCERTAIN',
    }).nextState;

    expect(next.state).toBe('QUARANTINED');
    expect(JSON.stringify(next)).toContain(appendIntent.requestDigest);
  });

  it('L-01 routes all transaction time through the RuntimeClock adapter', () => {
    const files = [
      'coordinator.ts',
      'metadata-store-adapter.ts',
      'notion-operation-adapter.ts',
      '../notion-image-upload-service.ts',
      '../sync-note-item.ts',
    ];
    const directClockCalls = files.flatMap((relativePath) => {
      const sourceText = readProductionSource(relativePath);
      return Array.from(
        sourceText.matchAll(/\b(?:Date\.now\(\)|new Date\()/g),
        (match) => `${relativePath}:${match[0]}`,
      );
    });

    expect(directClockCalls).toStrictEqual([]);
  });
});
