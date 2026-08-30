import { APIErrorCode } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

import { FakeRuntimeClock } from '../../../../../test/utils';
import {
  StatefulNotionServer,
  notionError,
} from '../../__tests__/stateful-notion-fake';
import { NotionImageUploadService } from '../../notion-image-upload-service';
import { canonicalJSON, digestCanonical } from '../canonical';
import { CleanupWorkerV2 } from '../cleanup-worker-v4';
import { MainCoordinatorV2 } from '../coordinator-v4';
import {
  MainTransactionExecutorV2,
  type MainExecutionResultV4,
} from '../executor-v4';
import { deriveAssetID, deriveTargetIdentityDigest } from '../identity-v4';
import {
  StaleRecordRevisionError,
  StaleRootRevisionError,
  type TransactionalMetadataStoreV4,
} from '../metadata-store-adapter';
import {
  createIdleRecordV4,
  createProcessSession,
  DEFAULT_LIVENESS_TTL_MS,
  type RuntimeIdentityFactory,
} from '../model-v4';
import {
  NotionOperationAdapterV2,
  type OperationPayloadProviderV4,
} from '../notion-operation-adapter-v4';
import type { RemoteOperationAdapterV4 } from '../remote-operation-v4';
import {
  assertTransactionRecord,
  parseSyncedNotesRootV4,
  serializeSyncedNotesRootV4,
} from '../schema-v4';
import { TRANSITION_REGISTRY } from '../transition-registry';
import type {
  CleanupLedgerEntry,
  MetadataStoreSnapshot,
  MutationAuthorization,
  NoteSyncRecordV4,
  RevisionExpectation,
  SealedOperationIntent,
  SourceSnapshotV4,
  SyncedNotesRootV4,
  TargetIdentity,
} from '../types-v4';

export const PROPERTY_IDS_V4 = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
  'P14',
  'P15',
] as const;

export type PropertyIDV4 = (typeof PROPERTY_IDS_V4)[number];

export const MODEL_TARGET_V4: TargetIdentity = {
  connectionID: 'bot-model',
  databaseID: 'database-model',
  libraryID: 71,
  noteItemKey: 'NOTE-MODEL',
  pageID: 'page-model',
  parentItemKey: 'PARENT-MODEL',
  workspaceID: 'workspace-model',
};

type ModelImage = {
  assetID: string;
  attachmentIdentity: string;
  attachmentKey: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentHash: string;
  contentLength: number;
  contentType: 'image/png';
  filename: string;
  sourceIdentity: string;
};

type ModelRunOptions = {
  forceLiveness?: boolean;
  maxMutationAttempts?: number;
  maxRunSteps?: number;
  target?: TargetIdentity;
};

export type MutationAuditV4 = {
  durableIntentExact: boolean;
  durableLeaseExact: boolean;
  kind: SealedOperationIntent['kind'];
  operationID: string;
  remoteMutationCountAfter: number;
  remoteMutationCountBefore: number;
  uniqueExecutableIntent: boolean;
};

export class SyntheticProcessCrash extends Error {
  public readonly name = 'SyntheticProcessCrash';
}

export class SyntheticPersistFailure extends Error {
  public readonly name = 'SyntheticPersistFailure';
}

function remoteMutationCount(server: StatefulNotionServer): number {
  return server.events.filter(
    ({ type }) => type === 'remote-mutation-committed',
  ).length;
}

function emptyRoot(
  target: TargetIdentity,
  clock: FakeRuntimeClock,
): SyncedNotesRootV4 {
  return {
    container: null,
    notes: {
      [target.noteItemKey]: createIdleRecordV4(target, clock),
    },
    rootRevision: 0,
    schemaVersion: 4,
  };
}

export class SerializedModelDiskV4 {
  public readonly history: SyncedNotesRootV4[] = [];
  public writeCount = 0;

  private crashAfterRemoteCommit = false;
  private failPersist = false;
  private rawRoot: string;
  private remoteCountWhenArmed = 0;

  public constructor(
    public readonly target: TargetIdentity,
    private readonly clock: FakeRuntimeClock,
    private readonly server: StatefulNotionServer,
  ) {
    const root = emptyRoot(target, clock);
    this.rawRoot = serializeSyncedNotesRootV4(root);
    this.history.push(structuredClone(root));
  }

  public armCrashAfterNextRemoteCommit(): void {
    this.crashAfterRemoteCommit = true;
    this.remoteCountWhenArmed = remoteMutationCount(this.server);
  }

  public failNextPersist(): void {
    this.failPersist = true;
  }

  public get raw(): string {
    return this.rawRoot;
  }

  public readRoot(): SyncedNotesRootV4 {
    return parseSyncedNotesRootV4(JSON.parse(this.rawRoot));
  }

  public readRecord(): NoteSyncRecordV4 {
    const record = this.readRoot().notes[this.target.noteItemKey];
    if (!record) throw new Error('Model note record is missing');
    return record;
  }

  public newStore(): TransactionalMetadataStoreV4 {
    return new SerializedModelStoreV4(this);
  }

  public fork(
    clock: FakeRuntimeClock,
    server: StatefulNotionServer,
  ): SerializedModelDiskV4 {
    const copy = new SerializedModelDiskV4(this.target, clock, server);
    copy.rawRoot = this.rawRoot;
    copy.history.splice(
      0,
      copy.history.length,
      ...structuredClone(this.history),
    );
    copy.writeCount = this.writeCount;
    copy.crashAfterRemoteCommit = this.crashAfterRemoteCommit;
    copy.failPersist = this.failPersist;
    copy.remoteCountWhenArmed = this.remoteCountWhenArmed;
    return copy;
  }

  public loadSnapshot(): MetadataStoreSnapshot {
    const root = this.readRoot();
    const record = root.notes[this.target.noteItemKey];
    if (!record) throw new Error('Model note record is missing');
    return {
      legacyMigrationRequired: false,
      record: structuredClone(record),
      rootRevision: root.rootRevision,
    };
  }

