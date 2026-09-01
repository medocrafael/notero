import { authorizeMainMutation } from './authorization-v4';
import type { MainCoordinatorV2 } from './coordinator-v4';
import type { MainEventPayloadV2, MainEventV2 } from './events-v4';
import type { TransactionalMetadataStoreV4 } from './metadata-store-adapter';
import {
  StaleRecordRevisionError,
  StaleRootRevisionError,
} from './metadata-store-adapter';
import type { ProcessSession, RuntimeIdentityFactory } from './model-v4';
import {
  createPendingCleanupEntry,
  createSealedQuarantineEvidence,
  sealOperationIntent,
} from './model-v4';
import type { RemoteOperationAdapterV4 } from './remote-operation-v4';
import type { RemoteOperationResultV4 } from './remote-operation-v4';
import type { RuntimeClock } from './runtime-clock';
import { TransactionInvariantError } from './schema-v4';
import { transitionMainV2 } from './transition-registry';
import type {
  CandidateRecordV4,
  ManagedContainerMapping,
  MetadataStoreSnapshot,
  RemoteObservation,
  RemoteVerificationState,
  SealedOperationIntent,
  SealedQuarantineEvidence,
} from './types-v4';

const DEFAULT_MAX_RUN_STEPS = 128;
const DEFAULT_MAX_MUTATIONS = 32;

export type MainExecutionResultV4 = {
  mutationAttempts: number;
  snapshot: MetadataStoreSnapshot;
  status: 'HALTED' | 'QUARANTINED' | 'STABLE' | 'STEP_LIMIT';
  steps: number;
  transitionIDs: string[];
};

function intentResource(intent: SealedOperationIntent) {
  switch (intent.kind) {
    case 'APPEND_BATCH':
    case 'FINALIZE_CANDIDATE':
    case 'VERIFY_CANDIDATE':
      return intent.details.candidate;
    case 'CREATE_CANDIDATE':
      return intent.details.container;
    case 'VERIFY_LIVENESS':
      return intent.details.active || intent.details.container;
    default:
      return null;
  }
}

function isIntentPersistenceEvent(event: MainEventV2): boolean {
  return [
    'APPEND_INTENT_PERSISTED',
    'CANDIDATE_INTENT_PERSISTED',
    'CONTAINER_INTENT_PERSISTED',
    'FINALIZE_INTENT_PERSISTED',
    'LIVENESS_INTENT_PERSISTED',
    'UPLOAD_INTENT_PERSISTED',
    'VERIFY_INTENT_PERSISTED',
  ].includes(event.type);
}

export class MainTransactionExecutorV2 {
  private readonly attemptedOperationIDs = new Set<string>();
  private readonly newlyPersistedOperationIDs = new Set<string>();
  private readonly transitionIDs: string[] = [];

  public constructor(
    private readonly store: TransactionalMetadataStoreV4,
    private readonly coordinator: MainCoordinatorV2,
    private readonly remote: RemoteOperationAdapterV4,
    private readonly session: ProcessSession,
    private readonly clock: RuntimeClock,
    private readonly identity: RuntimeIdentityFactory,
    private readonly maxRunSteps = DEFAULT_MAX_RUN_STEPS,
    private readonly maxMutationAttempts = DEFAULT_MAX_MUTATIONS,
  ) {}

