import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  createZoteroItemMock,
  FakeRuntimeClock,
} from '../../../../../test/utils';
import {
  getRawSyncedNotesMetadataFromAttachment,
  setRawSyncedNotesMetadataOnAttachment,
} from '../../../data/item-data';
import { transitionCleanupV4 } from '../cleanup-ledger-v4';
import { MainCoordinatorV2 } from '../coordinator-v4';
import {
  deriveAssetID,
  deriveTargetIdentityDigest,
  recomputeOperationRequestDigest,
} from '../identity-v4';
import {
  createIdleRecordV4,
  createOperationIntent,
  sealOperationIntent,
} from '../model-v4';
import { ownershipFromResource, validateTransactionRecord } from '../schema-v4';
import { transitionMainV2 } from '../transition-registry';
import type {
  CleanupLedgerEntry,
  CleanupWorkerLease,
  NoteSyncRecordV4,
  SourceSnapshotV4,
  UploadAssetRecordV4,
} from '../types-v4';

import {
  candidateResourceV4,
  clockV4,
  manifestDigestV4,
  recordV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

const FINDING_TO_TEST_MATRIX = {
  'C-01': {
    failure:
      'Zotero DB and Items methods are extracted and invoked without their receiver',
    fixLayer: 'ZoteroRuntimeAdapter',
    invariant:
      'Every receiver-dependent Zotero API call preserves its owning object',
    durable:
      'Unchanged v4 metadata after receiver-safe transactional load/save',
    remote: 'No Notion mutation is needed for the isolated runtime smoke',
    zotero9Smoke: true,
  },
  'H-01': {
    failure: 'A legacy local identity is passed as Notion created_by.id',
    fixLayer: 'sync job identity boundary and FSM create evidence',
    invariant:
      'Local connection scope and remote creator identity are distinct',
    durable:
      'Stable local target plus creator learned from exact remote create evidence',
    remote: 'Managed blocks retain the real Notion bot creator',
    zotero9Smoke: false,
  },
  'H-02': {
    failure:
      'A partial candidate is created with the authoritative final title',
    fixLayer: 'candidate operation and finalization coordinator',
    invariant:
      'Only a completely verified and finalized candidate has the final title',
    durable:
      'Failed staging candidate is cleanup or sealed quarantine evidence, never active',
    remote: 'Partial candidates remain visibly marked Notero Sync Incomplete',
    zotero9Smoke: false,
  },
  'H-03': {
    failure:
      'CANDIDATE_CREATING with no candidate or intent has no production exit',
    fixLayer: 'transition registry and coordinator run-halt producer',
    invariant:
      'Every nonterminal legal state has progress, halt/retry, or quarantine',
    durable: 'Typed retry halt with a bounded nextRetryAt',
    remote: 'No same-run retry spin or duplicate candidate create',
    zotero9Smoke: false,
  },
  'H-04': {
    failure:
      'DELETE_UNCERTAIN observation cycles leave attemptCount at one forever',
    fixLayer: 'cleanup reducer and worker cycle producer',
    invariant:
      'Every cleanup cycle advances durable attempt evidence and converges',
    durable:
      'Bounded attemptCount/lastAttemptAt/nextRetryAt then sealed quarantine',
    remote:
      'Unresolved retired blocks remain non-authoritative and are not deleted blindly',
    zotero9Smoke: false,
  },
  'H-05': {
    failure:
      'expired plus archived uploads fail identity matching before lifecycle interpretation',
    fixLayer: 'Notion upload observation adapter and stateful fake',
    invariant: 'Upload identity matching is independent from lifecycle state',
    durable:
      'Expired executable reference is cleared and a new generation may upload',
    remote:
      'Expired upload cannot attach; attached persistent upload remains reusable',
    zotero9Smoke: false,
  },
  'H-06': {
    failure:
      'Copied digest strings and bare File Upload IDs can agree while evidence is forged',
    fixLayer: 'schema v4 canonical evidence and metadata load quarantine',
    invariant:
      'Manifest and asset bindings are recomputed from persisted canonical descriptors',
    durable:
      'Invalid parseable metadata is preserved in a sealed quarantine envelope',
    remote:
      'Zero mutation and the previous authoritative active remains untouched',
    zotero9Smoke: true,
  },
  'M-01': {
    failure:
      'Coordinator and model harness maintain private planning/action sources',
    fixLayer: 'production transition registry and model explorer',
    invariant:
      'One registry drives production selection, reduction, and exploration',
    durable:
      'Only events produced by registered production producers are persisted',
    remote: 'Synthetic witnesses do not count as production-reachable coverage',
    zotero9Smoke: false,
  },
  'M-02': {
    failure: 'Reducers read RuntimeClock and implicitly rewrite updatedAt',
    fixLayer: 'event producers and pure reducers',
    invariant: 'The same record and frozen event serialize to the same result',
    durable: 'All evidence timestamps are explicit event payload fields',
    remote: 'Replay cannot manufacture a different mutation authorization',
    zotero9Smoke: false,
  },
  'M-03': {
    failure: 'Raw JSON crosses the PRE/HTML boundary through innerHTML',
    fixLayer: 'item-data metadata serializer/parser',
    invariant:
      'Arbitrary legal JSON strings round-trip as text without sibling HTML',
    durable: 'Exact JSON semantics and quarantine bytes remain preserved',
    remote: 'No Notion access is involved',
    zotero9Smoke: true,
  },
} as const;

function sourceV4(): SourceSnapshotV4 {
  return {
    batches: [[{ paragraph: { rich_text: [] }, type: 'paragraph' }]],
    featurePolicy: 'text-only-v1',
    imageAssetIDsByBatch: [[]],
    imageAssets: [],
    imageOccurrenceCount: 0,
    manifestDigest: manifestDigestV4,
    sourceVersion: sourceVersionV4,
    title: 'Synthetic note',
  };
}

function attachedAsset(
  attachmentIdentity: string,
  contentHash: string,
  sourceIdentity: string,
): UploadAssetRecordV4 {
  const identity = {
    attachmentIdentity,
    contentHash,
    contentLength: 4,
    contentType: 'image/png',
    sourceIdentity,
    targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
  };
  return {
    ...identity,
    assetID: deriveAssetID(identity),
    attachedAt: clockV4.nowISOString(),
    attachmentKey: attachmentIdentity,
    createOperationID: `create:${attachmentIdentity}`,
    expiryTime: null,
    fileUploadID: 'upload-shared-by-corruption',
    filename: `${attachmentIdentity}.png`,
    generation: 1,
    sendOperationID: `send:${attachmentIdentity}`,
    sourceVersion: sourceVersionV4,
    status: 'ATTACHED',
    transactionID: `transaction:${attachmentIdentity}`,
  };
}

describe('final independent-review finding reproductions', () => {
  it('records a complete finding-to-test matrix before production changes', () => {
    expect(Object.keys(FINDING_TO_TEST_MATRIX).toSorted()).toStrictEqual([
      'C-01',
      'H-01',
      'H-02',
      'H-03',
      'H-04',
      'H-05',
      'H-06',
      'M-01',
      'M-02',
      'M-03',
    ]);
    for (const finding of Object.values(FINDING_TO_TEST_MATRIX)) {
      expect(finding).toMatchObject({
        durable: expect.any(String),
        failure: expect.any(String),
        fixLayer: expect.any(String),
        invariant: expect.any(String),
        remote: expect.any(String),
        zotero9Smoke: expect.any(Boolean),
      });
    }
  });

  it('H-03 gives a persisted recovery transition to a candidate-creating sink', () => {
    const coordinator = new MainCoordinatorV2(
      sourceV4(),
      targetV4,
      { processSessionID: 'process-test', startedAt: clockV4.nowISOString() },
      clockV4,
      { randomUUID: () => 'recovery-id' },
    );

    expect(coordinator.select(recordV4('CANDIDATE_CREATING'))).toMatchObject({
      type: 'RECOVER_STALLED_CANDIDATE_CREATE',
    });
  });

  it('H-04 advances durable cleanup attempt evidence on every uncertain cycle', () => {
    const lease: CleanupWorkerLease = {
      acquiredAt: clockV4.nowISOString(),
      cleanupID: 'cleanup-uncertain-review',
      expiresAt: clockV4.addMs(clockV4.nowISOString(), 60_000),
      leaseEpoch: 1,
      leaseID: 'cleanup-lease-review',
      processSessionID: 'cleanup-process-review',
    };
    const resource = candidateResourceV4('cleanup-uncertain-review');
    const executable = createOperationIntent({
      createdAt: clockV4.nowISOString(),
      details: {
        cleanupID: lease.cleanupID,
        exactBlockID: resource.blockID,
        ownership: ownershipFromResource(resource),
        reason: 'ABORTED_ATTEMPT',
      },
      generation: 1,
      kind: 'DELETE_BLOCK',
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationID: 'delete-uncertain-review',
      operationSequence: 1,
      owner: 'CLEANUP',
      processSessionID: lease.processSessionID,
      sourceVersion: 'source:cleanup-review',
      targetIdentityDigest: resource.targetIdentityDigest,
      transactionID: 'transaction:cleanup-review',
    });
    const entry: CleanupLedgerEntry = {
      attemptCount: 1,
      cleanupID: lease.cleanupID,
      createdAt: clockV4.nowISOString(),
      deleteIntent: sealOperationIntent(executable, 'UNCERTAIN'),
      generation: 1,
      lastObservation: null,
      nextRetryAt: clockV4.nowISOString(),
      ownership: ownershipFromResource(resource),
      quarantineEvidenceID: null,
      reason: 'ABORTED_ATTEMPT',
      resource,
      sourceVersion: 'source:cleanup-review',
      state: 'DELETE_UNCERTAIN',
      transactionID: 'transaction:cleanup-review',
      updatedAt: clockV4.nowISOString(),
      workerLease: lease,
    };
    const record: NoteSyncRecordV4 = {
      ...createIdleRecordV4(targetV4, clockV4),
      cleanupLedger: [entry],
    };
    const next = transitionCleanupV4(
      record,
      entry.cleanupID,
      {
        nextRetryAt: clockV4.addMs(clockV4.nowISOString(), 1_000),
        observation: null,
        type: 'DELETE_BECAME_UNCERTAIN',
      },
      clockV4,
    );

    expect(next.cleanupLedger[0]).toMatchObject({
      attemptCount: 2,
      lastAttemptAt: clockV4.nowISOString(),
    });
  });

  it('H-06 rejects a mutually copied manifest digest that cannot be recomputed', () => {
    const corrupted = structuredClone(recordV4('CANDIDATE_DURABLE'));
    const transaction = corrupted.mainTransaction;
    const candidate = transaction?.candidate;
    const completion = candidate?.completionEvidence;
    if (
      !transaction ||
      !candidate ||
      !completion ||
      !corrupted.requestedSource
    ) {
      throw new Error('Expected a durable candidate fixture');
    }
    const forged = 'manifest:mutually-copied-but-not-recomputed';
    corrupted.requestedSource.manifestDigest = forged;
    transaction.sourceManifestDigest = forged;
    candidate.manifestDigest = forged;
    completion.manifestDigest = forged;
    completion.verificationIntent.details.manifestDigest = forged;
    completion.verificationIntent.requestDigest =
      recomputeOperationRequestDigest(completion.verificationIntent);

    expect(validateTransactionRecord(corrupted).valid).toBe(false);
  });

  it('H-06 rejects one File Upload ID bound to two different assets', () => {
    const corrupted = {
      ...createIdleRecordV4(targetV4, clockV4),
      uploadAssets: [
        attachedAsset('attachment-a', 'content-a', 'source-a'),
        attachedAsset('attachment-b', 'content-b', 'source-b'),
      ],
    };

    expect(validateTransactionRecord(corrupted).valid).toBe(false);
  });

  it('M-01 has no second coordinator or model planning source', () => {
    const coordinator = readFileSync(
      resolve(
        process.cwd(),
        'src/content/sync/note-sync-transaction/coordinator-v4.ts',
      ),
      'utf8',
    );
    const model = readFileSync(
      resolve(
        process.cwd(),
        'src/content/sync/note-sync-transaction/__tests__/model-harness-v4.ts',
      ),
      'utf8',
    );

    expect(coordinator).not.toMatch(/private plan\(/);
    expect(coordinator).not.toMatch(/TRANSITION_REGISTRY\.some/);
    expect(model).not.toMatch(/function availableActions\(/);
    expect(model).not.toMatch(/function collectRegistryWitnessesV4\(/);
  });

  it('M-02 replays the same record and frozen event deterministically', () => {
    const clock = new FakeRuntimeClock('2026-08-31T00:00:00.000Z');
    const record = createIdleRecordV4(targetV4, clock);
    const event = {
      source: {
        featurePolicy: 'text-only-v1' as const,
        manifestDigest: manifestDigestV4,
        observedAt: clock.nowISOString(),
        sourceVersion: sourceVersionV4,
      },
      type: 'SOURCE_OBSERVED' as const,
    };
    const first = transitionMainV2(record, event, { clock }).nextState;
    clock.advance(60_000);
    const replay = transitionMainV2(record, event, { clock }).nextState;

    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  });

  it.each([
    '</pre><script>synthetic()</script>',
    '&<>"\'',
    'Unicode 中文 😀 \u2028 \u2029 \u200b',
  ])('M-03 safely round-trips metadata text %s', (userText) => {
    const attachment = createZoteroItemMock();
    let noteHTML = '';
    attachment.getNote.mockImplementation(() => noteHTML);
    attachment.setNote.mockImplementation((value) => {
      noteHTML = value;
      return true;
    });
    const root = {
      notes: { synthetic: { sourceTitle: userText } },
      rootRevision: 0,
      schemaVersion: 4,
    };
    setRawSyncedNotesMetadataOnAttachment(
      attachment,
      JSON.stringify(root),
      '2026-08-31T00:00:00.000Z',
    );
    const loaded = getRawSyncedNotesMetadataFromAttachment(attachment);
    const document = new DOMParser().parseFromString(noteHTML, 'text/html');

    expect(loaded && JSON.parse(loaded)).toStrictEqual(root);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.getElementById('notero-synced-notes')?.textContent).toBe(
      JSON.stringify(root),
    );
  });
});
