import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  NoteTransactionCoordinator,
  type NoteTransactionSource,
} from '../coordinator';
import {
  NoteSyncTransactionExecutor,
  type RemoteOperationAdapter,
} from '../executor';
import { JsonMetadataStoreAdapter } from '../metadata-store-adapter';
import { createIdleRecord } from '../model';
import type { RemoteOperationObservation } from '../recovery';
import { validateNoteSyncRecordJSON } from '../schema';
import type {
  CandidateRecord,
  CompletionEvidence,
  ManagedResourceRecord,
  NoteSyncRecordV3,
  OperationEvidence,
  OperationIntent,
  SourceSnapshot,
} from '../types';

import { now, target } from './fixtures';

function evidence(
  intent: OperationIntent,
  result: OperationEvidence['result'],
  returnedBlockIDs?: string[],
): OperationEvidence {
  return {
    observedAt: now,
    operationID: intent.operationID,
    requestDigest: intent.requestDigest,
    result,
    ...(returnedBlockIDs && { returnedBlockIDs }),
  };
}

function resource(
  intent: Extract<
    OperationIntent,
    { kind: 'CREATE_CANDIDATE' | 'CREATE_CONTAINER' }
  >,
): ManagedResourceRecord {
  return {
    ...(intent.kind === 'CREATE_CANDIDATE' && {
      attemptID: intent.transactionID,
    }),
    blockID:
      intent.kind === 'CREATE_CONTAINER'
        ? `container-${intent.operationID}`
        : `candidate-${intent.operationID}`,
    createdByID: target.connectionID,
    kind: intent.kind === 'CREATE_CONTAINER' ? 'container' : 'candidate',
    lastEditedTime: now,
    marker: intent.details.marker,
    operationID: intent.operationID,
    parent: intent.details.parent,
    versionMarker: intent.details.versionMarker,
  };
}

class StatefulRemote implements RemoteOperationAdapter {
  public readonly executions: OperationIntent[] = [];
  private readonly observations = new Map<
    string,
    Awaited<ReturnType<RemoteOperationAdapter['execute']>>
  >();

  public constructor(
    private readonly afterMutation: (intent: OperationIntent) => void = () =>
      undefined,
  ) {}

  public async execute(intent: OperationIntent) {
    this.executions.push(intent);
    const observation = this.succeed(intent);
    this.observations.set(intent.operationID, observation);
    this.afterMutation(intent);
    return observation;
  }

  public async observe(intent: OperationIntent) {
    return (
      this.observations.get(intent.operationID) || {
        type: 'proven-unexecuted' as const,
      }
    );
  }

  private succeed(intent: OperationIntent): RemoteOperationObservation {
    switch (intent.kind) {
      case 'CREATE_CONTAINER':
        return {
          evidence: evidence(intent, 'created'),
          resource: resource(intent),
          type: 'success' as const,
        };
      case 'CREATE_CANDIDATE': {
        const block = resource(intent);
        const candidate: CandidateRecord = {
          batchDigests: [],
          block,
          completionEvidence: null,
          expectedBlockCount: intent.details.candidatePlan.expectedBlockCount,
          expectedImageCount: intent.details.candidatePlan.expectedImageCount,
          generation: intent.generation,
          imageAssetIdentities:
            intent.details.candidatePlan.imageAssetIdentities,
          manifestDigest: intent.details.candidatePlan.manifestDigest,
          nextBatchIndex: 0,
          previousActiveBlockID:
            intent.details.candidatePlan.previousActiveBlockID,
          returnedBlockIDs: [],
          sourceVersion: intent.sourceVersion,
          status: 'staging',
          transactionID: intent.transactionID,
        };
        return {
          candidate,
          evidence: evidence(intent, 'created'),
          type: 'candidate-created' as const,
        };
      }
      case 'APPEND_BATCH':
        return {
          evidence: evidence(
            intent,
            'written',
            Array.from(
              { length: intent.details.expectedBlockCount },
              (_, index) => `${intent.operationID}-child-${index}`,
            ),
          ),
          type: 'success' as const,
        };
      case 'FINALIZE_CANDIDATE': {
        const finalBlock: ManagedResourceRecord = {
          ...intent.details.candidate,
          kind: 'note',
          lastEditedTime: now,
          marker: intent.details.ownershipMarker,
          operationID: intent.operationID,
          versionMarker: intent.details.versionMarker,
        };
        const finalization = evidence(intent, 'finalized');
        const completionEvidence: CompletionEvidence = {
          completedAt: now,
          finalization,
          manifestDigest: intent.details.manifestDigest,
          verifiedAt: now,
        };
        return {
          completionEvidence,
          finalBlock,
          type: 'candidate-finalized' as const,
        };
      }
      case 'DELETE_BLOCK':
        return {
          evidence: evidence(intent, 'deleted'),
          type: 'success' as const,
        };
      case 'UPLOAD_CREATE':
      case 'UPLOAD_SEND':
        throw new Error('This text-only scenario must not upload files');
    }
    throw new Error(`Unsupported operation intent: ${JSON.stringify(intent)}`);
  }
}