  public async runUntilStable(): Promise<MainExecutionResultV4> {
    let snapshot = await this.store.load();
    let mutationAttempts = 0;
    let initialHaltMayResume = Boolean(
      snapshot.record.mainTransaction?.runHalt,
    );
    for (let step = 0; step < this.maxRunSteps; step += 1) {
      const record = snapshot.record;
      if (record.mainState === 'QUARANTINED') {
        return {
          mutationAttempts,
          snapshot,
          status: 'QUARANTINED',
          steps: step,
          transitionIDs: this.transitionIDs.slice(),
        };
      }
      if (record.mainTransaction?.runHalt) {
        if (initialHaltMayResume) {
          const resume = this.coordinator.select(record);
          if (resume?.type === 'SOURCE_OBSERVED') {
            snapshot = await this.persist(snapshot, resume);
            continue;
          }
          initialHaltMayResume = false;
          if (resume?.type === 'RESUME_AFTER_HALT') {
            snapshot = await this.persist(snapshot, resume);
            continue;
          }
        }
        return {
          mutationAttempts,
          snapshot,
          status: 'HALTED',
          steps: step,
          transitionIDs: this.transitionIDs.slice(),
        };
      }
      const intent = record.mainTransaction?.operationIntent;
      if (intent) {
        if (
          this.newlyPersistedOperationIDs.has(intent.operationID) &&
          !this.attemptedOperationIDs.has(intent.operationID) &&
          mutationAttempts >= this.maxMutationAttempts
        ) {
          snapshot = await this.persist(
            snapshot,
            this.stamp(
              this.eventFromRemote(snapshot, intent, {
                classification: 'TRANSIENT_BUDGET_EXHAUSTED',
                proof: 'NOT_EXECUTED',
                redactedMessage: 'Remote mutation budget exhausted',
                responseClassification: 'local-mutation-budget',
                type: 'REJECTED',
              }),
            ),
          );
          continue;
        }
        const shouldExecute =
          this.newlyPersistedOperationIDs.has(intent.operationID) &&
          !this.attemptedOperationIDs.has(intent.operationID) &&
          mutationAttempts < this.maxMutationAttempts;
        let result: RemoteOperationResultV4;
        if (shouldExecute) {
          // Reload and validate the exact durable intent immediately before
          // issuing its single authorized mutation attempt.
          snapshot = await this.store.load();
          const currentIntent =
            snapshot.record.mainTransaction?.operationIntent;
          if (currentIntent?.operationID !== intent.operationID) continue;
          const authorization = authorizeMainMutation(
            snapshot,
            this.session,
            this.clock,
            this.identity,
          );
          this.attemptedOperationIDs.add(intent.operationID);
          this.newlyPersistedOperationIDs.delete(intent.operationID);
          mutationAttempts += 1;
          try {
            result = await this.remote.execute(authorization, async () => {
              const latest = await this.store.loadForMutationAuthorization();
              return authorizeMainMutation(
                latest,
                this.session,
                this.clock,
                this.identity,
              );
            });
          } catch (error) {
            result = this.unexpectedRemoteFailure(error);
          }
        } else {
          try {
            result = await this.remote.observe(intent);
          } catch (error) {
            result = this.unexpectedRemoteFailure(error);
          }
        }
        const event = this.eventFromRemote(snapshot, intent, result);
        snapshot = await this.persist(snapshot, this.stamp(event));
        continue;
      }
      const event = this.coordinator.select(record);
      if (!event) {
        return {
          mutationAttempts,
          snapshot,
          status: 'STABLE',
          steps: step,
          transitionIDs: this.transitionIDs.slice(),
        };
      }
      snapshot = await this.persist(snapshot, event);
      if (isIntentPersistenceEvent(event)) {
        const persistedIntent =
          snapshot.record.mainTransaction?.operationIntent;
        if (persistedIntent) {
          this.newlyPersistedOperationIDs.add(persistedIntent.operationID);
        }
      }
    }
    snapshot = await this.store.load();
    return {
      mutationAttempts,
      snapshot,
      status: 'STEP_LIMIT',
      steps: this.maxRunSteps,
      transitionIDs: this.transitionIDs.slice(),
    };
  }

  private async persist(
    snapshot: MetadataStoreSnapshot,
    event: MainEventV2,
  ): Promise<MetadataStoreSnapshot> {
    let transition;
    try {
      transition = transitionMainV2(snapshot.record, event);
    } catch (error) {
      if (
        !(error instanceof TransactionInvariantError) ||
        event.type === 'VALIDATION_QUARANTINED'
      ) {
        throw error;
      }
      transition = transitionMainV2(
        snapshot.record,
        this.stamp(this.validationQuarantineEvent(snapshot, error, event)),
      );
    }
    try {
      const persisted = await this.store.persist(
        {
          noteRevision: snapshot.record.revision,
          rootRevision: snapshot.rootRevision,
        },
        transition.nextState,
      );
      this.transitionIDs.push(transition.transitionID);
      return persisted;
    } catch (error) {
      if (
        error instanceof StaleRecordRevisionError ||
        error instanceof StaleRootRevisionError
      ) {
        return this.store.load();
      }
      throw error;
    }
  }

