import { canonicalJSON, digestCanonical } from './canonical';
import type { MainEventPayloadV2, MainEventV2 } from './events-v4';
import {
  asRemoteCreatorIdentity,
  deriveAssetID,
  deriveContainerTargetDigest,
  deriveTargetIdentityDigest,
  remoteCreatorExpectation,
} from './identity-v4';
import {
  createOperationIntent,
  createPendingCleanupEntry,
  DEFAULT_LIVENESS_TTL_MS,
} from './model-v4';
import type { ProcessSession, RuntimeIdentityFactory } from './model-v4';
import { deriveNotionBlockFingerprint } from './notion-block-fingerprint-v4';
import type { RuntimeClock } from './runtime-clock';
import {
  selectCoordinatorTransitionV2,
  type CoordinatorProducerMapV2,
  type CoordinatorSelectionContextV2,
} from './transition-registry';
import type {
  CleanupLedgerEntry,
  MainTransactionV2,
  MainWriterLease,
  ManagedResourceIdentity,
  NoteSyncRecordV4,
  RemoteVerificationState,
  RemoteCreatorIdentity,
  SealedQuarantineEvidence,
  SourceSnapshotV4,
  TargetIdentity,
  UploadAssetRecordV4,
} from './types-v4';

const CREATE_ISOLATION_MS = 65 * 60 * 1000;
const MAIN_LEASE_MS = 60_000;
const STAGING_TITLE_PREFIX = 'Notero Sync Incomplete — ';

type CoordinatorV2Options = {
  forceLiveness?: boolean;
  legacyMigrationRequired?: boolean;
  livenessTtlMs?: number;
  remoteCreatorID?: RemoteCreatorIdentity;
  resumeHalted?: boolean;
};

export class MainCoordinatorV2 {
  private readonly targetDigest: string;
  private readonly containerTargetDigest: string;
  private forceLivenessPending: boolean;

