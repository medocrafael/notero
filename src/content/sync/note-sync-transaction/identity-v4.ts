import { canonicalJSON, digestCanonical } from './canonical';
import { UNKNOWN_REMOTE_CREATOR } from './types-v4';
import type {
  LocalConnectionIdentity,
  CanonicalSourceDescriptorV4,
  ManagedResourceIdentity,
  OperationKindV4,
  RemoteCreatorIdentity,
  RemoteCreatorExpectation,
  SealedOperationIntent,
  TargetIdentity,
  UploadAssetRecordV4,
} from './types-v4';

export function asLocalConnectionIdentity(
  value: string,
): LocalConnectionIdentity {
  if (!value) throw new Error('Local connection identity cannot be empty');
  return value as LocalConnectionIdentity;
}

export function asRemoteCreatorIdentity(value: string): RemoteCreatorIdentity {
  if (!value) throw new Error('Remote creator identity cannot be empty');
  if (value === UNKNOWN_REMOTE_CREATOR) {
    throw new Error('Remote creator identity cannot use the unknown sentinel');
  }
  return value as RemoteCreatorIdentity;
}

export function remoteCreatorExpectation(
  value: string | undefined,
): RemoteCreatorExpectation {
  return value ? asRemoteCreatorIdentity(value) : UNKNOWN_REMOTE_CREATOR;
}

export function knownRemoteCreator(
  expectation: RemoteCreatorExpectation,
): RemoteCreatorIdentity | null {
  return expectation === UNKNOWN_REMOTE_CREATOR ? null : expectation;
}

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
    | 'filename'
    | 'sourceIdentity'
    | 'targetIdentityDigest'
  >,
): string {
  return digestCanonical('notero-upload-asset-v4', {
    attachmentIdentity: asset.attachmentIdentity,
    contentHash: asset.contentHash,
    contentLength: asset.contentLength,
    contentType: asset.contentType,
    filename: asset.filename,
    sourceIdentity: asset.sourceIdentity,
    targetIdentityDigest: asset.targetIdentityDigest,
  });
}

export function deriveAssetIdentityDigest(
  asset: Parameters<typeof deriveAssetID>[0],
): string {
  return deriveAssetID(asset);
}

export function deriveFileUploadBindingDigest(
  asset: Pick<
    UploadAssetRecordV4,
    'assetIdentityDigest' | 'fileUploadID' | 'targetIdentityDigest'
  > & { fileUploadID: string },
): string {
  return digestCanonical('notero-file-upload-binding-v4', {
    assetIdentityDigest: asset.assetIdentityDigest,
    fileUploadID: asset.fileUploadID,
    targetIdentityDigest: asset.targetIdentityDigest,
  });
}

export function deriveManifestDigestV4(
  descriptor: CanonicalSourceDescriptorV4,
): string {
  return digestCanonical('notero-note-manifest-v4', descriptor);
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