  private stamp(event: MainEventPayloadV2): MainEventV2 {
    const now = this.clock.nowISOString();
    return { ...event, occurredAt: now, updatedAt: now } as MainEventV2;
  }

  private validationQuarantineEvent(
    snapshot: MetadataStoreSnapshot,
    error: TransactionInvariantError,
    rejectedEvent: MainEventV2,
  ): Extract<MainEventPayloadV2, { type: 'VALIDATION_QUARANTINED' }> {
    const intent = snapshot.record.mainTransaction?.operationIntent ?? null;
    const observation =
      'observation' in rejectedEvent ? rejectedEvent.observation : null;
    return {
      evidence: createSealedQuarantineEvidence({
        clock: this.clock,
        evidenceID: this.identity.randomUUID(),
        generation: intent?.generation ?? null,
        intent,
        noteRevision: snapshot.record.revision,
        observation,
        origin: 'SCHEMA',
        reasonCode: `INVARIANT_${error.issues.map(({ code }) => code).join('_')}`,
        requiredRepair: 'VERIFY_REMOTE_RESOURCE',
        resource: intent ? intentResource(intent) : null,
        responseClassification: 'reducer-validation-failed',
        rootRevision: snapshot.rootRevision,
        sourceVersion: intent?.sourceVersion ?? null,
        transactionID: intent?.transactionID ?? null,
      }),
      type: 'VALIDATION_QUARANTINED',
    };
  }

  private eventFromRemote(
    snapshot: MetadataStoreSnapshot,
    intent: SealedOperationIntent,
    result: RemoteOperationResultV4,
  ): MainEventPayloadV2 {
    if (result.type === 'PROVEN_UNEXECUTED') {
      const candidate = snapshot.record.mainTransaction?.candidate;
      const abortedCandidateCleanup =
        candidate &&
        ['APPEND_BATCH', 'FINALIZE_CANDIDATE', 'VERIFY_CANDIDATE'].includes(
          intent.kind,
        )
          ? createPendingCleanupEntry(
              {
                generation: candidate.generation,
                reason: 'ABORTED_ATTEMPT',
                resource: candidate.resource,
                sourceVersion: candidate.sourceVersion,
                transactionID: candidate.transactionID,
              },
              this.clock,
              this.identity,
            )
          : null;
      return {
        abortedCandidateCleanup,
        halt: {
          classification: 'TRANSIENT_RETRY_SCHEDULED',
          haltedAt: this.clock.nowISOString(),
          nextRetryAt:
            result.nextRetryAt ||
            this.clock.addMs(this.clock.nowISOString(), 1_000),
          operationID: intent.operationID,
          proof: 'NOT_EXECUTED',
          redactedMessage: 'Remote operation is scheduled for bounded retry',
        },
        operationKind: intent.kind,
        type: 'OPERATION_PROVEN_UNEXECUTED',
      };
    }
    if (result.type === 'REJECTED') {
      const candidate = snapshot.record.mainTransaction?.candidate;
      const abortedCandidateCleanup =
        candidate &&
        ['APPEND_BATCH', 'FINALIZE_CANDIDATE', 'VERIFY_CANDIDATE'].includes(
          intent.kind,
        )
          ? createPendingCleanupEntry(
              {
                generation: candidate.generation,
                reason: 'ABORTED_ATTEMPT',
                resource: candidate.resource,
                sourceVersion: candidate.sourceVersion,
                transactionID: candidate.transactionID,
              },
              this.clock,
              this.identity,
            )
          : null;
      const evidence = this.quarantineEvidence(snapshot, intent, {
        lastObservation: null,
        reasonCode: result.classification,
        requiredRepair:
          result.classification === 'AUTH_REQUIRED'
            ? 'RECONNECT_NOTION'
            : result.classification === 'PERMISSION_REQUIRED'
              ? 'RESTORE_CAPABILITY'
              : 'NONE',
        responseClassification: result.responseClassification,
      });
      return {
        abortedCandidateCleanup,
        evidence,
        halt: {
          classification: result.classification,
          haltedAt: this.clock.nowISOString(),
          nextRetryAt: null,
          operationID: intent.operationID,
          proof: result.proof,
          redactedMessage: result.redactedMessage,
        },
        type: 'OPERATION_REJECTED',
      };
    }
    if (result.type === 'UNCERTAIN') {
      return {
        evidence: this.quarantineEvidence(snapshot, intent, result),
        type: 'OPERATION_UNCERTAIN',
      };
    }
    return this.observedEvent(
      snapshot,
      intent,
      result.observation,
      result.verification,
    );
  }

