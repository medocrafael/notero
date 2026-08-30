import { digestCanonical } from './canonical';
import type { MainEventV2 } from './events-v4';
import {
  deriveAssetID,
  deriveContainerTargetDigest,
  deriveTargetIdentityDigest,
} from './identity-v4';
import { createOperationIntent, DEFAULT_LIVENESS_TTL_MS } from './model-v4';
import type { ProcessSession, RuntimeIdentityFactory } from './model-v4';
import type { RuntimeClock } from './runtime-clock';
import { ownershipFromResource } from './schema-v4';
import { TRANSITION_REGISTRY } from './transition-registry';
import type {
  CleanupLedgerEntry,
  MainTransactionV2,
  MainWriterLease,
  ManagedResourceIdentity,
  NoteSyncRecordV4,
  SourceSnapshotV4,
  TargetIdentity,
  UploadAssetRecordV4,
} from './types-v4';

const CREATE_ISOLATION_MS = 65 * 60 * 1000;
const MAIN_LEASE_MS = 60_000;

type CoordinatorV2Options = {
  forceLiveness?: boolean;
  legacyMigrationRequired?: boolean;
  livenessTtlMs?: number;
  resumeHalted?: boolean;
};

export class MainCoordinatorV2 {
  private readonly targetDigest: string;
  private readonly containerTargetDigest: string;

  public constructor(
    private readonly source: SourceSnapshotV4,
    private readonly targetIdentity: TargetIdentity,
    private readonly session: ProcessSession,
    private readonly clock: RuntimeClock,
    private readonly identity: RuntimeIdentityFactory,
    private readonly options: CoordinatorV2Options = {},
  ) {
    if (
      source.imageAssets.some(
        (asset) =>
          asset.assetID !==
          deriveAssetID({
            attachmentIdentity: asset.attachmentIdentity,
            contentHash: asset.contentHash,
            contentLength: asset.contentLength,
            contentType: asset.contentType,
            sourceIdentity: asset.sourceIdentity,
            targetIdentityDigest: deriveTargetIdentityDigest(
              this.targetIdentity,
            ),
          }),
      )
    ) {
      throw new Error(
        'Source snapshot contains a non-canonical image asset ID',
      );
    }
    this.targetDigest = deriveTargetIdentityDigest(this.targetIdentity);
    this.containerTargetDigest = deriveContainerTargetDigest(
      this.targetIdentity,
    );
  }

  public select(record: NoteSyncRecordV4): MainEventV2 | null {
    const event = this.plan(record);
    if (!event) return null;
    const registered = TRANSITION_REGISTRY.some(
      (definition) =>
        definition.eventKind === event.type &&
        definition.from.includes(record.mainState) &&
        definition.guard(record, event),
    );
    if (!registered) {
      throw new Error(
        `Coordinator emitted unregistered event ${record.mainState}/${event.type}`,
      );
    }
    return event;
  }