  public write(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): MetadataStoreSnapshot {
    if (this.failPersist) {
      this.failPersist = false;
      throw new SyntheticPersistFailure('Synthetic metadata persist failed');
    }
    if (
      this.crashAfterRemoteCommit &&
      remoteMutationCount(this.server) > this.remoteCountWhenArmed
    ) {
      this.crashAfterRemoteCommit = false;
      throw new SyntheticProcessCrash(
        'Synthetic process crashed after remote commit and before local persist',
      );
    }
    const root = this.readRoot();
    if (root.rootRevision !== expectation.rootRevision) {
      throw new StaleRootRevisionError(
        expectation.rootRevision,
        root.rootRevision,
      );
    }
    const current = root.notes[this.target.noteItemKey];
    if (!current) throw new Error('Model note record is missing');
    if (current.revision !== expectation.noteRevision) {
      throw new StaleRecordRevisionError(
        expectation.noteRevision,
        current.revision,
      );
    }
    const proposed = mutation(structuredClone(current));
    if (proposed.revision !== current.revision) {
      throw new StaleRecordRevisionError(current.revision, proposed.revision);
    }
    assertTransactionRecord(proposed, {
      expectedTargetIdentity: this.target,
      rootRevision: root.rootRevision,
    });
    const nextRootRevision = root.rootRevision + 1;
    const persisted: NoteSyncRecordV4 = {
      ...proposed,
      revision: current.revision + 1,
      updatedAt: this.clock.nowISOString(),
    };
    assertTransactionRecord(persisted, {
      expectedTargetIdentity: this.target,
      previousRevision: {
        noteRevision: current.revision,
        rootRevision: root.rootRevision,
      },
      rootRevision: nextRootRevision,
    });
    const nextRoot: SyncedNotesRootV4 = {
      ...root,
      container: persisted.container,
      notes: { ...root.notes, [this.target.noteItemKey]: persisted },
      rootRevision: nextRootRevision,
    };
    this.rawRoot = serializeSyncedNotesRootV4(nextRoot);
    this.history.push(structuredClone(nextRoot));
    this.writeCount += 1;
    return {
      legacyMigrationRequired: false,
      record: structuredClone(persisted),
      rootRevision: nextRootRevision,
    };
  }
}

class SerializedModelStoreV4 implements TransactionalMetadataStoreV4 {
  public constructor(private readonly disk: SerializedModelDiskV4) {}

  public async load(): Promise<MetadataStoreSnapshot> {
    return this.disk.loadSnapshot();
  }

  public async persist(
    expectation: RevisionExpectation,
    nextRecord: NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.disk.write(expectation, () => nextRecord);
  }

  public async mutate(
    expectation: RevisionExpectation,
    mutation: (current: NoteSyncRecordV4) => NoteSyncRecordV4,
  ): Promise<MetadataStoreSnapshot> {
    return this.disk.write(expectation, mutation);
  }

  public async mergeCleanupEntry(
    expectation: RevisionExpectation,
    entry: CleanupLedgerEntry,
  ): Promise<MetadataStoreSnapshot> {
    return this.disk.write(expectation, (current) => {
      const entries = current.cleanupLedger.slice();
      const index = entries.findIndex(
        ({ cleanupID }) => cleanupID === entry.cleanupID,
      );
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
      return { ...current, cleanupLedger: entries };
    });
  }
}

function textBlock(text: string): BlockObjectRequest {
  return {
    paragraph: {
      rich_text: [{ text: { content: text }, type: 'text' }],
    },
  };
}

export function textSourceV4(
  sourceVersion: string,
  text = sourceVersion,
): SourceSnapshotV4 {
  const batches = [[textBlock(text)]];
  return {
    batches,
    featurePolicy: 'text-only-v1',
    imageAssetIDsByBatch: [[]],
    imageAssets: [],
    imageOccurrenceCount: 0,
    manifestDigest: digestCanonical('model-manifest-v4', {
      batches,
      sourceVersion,
    }),
    sourceVersion,
    title: 'Model note',
  };
}

export function imageSourceV4(
  target: TargetIdentity,
  sourceVersion: string,
  contentVariant = 'image-a',
): { images: ModelImage[]; source: SourceSnapshotV4 } {
  const bytes = new Uint8Array([137, 80, 78, 71, contentVariant.length]);
  const identity = {
    attachmentIdentity: 'attachment:model-image',
    contentHash: digestCanonical('model-image-bytes-v4', {
      bytes: Array.from(bytes),
      contentVariant,
    }),
    contentLength: bytes.byteLength,
    contentType: 'image/png' as const,
    sourceIdentity: 'source:model-image',
    targetIdentityDigest: deriveTargetIdentityDigest(target),
  };
  const image: ModelImage = {
    assetID: deriveAssetID(identity),
    ...identity,
    attachmentKey: 'IMAGE-MODEL',
    bytes,
    filename: 'model-image.png',
  };
  const batches: BlockObjectRequest[][] = [
    [
      textBlock(`before:${sourceVersion}`),
      {
        image: {
          caption: [
            { text: { content: 'Synthetic model image' }, type: 'text' },
          ],
          file_upload: { id: image.assetID },
          type: 'file_upload',
        },
        type: 'image',
      },
      textBlock(`after:${sourceVersion}`),
    ],
  ];
  return {
    images: [image],
    source: {
      batches,
      featurePolicy: 'embedded-images-v1',
      imageAssetIDsByBatch: [[image.assetID]],
      imageAssets: [
        {
          assetID: image.assetID,
          attachmentIdentity: image.attachmentIdentity,
          attachmentKey: image.attachmentKey,
          contentHash: image.contentHash,
          contentLength: image.contentLength,
          contentType: image.contentType,
          filename: image.filename,
          sourceIdentity: image.sourceIdentity,
        },
      ],
      imageOccurrenceCount: 1,
      manifestDigest: digestCanonical('model-manifest-v4', {
        batches,
        contentVariant,
        sourceVersion,
      }),
      sourceVersion,
      title: 'Model note with image',
    },
  };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isModelBlockRequest(value: unknown): value is BlockObjectRequest {
  return (
    isUnknownRecord(value) &&
    (isUnknownRecord(value.paragraph) ||
      (value.type === 'image' && isUnknownRecord(value.image)))
  );
}

function substituteUploadIDs(
  value: unknown,
  uploadIDs: ReadonlyMap<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) substituteUploadIDs(entry, uploadIDs);
    return;
  }
  if (!isUnknownRecord(value)) return;
  for (const child of Object.values(value)) {
    substituteUploadIDs(child, uploadIDs);
  }
  if (
    value.type === 'file_upload' &&
    isUnknownRecord(value.file_upload) &&
    typeof value.file_upload.id === 'string'
  ) {
    const replacement = uploadIDs.get(value.file_upload.id);
    if (replacement) value.file_upload.id = replacement;
  }
}

