import { describe, expect, it } from 'vite-plus/test';

import {
  serializeNoteSyncRecord,
  validateNoteSyncRecordJSON,
  validateTransactionInvariants,
} from '../schema';

import { intent, record } from './fixtures';

describe('NoteSyncRecordV3 strict validation', () => {
  it('distinguishes JSON syntax, field, and transaction invariant failures', () => {
    expect(validateNoteSyncRecordJSON('{').validation).toBe('quarantined');

    const invalidField = validateNoteSyncRecordJSON(
      JSON.stringify({ ...record('IDLE'), state: 'free-form-stage' }),
    );
    expect(invalidField).toMatchObject({
      diagnostic: { code: 'INVALID_FIELD' },
      validation: 'quarantined',
    });

    const invalidTransaction = record('IDLE');
    invalidTransaction.transactionID = 'unexpected-transaction';
    expect(
      validateNoteSyncRecordJSON(JSON.stringify(invalidTransaction)),
    ).toMatchObject({
      diagnostic: { code: 'INVALID_TRANSACTION' },
      validation: 'quarantined',
    });
  });

  it('round-trips every main state through a complete process restart', () => {
    for (const state of [
      'IDLE',
      'PREPARING',
      'CANDIDATE_CREATING',
      'CANDIDATE_WRITING',
      'CANDIDATE_VERIFYING',
      'CANDIDATE_DURABLE',
      'ACTIVE_COMMITTED',
      'CLEANING',
      'QUARANTINED',
    ] as const) {
      const initial = record(state);
      const raw = serializeNoteSyncRecord(initial);
      const restarted = validateNoteSyncRecordJSON(raw);

      expect(restarted.validation).toBe('valid');
      if (restarted.validation !== 'valid') {
        throw new Error('Expected a valid restarted state');
      }
      expect(restarted.record).toStrictEqual(JSON.parse(raw));
    }
  });

  it('rejects Feature OFF upload state and upload operations at schema level', () => {
    const disabled = record('PREPARING', { featurePolicy: 'text-only-v1' });
    disabled.operationIntent = intent('UPLOAD_CREATE');

    expect(validateTransactionInvariants(disabled)).toContain(
      'Feature OFF forbids file-upload operations',
    );
  });

  it('rejects DELETE intent whose exact evidence differs from cleanup target', () => {
    const cleaning = record('CLEANING');
    const deleteIntent = intent('DELETE_BLOCK');
    if (deleteIntent.kind !== 'DELETE_BLOCK') {
      throw new Error('Synthetic delete intent is invalid');
    }
    cleaning.operationIntent = {
      ...deleteIntent,
      details: { ...deleteIntent.details, exactBlockID: 'different-block' },
    };

    expect(validateTransactionInvariants(cleaning)).toContain(
      'DELETE intent must exactly match current cleanup target',
    );
  });

  it('rejects active commit without durable candidate evidence', () => {
    const committed = record('ACTIVE_COMMITTED');
    if (!committed.candidate) throw new Error('Synthetic candidate is missing');
    committed.candidate = {
      ...committed.candidate,
      completionEvidence: null,
      status: 'staging',
    };

    expect(validateTransactionInvariants(committed)).toContain(
      'ACTIVE_COMMITTED must point to its durable candidate',
    );
  });
});