  private plan(record: NoteSyncRecordV4): MainEventV2 | null {
    this.assertSourceTarget(record);
    const requested = {
      featurePolicy: this.source.featurePolicy,
      manifestDigest: this.source.manifestDigest,
      observedAt: this.clock.nowISOString(),
      sourceVersion: this.source.sourceVersion,
    };
    if (!record.requestedSource) {
      return { source: requested, type: 'SOURCE_OBSERVED' };
    }
    if (record.requestedSource.sourceVersion === this.source.sourceVersion) {
      if (
        record.requestedSource.manifestDigest !== this.source.manifestDigest ||
        record.requestedSource.featurePolicy !== this.source.featurePolicy
      ) {
        throw new Error(
          'Observed source version conflicts with persisted immutable content',
        );
      }
    } else {
      return { source: requested, type: 'SOURCE_OBSERVED' };
    }
    if (record.mainState === 'QUARANTINED') return null;
    if (record.mainState === 'IDLE') return this.planIdle(record);
    const transaction = record.mainTransaction;
    if (!transaction) throw new Error('Executing state has no transaction');
    if (transaction.runHalt) {
      return this.options.resumeHalted ? { type: 'RESUME_AFTER_HALT' } : null;
    }
    if (
      record.requestedSource.sourceVersion !==
      transaction.transactionSourceVersion
    ) {
      if (transaction.operationIntent) return null;
      if (record.mainState === 'CANDIDATE_DURABLE' && !record.active) {
        return {
          retiredActiveCleanup: null,
          type: 'COMMIT_DURABLE_CANDIDATE',
        };
      }
      return this.supersede(record);
    }
    if (record.mainState === 'CANDIDATE_DURABLE') {
      return {
        retiredActiveCleanup: record.active
          ? this.cleanupFor(
              record.active.block,
              record.active.transactionID,
              record.active.generation,
              record.active.sourceVersion,
              'REPLACED_ACTIVE',
            )
          : null,
        type: 'COMMIT_DURABLE_CANDIDATE',
      };
    }
    if (!this.hasCurrentLease(record)) {
      return { lease: this.createLease(record), type: 'MAIN_LEASE_ACQUIRED' };
    }
    if (transaction.operationIntent) return null;
    switch (record.mainState) {
      case 'PREPARING':
        return transaction.purpose === 'LIVENESS'
          ? this.planLiveness(record)
          : this.planPreparation(record);
      case 'CANDIDATE_CREATING':
        return null;
      case 'CANDIDATE_WRITING':
        return this.planAppend(record);
      case 'CANDIDATE_VERIFYING':
        return this.planVerification(record);
      default:
        return null;
    }
  }

  private assertSourceTarget(record: NoteSyncRecordV4): void {
    const targetDigest = deriveTargetIdentityDigest(record.targetIdentity);
    if (this.targetDigest !== targetDigest) {
      throw new Error('Coordinator cannot be reused for another note target');
    }
  }

  private planIdle(record: NoteSyncRecordV4): MainEventV2 | null {
    if (!record.active) {
      return {
        transaction: this.newTransaction(record, 'SYNC'),
        type: 'START_SYNC',
      };
    }
    if (this.livenessDue(record)) {
      return {
        transaction: this.newTransaction(record, 'LIVENESS'),
        type: 'START_LIVENESS',
      };
    }
    return record.active.sourceVersion === record.requestedSource?.sourceVersion
      ? null
      : {
          transaction: this.newTransaction(record, 'SYNC'),
          type: 'START_SYNC',
        };
  }

  private livenessDue(record: NoteSyncRecordV4): boolean {
    if (this.options.forceLiveness) return true;
    const checkedAt = record.remoteVerification?.checkedAt;
    if (!checkedAt || record.remoteVerification?.outcome !== 'EXACT')
      return true;
    return (
      this.clock.compare(
        this.clock.addMs(
          checkedAt,
          this.options.livenessTtlMs ?? DEFAULT_LIVENESS_TTL_MS,
        ),
        this.clock.nowISOString(),
      ) <= 0
    );
  }

  private newTransaction(
    record: NoteSyncRecordV4,
    purpose: MainTransactionV2['purpose'],
  ): MainTransactionV2 {
    return {
      candidate: null,
      featurePolicy: this.source.featurePolicy,
      generation:
        Math.max(
          record.active?.generation ?? 0,
          record.mainTransaction?.generation ?? 0,
        ) + 1,
      operationIntent: null,
      operationSequence: 0,
      purpose,
      runHalt: null,
      sourceManifestDigest: this.source.manifestDigest,
      sourceTitle: this.source.title,
      targetIdentityDigest: this.targetDigest,
      transactionID: this.identity.randomUUID(),
      transactionSourceVersion: this.source.sourceVersion,
    };
  }