  public constructor(
    private readonly source: SourceSnapshotV4,
    private readonly targetIdentity: TargetIdentity,
    private readonly session: ProcessSession,
    private readonly clock: RuntimeClock,
    private readonly identity: RuntimeIdentityFactory,
    private readonly options: CoordinatorV2Options = {},
  ) {
    this.forceLivenessPending = options.forceLiveness === true;
    if (
      source.imageAssets.some(
        (asset) =>
          asset.assetID !== asset.assetIdentityDigest ||
          asset.assetIdentityDigest !==
            deriveAssetID({
              attachmentIdentity: asset.attachmentIdentity,
              contentHash: asset.contentHash,
              contentLength: asset.contentLength,
              contentType: asset.contentType,
              filename: asset.filename,
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
    const knownAssetIDs = new Set(
      source.imageAssets.map(({ assetID }) => assetID),
    );
    if (
      source.imageAssetIDsByBatch.length !== source.batches.length ||
      source.imageAssetIDsByBatch.flat().length !==
        source.imageOccurrenceCount ||
      source.imageAssetIDsByBatch
        .flat()
        .some((assetID) => !knownAssetIDs.has(assetID))
    ) {
      throw new Error('Source snapshot image occurrence mapping is invalid');
    }
    this.targetDigest = deriveTargetIdentityDigest(this.targetIdentity);
    this.containerTargetDigest = deriveContainerTargetDigest(
      this.targetIdentity,
    );
  }

  public select(record: NoteSyncRecordV4): MainEventV2 | null {
    this.assertSourceTarget(record);
    this.assertRemoteCreatorConsistency(record);
    this.assertSourceConsistency(record);
    const selection = selectCoordinatorTransitionV2(
      record,
      this.selectionContext(record),
      this.productionProducers(),
    );
    return selection ? this.stamp(selection.payload) : null;
  }

  public createLivenessRepairEvent(
    record: NoteSyncRecordV4,
    verification: RemoteVerificationState,
    evidence: SealedQuarantineEvidence,
  ): Extract<MainEventV2, { type: 'LIVENESS_REPAIR_REQUIRED' }> {
    const transaction = record.mainTransaction;
    if (
      record.mainState !== 'PREPARING' ||
      transaction?.purpose !== 'LIVENESS' ||
      transaction.operationIntent?.kind !== 'VERIFY_LIVENESS' ||
      verification.outcome === 'EXACT'
    ) {
      throw new Error('Liveness repair requires a non-exact liveness intent');
    }
    const clearContainer = Boolean(
      verification.expectedContainer &&
      verification.containerObservation?.outcome !== 'EXACT',
    );
    return this.stamp({
      clearContainer,
      evidence,
      replacement: this.newTransaction(record, 'SYNC'),
      verification: clearContainer
        ? { ...verification, expectedContainer: null }
        : verification,
      type: 'LIVENESS_REPAIR_REQUIRED',
    });
  }

  private stamp<Event extends MainEventPayloadV2>(
    event: Event,
  ): Event & { occurredAt: string; updatedAt: string } {
    const now = this.clock.nowISOString();
    return { ...event, occurredAt: now, updatedAt: now };
  }

  private assertSourceTarget(record: NoteSyncRecordV4): void {
    const targetDigest = deriveTargetIdentityDigest(record.targetIdentity);
    if (this.targetDigest !== targetDigest) {
      throw new Error('Coordinator cannot be reused for another note target');
    }
  }

  private assertRemoteCreatorConsistency(record: NoteSyncRecordV4): void {
    const expected = this.options.remoteCreatorID;
    if (!expected) return;
    const conflicting = [record.container, record.active?.container]
      .filter((resource) => resource !== null && resource !== undefined)
      .find(({ createdByID }) => createdByID !== expected);
    if (conflicting) {
      throw new Error(
        'Remote creator identity differs from persisted managed resources; explicit rebind or a new managed copy is required',
      );
    }
  }

  private assertSourceConsistency(record: NoteSyncRecordV4): void {
    const requested = record.requestedSource;
    if (
      requested?.sourceVersion === this.source.sourceVersion &&
      (requested.manifestDigest !== this.source.manifestDigest ||
        requested.featurePolicy !== this.source.featurePolicy ||
        canonicalJSON(requested.sourceDescriptor) !==
          canonicalJSON(this.source.sourceDescriptor))
    ) {
      throw new Error(
        'Observed source version conflicts with persisted immutable content',
      );
    }
  }

  private uploadPlanningState(record: NoteSyncRecordV4): {
    imagesReady: boolean;
    uploadWorkAvailable: boolean;
  } {
    if (this.source.featurePolicy === 'text-only-v1') {
      return { imagesReady: true, uploadWorkAvailable: false };
    }
    for (const sourceAsset of this.source.imageAssets) {
      const existing = this.reusableAsset(record, sourceAsset.assetID);
      if (existing?.status === 'ATTACHED' || existing?.status === 'UPLOADED') {
        continue;
      }
      if (
        existing?.status === 'CREATED_UNSENT' &&
        Boolean(existing.fileUploadID)
      ) {
        return { imagesReady: false, uploadWorkAvailable: true };
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
        return { imagesReady: false, uploadWorkAvailable: false };
      }
      return { imagesReady: false, uploadWorkAvailable: true };
    }
    return { imagesReady: true, uploadWorkAvailable: false };
  }

  private selectionContext(
    record: NoteSyncRecordV4,
  ): CoordinatorSelectionContextV2 {
    const transaction = record.mainTransaction;
    const runHalt = transaction?.runHalt;
    const uploadPlanning = this.uploadPlanningState(record);
    return {
      hasCurrentLease: this.hasCurrentLease(record),
      ...uploadPlanning,
      livenessDue: record.mainState === 'IDLE' && this.livenessDue(record),
      resumeHalted: this.options.resumeHalted === true,
      retryDue:
        !runHalt?.nextRetryAt ||
        this.clock.compare(runHalt.nextRetryAt, this.clock.nowISOString()) <= 0,
      sourceChangedFromTransaction: Boolean(
        transaction &&
        record.requestedSource &&
        record.requestedSource.sourceVersion !==
          transaction.transactionSourceVersion,
      ),
      sourceObservationRequired:
        !record.requestedSource ||
        record.requestedSource.sourceVersion !== this.source.sourceVersion,
    };
  }

  private productionProducers(): CoordinatorProducerMapV2 {
    return {
      APPEND_INTENT_PERSISTED: (record) => this.produceAppend(record),
      CANDIDATE_INTENT_PERSISTED: (record) => this.produceCandidate(record),
      COMMIT_DURABLE_CANDIDATE: (record) => this.produceCommit(record),
      CONTAINER_INTENT_PERSISTED: (record) => this.produceContainer(record),
      FINALIZE_INTENT_PERSISTED: (record) => this.produceFinalization(record),
      LIVENESS_INTENT_PERSISTED: (record) => this.produceLiveness(record),
      MAIN_LEASE_ACQUIRED: (record) => ({
        lease: this.createLease(record),
        type: 'MAIN_LEASE_ACQUIRED',
      }),
      RECOVER_STALLED_CANDIDATE_CREATE: () => ({
        type: 'RECOVER_STALLED_CANDIDATE_CREATE',
      }),
      RESUME_AFTER_HALT: () => ({ type: 'RESUME_AFTER_HALT' }),
      SOURCE_OBSERVED: () => ({
        source: {
          featurePolicy: this.source.featurePolicy,
          manifestDigest: this.source.manifestDigest,
          observedAt: this.clock.nowISOString(),
          sourceDescriptor: this.source.sourceDescriptor,
          sourceVersion: this.source.sourceVersion,
        },
        type: 'SOURCE_OBSERVED',
      }),
      START_LIVENESS: (record) => ({
        transaction: this.newTransaction(record, 'LIVENESS'),
        type: 'START_LIVENESS',
      }),
      START_SYNC: (record) => ({
        transaction: this.newTransaction(record, 'SYNC'),
        type: 'START_SYNC',
      }),
      SUPERSEDE_TRANSACTION: (record) => this.produceSupersede(record),
      UPLOAD_INTENT_PERSISTED: (record) => this.produceUpload(record),
      VERIFY_INTENT_PERSISTED: (record) => this.produceVerification(record),
    };
  }

  private produceCommit(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'COMMIT_DURABLE_CANDIDATE' }> {
    return {
      committedAt: this.clock.nowISOString(),
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

  private livenessDue(record: NoteSyncRecordV4): boolean {
    if (this.forceLivenessPending) return true;
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
      sourceDescriptor: this.source.sourceDescriptor,
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

  private produceLiveness(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'LIVENESS_INTENT_PERSISTED' }> {
    const force = this.forceLivenessPending;
    this.forceLivenessPending = false;
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        active: record.active?.block ?? null,
        container: record.container,
        force,
      },
      kind: 'VERIFY_LIVENESS',
      operationID,
    });
    return { intent, type: 'LIVENESS_INTENT_PERSISTED' };
  }

  private produceContainer(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'CONTAINER_INTENT_PERSISTED' }> {
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        expectedCreator: remoteCreatorExpectation(
          this.options.remoteCreatorID ||
            (record.targetIdentity.identityType === 'legacy-local'
              ? undefined
              : asRemoteCreatorIdentity(record.targetIdentity.connectionID)),
        ),
        ...this.isolationWindow(),
        migrationNotice: this.options.legacyMigrationRequired === true,
        operationMarker: `notero:operation:${operationID}`,
        ownershipMarker: `notero:container:${this.containerTargetDigest}`,
        parent: { id: record.targetIdentity.pageID, type: 'page_id' },
        resourceTargetIdentityDigest: this.containerTargetDigest,
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

  private produceUpload(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'UPLOAD_INTENT_PERSISTED' }> {
    if (this.source.featurePolicy === 'text-only-v1') {
      throw new Error('Registry selected image upload while Feature OFF');
    }
    const expectedCreator = record.container?.createdByID;
    if (!expectedCreator) {
      throw new Error('Image upload planning requires a bound remote creator');
    }
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
            assetIdentityDigest: existing.assetIdentityDigest,
            attachmentIdentity: existing.attachmentIdentity,
            attachmentKey: existing.attachmentKey,
            contentHash: existing.contentHash,
            contentLength: existing.contentLength,
            contentType: existing.contentType,
            createOperationID: existing.createOperationID,
            expectedCreator,
            fileUploadID: existing.fileUploadID,
            filename: existing.filename,
            sourceIdentity: existing.sourceIdentity,
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
        throw new Error('Registry selected an upload with unresolved work');
      }
      const transaction = record.mainTransaction;
      if (!transaction) throw new Error('Upload requires transaction');
      const asset: UploadAssetRecordV4 = {
        assetID: sourceAsset.assetID,
        assetIdentityDigest: sourceAsset.assetIdentityDigest,
        attachedAt: null,
        attachmentIdentity: sourceAsset.attachmentIdentity,
        attachmentKey: sourceAsset.attachmentKey,
        contentHash: sourceAsset.contentHash,
        contentLength: sourceAsset.contentLength,
        contentType: sourceAsset.contentType,
        createOperationID: operationID,
        expiryTime: null,
        fileUploadBindingDigest: null,
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
          assetIdentityDigest: asset.assetIdentityDigest,
          attachmentIdentity: asset.attachmentIdentity,
          attachmentKey: asset.attachmentKey,
          contentHash: asset.contentHash,
          contentLength: asset.contentLength,
          contentType: asset.contentType,
          expectedCreator,
          filename: asset.filename,
          ...this.isolationWindow(),
          sourceIdentity: asset.sourceIdentity,
        },
        kind: 'UPLOAD_CREATE',
        operationID,
      });
      return { asset, intent, type: 'UPLOAD_INTENT_PERSISTED' };
    }
    throw new Error('Registry selected image upload without pending work');
  }

  private uploadReferences(record: NoteSyncRecordV4) {
    const expectedCreator = record.container?.createdByID;
    if (!expectedCreator) {
      throw new Error('Upload references require a bound remote creator');
    }
    return this.source.imageAssets.map((sourceAsset) => {
      const asset = this.reusableAsset(record, sourceAsset.assetID);
      if (!asset?.fileUploadID || !asset.fileUploadBindingDigest) {
        throw new Error(`Image asset ${sourceAsset.assetID} is not uploaded`);
      }
      return {
        assetID: asset.assetID,
        assetIdentityDigest: asset.assetIdentityDigest,
        contentHash: asset.contentHash,
        contentLength: asset.contentLength,
        contentType: asset.contentType,
        expectedCreator,
        fileUploadBindingDigest: asset.fileUploadBindingDigest,
        fileUploadID: asset.fileUploadID,
        filename: asset.filename,
      };
    });
  }

  private uploadReferencesForBatch(
    record: NoteSyncRecordV4,
    batchIndex: number,
  ) {
    const byAssetID = new Map(
      this.uploadReferences(record).map((reference) => [
        reference.assetID,
        reference,
      ]),
    );
    return (this.source.imageAssetIDsByBatch[batchIndex] ?? []).map(
      (assetID) => {
        const reference = byAssetID.get(assetID);
        if (!reference) {
          throw new Error(
            `Image asset ${assetID} is unavailable for its batch`,
          );
        }
        return reference;
      },
    );
  }

  private produceCandidate(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'CANDIDATE_INTENT_PERSISTED' }> {
    const container = record.container;
    const transaction = record.mainTransaction;
    if (!container || !transaction) {
      throw new Error('Candidate creation requires container and transaction');
    }
    const uploads = this.uploadReferences(record);
    const stagingTitle = `${STAGING_TITLE_PREFIX}${this.source.title}`.slice(
      0,
      2_000,
    );
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        container,
        expectedCreator: container.createdByID,
        expectedBatchCount: this.source.batches.length,
        expectedBlockCount: this.source.batches.reduce(
          (total, batch) => total + batch.length,
          0,
        ),
        expectedImageCount: this.source.imageOccurrenceCount,
        expectedImageUploadIDs: this.source.imageAssetIDsByBatch
          .flat()
          .map((assetID) => {
            const upload = uploads.find((entry) => entry.assetID === assetID);
            if (!upload)
              throw new Error(`Image asset ${assetID} is unavailable`);
            return upload.fileUploadID;
          }),
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
        sourceDescriptor: transaction.sourceDescriptor,
        stagingTitle,
        versionMarker: `notero:source:${transaction.transactionSourceVersion}`,
      },
      kind: 'CREATE_CANDIDATE',
      operationID,
    });
    return { intent, type: 'CANDIDATE_INTENT_PERSISTED' };
  }

  private produceAppend(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'APPEND_INTENT_PERSISTED' }> {
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
        blockFingerprints: batch.map((block, blockIndex) =>
          deriveNotionBlockFingerprint(block, {
            batchIndex,
            blockIndex,
            sourceVersion: this.source.sourceVersion,
          }),
        ),
        candidate: candidate.resource,
        expectedTitle: candidate.stagingTitle,
        expectedBlockCount: batch.length,
        fileUploads: this.uploadReferencesForBatch(record, batchIndex),
        precedingBlockIDs: candidate.batchEvidence.flatMap(
          ({ returnedBlockIDs }) => returnedBlockIDs,
        ),
      },
      kind: 'APPEND_BATCH',
      operationID,
    });
    return { intent, type: 'APPEND_INTENT_PERSISTED' };
  }

  private produceVerification(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'VERIFY_INTENT_PERSISTED' }> {
    const candidate = record.mainTransaction?.candidate;
    if (!candidate) throw new Error('Verification requires candidate');
    const fileUploads = candidate.batchEvidence.flatMap((_batch, batchIndex) =>
      this.uploadReferencesForBatch(record, batchIndex),
    );
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        batchBlockCounts: candidate.batchEvidence.map(
          ({ returnedBlockIDs }) => returnedBlockIDs.length,
        ),
        batchDigests: candidate.batchEvidence.map(
          ({ batchDigest }) => batchDigest,
        ),
        blockFingerprints: candidate.batchEvidence.flatMap(
          ({ blockFingerprints }) => blockFingerprints,
        ),
        candidate: candidate.resource,
        expectedBatchCount: candidate.expectedBatchCount,
        expectedBlockCount: candidate.expectedBlockCount,
        expectedImageUploadIDs: fileUploads.map(
          ({ fileUploadID }) => fileUploadID,
        ),
        expectedTitle: candidate.stagingTitle,
        fileUploads,
        manifestDigest: candidate.manifestDigest,
        returnedBlockIDs: candidate.batchEvidence.flatMap(
          ({ returnedBlockIDs }) => returnedBlockIDs,
        ),
        sourceDescriptor: candidate.sourceDescriptor,
      },
      kind: 'VERIFY_CANDIDATE',
      operationID,
    });
    return { intent, type: 'VERIFY_INTENT_PERSISTED' };
  }

  private produceFinalization(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'FINALIZE_INTENT_PERSISTED' }> {
    const candidate = record.mainTransaction?.candidate;
    if (!candidate?.completionEvidence || candidate.status !== 'VERIFIED') {
      throw new Error('Finalization requires a verified candidate');
    }
    const operationID = this.operationID();
    const intent = createOperationIntent({
      ...this.intentBase(record),
      details: {
        candidate: candidate.resource,
        finalTitle: candidate.finalTitle,
        stagingTitle: candidate.stagingTitle,
      },
      kind: 'FINALIZE_CANDIDATE',
      operationID,
    });
    return { intent, type: 'FINALIZE_INTENT_PERSISTED' };
  }

  private produceSupersede(
    record: NoteSyncRecordV4,
  ): Extract<MainEventPayloadV2, { type: 'SUPERSEDE_TRANSACTION' }> {
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
    return createPendingCleanupEntry(
      {
        generation,
        reason,
        resource,
        sourceVersion,
        transactionID,
      },
      this.clock,
      this.identity,
    );
  }
}
