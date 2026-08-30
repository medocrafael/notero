import type {
  MutationAuthorization,
  RemoteObservation,
  RemoteVerificationState,
  RunHalt,
  SealedOperationIntent,
  SealedQuarantineEvidence,
} from './types-v4';

export type RemoteObservedResultV4 = {
  observation: RemoteObservation;
  type: 'OBSERVED';
  verification?: RemoteVerificationState;
};

export type RemoteOperationResultV4 =
  | RemoteObservedResultV4
  | {
      responseClassification: string;
      type: 'PROVEN_UNEXECUTED';
    }
  | {
      classification: RunHalt['classification'];
      proof: RunHalt['proof'];
      redactedMessage: string;
      responseClassification: string;
      type: 'REJECTED';
    }
  | {
      lastObservation: RemoteObservation | null;
      reasonCode: string;
      redactedMessage: string;
      requiredRepair: SealedQuarantineEvidence['requiredRepair'];
      responseClassification: string;
      type: 'UNCERTAIN';
    };

export type RemoteOperationAdapterV4 = {
  execute: (
    authorization: MutationAuthorization,
  ) => Promise<RemoteOperationResultV4>;
  observe: (intent: SealedOperationIntent) => Promise<RemoteOperationResultV4>;
};