  private hasCurrentLease(record: NoteSyncRecordV4): boolean {
    const lease = record.writerCoordination.mainLease;
    const transaction = record.mainTransaction;
    return Boolean(
      lease &&
      transaction &&
      lease.processSessionID === this.session.processSessionID &&
      lease.transactionID === transaction.transactionID &&
      lease.generation === transaction.generation &&
      lease.noteIdentityDigest === this.targetDigest &&
      this.clock.compare(lease.expiresAt, this.clock.nowISOString()) > 0,
    );
  }

  private createLease(record: NoteSyncRecordV4): MainWriterLease {
    const transaction = record.mainTransaction;
    if (!transaction) throw new Error('Cannot lease an absent transaction');
    const now = this.clock.nowISOString();
    return {
      acquiredAt: now,
      expiresAt: this.clock.addMs(now, MAIN_LEASE_MS),
      generation: transaction.generation,
      leaseEpoch: (record.writerCoordination.mainLease?.leaseEpoch ?? 0) + 1,
      leaseID: this.identity.randomUUID(),
      noteIdentityDigest: this.targetDigest,
      processSessionID: this.session.processSessionID,
      transactionID: transaction.transactionID,
    };
  }

  private intentBase(record: NoteSyncRecordV4) {
    const transaction = record.mainTransaction;
    const lease = record.writerCoordination.mainLease;
    if (!transaction || !lease) {
      throw new Error('Operation planning requires transaction lease');
    }
    return {
      createdAt: this.clock.nowISOString(),
      generation: transaction.generation,
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationSequence: transaction.operationSequence + 1,
      owner: 'MAIN' as const,
      processSessionID: lease.processSessionID,
      sourceVersion: transaction.transactionSourceVersion,
      targetIdentityDigest: this.targetDigest,
      transactionID: transaction.transactionID,
    };
  }

  private operationID(): string {
    return this.identity.randomUUID();
  }

  private isolationWindow() {
    const requestStartedAt = this.clock.nowISOString();
    return {
      isolationDeadline: this.clock.addMs(
        requestStartedAt,
        CREATE_ISOLATION_MS,
      ),
      requestStartedAt,
    };
  }

