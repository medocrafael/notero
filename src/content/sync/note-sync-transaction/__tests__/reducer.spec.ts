import { describe, expect, it } from 'vite-plus/test';

import type { NoteSyncEvent } from '../events';
import { transition } from '../reducer';
import { validateTransactionInvariants } from '../schema';
import type { NoteSyncRecordV3, UploadAssetRecord } from '../types';

import {
  candidate,
  evidence,
  intent,
  now,
  quarantine,
  record,
  resource,
  target,
  version,
} from './fixtures';

type TransitionCase = {
  event: NoteSyncEvent;
  id: string;
  initial: NoteSyncRecordV3;
  next: NoteSyncRecordV3['state'];
};

const uploadCreate = intent('UPLOAD_CREATE');
if (uploadCreate.kind !== 'UPLOAD_CREATE') {
  throw new Error('Synthetic upload create intent is invalid');
}
const upload: UploadAssetRecord = {
  attachedAt: null,
  attachmentKey: uploadCreate.details.attachmentKey,
  contentHash: uploadCreate.details.contentHash,
  contentLength: uploadCreate.details.contentLength,
  contentType: uploadCreate.details.contentType,
  createOperationID: uploadCreate.operationID,
  expiryTime: uploadCreate.details.isolationDeadline,
  fileUploadID: null,
  filename: uploadCreate.details.filename,
  generation: 1,
  sendOperationID: null,
  sourceVersion: 'source-version-0001',
  status: 'create-intended',
  targetIdentity: target,
  transactionID: 'transaction-test',
};

const cleanupTarget = record('CLEANING').cleanup.targets[0];
if (!cleanupTarget) throw new Error('Synthetic cleanup target is missing');

function withOperation(
  state: NoteSyncRecordV3,
  operationIntent: NoteSyncRecordV3['operationIntent'],
): NoteSyncRecordV3 {
  return { ...state, operationIntent };
}

const activeCommittedWithCleanup = record('ACTIVE_COMMITTED');
activeCommittedWithCleanup.cleanup = {
  mode: 'retire',
  resume: 'IDLE',
  targets: [
    {
      generation: 0,
      reason: 'retired-active',
      resource: resource('note', 'retired-active-block'),
      sourceVersion: 'active-version-0001',
      status: 'pending',
      transactionID: 'transaction-test',
    },
  ],
};

const cleanupComplete = record('CLEANING');
cleanupComplete.cleanup = {
  ...cleanupComplete.cleanup,
  targets: cleanupComplete.cleanup.targets.map((entry) => ({
    ...entry,
    status: 'quarantined',
  })),
};

