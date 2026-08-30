import type { TransactionEffect } from './effects';
import type { NoteSyncEvent } from './events';
import {
  appendQuarantine,
  cleanupContainsActive,
  MAX_CLEANUP_TARGETS,
  MAX_UPLOAD_ASSETS,
  operationBelongsToRecord,
  sameTargetIdentity,
} from './model';
import type {
  CandidateRecord,
  NoteSyncRecordV3,
  OperationEvidence,
  OperationIntent,
  QuarantineRecord,
  UploadAssetRecord,
  VersionRecord,
} from './types';

export type TransitionResult = {
  effects: TransactionEffect[];
  nextState: NoteSyncRecordV3;
};

export class IllegalTransactionEventError extends Error {
  public readonly name = 'IllegalTransactionEventError';
}

function noEffects(nextState: NoteSyncRecordV3): TransitionResult {
  return { effects: [{ type: 'NONE' }], nextState };
}

function intentEffect(
  nextState: NoteSyncRecordV3,
  intent: OperationIntent,
): TransitionResult {
  return {
    effects: [{ intent, type: 'EXECUTE_REMOTE_OPERATION' }],
    nextState,
  };
}

function observeEffect(
  record: NoteSyncRecordV3,
  intent: OperationIntent,
): TransitionResult {
  return {
    effects: [{ intent, type: 'OBSERVE_REMOTE_OPERATION' }],
    nextState: record,
  };
}

function withIntent(
  record: NoteSyncRecordV3,
  intent: OperationIntent,
): TransitionResult {
  if (record.operationIntent) {
    return illegal(
      record,
      `Cannot replace pending ${record.operationIntent.kind}`,
    );
  }
  if (
    intent.transactionID !== record.transactionID ||
    intent.generation !== record.generation ||
    intent.sourceVersion !== record.sourceVersion ||
    !sameTargetIdentity(intent.targetIdentity, record.targetIdentity)
  ) {
    return illegal(record, 'Operation identity does not match the transaction');
  }
  const next = {
    ...record,
    operationGeneration: intent.operationGeneration,
    operationIntent: intent,
  };
  return intentEffect(next, intent);
}

function diagnostic(
  code: QuarantineRecord['code'],
  message: string,
  record: NoteSyncRecordV3,
): QuarantineRecord {
  return {
    actionable: true,
    code,
    createdAt: record.updatedAt,
    evidenceDigest: `${record.state}:${record.recordRevision}:${record.transactionID || 'none'}`,
    message,
    operationID: record.operationIntent?.operationID || null,
  };
}

function illegal(record: NoteSyncRecordV3, message: string): TransitionResult {
  return noEffects(
    appendQuarantine(record, diagnostic('ILLEGAL_EVENT', message, record)),
  );
}

function replaceUpload(
  uploads: UploadAssetRecord[],
  asset: UploadAssetRecord,
): UploadAssetRecord[] {
  return [
    ...uploads.filter(
      (current) =>
        !(
          current.attachmentKey === asset.attachmentKey &&
          current.contentHash === asset.contentHash &&
          sameTargetIdentity(current.targetIdentity, asset.targetIdentity)
        ),
    ),
    asset,
  ].slice(-MAX_UPLOAD_ASSETS);
}

function markUploadsAttached(
  uploads: UploadAssetRecord[],
  attached: UploadAssetRecord[],
  attachedAt: string,
): UploadAssetRecord[] {
  return attached.reduce(
    (current, asset) =>
      replaceUpload(current, {
        ...asset,
        attachedAt,
        expiryTime: null,
        status: 'attached',
      }),
    uploads,
  );
}

function versionFromCandidate(
  record: NoteSyncRecordV3,
  committedAt: string,
): VersionRecord | undefined {
  const candidate = record.candidate;
  const container = record.container;
  if (
    !candidate ||
    candidate.status !== 'durable' ||
    !candidate.completionEvidence ||
    !container
  ) {
    return undefined;
  }
  return {
    block: candidate.block,
    committedAt,
    completedAt: candidate.completionEvidence.completedAt,
    completionEvidence: candidate.completionEvidence,
    container,
    contentManifestDigest: candidate.manifestDigest,
    generation: candidate.generation,
    imageAssetIdentities: candidate.imageAssetIdentities,
    sourceVersion: candidate.sourceVersion,
    transactionID: candidate.transactionID,
  };
}