  private observedEvent(
    snapshot: MetadataStoreSnapshot,
    intent: SealedOperationIntent,
    observation: RemoteObservation,
    verification: RemoteVerificationState | undefined,
  ): MainEventPayloadV2 {
    switch (intent.kind) {
      case 'CREATE_CONTAINER': {
        const resource = observation.remoteResource;
        if (!resource || resource.kind !== 'container') {
          throw new Error('Container observation omitted its exact resource');
        }
        const container: ManagedContainerMapping = {
          ...resource,
          kind: 'container',
        };
        return {
          container,
          observation,
          type: 'CONTAINER_CREATED',
        };
      }
      case 'CREATE_CANDIDATE': {
        const resource = observation.remoteResource;
        if (!resource || resource.kind !== 'note') {
          throw new Error('Candidate observation omitted its exact resource');
        }
        const details = intent.details;
        const candidate: CandidateRecordV4 = {
          batchEvidence: [],
          completionEvidence: null,
          container: details.container,
          expectedBatchCount: details.expectedBatchCount,
          expectedBlockCount: details.expectedBlockCount,
          expectedImageCount: details.expectedImageCount,
          finalizationEvidence: null,
          finalTitle: details.finalTitle,
          generation: intent.generation,
          imageAssetIdentities: details.imageAssetIdentities,
          manifestDigest: details.manifestDigest,
          previousActiveBlockID: details.previousActiveBlockID,
          resource,
          sourceDescriptor: details.sourceDescriptor,
          sourceVersion: intent.sourceVersion,
          stagingTitle: details.stagingTitle,
          status: details.expectedBatchCount === 0 ? 'WRITING' : 'CREATED',
          targetIdentityDigest: intent.targetIdentityDigest,
          transactionID: intent.transactionID,
        };
        return { candidate, observation, type: 'CANDIDATE_CREATED' };
      }
      case 'APPEND_BATCH':
        if (!observation.remoteResource) {
          throw new Error('Append observation omitted its candidate resource');
        }
        return {
          attachedAssets: observation.attachedUploadIDs.map((fileUploadID) => {
            const asset = snapshot.record.uploadAssets.find(
              (candidate) => candidate.fileUploadID === fileUploadID,
            );
            if (!asset) {
              throw new Error(
                'Append attachment proof references an unknown upload',
              );
            }
            return {
              ...asset,
              attachedAt: observation.observedAt,
              expiryTime: null,
              status: 'ATTACHED' as const,
            };
          }),
          candidate: observation.remoteResource,
          evidence: {
            batchDigest: intent.details.batchDigest,
            blockFingerprints: observation.blockFingerprints,
            completedAt: observation.observedAt,
            imageAssetIdentityDigests: intent.details.fileUploads.map(
              ({ assetIdentityDigest }) => assetIdentityDigest,
            ),
            imageUploadIDs: intent.details.fileUploads.map(
              ({ fileUploadID }) => fileUploadID,
            ),
            index: intent.details.batchIndex,
            parentBlockID: intent.details.candidate.blockID,
            returnedBlockIDs: observation.returnedBlockIDs,
          },
          observation,
          type: 'BATCH_APPENDED',
        };
      case 'VERIFY_CANDIDATE': {
        const candidate = snapshot.record.mainTransaction?.candidate;
        if (!candidate) throw new Error('Verification lost its candidate');
        return {
          completionEvidence: {
            batchDigests: intent.details.batchDigests,
            blockFingerprints: intent.details.blockFingerprints,
            candidateBlockID: candidate.resource.blockID,
            completedBatchCount: candidate.batchEvidence.length,
            expectedBatchCount: candidate.expectedBatchCount,
            expectedBlockCount: candidate.expectedBlockCount,
            expectedImageCount: candidate.expectedImageCount,
            imageAssetIdentities: candidate.imageAssetIdentities,
            imageAssetIdentityDigests: candidate.batchEvidence.flatMap(
              ({ imageAssetIdentityDigests }) => imageAssetIdentityDigests,
            ),
            imageUploadIDs: intent.details.expectedImageUploadIDs,
            manifestDigest: candidate.manifestDigest,
            returnedBlockIDs: intent.details.returnedBlockIDs,
            sourceVersion: candidate.sourceVersion,
            verificationIntent: sealOperationIntent(intent, 'SEALED'),
            verifiedAt: observation.observedAt,
          },
          observation,
          type: 'CANDIDATE_VERIFIED',
        };
      }
      case 'FINALIZE_CANDIDATE': {
        const resource = observation.remoteResource;
        if (!resource || resource.kind !== 'note') {
          throw new Error('Finalization omitted its exact candidate resource');
        }
        return {
          candidate: resource,
          finalizationEvidence: {
            candidateBlockID: resource.blockID,
            finalTitle: intent.details.finalTitle,
            finalizationIntent: sealOperationIntent(intent, 'SEALED'),
            finalizedAt: observation.observedAt,
            lastEditedTime: resource.lastEditedTime,
            stagingTitle: intent.details.stagingTitle,
          },
          observation,
          type: 'CANDIDATE_FINALIZED',
        };
      }
      case 'UPLOAD_CREATE':
      case 'UPLOAD_SEND': {
        const asset = observation.upload;
        if (!asset) throw new Error('Upload observation omitted its asset');
        return { asset, observation, type: 'UPLOAD_OBSERVED' };
      }
      case 'VERIFY_LIVENESS': {
        if (!verification) {
          throw new Error('Liveness observation omitted verification state');
        }
        if (verification.outcome === 'EXACT') {
          return { type: 'LIVENESS_EXACT', verification };
        }
        const evidence = this.quarantineEvidence(snapshot, intent, {
          lastObservation:
            verification.containerObservation || verification.activeObservation,
          reasonCode: `LIVENESS_${verification.outcome}`,
          requiredRepair: 'VERIFY_REMOTE_RESOURCE',
          responseClassification: verification.outcome,
        });
        return this.coordinator.createLivenessRepairEvent(
          snapshot.record,
          verification,
          evidence,
        );
      }
      case 'DELETE_BLOCK':
        throw new Error('Cleanup delete cannot execute in the main machine');
    }
    throw new Error('Unsupported main operation');
  }