  private planLiveness(record: NoteSyncRecordV4): MainEventV2 {
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        active: record.active?.block ?? null,
        container: record.container,
        force: this.options.forceLiveness === true,
      },
      kind: 'VERIFY_LIVENESS',
      operationID,
    });
    return { intent, type: 'LIVENESS_INTENT_PERSISTED' };
  }

  private planPreparation(record: NoteSyncRecordV4): MainEventV2 {
    if (!record.container) return this.planContainer(record);
    const uploadEvent = this.planUpload(record);
    if (uploadEvent) return uploadEvent;
    return this.planCandidate(record);
  }

  private planContainer(record: NoteSyncRecordV4): MainEventV2 {
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        expectedCreator: record.targetIdentity.connectionID,
        ...this.isolationWindow(),
        migrationNotice: this.options.legacyMigrationRequired === true,
        operationMarker: `notero:operation:${operationID}`,
        ownershipMarker: `notero:container:${this.containerTargetDigest}`,
        parent: { id: record.targetIdentity.pageID, type: 'page_id' },
        title: 'Zotero Notes',
        versionMarker: 'notero:fsm-v4',
      },
      kind: 'CREATE_CONTAINER',
      operationID,
    });
    return { intent, type: 'CONTAINER_INTENT_PERSISTED' };
  }

  private reusableAsset(
    record: NoteSyncRecordV4,
    assetID: string,
  ): UploadAssetRecordV4 | undefined {
    const asset = record.uploadAssets.find(
      (entry) => entry.assetID === assetID,
    );
    if (!asset) return undefined;
    if (
      asset.expiryTime &&
      this.clock.compare(asset.expiryTime, this.clock.nowISOString()) <= 0
    ) {
      return undefined;
    }
    return asset;
  }

  private planUpload(record: NoteSyncRecordV4): MainEventV2 | null {
    if (this.source.featurePolicy === 'text-only-v1') return null;
    for (const sourceAsset of this.source.imageAssets) {
      const existing = this.reusableAsset(record, sourceAsset.assetID);
      if (existing?.status === 'ATTACHED' || existing?.status === 'UPLOADED') {
        continue;
      }
      const operationID = this.operationID();
      if (existing?.status === 'CREATED_UNSENT' && existing.fileUploadID) {
        const intent = createOperationIntent({
          ...this.intentBase(record),
          details: {
            assetID: existing.assetID,
            attachmentKey: existing.attachmentKey,
            contentHash: existing.contentHash,
            contentLength: existing.contentLength,
            contentType: existing.contentType,
            createOperationID: existing.createOperationID,
            fileUploadID: existing.fileUploadID,
            filename: existing.filename,
          },
          kind: 'UPLOAD_SEND',
          operationID,
        });
        return {
          asset: {
            ...existing,
            sendOperationID: operationID,
            status: 'SEND_INTENDED',
          },
          intent,
          type: 'UPLOAD_INTENT_PERSISTED',
        };
      }
      if (
        existing &&
        [
          'CREATE_INTENDED',
          'CREATE_UNCERTAIN',
          'SEND_INTENDED',
          'SEND_UNCERTAIN',
        ].includes(existing.status)
      ) {
        return null;
      }
      const transaction = record.mainTransaction;
      if (!transaction) throw new Error('Upload requires transaction');
      const asset: UploadAssetRecordV4 = {
        assetID: sourceAsset.assetID,
        attachedAt: null,
        attachmentIdentity: sourceAsset.attachmentIdentity,
        attachmentKey: sourceAsset.attachmentKey,
        contentHash: sourceAsset.contentHash,
        contentLength: sourceAsset.contentLength,
        contentType: sourceAsset.contentType,
        createOperationID: operationID,
        expiryTime: null,
        fileUploadID: null,
        filename: sourceAsset.filename,
        generation: transaction.generation,
        sendOperationID: null,
        sourceIdentity: sourceAsset.sourceIdentity,
        sourceVersion: transaction.transactionSourceVersion,
        status: 'CREATE_INTENDED',
        targetIdentityDigest: this.targetDigest,
        transactionID: transaction.transactionID,
      };
      const intent = createOperationIntent({
        ...this.intentBase(record),
        details: {
          assetID: asset.assetID,
          attachmentKey: asset.attachmentKey,
          contentHash: asset.contentHash,
          contentLength: asset.contentLength,
          contentType: asset.contentType,
          filename: asset.filename,
          ...this.isolationWindow(),
        },
        kind: 'UPLOAD_CREATE',
        operationID,
      });
      return { asset, intent, type: 'UPLOAD_INTENT_PERSISTED' };
    }
    return null;
  }

  private uploadReferences(record: NoteSyncRecordV4) {
    return this.source.imageAssets.map((sourceAsset) => {
      const asset = this.reusableAsset(record, sourceAsset.assetID);
      if (!asset?.fileUploadID) {
        throw new Error(`Image asset ${sourceAsset.assetID} is not uploaded`);
      }
      return {
        assetID: asset.assetID,
        contentHash: asset.contentHash,
        fileUploadID: asset.fileUploadID,
      };
    });
  }

  private planCandidate(record: NoteSyncRecordV4): MainEventV2 {
    const container = record.container;
    const transaction = record.mainTransaction;
    if (!container || !transaction) {
      throw new Error('Candidate creation requires container and transaction');
    }
    const uploads = this.uploadReferences(record);
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        container,
        expectedBatchCount: this.source.batches.length,
        expectedBlockCount: this.source.batches.reduce(
          (total, batch) => total + batch.length,
          0,
        ),
        expectedImageCount: this.source.imageOccurrenceCount,
        expectedImageUploadIDs: uploads.map(({ fileUploadID }) => fileUploadID),
        finalTitle: this.source.title,
        imageAssetIdentities: this.source.imageAssets.map(
          ({ assetID }) => assetID,
        ),
        ...this.isolationWindow(),
        manifestDigest: transaction.sourceManifestDigest,
        operationMarker: `notero:operation:${operationID}`,
        ownershipMarker: `notero:note:${this.targetDigest}`,
        parent: { id: container.blockID, type: 'block_id' },
        previousActiveBlockID: record.active?.block.blockID ?? null,
        versionMarker: `notero:source:${transaction.transactionSourceVersion}`,
      },
      kind: 'CREATE_CANDIDATE',
      operationID,
    });
    return { intent, type: 'CANDIDATE_INTENT_PERSISTED' };
  }

  private planAppend(record: NoteSyncRecordV4): MainEventV2 {
    const candidate = record.mainTransaction?.candidate;
    if (!candidate) throw new Error('Append planning requires candidate');
    const batchIndex = candidate.batchEvidence.length;
    const batch = this.source.batches[batchIndex];
    if (!batch) throw new Error(`Source batch ${batchIndex} is unavailable`);
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        batchDigest: digestCanonical('notero-batch-v4', {
          batch,
          batchIndex,
          sourceVersion: this.source.sourceVersion,
        }),
        batchIndex,
        blockFingerprints: batch.map((block, index) =>
          digestCanonical('notero-block-v4', {
            block,
            index,
            sourceVersion: this.source.sourceVersion,
          }),
        ),
        candidate: candidate.resource,
        expectedBlockCount: batch.length,
        fileUploads: this.uploadReferences(record),
      },
      kind: 'APPEND_BATCH',
      operationID,
    });
    return { intent, type: 'APPEND_INTENT_PERSISTED' };
  }

  private planVerification(record: NoteSyncRecordV4): MainEventV2 {
    const candidate = record.mainTransaction?.candidate;
    if (!candidate) throw new Error('Verification requires candidate');
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        batchDigests: candidate.batchEvidence.map(
          ({ batchDigest }) => batchDigest,
        ),
        blockFingerprints: candidate.batchEvidence.flatMap(
          ({ blockFingerprints }) => blockFingerprints,
        ),
        candidate: candidate.resource,
        expectedBatchCount: candidate.expectedBatchCount,
        expectedBlockCount: candidate.expectedBlockCount,
        expectedImageUploadIDs: candidate.batchEvidence.flatMap(
          ({ imageUploadIDs }) => imageUploadIDs,
        ),
        manifestDigest: candidate.manifestDigest,
        returnedBlockIDs: candidate.batchEvidence.flatMap(
          ({ returnedBlockIDs }) => returnedBlockIDs,
        ),
      },
      kind: 'VERIFY_CANDIDATE',
      operationID,
    });
    return { intent, type: 'VERIFY_INTENT_PERSISTED' };
  }

  private supersede(record: NoteSyncRecordV4): MainEventV2 {
    const candidate = record.mainTransaction?.candidate;
    const cleanupEntries = candidate
      ? [
          this.cleanupFor(
            candidate.resource,
            candidate.transactionID,
            candidate.generation,
            candidate.sourceVersion,
            'SUPERSEDED_CANDIDATE',
          ),
        ]
      : [];
    return {
      cleanupEntries,
      replacement: this.newTransaction(record, 'SYNC'),
      type: 'SUPERSEDE_TRANSACTION',
    };
  }

  private cleanupFor(
    resource: ManagedResourceIdentity,
    transactionID: string,
    generation: number,
    sourceVersion: string,
    reason: CleanupLedgerEntry['reason'],
  ): CleanupLedgerEntry {
    const now = this.clock.nowISOString();
    return {
      attemptCount: 0,
      cleanupID: this.identity.randomUUID(),
      createdAt: now,
      deleteIntent: null,
      generation,
      lastObservation: null,
      nextRetryAt: null,
      ownership: ownershipFromResource(resource),
      quarantineEvidenceID: null,
      reason,
      resource,
      sourceVersion,
      state: 'PENDING',
      transactionID,
      updatedAt: now,
      workerLease: null,
    };
  }
}