class FrozenModelPayloadsV4 implements OperationPayloadProviderV4 {
  private readonly imagesByAssetID: ReadonlyMap<string, ModelImage>;

  public constructor(
    private readonly source: SourceSnapshotV4,
    images: readonly ModelImage[],
  ) {
    this.imagesByAssetID = new Map(
      images.map((image) => [image.assetID, image]),
    );
  }

  public async getAppendBatch(
    intent: Parameters<OperationPayloadProviderV4['getAppendBatch']>[0],
  ): Promise<BlockObjectRequest[]> {
    const sourceBatch = this.source.batches[intent.details.batchIndex];
    if (!sourceBatch) throw new Error('Frozen model batch is missing');
    if (!sourceBatch.every(isModelBlockRequest)) {
      throw new Error('Frozen model batch contains an unsupported block');
    }
    const batch = structuredClone(sourceBatch);
    const uploadIDs = new Map(
      intent.details.fileUploads.map(({ assetID, fileUploadID }) => [
        assetID,
        fileUploadID,
      ]),
    );
    substituteUploadIDs(batch, uploadIDs);
    return batch;
  }

  public async getUploadBytes(
    intent: Parameters<OperationPayloadProviderV4['getUploadBytes']>[0],
  ) {
    const image = this.imagesByAssetID.get(intent.details.assetID);
    if (!image) throw new Error('Frozen model image bytes are missing');
    return {
      attachmentKey: image.attachmentKey,
      bytes: image.bytes,
      contentHash: image.contentHash,
      contentType: image.contentType,
      filename: image.filename,
      size: image.contentLength,
    };
  }
}

function same(value: unknown, other: unknown): boolean {
  return canonicalJSON(value) === canonicalJSON(other);
}

export class ModelHarnessV4 {
  public readonly audits: MutationAuditV4[] = [];
  public clock = new FakeRuntimeClock('2026-08-30T00:00:00.000Z');
  public disk: SerializedModelDiskV4;
  public readonly propertyFailures: string[] = [];
  public readonly propertyWitnesses = new Map<PropertyIDV4, number>();
  public readonly restartFreshness: boolean[] = [];
  public server: StatefulNotionServer;
  public readonly transitionIDs: string[] = [];

  public crashed = false;
  public permissionLost = false;
  public source: SourceSnapshotV4 = textSourceV4('source:a');
  public sourceImages: ModelImage[] = [];

  private identitySequence = 0;
  private processInvocationCount = 0;
  private lastProcessObjects:
    | {
        adapter: object;
        coordinator: object;
        executor: object;
        payloads: object;
        sessionID: string;
        store: object;
      }
    | undefined;
  private tamperObservation = false;

  public constructor(public readonly target = MODEL_TARGET_V4) {
    this.server = new StatefulNotionServer(
      target.connectionID,
      target.pageID,
      target.workspaceID,
      () => this.clock.nowEpochMs(),
    );
    this.disk = new SerializedModelDiskV4(target, this.clock, this.server);
  }

  public fork(): ModelHarnessV4 {
    const copy = new ModelHarnessV4(this.target);
    copy.clock.set(this.clock.nowISOString());
    copy.server = this.server.fork(() => copy.clock.nowEpochMs());
    copy.disk = this.disk.fork(copy.clock, copy.server);
    copy.audits.push(...structuredClone(this.audits));
    copy.propertyFailures.push(...this.propertyFailures);
    for (const [property, count] of this.propertyWitnesses) {
      copy.propertyWitnesses.set(property, count);
    }
    copy.restartFreshness.push(...this.restartFreshness);
    copy.transitionIDs.push(...this.transitionIDs);
    copy.crashed = this.crashed;
    copy.permissionLost = this.permissionLost;
    copy.source = structuredClone(this.source);
    copy.sourceImages = structuredClone(this.sourceImages);
    copy.identitySequence = this.identitySequence;
    copy.processInvocationCount = this.processInvocationCount;
    copy.tamperObservation = this.tamperObservation;
    return copy;
  }

  public setTextSource(version: string, text = version): void {
    this.source = textSourceV4(version, text);
    this.sourceImages = [];
  }

  public setImageSource(version: string, contentVariant = 'image-a'): void {
    const prepared = imageSourceV4(this.target, version, contentVariant);
    this.source = prepared.source;
    this.sourceImages = prepared.images;
    this.server.setNextUploadContentLength(
      prepared.images[0]?.contentLength ?? null,
    );
  }

  public tamperNextObservation(): void {
    this.tamperObservation = true;
  }

  public witness(property: PropertyIDV4, condition: boolean, detail: string) {
    this.propertyWitnesses.set(
      property,
      (this.propertyWitnesses.get(property) ?? 0) + 1,
    );
    if (!condition) this.propertyFailures.push(`${property}: ${detail}`);
  }

  public record(): NoteSyncRecordV4 {
    return this.disk.readRecord();
  }

  public mutationCount(): number {
    return remoteMutationCount(this.server);
  }

  public canonicalState(): string {
    return canonicalJSON({
      clock: this.clock.nowISOString(),
      crashed: this.crashed,
      permissionLost: this.permissionLost,
      remote: this.server.canonicalProjection(),
      root: this.disk.readRoot(),
      source: this.source,
      targetIdentityDigest: deriveTargetIdentityDigest(this.target),
    });
  }