const cases: TransitionCase[] = [
  {
    event: {
      featurePolicy: 'embedded-images-v1',
      now,
      requestedSourceVersion: 'source-version-0001',
      source: {
        batches: [],
        featurePolicy: 'embedded-images-v1',
        imageAssets: [],
        manifestDigest: 'manifest-digest',
        sourceVersion: 'source-version-0001',
        title: 'Synthetic note',
      },
      targetIdentity: target,
      transactionID: 'transaction-test',
      type: 'SYNC_REQUESTED',
    },
    id: 'T1',
    initial: record('IDLE'),
    next: 'PREPARING',
  },
  {
    event: { intent: intent('CREATE_CONTAINER'), type: 'CONTAINER_REQUIRED' },
    id: 'T2',
    initial: { ...record('PREPARING'), container: null },
    next: 'PREPARING',
  },
  {
    event: { intent: uploadCreate, type: 'UPLOAD_CREATE_REQUIRED', upload },
    id: 'T3',
    initial: record('PREPARING'),
    next: 'PREPARING',
  },
  {
    event: { intent: intent('UPLOAD_SEND'), type: 'UPLOAD_SEND_REQUIRED' },
    id: 'T4',
    initial: record('PREPARING'),
    next: 'PREPARING',
  },
  {
    event: { type: 'RESOURCES_READY' },
    id: 'T5',
    initial: record('PREPARING'),
    next: 'CANDIDATE_CREATING',
  },
  {
    event: { intent: intent('CREATE_CANDIDATE'), type: 'CREATE_CANDIDATE' },
    id: 'T6',
    initial: record('CANDIDATE_CREATING'),
    next: 'CANDIDATE_CREATING',
  },
  {
    event: {
      candidate: candidate(),
      evidence: evidence('create_candidate-op', 'created'),
      type: 'RECONCILE_CREATE',
    },
    id: 'T7',
    initial: withOperation(
      record('CANDIDATE_CREATING'),
      intent('CREATE_CANDIDATE'),
    ),
    next: 'CANDIDATE_WRITING',
  },
  {
    event: { intent: intent('APPEND_BATCH'), type: 'APPEND_BATCH' },
    id: 'T8',
    initial: record('CANDIDATE_WRITING'),
    next: 'CANDIDATE_WRITING',
  },
  {
    event: { cleanupTarget, type: 'APPEND_UNKNOWN' },
    id: 'T9',
    initial: withOperation(record('CANDIDATE_WRITING'), intent('APPEND_BATCH')),
    next: 'CLEANING',
  },
  {
    event: {
      intent: intent('FINALIZE_CANDIDATE'),
      type: 'FINALIZE_CANDIDATE',
    },
    id: 'T10',
    initial: record('CANDIDATE_VERIFYING'),
    next: 'CANDIDATE_VERIFYING',
  },
  {
    event: { cleanupTarget, type: 'FINALIZE_UNKNOWN' },
    id: 'T11',
    initial: withOperation(
      record('CANDIDATE_VERIFYING'),
      intent('FINALIZE_CANDIDATE'),
    ),
    next: 'CLEANING',
  },
  {
    event: { committedAt: now, type: 'COMMIT_ACTIVE' },
    id: 'T12',
    initial: record('CANDIDATE_DURABLE'),
    next: 'ACTIVE_COMMITTED',
  },
  {
    event: { type: 'NO_PREVIOUS_ACTIVE' },
    id: 'T13',
    initial: record('ACTIVE_COMMITTED'),
    next: 'IDLE',
  },
  {
    event: { type: 'PREVIOUS_ACTIVE_RETIRED' },
    id: 'T14',
    initial: activeCommittedWithCleanup,
    next: 'CLEANING',
  },
  {
    event: { intent: intent('DELETE_BLOCK'), type: 'DELETE_NEXT' },
    id: 'T15',
    initial: record('CLEANING'),
    next: 'CLEANING',
  },
  {
    event: { type: 'RECOVER_DELETE_INTENT' },
    id: 'T16',
    initial: withOperation(record('CLEANING'), intent('DELETE_BLOCK')),
    next: 'CLEANING',
  },
  {
    event: { type: 'CLEANUP_COMPLETE' },
    id: 'T17',
    initial: cleanupComplete,
    next: 'IDLE',
  },
  {
    event: {
      cleanupTarget,
      now,
      requestedSourceVersion: 'source-version-0002',
      type: 'SOURCE_CHANGED',
    },
    id: 'T18',
    initial: record('PREPARING', { active: version() }),
    next: 'CLEANING',
  },
  {
    event: {
      cleanupTarget,
      now,
      requestedSourceVersion: 'source-version-0002',
      type: 'SOURCE_CHANGED_WITH_ACTIVE',
    },
    id: 'T19',
    initial: record('CANDIDATE_DURABLE', { active: version() }),
    next: 'CLEANING',
  },
  {
    event: {
      committedAt: now,
      now,
      requestedSourceVersion: 'source-version-0002',
      type: 'SOURCE_CHANGED_WITHOUT_ACTIVE',
    },
    id: 'T20',
    initial: record('CANDIDATE_DURABLE'),
    next: 'ACTIVE_COMMITTED',
  },
  {
    event: {
      now,
      requestedSourceVersion: 'source-version-0002',
      type: 'SOURCE_CHANGED',
    },
    id: 'T21',
    initial: activeCommittedWithCleanup,
    next: 'ACTIVE_COMMITTED',
  },
  {
    event: {
      diagnostic: quarantine('INVALID_TRANSACTION'),
      type: 'INVALID_SCHEMA_OR_EVIDENCE',
    },
    id: 'T22',
    initial: record('PREPARING'),
    next: 'QUARANTINED',
  },
  {
    event: { repairedState: 'IDLE', type: 'EXPLICIT_REPAIR_OR_NEW_PROOF' },
    id: 'T23',
    initial: record('QUARANTINED'),
    next: 'IDLE',
  },
];

describe('note transaction reducer T1-T23', () => {
  it.each(cases)('$id transitions to $next', ({ event, initial, next }) => {
    expect(validateTransactionInvariants(initial)).toStrictEqual([]);

    const result = transition(initial, event);

    expect(result.nextState.state).toBe(next);
    expect(validateTransactionInvariants(result.nextState)).toStrictEqual([]);
  });

  it.each(cases)(
    '$id rejects an illegal event without a remote effect',
    ({ initial }) => {
      const result = transition(initial, { type: 'NO_PREVIOUS_ACTIVE' });

      const isLegal =
        initial.state === 'ACTIVE_COMMITTED' && !initial.cleanup.targets.length;
      expect(result.nextState.state).toBe(isLegal ? 'IDLE' : 'QUARANTINED');
      expect(result.effects).toStrictEqual([{ type: 'NONE' }]);
    },
  );

  it('commits active through one local transition with no promotion effect', () => {
    const result = transition(record('CANDIDATE_DURABLE'), {
      committedAt: now,
      type: 'COMMIT_ACTIVE',
    });

    expect(result.nextState.active?.block.blockID).toBe(
      result.nextState.candidate?.block.blockID,
    );
    expect(result.nextState.state).toBe('ACTIVE_COMMITTED');
    expect(result.effects).toStrictEqual([{ type: 'NONE' }]);
  });

  it('never places the current active in cleanup', () => {
    const broken = record('CLEANING');
    if (!broken.active) throw new Error('Synthetic active is missing');
    const existingTarget = broken.cleanup.targets[0];
    if (!existingTarget) throw new Error('Synthetic cleanup target is missing');
    broken.cleanup.targets = [
      { ...existingTarget, resource: broken.active.block },
    ];

    const result = transition(broken, { type: 'CLEANUP_COMPLETE' });

    expect(result.nextState.state).toBe('QUARANTINED');
    expect(result.effects).toStrictEqual([{ type: 'NONE' }]);
  });
});
