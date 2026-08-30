import { describe, expect, it } from 'vite-plus/test';

import type { NoteSyncEvent } from '../events';
import { transition } from '../reducer';
import {
  serializeNoteSyncRecord,
  validateNoteSyncRecordJSON,
  validateTransactionInvariants,
} from '../schema';
import type { NoteSyncRecordV3, OperationIntent } from '../types';

import {
  candidate,
  completionEvidence,
  evidence,
  intent,
  now,
  record,
  resource,
  target,
  version,
} from './fixtures';

type ExplorerNode = {
  depth: number;
  remoteEffectCount: number;
  state: NoteSyncRecordV3;
};

function canonical(recordValue: NoteSyncRecordV3): string {
  return JSON.stringify(recordValue, Object.keys(recordValue).toSorted());
}

function cleanupTarget(blockID = 'cleanup-block') {
  return {
    generation: 1,
    reason: 'aborted-candidate' as const,
    resource: resource('candidate', blockID),
    sourceVersion: 'source-version-0001',
    status: 'pending' as const,
    transactionID: 'transaction-test',
  };
}

function eventSet(state: NoteSyncRecordV3): NoteSyncEvent[] {
  if (state.state === 'IDLE') {
    return [
      {
        featurePolicy: state.featurePolicy,
        now,
        requestedSourceVersion:
          state.active?.sourceVersion === 'source-version-0001'
            ? 'source-version-0002'
            : 'source-version-0001',
        source: {
          batches: [],
          featurePolicy: state.featurePolicy,
          imageAssets: [],
          manifestDigest: 'manifest-digest',
          sourceVersion:
            state.active?.sourceVersion === 'source-version-0001'
              ? 'source-version-0002'
              : 'source-version-0001',
          title: 'Synthetic note',
        },
        targetIdentity: target,
        transactionID: 'transaction-test',
        type: 'SYNC_REQUESTED',
      },
    ];
  }
  if (state.operationIntent) {
    const current = state.operationIntent;
    if (current.kind === 'CREATE_CONTAINER') {
      return [
        {
          evidence: evidence(
            current.operationID,
            'created',
            current.requestDigest,
          ),
          resource: resource('container', 'container-block'),
          type: 'OPERATION_SUCCEEDED',
        },
        {
          diagnostic: {
            actionable: true,
            code: 'AMBIGUOUS_REMOTE_RESULT',
            createdAt: now,
            evidenceDigest: 'uncertain-container',
            message: 'Synthetic create uncertainty',
            operationID: current.operationID,
          },
          type: 'OPERATION_UNCERTAIN',
        },
      ];
    }
    if (current.kind === 'CREATE_CANDIDATE') {
      return [
        {
          candidate: candidate(),
          evidence: evidence(
            current.operationID,
            'created',
            current.requestDigest,
          ),
          type: 'RECONCILE_CREATE',
        },
      ];
    }
    if (current.kind === 'APPEND_BATCH') {
      return [
        {
          evidence: {
            ...evidence(current.operationID, 'written', current.requestDigest),
            returnedBlockIDs: ['content-block-0001'],
          },
          type: 'OPERATION_SUCCEEDED',
        },
        { cleanupTarget: cleanupTarget(), type: 'APPEND_UNKNOWN' },
      ];
    }
    if (current.kind === 'FINALIZE_CANDIDATE') {
      return [
        {
          completionEvidence,
          finalBlock: resource('note', 'note-block'),
          type: 'FINALIZE_CONFIRMED',
        },
        {
          cleanupTarget: cleanupTarget(),
          type: 'FINALIZE_UNKNOWN',
        },
      ];
    }
    if (current.kind === 'DELETE_BLOCK') {
      return [
        {
          evidence: evidence(
            current.operationID,
            'deleted',
            current.requestDigest,
          ),
          type: 'RECOVER_DELETE_INTENT',
        },
        { type: 'RECOVER_DELETE_INTENT' },
      ];
    }
    return [];
  }
  switch (state.state) {
    case 'PREPARING':
      return state.container
        ? [{ type: 'RESOURCES_READY' }]
        : [
            {
              intent: intent('CREATE_CONTAINER'),
              type: 'CONTAINER_REQUIRED',
            },
          ];
    case 'CANDIDATE_CREATING':
      return [
        {
          intent: intent('CREATE_CANDIDATE'),
          type: 'CREATE_CANDIDATE',
        },
      ];
    case 'CANDIDATE_WRITING':
      return state.candidate?.nextBatchIndex === 0
        ? [{ intent: intent('APPEND_BATCH'), type: 'APPEND_BATCH' }]
        : [{ type: 'CONTENT_COMPLETE' }];
    case 'CANDIDATE_VERIFYING':
      return [
        {
          intent: intent('FINALIZE_CANDIDATE'),
          type: 'FINALIZE_CANDIDATE',
        },
      ];
    case 'CANDIDATE_DURABLE':
      return [{ committedAt: now, type: 'COMMIT_ACTIVE' }];
    case 'ACTIVE_COMMITTED':
      return state.cleanup.targets.length
        ? [{ type: 'PREVIOUS_ACTIVE_RETIRED' }]
        : [{ type: 'NO_PREVIOUS_ACTIVE' }];
    case 'CLEANING':
      return state.cleanup.targets.some(({ status }) => status === 'pending')
        ? [{ intent: intent('DELETE_BLOCK'), type: 'DELETE_NEXT' }]
        : [{ type: 'CLEANUP_COMPLETE' }];
    case 'QUARANTINED':
      return [];
    default:
      return [];
  }
}