  public async runMain(
    options: ModelRunOptions = {},
  ): Promise<MainExecutionResultV4> {
    const target = options.target ?? this.target;
    const identity = this.newIdentityFactory();
    const session = createProcessSession(this.clock, identity);
    const store = this.disk.newStore();
    const payloads = new FrozenModelPayloadsV4(this.source, this.sourceImages);
    const client = this.server.client();
    const uploadService = new NotionImageUploadService(
      client,
      {
        clock: this.clock,
        maxAttempts: 1,
        maxTotalWaitMilliseconds: 1_000,
        random: () => 0.5,
      },
      target.connectionID,
    );
    const adapter = new NotionOperationAdapterV2(
      client,
      payloads,
      uploadService,
      this.clock,
    );
    const remote = this.auditedRemote(store, adapter);
    const coordinator = new MainCoordinatorV2(
      this.source,
      target,
      session,
      this.clock,
      identity,
      {
        forceLiveness: options.forceLiveness,
        resumeHalted: true,
      },
    );
    const executor = new MainTransactionExecutorV2(
      store,
      coordinator,
      remote,
      session,
      this.clock,
      identity,
      options.maxRunSteps,
      options.maxMutationAttempts,
    );
    const objects = {
      adapter,
      coordinator,
      executor,
      payloads,
      sessionID: session.processSessionID,
      store,
    };
    if (this.lastProcessObjects) {
      this.restartFreshness.push(
        this.lastProcessObjects.adapter !== objects.adapter &&
          this.lastProcessObjects.coordinator !== objects.coordinator &&
          this.lastProcessObjects.executor !== objects.executor &&
          this.lastProcessObjects.payloads !== objects.payloads &&
          this.lastProcessObjects.store !== objects.store &&
          this.lastProcessObjects.sessionID !== objects.sessionID,
      );
    } else if (this.processInvocationCount > 0) {
      // A fork is a serialization boundary: process-local instances are not
      // copied. Re-instantiation after that boundary is necessarily fresh.
      this.restartFreshness.push(true);
    }
    this.lastProcessObjects = objects;
    this.processInvocationCount += 1;
    const result = await executor.runUntilStable();
    this.transitionIDs.push(...result.transitionIDs);
    this.crashed = false;
    this.checkGlobalSafety(result);
    return result;
  }

  public async runCleanup(limit = 2) {
    const identity = this.newIdentityFactory();
    const session = createProcessSession(this.clock, identity);
    const store = this.disk.newStore();
    const client = this.server.client();
    const payloads = new FrozenModelPayloadsV4(this.source, this.sourceImages);
    const uploadService = new NotionImageUploadService(
      client,
      { clock: this.clock, maxAttempts: 1, random: () => 0.5 },
      this.target.connectionID,
    );
    const adapter = new NotionOperationAdapterV2(
      client,
      payloads,
      uploadService,
      this.clock,
    );
    const result = await new CleanupWorkerV2(
      store,
      this.auditedRemote(store, adapter),
      session,
      this.clock,
      identity,
      limit,
    ).runBounded();
    this.witness(
      'P10',
      result.inspected <= limit && result.mutationAttempts <= limit,
      'cleanup worker exceeded its configured bound',
    );
    this.checkGlobalSafety();
    return result;
  }

  public losePermission(): void {
    this.permissionLost = true;
    this.server.losePermission(
      notionError(APIErrorCode.RestrictedResource, 403),
    );
  }

  public restorePermission(): void {
    this.permissionLost = false;
    this.server.restorePermission();
  }

  public checkGlobalSafety(result?: MainExecutionResultV4): void {
    const record = this.record();
    const exactAudits = this.audits.every(
      ({ durableIntentExact, durableLeaseExact, uniqueExecutableIntent }) =>
        durableIntentExact && durableLeaseExact && uniqueExecutableIntent,
    );
    this.witness(
      'P4',
      exactAudits,
      'a remote mutation lacked its exact durable current intent',
    );
    this.witness(
      'P12',
      exactAudits,
      'a remote mutation lacked one unique exact intent and lease',
    );
    if (record.active) {
      this.witness(
        'P9',
        record.active.block.blockID ===
          record.active.completionEvidence.candidateBlockID &&
          record.active.completionEvidence.completedBatchCount ===
            record.active.completionEvidence.expectedBatchCount,
        'active lacks exact durable completion proof',
      );
    }
    for (const entry of record.cleanupLedger) {
      if (entry.state === 'CONFIRMED') {
        this.witness(
          'P3',
          entry.lastObservation?.deletionProof?.inTrash === true &&
            entry.lastObservation.deletionProof.archived &&
            entry.lastObservation.deletionProof.exactBlockID ===
              entry.resource.blockID,
          'cleanup was confirmed without exact in_trash evidence',
        );
      }
    }
    this.witness(
      'P10',
      record.cleanupLedger.length <= 128 &&
        (!result || (result.steps <= 128 && result.mutationAttempts <= 32)),
      'a main or cleanup bound was exceeded',
    );
  }

  private newIdentityFactory(): RuntimeIdentityFactory {
    return {
      randomUUID: () => `model-id-${++this.identitySequence}`,
    };
  }

  private auditedRemote(
    store: TransactionalMetadataStoreV4,
    adapter: RemoteOperationAdapterV4,
  ): RemoteOperationAdapterV4 {
    return {
      execute: async (authorization) => {
        const before = await store.load();
        const durable = this.durableAuthorization(before, authorization);
        const countBefore = this.mutationCount();
        let result = await adapter.execute(authorization);
        if (this.tamperObservation && result.type === 'OBSERVED') {
          this.tamperObservation = false;
          result = {
            ...result,
            observation: {
              ...result.observation,
              requestDigest: 'tampered-observation-digest',
            },
          };
        }
        this.audits.push({
          ...durable,
          kind: authorization.intent.kind,
          operationID: authorization.intent.operationID,
          remoteMutationCountAfter: this.mutationCount(),
          remoteMutationCountBefore: countBefore,
        });
        return result;
      },
      observe: (intent) => adapter.observe(intent),
    };
  }

  private durableAuthorization(
    snapshot: MetadataStoreSnapshot,
    authorization: MutationAuthorization,
  ): Pick<
    MutationAuditV4,
    'durableIntentExact' | 'durableLeaseExact' | 'uniqueExecutableIntent'
  > {
    const { intent, lease } = authorization;
    const mainIntent = snapshot.record.mainTransaction?.operationIntent ?? null;
    const cleanupMatches = snapshot.record.cleanupLedger.filter(
      ({ deleteIntent }) => deleteIntent?.operationID === intent.operationID,
    );
    const durableIntent =
      intent.owner === 'MAIN'
        ? mainIntent
        : (cleanupMatches[0]?.deleteIntent ?? null);
    const durableLease =
      intent.owner === 'MAIN'
        ? snapshot.record.writerCoordination.mainLease
        : (cleanupMatches[0]?.workerLease ?? null);
    const executableMatches = [
      ...(mainIntent?.status === 'EXECUTABLE' ? [mainIntent] : []),
      ...snapshot.record.cleanupLedger.flatMap(({ deleteIntent }) =>
        deleteIntent?.status === 'EXECUTABLE' ? [deleteIntent] : [],
      ),
    ].filter(({ operationID }) => operationID === intent.operationID);
    return {
      durableIntentExact:
        durableIntent?.status === 'EXECUTABLE' && same(durableIntent, intent),
      durableLeaseExact: Boolean(
        durableLease &&
        durableLease.leaseID === lease.leaseID &&
        durableLease.leaseEpoch === lease.leaseEpoch &&
        durableLease.processSessionID === lease.processSessionID,
      ),
      uniqueExecutableIntent: executableMatches.length === 1,
    };
  }
}

