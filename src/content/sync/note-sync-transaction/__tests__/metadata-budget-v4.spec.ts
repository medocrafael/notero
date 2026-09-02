import { describe, expect, it } from 'vite-plus/test';

import {
  MAX_CONFIRMED_CLEANUP_TOMBSTONES,
  MetadataBudgetExceededError,
  assertMetadataRootBudgetV4,
  compactRecordMetadataV4,
} from '../metadata-budget-v4';
import { ownershipFromResource } from '../schema-v4';
import type { CleanupLedgerEntry, SyncedNotesRootV4 } from '../types-v4';

import {
  candidateResourceV4,
  clockV4,
  recordV4,
  sourceDescriptorV4,
  sourceVersionV4,
  targetV4,
} from './fixtures-v4';

function entry(index: number, confirmed: boolean): CleanupLedgerEntry {
  const resource = candidateResourceV4(`cleanup-budget-${index}`);
  return {
    attemptCount: 1,
    cleanupID: `cleanup-budget-${index}`,
    createdAt: clockV4.addMs(clockV4.nowISOString(), index),
    deleteIntent: null,
    generation: index + 1,
    lastAttemptAt: clockV4.addMs(clockV4.nowISOString(), index),
    lastObservation: null,
    nextRetryAt: null,
    ownership: ownershipFromResource(resource),
    quarantineEvidenceID: null,
    reason: 'ABORTED_ATTEMPT',
    resource,
    sourceVersion: `${sourceVersionV4}:${index}`,
    state: confirmed ? 'CONFIRMED' : 'PENDING',
    transactionID: `transaction-budget-${index}`,
    updatedAt: clockV4.addMs(clockV4.nowISOString(), index),
    workerLease: null,
  };
}

describe('schema-v4 metadata budget', () => {
  it('bounds resolved tombstones without dropping any unresolved cleanup', () => {
    const unresolved = Array.from({ length: 80 }, (_value, index) =>
      entry(index, false),
    );
    const confirmed = Array.from({ length: 40 }, (_value, index) =>
      entry(100 + index, true),
    );
    const compacted = compactRecordMetadataV4({
      ...recordV4('IDLE'),
      cleanupLedger: [...unresolved, ...confirmed],
    });

    expect(
      compacted.cleanupLedger.filter(({ state }) => state !== 'CONFIRMED'),
    ).toHaveLength(unresolved.length);
    expect(
      compacted.cleanupLedger.filter(({ state }) => state === 'CONFIRMED'),
    ).toHaveLength(MAX_CONFIRMED_CLEANUP_TOMBSTONES);
  });

  it('fails explicitly before writing an over-budget root', () => {
    const record = {
      ...recordV4('IDLE'),
      requestedSource: {
        featurePolicy: 'text-only-v1' as const,
        manifestDigest: 'x'.repeat(1_000),
        observedAt: clockV4.nowISOString(),
        sourceDescriptor: sourceDescriptorV4,
        sourceVersion: sourceVersionV4,
      },
      targetIdentity: targetV4,
    };
    const root: SyncedNotesRootV4 = {
      container: null,
      notes: { [targetV4.noteItemKey]: record },
      rootRevision: 1,
      schemaVersion: 4,
    };

    expect(() => assertMetadataRootBudgetV4(root, 100)).toThrow(
      MetadataBudgetExceededError,
    );
  });
});