function operationSucceeded(
  record: NoteSyncRecordV3,
  evidence: OperationEvidence,
  resource?: import('./types').ManagedResourceRecord,
): TransitionResult {
  const intent = record.operationIntent;
  if (
    !intent ||
    evidence.operationID !== intent.operationID ||
    evidence.requestDigest !== intent.requestDigest
  ) {
    return illegal(record, 'Remote evidence has no matching durable intent');
  }

  if (intent.kind === 'CREATE_CONTAINER') {
    if (!resource || resource.kind !== 'container') {
      return illegal(
        record,
        'Container create evidence has no managed resource',
      );
    }
    return noEffects({ ...record, container: resource, operationIntent: null });
  }
  if (intent.kind === 'APPEND_BATCH') {
    if (!record.candidate || record.state !== 'CANDIDATE_WRITING') {
      return illegal(record, 'Append evidence has no staging candidate');
    }
    const ids = evidence.returnedBlockIDs || [];
    if (ids.length !== intent.details.expectedBlockCount) {
      return illegal(
        record,
        'Append response block count does not match intent',
      );
    }
    const candidate: CandidateRecord = {
      ...record.candidate,
      batchDigests: [
        ...record.candidate.batchDigests,
        intent.details.batchDigest,
      ],
      nextBatchIndex: record.candidate.nextBatchIndex + 1,
      returnedBlockIDs: [...record.candidate.returnedBlockIDs, ...ids],
    };
    return noEffects({
      ...record,
      candidate,
      operationIntent: null,
      uploads: markUploadsAttached(
        record.uploads,
        intent.details.fileUploads,
        evidence.observedAt,
      ),
    });
  }
  if (intent.kind === 'DELETE_BLOCK') {
    if (evidence.result !== 'deleted') {
      return illegal(record, 'Delete evidence is not a confirmed deletion');
    }
    return noEffects({
      ...record,
      cleanup: {
        ...record.cleanup,
        targets: record.cleanup.targets.filter(
          ({ resource: target }) =>
            target.blockID !== intent.details.exactBlockID,
        ),
      },
      operationIntent: null,
    });
  }
  return noEffects({ ...record, operationIntent: null });
}

/**
 * Pure implementation of I1-I12 and T1-T23. It has no Notion, Zotero, clock,
 * random, persistence, or file-system dependency. Every remote effect carries
 * a complete operation intent which the executor must persist first.
 */