function source(version: string): NoteTransactionSource {
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
    manifestDigest: `manifest-${version}`,
    sourceVersion: version,
    title: `Title ${version}`,
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

function harness(initialSource: NoteTransactionSource) {
  let raw = JSON.stringify(
    createIdleRecord(target, initialSource.snapshot.featurePolicy, now),
  );
  let failNextWrite = false;
  const history: string[] = [];
  const store = new JsonMetadataStoreAdapter(
    {
      read: async () => raw,
      write: async (next) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('synthetic post-result persist crash');
        }
        raw = next;
        history.push(next);
      },
    },
    () => now,
  );
  return {
    failNextWrite: () => {
      failNextWrite = true;
    },
    history,
    raw: () => raw,
    store,
  };
}

describe('stateful transaction coordinator', () => {
  it('keeps the old active until the durable replacement commits, then deletes it', async () => {
    const firstSource = source('source-v1');
    const state = harness(firstSource);
    const remote = new StatefulRemote();
    const firstCoordinator = new NoteTransactionCoordinator(
      firstSource,
      target,
      false,
      { now: () => now, randomUUID: incrementingUUID() },
    );
    const executor = new NoteSyncTransactionExecutor(state.store, remote);

    const first = await executor.runUntilStable(firstCoordinator.selector());
    expect(first.state).toBe('IDLE');
    expect(first.active?.sourceVersion).toBe('source-v1');
    expect(remote.executions.map(({ kind }) => kind)).toEqual([
      'CREATE_CONTAINER',
      'CREATE_CANDIDATE',
      'APPEND_BATCH',
      'FINALIZE_CANDIDATE',
    ]);

    const oldBlockID = first.active?.block.blockID;
    const secondHistoryStart = state.history.length;
    const secondSource = source('source-v2');
    const secondCoordinator = new NoteTransactionCoordinator(
      secondSource,
      target,
      false,
      { now: () => now, randomUUID: incrementingUUID(100) },
    );
    const second = await executor.runUntilStable(secondCoordinator.selector());

    expect(second.state).toBe('IDLE');
    expect(second.active?.sourceVersion).toBe('source-v2');
    expect(second.active?.block.blockID).not.toBe(oldBlockID);
    const secondKinds = remote.executions.slice(4).map(({ kind }) => kind);
    expect(secondKinds).toEqual([
      'CREATE_CANDIDATE',
      'APPEND_BATCH',
      'FINALIZE_CANDIDATE',
      'DELETE_BLOCK',
    ]);
    const deleteIntent = remote.executions.at(-1);
    expect(deleteIntent?.kind).toBe('DELETE_BLOCK');
    if (deleteIntent?.kind !== 'DELETE_BLOCK')
      throw new Error('missing delete');
    expect(deleteIntent.details.exactBlockID).toBe(oldBlockID);

    const snapshots = state.history.slice(secondHistoryStart).map(parseRecord);
    const beforeCommit = snapshots.filter(
      (record) =>
        !['ACTIVE_COMMITTED', 'CLEANING', 'IDLE'].includes(record.state),
    );
    expect(
      beforeCommit.every(
        (record) =>
          record.active === null || record.active.block.blockID === oldBlockID,
      ),
    ).toBe(true);
  });

  it('unchanged synchronization performs no remote mutation or metadata write', async () => {
    const currentSource = source('source-v1');
    const state = harness(currentSource);
    const remote = new StatefulRemote();
    const coordinator = new NoteTransactionCoordinator(
      currentSource,
      target,
      false,
      { now: () => now, randomUUID: incrementingUUID() },
    );
    const executor = new NoteSyncTransactionExecutor(state.store, remote);
    await executor.runUntilStable(coordinator.selector());
    const operations = remote.executions.length;
    const revisions = state.history.length;

    const result = await executor.runUntilStable(coordinator.selector());

    expect(result.state).toBe('IDLE');
    expect(remote.executions).toHaveLength(operations);
    expect(state.history).toHaveLength(revisions);
  });

  it('H-01 recovers a confirmed old-active delete after crashing before confirmation persistence', async () => {
    const firstSource = source('source-v1');
    const state = harness(firstSource);
    let armDeleteCrash = false;
    const remote = new StatefulRemote((intent) => {
      if (armDeleteCrash && intent.kind === 'DELETE_BLOCK') {
        armDeleteCrash = false;
        state.failNextWrite();
      }
    });
    const executor = new NoteSyncTransactionExecutor(state.store, remote);
    await executor.runUntilStable(
      new NoteTransactionCoordinator(firstSource, target, false, {
        now: () => now,
        randomUUID: incrementingUUID(),
      }).selector(),
    );
    const beforeReplacement = parseRecord(state.raw());
    const oldActive = beforeReplacement.active?.block.blockID;
    if (!oldActive) throw new Error('Expected a first active block');

    const nextSource = source('source-v2');
    const nextCoordinator = new NoteTransactionCoordinator(
      nextSource,
      target,
      false,
      { now: () => now, randomUUID: incrementingUUID(200) },
    );
    armDeleteCrash = true;
    await expect(
      executor.runUntilStable(nextCoordinator.selector()),
    ).rejects.toThrow('synthetic post-result persist crash');

    const crashed = parseRecord(state.raw());
    expect(crashed.active?.sourceVersion).toBe('source-v2');
    expect(crashed.operationIntent?.kind).toBe('DELETE_BLOCK');
    if (crashed.operationIntent?.kind !== 'DELETE_BLOCK') {
      throw new Error('Expected persisted DELETE_BLOCK intent');
    }
    expect(crashed.operationIntent.details.exactBlockID).toBe(oldActive);
    const deleteExecutions = remote.executions.filter(
      ({ kind }) => kind === 'DELETE_BLOCK',
    );
    expect(deleteExecutions).toHaveLength(1);

    const restarted = new NoteSyncTransactionExecutor(state.store, remote);
    const recovered = await restarted.runUntilStable(
      nextCoordinator.selector(),
    );
    expect(recovered.state).toBe('IDLE');
    expect(recovered.active?.sourceVersion).toBe('source-v2');
    expect(recovered.cleanup.targets).toHaveLength(0);
    expect(
      remote.executions.filter(({ kind }) => kind === 'DELETE_BLOCK'),
    ).toHaveLength(1);

    const unchanged = await restarted.runUntilStable(
      nextCoordinator.selector(),
    );
    expect(unchanged.state).toBe('IDLE');
  });
});

function incrementingUUID(start = 0): () => string {
  let sequence = start;
  return () => `operation-${++sequence}`;
}

function parseRecord(raw: string): NoteSyncRecordV3 {
  const parsed = validateNoteSyncRecordJSON(raw);
  if (parsed.validation !== 'valid') {
    throw new Error('Expected valid synthetic transaction metadata');
  }
  return parsed.record;
}
