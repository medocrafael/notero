import type { OperationIntent } from './types';

export type TransactionEffect =
  | { type: 'NONE' }
  | { intent: OperationIntent; type: 'EXECUTE_REMOTE_OPERATION' }
  | { intent: OperationIntent; type: 'OBSERVE_REMOTE_OPERATION' };
