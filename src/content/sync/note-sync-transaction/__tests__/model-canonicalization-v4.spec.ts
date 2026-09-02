import { describe, expect, it } from 'vite-plus/test';

import { ModelHarnessV4 } from './model-harness-v4';

describe('FSM v2 successor-relevant model canonicalization', () => {
  it('distinguishes identity generator states whose next opaque identity differs', () => {
    const left = new ModelHarnessV4();
    const right = left.fork();
    left.setFutureControlStateForTest({ identitySequence: 2 });
    right.setFutureControlStateForTest({ identitySequence: 9 });

    const leftKey = left.canonicalState();
    const rightKey = right.canonicalState();
    const leftSuccessorIdentity = left.nextGeneratedIdentityForTest();
    const rightSuccessorIdentity = right.nextGeneratedIdentityForTest();

    expect(leftSuccessorIdentity).not.toBe(rightSuccessorIdentity);
    expect(leftKey).not.toBe(rightKey);
  });

  it('distinguishes process invocation control that changes restart behavior', () => {
    const left = new ModelHarnessV4();
    const right = left.fork();
    left.setFutureControlStateForTest({ processInvocationCount: 0 });
    right.setFutureControlStateForTest({ processInvocationCount: 3 });

    expect(left.canonicalState()).not.toBe(right.canonicalState());
  });

  it('distinguishes fake remote counters whose next resource IDs differ', () => {
    const left = new ModelHarnessV4();
    const right = left.fork();
    left.server.setFutureResourceCountersForTest({
      blockCounter: 2,
      uploadCounter: 4,
    });
    right.server.setFutureResourceCountersForTest({
      blockCounter: 8,
      uploadCounter: 12,
    });

    expect(left.server.nextResourceIDsForTest()).not.toStrictEqual(
      right.server.nextResourceIDsForTest(),
    );
    expect(left.canonicalState()).not.toBe(right.canonicalState());
  });

  it('distinguishes armed disk and observation failpoints', () => {
    const plain = new ModelHarnessV4();
    const persistFailure = plain.fork();
    const observationTamper = plain.fork();
    persistFailure.disk.failNextPersist();
    observationTamper.tamperNextObservation();

    expect(persistFailure.canonicalState()).not.toBe(plain.canonicalState());
    expect(observationTamper.canonicalState()).not.toBe(plain.canonicalState());
    expect(observationTamper.canonicalState()).not.toBe(
      persistFailure.canonicalState(),
    );
  });

  it('distinguishes scheduler histories that enable different next actions', () => {
    const state = new ModelHarnessV4();

    expect(state.canonicalState(['EDIT_ACTIVE'])).not.toBe(
      state.canonicalState(['SOURCE_C']),
    );
  });
});