export function transition(
  record: NoteSyncRecordV3,
  event: NoteSyncEvent,
): TransitionResult {
  if (cleanupContainsActive(record)) {
    return illegal(record, 'Cleanup ledger targets the authoritative active');
  }
  if (!operationBelongsToRecord(record)) {
    return illegal(record, 'Persisted operation identity violates the record');
  }

  if (event.type === 'INVALID_SCHEMA_OR_EVIDENCE') {
    return noEffects(appendQuarantine(record, event.diagnostic));
  }

  if (record.state === 'QUARANTINED') {
    if (event.type !== 'EXPLICIT_REPAIR_OR_NEW_PROOF') {
      return illegal(
        record,
        'A quarantined transaction requires explicit repair',
      );
    }
    return noEffects({
      ...record,
      active: event.active === undefined ? record.active : event.active,
      candidate:
        event.candidate === undefined ? record.candidate : event.candidate,
      operationIntent: null,
      state: event.repairedState,
    });
  }

  if (event.type === 'OPERATION_UNCERTAIN') {
    if (!record.operationIntent) {
      return illegal(
        record,
        'Uncertain result has no durable operation intent',
      );
    }
    const operationIntent = {
      ...record.operationIntent,
      phase: 'UNCERTAIN' as const,
    };
    if (record.operationIntent.kind === 'APPEND_BATCH') {
      return noEffects(appendQuarantine(record, event.diagnostic));
    }
    return noEffects({ ...record, operationIntent });
  }

  if (event.type === 'OPERATION_PROVEN_UNEXECUTED') {
    if (!record.operationIntent) {
      return illegal(record, 'Proven-unexecuted result has no durable intent');
    }
    return noEffects({ ...record, operationIntent: null });
  }

  if (event.type === 'OPERATION_SUCCEEDED') {
    return operationSucceeded(record, event.evidence, event.resource);
  }

  if (event.type === 'UPLOAD_OBSERVED') {
    const intent = record.operationIntent;
    if (
      !intent ||
      !['UPLOAD_CREATE', 'UPLOAD_SEND'].includes(intent.kind) ||
      event.evidence.operationID !== intent.operationID ||
      event.evidence.requestDigest !== intent.requestDigest
    ) {
      return illegal(record, 'Upload evidence has no matching durable intent');
    }
    return noEffects({
      ...record,
      operationIntent: null,
      uploads: replaceUpload(record.uploads, event.asset),
    });
  }

  switch (event.type) {
    case 'SYNC_REQUESTED': {
      if (record.state !== 'IDLE') {
        return illegal(record, 'SYNC_REQUESTED is only legal from IDLE');
      }
      if (!sameTargetIdentity(record.targetIdentity, event.targetIdentity)) {
        return illegal(record, 'A note record cannot change target identity');
      }
      if (
        record.active?.sourceVersion === event.requestedSourceVersion &&
        record.featurePolicy === event.featurePolicy
      ) {
        return noEffects({
          ...record,
          requestedSourceVersion: event.requestedSourceVersion,
          updatedAt: event.now,
        });
      }
      return noEffects({
        ...record,
        candidate: null,
        cleanup: { mode: null, resume: 'IDLE', targets: [] },
        featurePolicy: event.featurePolicy,
        generation: record.generation + 1,
        operationGeneration: 0,
        operationIntent: null,
        requestedSourceVersion: event.requestedSourceVersion,
        sourceVersion: event.source.sourceVersion,
        state: 'PREPARING',
        transactionID: event.transactionID,
        updatedAt: event.now,
        uploads: event.featurePolicy === 'text-only-v1' ? [] : record.uploads,
      });
    }
    case 'CONTAINER_REQUIRED':
      return record.state === 'PREPARING' &&
        event.intent.kind === 'CREATE_CONTAINER'
        ? withIntent(record, event.intent)
        : illegal(record, 'Container creation is not legal in this state');
    case 'UPLOAD_CREATE_REQUIRED':
      if (
        record.state !== 'PREPARING' ||
        record.featurePolicy !== 'embedded-images-v1' ||
        event.intent.kind !== 'UPLOAD_CREATE'
      ) {
        return illegal(record, 'Upload create is not legal in this state');
      }
      return withIntent(
        { ...record, uploads: replaceUpload(record.uploads, event.upload) },
        event.intent,
      );
    case 'UPLOAD_SEND_REQUIRED':
      return record.state === 'PREPARING' &&
        record.featurePolicy === 'embedded-images-v1' &&
        event.intent.kind === 'UPLOAD_SEND'
        ? withIntent(record, event.intent)
        : illegal(record, 'Upload send is not legal in this state');
    case 'RESOURCES_READY':
      return record.state === 'PREPARING' &&
        record.container &&
        !record.operationIntent
        ? noEffects({ ...record, state: 'CANDIDATE_CREATING' })
        : illegal(record, 'Candidate resources are not ready');
    case 'CREATE_CANDIDATE':
      return record.state === 'CANDIDATE_CREATING' &&
        event.intent.kind === 'CREATE_CANDIDATE'
        ? withIntent(record, event.intent)
        : illegal(record, 'Candidate creation is not legal in this state');
    case 'RECONCILE_CREATE':
      if (
        record.state !== 'CANDIDATE_CREATING' ||
        record.operationIntent?.kind !== 'CREATE_CANDIDATE' ||
        event.evidence.operationID !== record.operationIntent.operationID ||
        event.candidate.transactionID !== record.transactionID ||
        event.candidate.generation !== record.generation ||
        event.candidate.sourceVersion !== record.sourceVersion
      ) {
        return illegal(record, 'Candidate create evidence is inconsistent');
      }
      return noEffects({
        ...record,
        candidate: event.candidate,
        operationIntent: null,
        state: 'CANDIDATE_WRITING',
      });
    case 'APPEND_BATCH':
      return record.state === 'CANDIDATE_WRITING' &&
        event.intent.kind === 'APPEND_BATCH' &&
        record.candidate?.nextBatchIndex === event.intent.details.batchIndex
        ? withIntent(record, event.intent)
        : illegal(record, 'Append batch is not the next candidate batch');
    case 'APPEND_UNKNOWN':
      if (
        record.state !== 'CANDIDATE_WRITING' ||
        record.operationIntent?.kind !== 'APPEND_BATCH'
      ) {
        return illegal(record, 'Append uncertainty has no append intent');
      }
      return noEffects({
        ...record,
        candidate: null,
        cleanup: {
          mode: 'abort',
          resume: 'PREPARING',
          targets: [...record.cleanup.targets, event.cleanupTarget].slice(
            -MAX_CLEANUP_TARGETS,
          ),
        },
        operationIntent: null,
        state: 'CLEANING',
        uploads: markUploadsAttached(
          record.uploads,
          event.attachedUploads || [],
          record.updatedAt,
        ),
      });
    case 'CONTENT_COMPLETE':
      return record.state === 'CANDIDATE_WRITING' &&
        record.candidate &&
        !record.operationIntent
        ? noEffects({
            ...record,
            candidate: { ...record.candidate, status: 'verified' },
            state: 'CANDIDATE_VERIFYING',
          })
        : illegal(record, 'Candidate content is not complete');
    case 'FINALIZE_CANDIDATE':
      return record.state === 'CANDIDATE_VERIFYING' &&
        event.intent.kind === 'FINALIZE_CANDIDATE'
        ? withIntent(record, event.intent)
        : illegal(record, 'Candidate finalization is not legal');
    case 'FINALIZE_CONFIRMED':
      if (
        record.state !== 'CANDIDATE_VERIFYING' ||
        record.operationIntent?.kind !== 'FINALIZE_CANDIDATE' ||
        !record.candidate ||
        event.completionEvidence.finalization.operationID !==
          record.operationIntent.operationID ||
        event.completionEvidence.manifestDigest !==
          record.candidate.manifestDigest
      ) {
        return illegal(record, 'Candidate completion evidence is inconsistent');
      }
      return noEffects({
        ...record,
        candidate: {
          ...record.candidate,
          block: event.finalBlock,
          completionEvidence: event.completionEvidence,
          status: 'durable',
        },
        operationIntent: null,
        state: 'CANDIDATE_DURABLE',
      });
    case 'FINALIZE_UNKNOWN':
      if (record.state !== 'CANDIDATE_VERIFYING') {
        return illegal(record, 'Finalization recovery is not legal');
      }
      if (event.diagnostic) {
        return noEffects(appendQuarantine(record, event.diagnostic));
      }
      if (!event.cleanupTarget) {
        return illegal(
          record,
          'Finalization uncertainty has no cleanup target',
        );
      }
      return noEffects({
        ...record,
        candidate: null,
        cleanup: {
          mode: 'abort',
          resume: 'PREPARING',
          targets: [...record.cleanup.targets, event.cleanupTarget],
        },
        operationIntent: null,
        state: 'CLEANING',
      });
    case 'COMMIT_ACTIVE': {
      if (record.state !== 'CANDIDATE_DURABLE') {
        return illegal(record, 'Only a durable candidate can commit');
      }
      const active = versionFromCandidate(record, event.committedAt);
      if (!active)
        return illegal(record, 'Durable candidate evidence is missing');
      const retired = record.active
        ? [
            ...record.cleanup.targets,
            {
              generation: record.active.generation,
              reason: 'retired-active' as const,
              resource: record.active.block,
              sourceVersion: record.active.sourceVersion,
              status: 'pending' as const,
              transactionID: record.transactionID || active.transactionID,
            },
          ]
        : record.cleanup.targets;
      return noEffects({
        ...record,
        active,
        cleanup: {
          mode: retired.length ? 'retire' : null,
          resume: 'IDLE',
          targets: retired,
        },
        state: 'ACTIVE_COMMITTED',
      });
    }
    case 'NO_PREVIOUS_ACTIVE':
      return record.state === 'ACTIVE_COMMITTED' &&
        record.cleanup.targets.length === 0
        ? noEffects({
            ...record,
            candidate: null,
            cleanup: { mode: null, resume: 'IDLE', targets: [] },
            sourceVersion: null,
            state: 'IDLE',
            transactionID: null,
          })
        : illegal(record, 'Committed transaction still requires cleanup');
    case 'PREVIOUS_ACTIVE_RETIRED':
      return record.state === 'ACTIVE_COMMITTED' &&
        record.cleanup.targets.length > 0
        ? noEffects({ ...record, candidate: null, state: 'CLEANING' })
        : illegal(record, 'There is no previous active to retire');
    case 'DELETE_NEXT': {
      const target = record.cleanup.targets[0];
      return record.state === 'CLEANING' &&
        target &&
        event.intent.kind === 'DELETE_BLOCK' &&
        event.intent.details.exactBlockID === target.resource.blockID &&
        event.intent.details.expectedParent.id === target.resource.parent.id &&
        event.intent.details.expectedCreator === target.resource.createdByID &&
        event.intent.details.expectedOwnershipMarker ===
          target.resource.marker &&
        event.intent.details.expectedVersionMarker ===
          target.resource.versionMarker &&
        event.intent.details.expectedLastEditedTime ===
          target.resource.lastEditedTime &&
        event.intent.details.targetGeneration === target.generation &&
        event.intent.details.targetSourceVersion === target.sourceVersion &&
        target.resource.blockID !== record.active?.block.blockID
        ? withIntent(record, event.intent)
        : illegal(
            record,
            'Delete intent does not exactly match cleanup target',
          );
    }
    case 'RECOVER_DELETE_INTENT':
      if (
        record.state !== 'CLEANING' ||
        record.operationIntent?.kind !== 'DELETE_BLOCK'
      ) {
        return illegal(
          record,
          'Delete recovery has no persisted DELETE intent',
        );
      }
      if (event.diagnostic) {
        return noEffects(appendQuarantine(record, event.diagnostic));
      }
      if (event.evidence) {
        return operationSucceeded(record, event.evidence);
      }
      return observeEffect(record, record.operationIntent);
    case 'CLEANUP_COMPLETE':
      if (
        record.state !== 'CLEANING' ||
        record.cleanup.targets.some(({ status }) => status === 'pending') ||
        record.operationIntent
      ) {
        return illegal(record, 'Cleanup still has pending work');
      }
      return noEffects({
        ...record,
        candidate: null,
        cleanup: { mode: null, resume: 'IDLE', targets: [] },
        sourceVersion: null,
        state: 'IDLE',
        transactionID: null,
      });
    case 'SOURCE_CHANGED': {
      if (record.state === 'IDLE') {
        return illegal(record, 'IDLE source changes use SYNC_REQUESTED');
      }
      if (['ACTIVE_COMMITTED', 'CLEANING'].includes(record.state)) {
        return noEffects({
          ...record,
          requestedSourceVersion: event.requestedSourceVersion,
          updatedAt: event.now,
        });
      }
      const targets = event.cleanupTarget
        ? [...record.cleanup.targets, event.cleanupTarget]
        : record.cleanup.targets;
      return noEffects({
        ...record,
        candidate: null,
        cleanup: { mode: 'abort', resume: 'PREPARING', targets },
        operationIntent: null,
        requestedSourceVersion: event.requestedSourceVersion,
        state: targets.length ? 'CLEANING' : 'IDLE',
        updatedAt: event.now,
        ...(targets.length === 0 && {
          sourceVersion: null,
          transactionID: null,
        }),
      });
    }
    case 'SOURCE_CHANGED_WITH_ACTIVE':
      return record.state === 'CANDIDATE_DURABLE' && record.active
        ? noEffects({
            ...record,
            candidate: null,
            cleanup: {
              mode: 'abort',
              resume: 'PREPARING',
              targets: [...record.cleanup.targets, event.cleanupTarget],
            },
            operationIntent: null,
            requestedSourceVersion: event.requestedSourceVersion,
            state: 'CLEANING',
            updatedAt: event.now,
          })
        : illegal(record, 'Durable source change expected an existing active');
    case 'SOURCE_CHANGED_WITHOUT_ACTIVE':
      if (record.state !== 'CANDIDATE_DURABLE' || record.active) {
        return illegal(
          record,
          'Durable source change unexpectedly has an active',
        );
      }
      return transition(
        {
          ...record,
          requestedSourceVersion: event.requestedSourceVersion,
          updatedAt: event.now,
        },
        { committedAt: event.committedAt, type: 'COMMIT_ACTIVE' },
      );
    case 'EXPLICIT_REPAIR_OR_NEW_PROOF':
      return illegal(record, 'Repair event is only legal from QUARANTINED');
    default:
      return illegal(record, `Event is not legal from ${record.state}`);
  }
}
