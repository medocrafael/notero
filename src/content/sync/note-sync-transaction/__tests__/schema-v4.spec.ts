import { describe, expect, it } from 'vite-plus/test';

import { canonicalJSON, digestCanonical, sha256 } from '../canonical';
import {
  deriveTargetIdentityDigest,
  recomputeOperationRequestDigest,
} from '../identity-v4';
import { createOperationIntent } from '../model-v4';
import {
  assertTransactionRecord,
  parseSyncedNotesRootV4,
  validateTransactionRecord,
} from '../schema-v4';
import type { NoteSyncRecordV4 } from '../types-v4';

import {
  clockV4,
  manifestDigestV4,
  recordV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

describe('schema v4 foundations', () => {
  it('uses a standard SHA-256 digest and deep canonical key ordering', () => {
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(canonicalJSON({ z: [{ y: 2, x: 1 }], a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"z":[{"x":1,"y":2}]}',
    );
    expect(digestCanonical('test', { outer: { second: 2, first: 1 } })).toBe(
      digestCanonical('test', { outer: { first: 1, second: 2 } }),
    );
  });

  it.each([
    'IDLE',
    'PREPARING',
    'CANDIDATE_CREATING',
    'CANDIDATE_WRITING',
    'CANDIDATE_VERIFYING',
    'CANDIDATE_DURABLE',
  ] as const)('accepts a valid %s record', (state) => {
    expect(validateTransactionRecord(recordV4(state))).toStrictEqual(
      expect.objectContaining({ issues: [], valid: true }),
    );
  });

  it('rejects a cross-target candidate even when every field is well typed', () => {
    const record = recordV4('CANDIDATE_WRITING');
    if (!record.mainTransaction?.candidate) throw new Error('bad fixture');
    const invalid: NoteSyncRecordV4 = {
      ...record,
      mainTransaction: {
        ...record.mainTransaction,
        candidate: {
          ...record.mainTransaction.candidate,
          targetIdentityDigest: deriveTargetIdentityDigest({
            ...targetV4,
            noteItemKey: 'OTHER_NOTE',
          }),
        },
      },
    };

    const validation = validateTransactionRecord(invalid);
    expect(validation.valid).toBe(false);
    if (validation.valid) throw new Error('Expected invalid record');
    expect(validation.issues.map(({ code }) => code)).toContain('V6');
  });

  it('recomputes an operation digest over nested payload and authorization', () => {
    const record = recordV4('PREPARING');
    const lease = record.writerCoordination.mainLease;
    if (!record.mainTransaction || !lease) throw new Error('bad fixture');
    const intent = createOperationIntent({
      createdAt: clockV4.nowISOString(),
      details: {
        active: null,
        container: null,
        force: true,
      },
      generation: record.mainTransaction.generation,
      kind: 'VERIFY_LIVENESS',
      leaseEpoch: lease.leaseEpoch,
      leaseID: lease.leaseID,
      operationID: 'operation:liveness',
      operationSequence: 1,
      owner: 'MAIN',
      processSessionID: lease.processSessionID,
      sourceVersion: sourceVersionV4,
      targetIdentityDigest: deriveTargetIdentityDigest(targetV4),
      transactionID: record.mainTransaction.transactionID,
    });

    expect(intent.requestDigest).toBe(recomputeOperationRequestDigest(intent));
    if (intent.kind !== 'VERIFY_LIVENESS') throw new Error('bad intent');
    expect(
      recomputeOperationRequestDigest({
        ...intent,
        details: { ...intent.details, force: false },
      }),
    ).not.toBe(intent.requestDigest);
  });

  it('enforces root/note single-increment revision semantics', () => {
    const next = { ...recordV4('IDLE'), revision: 8 };
    const validation = validateTransactionRecord(next, {
      previousRevision: { noteRevision: 7, rootRevision: 10 },
      rootRevision: 11,
    });
    expect(validation.valid).toBe(true);

    const skipped = validateTransactionRecord(
      { ...next, revision: 9 },
      {
        previousRevision: { noteRevision: 7, rootRevision: 10 },
        rootRevision: 12,
      },
    );
    expect(skipped.valid).toBe(false);
    if (skipped.valid) throw new Error('Expected invalid revision');
    expect(skipped.issues.map(({ code }) => code)).toContain('V18');
  });

  it('loads every note through the same central invariant validator', () => {
    const invalid = recordV4('PREPARING');
    if (!invalid.mainTransaction) throw new Error('bad fixture');
    invalid.mainTransaction.sourceManifestDigest = `${manifestDigestV4}:changed`;

    expect(() =>
      parseSyncedNotesRootV4({
        container: null,
        notes: { [targetV4.noteItemKey]: invalid },
        rootRevision: 0,
        schemaVersion: 4,
      }),
    ).toThrow(/V14/);
  });

  it('throws a structured invariant error at assertion boundaries', () => {
    expect(() =>
      assertTransactionRecord({
        ...recordV4('IDLE'),
        schemaVersion: 3,
      }),
    ).toThrow(/SCHEMA/);
  });
});