export type ModelActionV4 =
  | 'ADVANCE_TTL'
  | 'CLEANUP_404'
  | 'CLEANUP_ARCHIVED_ONLY'
  | 'CLEANUP_CONFIRMED'
  | 'CRASH_AFTER_REMOTE'
  | 'DUPLICATE_MARKER'
  | 'EDIT_ACTIVE'
  | 'MOVE_ACTIVE'
  | 'PAGINATION_INTERRUPTED'
  | 'PERMISSION_LOST'
  | 'PERSIST_FAILURE'
  | 'REMOTE_RESPONSE_LOST'
  | 'RESTART'
  | 'RESTORE_PERMISSION'
  | 'SOURCE_B'
  | 'SOURCE_C'
  | 'SYNC_FEATURE_OFF'
  | 'SYNC_IMAGE'
  | 'SYNC_TEXT'
  | 'TARGET_CHANGED'
  | 'TRASH_ACTIVE'
  | 'UNCHANGED';

function activeID(harness: ModelHarnessV4): string {
  const id = harness.record().active?.block.blockID;
  if (!id) throw new Error('Model action requires an active block');
  return id;
}

function mutationsTargeting(
  server: StatefulNotionServer,
  fromEventIndex: number,
  target: string,
) {
  return server.events
    .slice(fromEventIndex)
    .filter(
      (event) =>
        event.target === target && event.type === 'remote-mutation-committed',
    );
}

async function expectCrash(harness: ModelHarnessV4): Promise<void> {
  try {
    await harness.runMain();
    throw new Error('Expected synthetic process crash did not occur');
  } catch (error) {
    if (!(error instanceof SyntheticProcessCrash)) throw error;
    harness.crashed = true;
  }
}

async function expectPersistFailure(harness: ModelHarnessV4): Promise<void> {
  try {
    await harness.runMain();
    throw new Error('Expected synthetic persist failure did not occur');
  } catch (error) {
    if (!(error instanceof SyntheticPersistFailure)) throw error;
    harness.crashed = true;
  }
}

