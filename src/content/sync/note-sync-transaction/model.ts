import type {
  FeaturePolicy,
  NoteSyncRecordV3,
  QuarantineRecord,
  TargetIdentity,
} from './types';
import { NOTE_SYNC_SCHEMA_VERSION } from './types';

export const MAX_CLEANUP_TARGETS = 32;
export const MAX_QUARANTINE_RECORDS = 32;
export const MAX_UPLOAD_ASSETS = 64;

export function createIdleRecord(
  targetIdentity: TargetIdentity,
  featurePolicy: FeaturePolicy,
  now: string,
): NoteSyncRecordV3 {
  return {
    active: null,
    candidate: null,
    cleanup: { mode: null, resume: 'IDLE', targets: [] },
    container: null,
    createdAt: now,
    featurePolicy,
    generation: 0,
    operationGeneration: 0,
    operationIntent: null,
    quarantine: [],
    recordRevision: 0,
    requestedSourceVersion: null,
    schemaVersion: NOTE_SYNC_SCHEMA_VERSION,
    sourceVersion: null,
    state: 'IDLE',
    targetIdentity,
    transactionID: null,
    updatedAt: now,
    uploads: [],
  };
}

export function appendQuarantine(
  record: NoteSyncRecordV3,
  diagnostic: QuarantineRecord,
): NoteSyncRecordV3 {
  return {
    ...record,
    operationIntent: null,
    quarantine: [...record.quarantine, diagnostic].slice(
      -MAX_QUARANTINE_RECORDS,
    ),
    state: 'QUARANTINED',
    updatedAt: diagnostic.createdAt,
  };
}

export function sameTargetIdentity(
  left: TargetIdentity,
  right: TargetIdentity,
): boolean {
  return (
    left.connectionID === right.connectionID &&
    left.workspaceID === right.workspaceID &&
    left.databaseID === right.databaseID &&
    left.pageID === right.pageID &&
    left.libraryID === right.libraryID &&
    left.parentItemKey === right.parentItemKey &&
    left.noteItemKey === right.noteItemKey &&
    left.identityType === right.identityType
  );
}

export function cleanupContainsActive(record: NoteSyncRecordV3): boolean {
  return Boolean(
    record.active &&
    record.cleanup.targets.some(
      ({ resource }) => resource.blockID === record.active?.block.blockID,
    ),
  );
}

export function operationBelongsToRecord(record: NoteSyncRecordV3): boolean {
  const intent = record.operationIntent;
  return Boolean(
    !intent ||
    (record.transactionID &&
      intent.transactionID === record.transactionID &&
      intent.generation === record.generation &&
      intent.sourceVersion === record.sourceVersion &&
      sameTargetIdentity(intent.targetIdentity, record.targetIdentity)),
  );
}