  private quarantineEvidence(
    snapshot: MetadataStoreSnapshot,
    intent: SealedOperationIntent,
    failure: {
      lastObservation: RemoteObservation | null;
      reasonCode: string;
      requiredRepair: SealedQuarantineEvidence['requiredRepair'];
      responseClassification: string;
    },
  ): SealedQuarantineEvidence {
    return createSealedQuarantineEvidence({
      clock: this.clock,
      evidenceID: this.identity.randomUUID(),
      generation: intent.generation,
      intent,
      noteRevision: snapshot.record.revision,
      observation: failure.lastObservation,
      origin: intent.kind === 'VERIFY_LIVENESS' ? 'LIVENESS' : 'MAIN',
      reasonCode: failure.reasonCode,
      requiredRepair: failure.requiredRepair,
      resource: intentResource(intent),
      responseClassification: failure.responseClassification,
      rootRevision: snapshot.rootRevision,
      sourceVersion: intent.sourceVersion,
      transactionID: intent.transactionID,
    });
  }

  private unexpectedRemoteFailure(error: unknown): RemoteOperationResultV4 {
    return {
      lastObservation: null,
      reasonCode: 'UNCLASSIFIED_REMOTE_FAILURE',
      redactedMessage:
        error instanceof Error ? error.name : 'Unknown remote failure',
      requiredRepair: 'VERIFY_REMOTE_RESOURCE',
      responseClassification: 'unclassified-exception',
      type: 'UNCERTAIN',
    };
  }
}