export async function applyModelActionV4(
  harness: ModelHarnessV4,
  action: ModelActionV4,
): Promise<void> {
  switch (action) {
    case 'SYNC_TEXT':
      harness.setTextSource('source:a', 'alpha');
      await harness.runMain();
      return;
    case 'SYNC_IMAGE':
      harness.setImageSource('source:image-a');
      await harness.runMain();
      return;
    case 'SYNC_FEATURE_OFF': {
      harness.setTextSource('source:off', 'embedded source rendered as text');
      await harness.runMain();
      const record = harness.record();
      harness.witness(
        'P7',
        harness.server.createUploadCount === 0 &&
          harness.server.sendUploadCount === 0 &&
          record.uploadAssets.length === 0 &&
          record.active?.imageAssetIdentities.length === 0,
        'Feature OFF created image work',
      );
      return;
    }
    case 'UNCHANGED': {
      const beforeMutations = harness.mutationCount();
      const beforeUploads = harness.server.createUploadCount;
      const beforeRoot = harness.disk.raw;
      await harness.runMain();
      harness.witness(
        'P8',
        harness.mutationCount() === beforeMutations &&
          harness.server.createUploadCount === beforeUploads &&
          harness.disk.raw === beforeRoot,
        'unchanged resync changed remote or durable state',
      );
      return;
    }
    case 'SOURCE_B': {
      const oldActive = activeID(harness);
      const historyStart = harness.disk.history.length;
      harness.setTextSource('source:b', 'bravo');
      await harness.runMain();
      const record = harness.record();
      const writes = harness.disk.history.slice(historyStart);
      const commitIndex = writes.findIndex(
        (root) =>
          root.notes[harness.target.noteItemKey]?.active?.sourceVersion ===
          'source:b',
      );
      harness.witness(
        'P1',
        commitIndex >= 0 &&
          writes
            .slice(0, commitIndex)
            .every(
              (root) =>
                root.notes[harness.target.noteItemKey]?.active?.block
                  .blockID === oldActive,
            ),
        'old active changed before the replacement commit',
      );
      harness.witness(
        'P6',
        record.requestedSource?.sourceVersion === 'source:b' &&
          record.active?.sourceVersion === 'source:b',
        'latest requested source was not committed',
      );
      return;
    }
    case 'SOURCE_C': {
      const unresolvedBefore = harness
        .record()
        .cleanupLedger.filter(({ state }) => state !== 'CONFIRMED').length;
      harness.setTextSource('source:c', 'charlie');
      const result = await harness.runMain();
      const record = harness.record();
      harness.witness(
        'P6',
        record.requestedSource?.sourceVersion === 'source:c' &&
          record.active?.sourceVersion === 'source:c',
        `latest source C was lost (${result.status}/${record.mainState}/${record.requestedSource?.sourceVersion}/${record.active?.sourceVersion})`,
      );
      if (unresolvedBefore > 0) {
        harness.witness(
          'P11',
          record.active?.sourceVersion === 'source:c',
          `unresolved cleanup blocked a later source generation (${result.status}/${record.mainState}/${record.active?.sourceVersion})`,
        );
      }
      return;
    }
    case 'CRASH_AFTER_REMOTE': {
      const oldActive = activeID(harness);
      harness.setTextSource('source:crash', 'crash replacement');
      harness.disk.armCrashAfterNextRemoteCommit();
      await expectCrash(harness);
      const record = harness.record();
      harness.witness(
        'P1',
        record.active?.block.blockID === oldActive,
        'crash replaced the old active before durable commit',
      );
      harness.witness(
        'P5',
        Boolean(record.mainTransaction?.operationIntent),
        'crash failed to preserve the exact durable recovery intent',
      );
      harness.checkGlobalSafety();
      return;
    }
    case 'PERSIST_FAILURE': {
      const oldActive = activeID(harness);
      const beforeMutations = harness.mutationCount();
      harness.setTextSource('source:persist-failure', 'persist failure');
      harness.disk.failNextPersist();
      await expectPersistFailure(harness);
      harness.witness(
        'P1',
        harness.record().active?.block.blockID === oldActive,
        'local persist failure discarded the LKG',
      );
      harness.witness(
        'P4',
        harness.mutationCount() === beforeMutations,
        'remote mutation occurred after local persist failed',
      );
      harness.witness(
        'P5',
        harness.disk.raw.length > 0,
        'persist failure left no reloadable durable state',
      );
      return;
    }
    case 'REMOTE_RESPONSE_LOST': {
      const oldActive = activeID(harness);
      const historyStart = harness.disk.history.length;
      harness.setTextSource('source:lost-response', 'lost response');
      harness.server.failNextAppend(
        new TypeError('Synthetic response lost after remote commit'),
        true,
      );
      const result = await harness.runMain();
      const writes = harness.disk.history.slice(historyStart);
      const commitIndex = writes.findIndex(
        (root) =>
          root.notes[harness.target.noteItemKey]?.active?.sourceVersion ===
          'source:lost-response',
      );
      harness.witness(
        'P1',
        result.status === 'STABLE' &&
          commitIndex >= 0 &&
          writes
            .slice(0, commitIndex)
            .every(
              (root) =>
                root.notes[harness.target.noteItemKey]?.active?.block
                  .blockID === oldActive,
            ),
        'lost response exposed a replacement before reconciliation and commit',
      );
      harness.witness(
        'P5',
        result.status === 'STABLE',
        'committed remote write with lost response did not reconcile',
      );
      return;
    }
    case 'RESTART': {
      const intent = harness.record().mainTransaction?.operationIntent;
      const beforeAttempts = harness.audits.filter(
        ({ operationID }) => operationID === intent?.operationID,
      ).length;
      const result = await harness.runMain();
      const afterAttempts = harness.audits.filter(
        ({ operationID }) => operationID === intent?.operationID,
      ).length;
      harness.witness(
        'P5',
        ['QUARANTINED', 'STABLE'].includes(result.status) &&
          afterAttempts === beforeAttempts &&
          harness.restartFreshness.at(-1) === true,
        'restart blind-replayed an intent or reused process-local objects',
      );
      return;
    }
    case 'PERMISSION_LOST': {
      const oldActive = activeID(harness);
      harness.losePermission();
      harness.clock.advance(DEFAULT_LIVENESS_TTL_MS + 1);
      const result = await harness.runMain({ forceLiveness: true });
      harness.witness(
        'P1',
        harness.record().active?.block.blockID === oldActive,
        'permission failure discarded the LKG',
      );
      harness.witness(
        'P14',
        result.status === 'HALTED' && result.mutationAttempts <= 1,
        'permanent permission error repeated in one run',
      );
      return;
    }
    case 'RESTORE_PERMISSION': {
      harness.restorePermission();
      const result = await harness.runMain({ forceLiveness: true });
      harness.witness(
        'P5',
        ['QUARANTINED', 'STABLE'].includes(result.status) &&
          harness.restartFreshness.at(-1) === true,
        `restored process did not recover through a fresh invocation (${result.status}/${String(harness.restartFreshness.at(-1))})`,
      );
      return;
    }
    case 'MOVE_ACTIVE':
    case 'EDIT_ACTIVE':
    case 'TRASH_ACTIVE': {
      const oldActive = activeID(harness);
      const eventStart = harness.server.events.length;
      if (action === 'MOVE_ACTIVE') {
        harness.server.moveBlock(oldActive, harness.target.pageID, 'page_id');
      } else if (action === 'EDIT_ACTIVE') {
        harness.server.corruptHeadingOwnership(oldActive);
      } else {
        harness.server.setTrashState(oldActive, {
          archived: true,
          inTrash: true,
        });
      }
      await harness.runMain({ forceLiveness: true });
      const untouched =
        mutationsTargeting(harness.server, eventStart, oldActive).length === 0;
      harness.witness(
        'P2',
        untouched,
        `${action} block received a mutation without exact ownership`,
      );
      harness.witness(
        'P13',
        untouched,
        `${action} block was modified or deleted after preflight mismatch`,
      );
      harness.witness(
        'P15',
        harness.transitionIDs.includes('M24_LIVENESS_REPAIR_REQUIRED'),
        'stale active mapping was not detected by liveness',
      );
      return;
    }
    case 'ADVANCE_TTL': {
      const previousCheck = harness.record().remoteVerification?.checkedAt;
      harness.clock.advance(DEFAULT_LIVENESS_TTL_MS + 1);
      await harness.runMain();
      harness.witness(
        'P15',
        Boolean(
          harness.record().remoteVerification?.checkedAt &&
          harness.record().remoteVerification?.checkedAt !== previousCheck,
        ),
        'TTL expiry did not trigger a new liveness observation',
      );
      return;
    }
    case 'PAGINATION_INTERRUPTED': {
      const oldActive = activeID(harness);
      harness.setTextSource('source:pagination', 'pagination replacement');
      harness.server.setIncompletePagination(true);
      const result = await harness.runMain();
      harness.server.setIncompletePagination(false);
      harness.witness(
        'P1',
        result.status === 'QUARANTINED' &&
          harness.record().active?.block.blockID === oldActive,
        'pagination failure replaced the LKG',
      );
      return;
    }
    case 'DUPLICATE_MARKER': {
      const oldActive = activeID(harness);
      harness.setTextSource('source:duplicate', 'duplicate replacement');
      harness.disk.armCrashAfterNextRemoteCommit();
      await expectCrash(harness);
      const intent = harness.record().mainTransaction?.operationIntent;
      if (intent?.kind !== 'CREATE_CANDIDATE') {
        throw new Error('Duplicate-marker scenario lost its create intent');
      }
      const created = Array.from(harness.server.blocks.entries()).find(
        ([, block]) =>
          block.response.type === 'heading_1' &&
          block.response.heading_1.rich_text.some((richText) =>
            Boolean(
              richText.href &&
              decodeURIComponent(richText.href).endsWith(
                intent.details.operationMarker,
              ),
            ),
          ),
      );
      if (!created) throw new Error('Created candidate marker is missing');
      harness.server.duplicateHeading(created[0], 'duplicate-candidate');
      const result = await harness.runMain();
      harness.witness(
        'P5',
        result.status === 'QUARANTINED' &&
          harness.record().active?.block.blockID === oldActive,
        'duplicate marker did not fail closed',
      );
      return;
    }
    case 'CLEANUP_404': {
      const entry = harness
        .record()
        .cleanupLedger.find(({ state }) => state === 'PENDING');
      if (!entry) throw new Error('Cleanup 404 requires a pending entry');
      harness.server.blocks.delete(entry.resource.blockID);
      const result = await harness.runCleanup(1);
      const current = harness
        .record()
        .cleanupLedger.find(({ cleanupID }) => cleanupID === entry.cleanupID);
      harness.witness(
        'P3',
        current?.state === 'DELETE_UNCERTAIN' &&
          current.lastObservation?.deletionProof == null,
        `404 was accepted as deletion success (${current?.state}/${result.errors.join(',')})`,
      );
      harness.witness(
        'P11',
        harness.record().mainState === 'IDLE',
        `uncertain cleanup changed main progress (${harness.record().mainState})`,
      );
      return;
    }
    case 'CLEANUP_ARCHIVED_ONLY': {
      const entry = harness
        .record()
        .cleanupLedger.find(({ state }) => state === 'PENDING');
      if (!entry) throw new Error('Archived-only cleanup requires a target');
      harness.server.setTrashState(entry.resource.blockID, {
        archived: true,
        inTrash: false,
      });
      const result = await harness.runCleanup(1);
      const current = harness
        .record()
        .cleanupLedger.find(({ cleanupID }) => cleanupID === entry.cleanupID);
      harness.witness(
        'P3',
        current?.state === 'DELETE_UNCERTAIN',
        `archived-only evidence was accepted as deletion success (${current?.state}/${result.errors.join(',')})`,
      );
      return;
    }
    case 'CLEANUP_CONFIRMED': {
      const entry = harness
        .record()
        .cleanupLedger.find(({ state }) => state === 'PENDING');
      if (!entry) throw new Error('Cleanup confirmation requires a target');
      const result = await harness.runCleanup(1);
      const current = harness
        .record()
        .cleanupLedger.find(({ cleanupID }) => cleanupID === entry.cleanupID);
      harness.witness(
        'P3',
        current?.state === 'CONFIRMED' &&
          current.lastObservation?.deletionProof?.inTrash === true,
        `exact in_trash evidence did not confirm cleanup (${current?.state}/${result.errors.join(',')})`,
      );
      return;
    }
    case 'TARGET_CHANGED': {
      const beforeRoot = harness.disk.raw;
      const beforeMutations = harness.mutationCount();
      await harness
        .runMain({
          target: { ...harness.target, workspaceID: 'workspace-other' },
        })
        .then(
          () => {
            throw new Error('Target mismatch was unexpectedly accepted');
          },
          () => undefined,
        );
      const unchanged =
        harness.disk.raw === beforeRoot &&
        harness.mutationCount() === beforeMutations;
      harness.witness(
        'P2',
        unchanged,
        'target identity mismatch changed durable or remote state',
      );
      harness.witness(
        'P13',
        unchanged,
        'cross-target resource received a mutation',
      );
      return;
    }
  }
}