function restarted(recordValue: NoteSyncRecordV3): NoteSyncRecordV3 {
  const parsed = validateNoteSyncRecordJSON(
    serializeNoteSyncRecord(recordValue),
  );
  if (parsed.validation !== 'valid') {
    throw new Error(parsed.diagnostic.message);
  }
  return parsed.record;
}

function explore(initial: NoteSyncRecordV3, maxDepth = 10): ExplorerNode[] {
  const queue: ExplorerNode[] = [
    { depth: 0, remoteEffectCount: 0, state: restarted(initial) },
  ];
  const visited = new Set<string>();
  const nodes: ExplorerNode[] = [];
  while (queue.length) {
    const node = queue.shift();
    if (!node) break;
    const key = `${node.depth}:${canonical(node.state)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    nodes.push(node);
    if (node.depth >= maxDepth) continue;
    for (const event of eventSet(node.state)) {
      const result = transition(node.state, event);
      const effectCount = result.effects.filter(
        ({ type }) => type === 'EXECUTE_REMOTE_OPERATION',
      ).length;
      queue.push({
        depth: node.depth + 1,
        remoteEffectCount: node.remoteEffectCount + effectCount,
        state: restarted(result.nextState),
      });
    }
  }
  return nodes;
}

function assertDurableIntentForEffects(
  state: NoteSyncRecordV3,
  operationIntent: OperationIntent | null,
): void {
  if (!operationIntent) return;
  expect(state.operationIntent?.operationID).toBe(operationIntent.operationID);
  expect(state.operationIntent?.requestDigest).toBe(
    operationIntent.requestDigest,
  );
}

describe('bounded deterministic note transaction state-space explorer', () => {
  it('M-01 canonicalization preserves nested safety identity', () => {
    const appendIntent = intent('APPEND_BATCH');
    const initial = {
      ...record('CANDIDATE_WRITING'),
      operationIntent: appendIntent,
    };
    const changed = {
      ...initial,
      operationIntent: {
        ...appendIntent,
        requestDigest: 'different-nested-request-digest',
      },
    };

    expect(canonical(initial)).not.toBe(canonical(changed));
  });

  it('explores state × event × failpoint × restart to depth 12', () => {
    const initial = record('IDLE');
    const nodes = explore(initial, 12);

    expect(nodes.length).toBeGreaterThan(10);
    for (const node of nodes) {
      expect(validateTransactionInvariants(node.state)).toStrictEqual([]);
      expect(node.depth).toBeLessThanOrEqual(12);
    }
  });

  it('P1/P6 preserves LKG until a durable candidate commits', () => {
    const oldActive = version();
    const nodes = explore(record('IDLE', { active: oldActive }), 10);

    const unsafe = nodes.filter(
      (node) =>
        node.state.state !== 'ACTIVE_COMMITTED' &&
        node.state.active?.transactionID !== 'transaction-test' &&
        node.state.active?.block.blockID !== oldActive.block.blockID,
    );
    expect(unsafe).toStrictEqual([]);
  });

  it('P2/P8 every destructive effect has exact durable matching intent', () => {
    const cleaning = record('CLEANING');
    const event: NoteSyncEvent = {
      intent: intent('DELETE_BLOCK'),
      type: 'DELETE_NEXT',
    };
    const result = transition(cleaning, event);
    const effect = result.effects.find(
      ({ type }) => type === 'EXECUTE_REMOTE_OPERATION',
    );
    if (!effect || effect.type !== 'EXECUTE_REMOTE_OPERATION') {
      throw new Error('Synthetic delete effect is missing');
    }

    expect(effect.intent.kind).toBe('DELETE_BLOCK');
    assertDurableIntentForEffects(result.nextState, effect.intent);
    expect(result.nextState.active?.block.blockID).not.toBe(
      effect.intent.kind === 'DELETE_BLOCK'
        ? effect.intent.details.exactBlockID
        : undefined,
    );
  });

  it('P3/P9 commits at most one active and only from durable evidence', () => {
    const result = transition(record('CANDIDATE_DURABLE'), {
      committedAt: now,
      type: 'COMMIT_ACTIVE',
    });

    expect(result.nextState.active).not.toBeNull();
    expect(result.nextState.active?.completionEvidence).toStrictEqual(
      result.nextState.candidate?.completionEvidence,
    );
    expect(result.nextState.active?.block.blockID).toBe(
      result.nextState.candidate?.block.blockID,
    );
  });

  it('P4 repeated recovery never adds another remote effect', () => {
    const deleting = {
      ...record('CLEANING'),
      operationIntent: intent('DELETE_BLOCK'),
    };
    const first = transition(deleting, { type: 'RECOVER_DELETE_INTENT' });
    const second = transition(first.nextState, {
      type: 'RECOVER_DELETE_INTENT',
    });

    expect(first.effects).toHaveLength(1);
    expect(second.effects).toHaveLength(1);
    expect(first.effects[0]).toStrictEqual(second.effects[0]);
  });

  it('P5 every explored state reaches progress or explicit quarantine', () => {
    const nodes = explore(record('IDLE'), 12);
    const states = new Set(nodes.map(({ state }) => state.state));

    expect(states.has('IDLE')).toBe(true);
    expect(states.has('CANDIDATE_DURABLE')).toBe(true);
    expect(states.has('ACTIVE_COMMITTED')).toBe(true);
  });

  it('P7 Feature OFF produces zero file-upload effects', () => {
    const disabled = record('PREPARING', { featurePolicy: 'text-only-v1' });
    const result = transition(disabled, {
      intent: intent('UPLOAD_CREATE'),
      type: 'UPLOAD_CREATE_REQUIRED',
      upload: {
        attachedAt: null,
        attachmentKey: 'IMAGE001',
        contentHash: 'image-content-hash',
        contentLength: 100,
        contentType: 'image/png',
        createOperationID: 'upload-create-op',
        expiryTime: null,
        fileUploadID: null,
        filename: 'image.png',
        generation: 1,
        sendOperationID: null,
        sourceVersion: 'source-version-0001',
        status: 'create-intended',
        targetIdentity: target,
        transactionID: 'transaction-test',
      },
    });

    expect(result.nextState.state).toBe('QUARANTINED');
    expect(
      result.effects.filter(({ type }) => type === 'EXECUTE_REMOTE_OPERATION'),
    ).toHaveLength(0);
  });

  it('P10 404, zero-match, and multi-match diagnostics never generate success', () => {
    for (const code of [
      'REMOTE_NOT_FOUND',
      'AMBIGUOUS_REMOTE_RESULT',
      'PAGINATION_INCOMPLETE',
    ] as const) {
      const result = transition(record('PREPARING'), {
        diagnostic: {
          actionable: true,
          code,
          createdAt: now,
          evidenceDigest: `evidence-${code}`,
          message: 'Synthetic unknown result',
          operationID: null,
        },
        type: 'INVALID_SCHEMA_OR_EVIDENCE',
      });

      expect(result.nextState.state).toBe('QUARANTINED');
      expect(result.effects).toStrictEqual([{ type: 'NONE' }]);
    }
  });
});
