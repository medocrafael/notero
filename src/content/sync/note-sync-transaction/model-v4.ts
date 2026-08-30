import {
  deriveOperationRequestDigest,
  deriveTargetIdentityDigest,
  type UnsealedOperationIntent,
} from './identity-v4';
import type { RuntimeClock } from './runtime-clock';
import {
  NOTE_SYNC_SCHEMA_VERSION_V4,
  type CandidateRecordV4,
  type DurableActiveMapping,
  type FeaturePolicy,
  type MainWriterLease,
  type NoteSyncRecordV4,
  type RemoteObservation,
  type SealedOperationIntent,
  type SealedQuarantineEvidence,
  type SourceSnapshotV4,
  type TargetIdentity,
} from './types-v4';

export const DEFAULT_MAIN_LEASE_MS = 60_000;
export const DEFAULT_LIVENESS_TTL_MS = 30 * 60 * 1000;
export const MAX_QUARANTINE_EVIDENCE = 64;

export type ProcessSession = {
  processSessionID: string;
  startedAt: string;
};

export type RuntimeIdentityFactory = {
  randomUUID: () => string;
};

export function createProcessSession(
  clock: RuntimeClock,
  identity: RuntimeIdentityFactory,
): ProcessSession {
  return {
    processSessionID: identity.randomUUID(),
    startedAt: clock.nowISOString(),
  };
}

export function createIdleRecordV4(
  targetIdentity: TargetIdentity,
  clock: RuntimeClock,
): NoteSyncRecordV4 {
  const now = clock.nowISOString();
  return {
    active: null,
    cleanupLedger: [],
    container: null,
    createdAt: now,
    mainState: 'IDLE',
    mainTransaction: null,
    quarantineEvidence: [],
    remoteVerification: null,
    requestedSource: null,
    revision: 0,
    schemaVersion: NOTE_SYNC_SCHEMA_VERSION_V4,
    targetIdentity,
    updatedAt: now,
    uploadAssets: [],
    writerCoordination: { mainLease: null },
  };
}

export function observeRequestedSource(
  record: NoteSyncRecordV4,
  source: Pick<
    SourceSnapshotV4,
    'featurePolicy' | 'manifestDigest' | 'sourceVersion'
  >,
  clock: RuntimeClock,
): NoteSyncRecordV4 {
  if (record.requestedSource?.sourceVersion === source.sourceVersion) {
    if (
      record.requestedSource.manifestDigest !== source.manifestDigest ||
      record.requestedSource.featurePolicy !== source.featurePolicy
    ) {
      throw new Error(
        'The same source version was observed with conflicting immutable content',
      );
    }
    return record;
  }
  return {
    ...record,
    requestedSource: {
      featurePolicy: source.featurePolicy,
      manifestDigest: source.manifestDigest,
      observedAt: clock.nowISOString(),
      sourceVersion: source.sourceVersion,
    },
  };
}

export function acquireMainWriterLease(
  record: NoteSyncRecordV4,
  session: ProcessSession,
  clock: RuntimeClock,
  identity: RuntimeIdentityFactory,
  durationMs = DEFAULT_MAIN_LEASE_MS,
): NoteSyncRecordV4 {
  const transaction = record.mainTransaction;
  if (!transaction) throw new Error('Cannot lease an absent main transaction');
  const current = record.writerCoordination.mainLease;
  const now = clock.nowISOString();
  const nextLease: MainWriterLease = {
    acquiredAt: now,
    expiresAt: clock.addMs(now, durationMs),
    generation: transaction.generation,
    leaseEpoch: (current?.leaseEpoch ?? 0) + 1,
    leaseID: identity.randomUUID(),
    noteIdentityDigest: deriveTargetIdentityDigest(record.targetIdentity),
    processSessionID: session.processSessionID,
    transactionID: transaction.transactionID,
  };
  return {
    ...record,
    writerCoordination: { mainLease: nextLease },
  };
}

export function createOperationIntent(
  request: UnsealedOperationIntent,
): SealedOperationIntent {
  const requestDigest = deriveOperationRequestDigest(request);
  return {
    ...request,
    requestDigest,
    status: 'EXECUTABLE',
  };
}

export function sealOperationIntent<Intent extends SealedOperationIntent>(
  intent: Intent,
  status: 'SEALED' | 'UNCERTAIN',
): Intent {
  return { ...intent, status };
}

export function deriveDurableActive(
  candidate: CandidateRecordV4,
  featurePolicy: FeaturePolicy,
  clock: RuntimeClock,
): DurableActiveMapping {
  if (candidate.status !== 'DURABLE' || !candidate.completionEvidence) {
    throw new Error('Only a durable candidate can become authoritative');
  }
  return {
    block: candidate.resource,
    committedAt: clock.nowISOString(),
    completionEvidence: candidate.completionEvidence,
    container: candidate.container,
    featurePolicy,
    generation: candidate.generation,
    imageAssetIdentities: candidate.imageAssetIdentities,
    manifestDigest: candidate.manifestDigest,
    sourceVersion: candidate.sourceVersion,
    targetIdentityDigest: candidate.targetIdentityDigest,
    transactionID: candidate.transactionID,
  };
}

export function createSealedQuarantineEvidence(input: {
  clock: RuntimeClock;
  evidenceID: string;
  generation: number | null;
  intent: SealedOperationIntent | null;
  noteRevision: number;
  observation: RemoteObservation | null;
  origin: SealedQuarantineEvidence['origin'];
  reasonCode: string;
  requiredRepair: SealedQuarantineEvidence['requiredRepair'];
  resource: SealedQuarantineEvidence['resource'];
  rootRevision: number;
  responseClassification: string | null;
  sourceVersion: string | null;
  transactionID: string | null;
}): SealedQuarantineEvidence {
  const now = input.clock.nowISOString();
  const intent = input.intent
    ? sealOperationIntent(input.intent, 'SEALED')
    : null;
  return {
    evidenceID: input.evidenceID,
    expectedOwnership: input.resource
      ? {
          blockID: input.resource.blockID,
          createdByID: input.resource.createdByID,
          kind: input.resource.kind,
          lastEditedTime: input.resource.lastEditedTime,
          operationMarker: input.resource.operationMarker,
          ownershipMarker: input.resource.ownershipMarker,
          parent: input.resource.parent,
          targetIdentityDigest: input.resource.targetIdentityDigest,
          versionMarker: input.resource.versionMarker,
        }
      : null,
    firstSeenAt: now,
    generation: input.generation,
    lastObservation: input.observation,
    lastSeenAt: now,
    noteRevision: input.noteRevision,
    origin: input.origin,
    originalOperationIntent: intent,
    reasonCode: input.reasonCode,
    requiredRepair: input.requiredRepair,
    resource: input.resource,
    responseClassification: input.responseClassification,
    rootRevision: input.rootRevision,
    sealed: true,
    sourceVersion: input.sourceVersion,
    transactionID: input.transactionID,
  };
}

export function quarantineMain(
  record: NoteSyncRecordV4,
  evidence: SealedQuarantineEvidence,
): NoteSyncRecordV4 {
  return {
    ...record,
    mainState: 'QUARANTINED',
    mainTransaction: record.mainTransaction
      ? { ...record.mainTransaction, operationIntent: null }
      : null,
    quarantineEvidence: [...record.quarantineEvidence, evidence].slice(
      -MAX_QUARANTINE_EVIDENCE,
    ),
    writerCoordination: { mainLease: null },
  };
}