function availableActions(
  harness: ModelHarnessV4,
  sequence: readonly ModelActionV4[],
): ModelActionV4[] {
  const record = harness.record();
  if (!record.requestedSource && !record.active) {
    return ['SYNC_TEXT', 'SYNC_IMAGE', 'SYNC_FEATURE_OFF'];
  }
  if (harness.crashed) return ['RESTART'];
  if (harness.permissionLost) return ['RESTORE_PERMISSION'];
  if (record.mainState === 'QUARANTINED') return [];
  const pending = record.cleanupLedger.some(({ state }) => state === 'PENDING');
  const unresolved = record.cleanupLedger.some(
    ({ state }) => state === 'DELETE_UNCERTAIN' || state === 'QUARANTINED',
  );
  if (unresolved) return ['SOURCE_C'];
  if (pending) {
    const actions: ModelActionV4[] = [
      'CLEANUP_404',
      'CLEANUP_ARCHIVED_ONLY',
      'SOURCE_C',
    ];
    if (
      !sequence.some((action) =>
        ['EDIT_ACTIVE', 'MOVE_ACTIVE', 'TRASH_ACTIVE'].includes(action),
      )
    ) {
      actions.splice(2, 0, 'CLEANUP_CONFIRMED');
    }
    return actions;
  }
  if (sequence.length >= 2) return [];
  return [
    'UNCHANGED',
    'SOURCE_B',
    'CRASH_AFTER_REMOTE',
    'PERSIST_FAILURE',
    'REMOTE_RESPONSE_LOST',
    'PERMISSION_LOST',
    'MOVE_ACTIVE',
    'EDIT_ACTIVE',
    'TRASH_ACTIVE',
    'ADVANCE_TTL',
    'PAGINATION_INTERRUPTED',
    'DUPLICATE_MARKER',
    'TARGET_CHANGED',
  ];
}

async function collectRegistryWitnessesV4() {
  const transitionWitnesses = new Map<string, ModelActionV4[] | string[]>();
  const absorb = (harness: ModelHarnessV4, sequence: string[]) => {
    for (const transitionID of harness.transitionIDs) {
      if (!transitionWitnesses.has(transitionID)) {
        transitionWitnesses.set(transitionID, sequence);
      }
    }
  };

  const text = new ModelHarnessV4();
  await applyModelActionV4(text, 'SYNC_TEXT');
  absorb(text, ['SYNC_TEXT']);

  const image = new ModelHarnessV4();
  await applyModelActionV4(image, 'SYNC_IMAGE');
  absorb(image, ['SYNC_IMAGE']);

  const superseded = new ModelHarnessV4();
  superseded.setTextSource('source:old-transaction');
  const partial = await superseded.runMain({ maxRunSteps: 7 });
  superseded.transitionIDs.push(...partial.transitionIDs);
  superseded.setTextSource('source:newest-transaction');
  await superseded.runMain();
  absorb(superseded, ['PARTIAL_TRANSACTION', 'SOURCE_CHANGED']);

  const proven = new ModelHarnessV4();
  proven.setTextSource('source:proven-unexecuted');
  const intentOnly = await proven.runMain({ maxRunSteps: 4 });
  proven.transitionIDs.push(...intentOnly.transitionIDs);
  proven.clock.advance(66 * 60 * 1000);
  await proven.runMain();
  absorb(proven, ['PERSIST_INTENT_ONLY', 'ADVANCE_ISOLATION', 'RESTART']);

  const ambiguous = new ModelHarnessV4();
  ambiguous.setTextSource('source:ambiguous');
  const ambiguousIntent = await ambiguous.runMain({ maxRunSteps: 4 });
  ambiguous.transitionIDs.push(...ambiguousIntent.transitionIDs);
  await ambiguous.runMain();
  absorb(ambiguous, ['PERSIST_INTENT_ONLY', 'RESTART_BEFORE_ISOLATION']);

  const permission = new ModelHarnessV4();
  permission.setTextSource('source:permission');
  permission.losePermission();
  await permission.runMain();
  permission.restorePermission();
  await permission.runMain();
  absorb(permission, ['PERMISSION_LOST', 'RESTORE_PERMISSION']);

  const invalidObservation = new ModelHarnessV4();
  invalidObservation.setTextSource('source:invalid-observation');
  invalidObservation.tamperNextObservation();
  await invalidObservation.runMain();
  absorb(invalidObservation, ['TAMPERED_REMOTE_OBSERVATION']);

  const repair = new ModelHarnessV4();
  await applyModelActionV4(repair, 'SYNC_TEXT');
  await applyModelActionV4(repair, 'MOVE_ACTIVE');
  absorb(repair, ['SYNC_TEXT', 'MOVE_ACTIVE', 'FORCE_LIVENESS']);

  return transitionWitnesses;
}

