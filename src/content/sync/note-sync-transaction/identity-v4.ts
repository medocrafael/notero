import { canonicalJSON, digestCanonical } from './canonical';
import type {
  ManagedResourceIdentity,
  OperationKindV4,
  SealedOperationIntent,
  TargetIdentity,
  UploadAssetRecordV4,
} from './types-v4';

export type UnsealedOperationIntent = {
  [Kind in OperationKindV4]: Omit<
    Extract<SealedOperationIntent, { kind: Kind }>,
    'requestDigest' | 'status'
  >;
}[OperationKindV4];

export function deriveTargetIdentityDigest(target: TargetIdentity): string {
  return digestCanonical('notero-target-v4', target);
}

export function deriveContainerTargetDigest(target: TargetIdentity): string {
  const { noteItemKey: _noteItemKey, ...containerTarget } = target;
  return digestCanonical('notero-container-target-v4', containerTarget);
}

export function deriveAssetID(
  asset: Pick<
    UploadAssetRecordV4,
    | 'attachmentIdentity'
    | 'contentHash'
    | 'contentLength'
    | 'contentType'
    | 'sourceIdentity'
    | 'targetIdentityDigest'
  >,
): string {
  return digestCanonical('notero-upload-asset-v4', asset);
}

export function deriveOperationRequestDigest(
  intent: UnsealedOperationIntent,
): string {
  return digestCanonical('notero-operation-v4', intent);
}

export function recomputeOperationRequestDigest(
  intent: SealedOperationIntent,
): string {
  const { requestDigest: _requestDigest, status: _status, ...request } = intent;
  return deriveOperationRequestDigest(request);
}

export function sameResourceIdentity(
  left: ManagedResourceIdentity | null,
  right: ManagedResourceIdentity | null,
): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}

export function isMainOperationKind(kind: OperationKindV4): boolean {
  return kind !== 'DELETE_BLOCK';
}