export type ModelExplorerReportV4 = {
  canonicalizationRules: readonly string[];
  exploredEdges: number;
  exploredStates: number;
  maxDepth: number;
  processRestartChecks: number;
  properties: Record<
    PropertyIDV4,
    { failures: string[]; passed: boolean; witnesses: number }
  >;
  prunedStates: number;
  shortestCounterexample: string[] | null;
  transitionCoverage: {
    covered: number;
    missing: string[];
    total: number;
  };
  transitionWitnesses: Record<string, string[]>;
};

export async function exploreModelV4(
  maxDepth = 4,
): Promise<ModelExplorerReportV4> {
  const initial = new ModelHarnessV4();
  const seen = new Map<string, ModelActionV4[]>([
    [initial.canonicalState(), []],
  ]);
  const queue: Array<{
    harness: ModelHarnessV4;
    sequence: ModelActionV4[];
  }> = [{ harness: initial, sequence: [] }];
  const failures = new Map<PropertyIDV4, string[]>();
  const witnesses = new Map<PropertyIDV4, number>();
  const transitionIDs = new Set<string>();
  let exploredEdges = 0;
  let prunedStates = 0;
  let processRestartChecks = 0;
  let shortestCounterexample: string[] | null = null;

  while (queue.length) {
    const node = queue.shift();
    if (!node) break;
    const { harness: state, sequence } = node;
    if (sequence.length >= maxDepth) continue;
    for (const action of availableActions(state, sequence)) {
      exploredEdges += 1;
      const nextSequence = [...sequence, action];
      try {
        const next = state.fork();
        await applyModelActionV4(next, action);
        next.checkGlobalSafety();
        for (const transitionID of next.transitionIDs) {
          transitionIDs.add(transitionID);
        }
        for (const property of PROPERTY_IDS_V4) {
          witnesses.set(
            property,
            Math.max(
              witnesses.get(property) ?? 0,
              next.propertyWitnesses.get(property) ?? 0,
            ),
          );
        }
        for (const failure of next.propertyFailures) {
          const property = PROPERTY_IDS_V4.find((candidate) =>
            failure.startsWith(`${candidate}:`),
          );
          if (!property) {
            throw new Error(`Unknown property failure: ${failure}`);
          }
          failures.set(property, [...(failures.get(property) ?? []), failure]);
          if (
            !shortestCounterexample ||
            nextSequence.length < shortestCounterexample.length
          ) {
            shortestCounterexample = nextSequence;
          }
        }
        processRestartChecks += next.restartFreshness.length;
        const key = next.canonicalState();
        if (seen.has(key)) {
          prunedStates += 1;
        } else {
          seen.set(key, nextSequence);
          queue.push({ harness: next, sequence: nextSequence });
        }
      } catch (error) {
        if (!shortestCounterexample) shortestCounterexample = nextSequence;
        const message = error instanceof Error ? error.message : 'UnknownError';
        failures.set('P5', [
          ...(failures.get('P5') ?? []),
          `P5: explorer action threw ${message}`,
        ]);
      }
    }
  }

  const registryWitnesses = await collectRegistryWitnessesV4();
  for (const id of registryWitnesses.keys()) transitionIDs.add(id);
  const transitionWitnesses = Object.fromEntries(
    Array.from(registryWitnesses.entries()).map(([id, sequence]) => [
      id,
      sequence.slice(),
    ]),
  );
  const registryIDs = TRANSITION_REGISTRY.map(({ id }) => id);
  const missing = registryIDs.filter((id) => !transitionIDs.has(id));
  const propertyResult = (property: PropertyIDV4) => {
    const propertyFailures = failures.get(property) ?? [];
    const propertyWitnesses = witnesses.get(property) ?? 0;
    return {
      failures: propertyFailures,
      passed: propertyFailures.length === 0 && propertyWitnesses > 0,
      witnesses: propertyWitnesses,
    };
  };
  const properties = {
    P1: propertyResult('P1'),
    P2: propertyResult('P2'),
    P3: propertyResult('P3'),
    P4: propertyResult('P4'),
    P5: propertyResult('P5'),
    P6: propertyResult('P6'),
    P7: propertyResult('P7'),
    P8: propertyResult('P8'),
    P9: propertyResult('P9'),
    P10: propertyResult('P10'),
    P11: propertyResult('P11'),
    P12: propertyResult('P12'),
    P13: propertyResult('P13'),
    P14: propertyResult('P14'),
    P15: propertyResult('P15'),
  } satisfies ModelExplorerReportV4['properties'];

  return {
    canonicalizationRules: [
      'serialize and reload the complete schema-v4 root through production parser',
      'retain every nested intent, lease, candidate, completion, cleanup, upload, evidence, target, and revision field',
      'retain sorted full fake-remote block, parent/child, marker, trash, and upload lifecycle projections',
      'retain injected clock, permission, crash, source, and target identity categories',
      'prune only byte-identical canonical JSON states',
    ],
    exploredEdges,
    exploredStates: seen.size,
    maxDepth,
    processRestartChecks,
    properties,
    prunedStates,
    shortestCounterexample,
    transitionCoverage: {
      covered: registryIDs.length - missing.length,
      missing,
      total: registryIDs.length,
    },
    transitionWitnesses,
  };
}
