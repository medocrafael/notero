import { canonicalJSON } from './canonical';
import type {
  CleanupLedgerEntry,
  NoteSyncRecordV4,
  SyncedNotesRootV4,
  UploadAssetRecordV4,
} from './types-v4';

export const MAX_METADATA_ROOT_BYTES_V4 = 1024 * 1024;
export const MAX_CONFIRMED_CLEANUP_TOMBSTONES = 16;
export const MAX_PERSISTED_UPLOAD_ASSETS = 64;
export const MAX_QUARANTINE_EVIDENCE = 64;

export class MetadataBudgetExceededError extends Error {
  public readonly name = 'MetadataBudgetExceededError';

  public constructor(
    public readonly actualBytes: number,
    public readonly maximumBytes: number,
  ) {
    super(
      `Notero synchronization metadata exceeds its safe budget (${actualBytes}/${maximumBytes} bytes)`,
    );
  }
}

function newest<T extends { updatedAt: string }>(values: T[]): T[] {
  return values.toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function compactCleanup(
  cleanupLedger: CleanupLedgerEntry[],
): CleanupLedgerEntry[] {
  const unresolved = cleanupLedger.filter(({ state }) => state !== 'CONFIRMED');
  const confirmed = newest(
    cleanupLedger.filter(({ state }) => state === 'CONFIRMED'),
  ).slice(-MAX_CONFIRMED_CLEANUP_TOMBSTONES);
  // Unresolved ownership evidence is never discarded to satisfy a capacity
  // target. If it alone exceeds the schema/root budget, persistence fails
  // explicitly and leaves the prior durable root intact.
  return [...unresolved, ...confirmed];
}

function compactUploads(record: NoteSyncRecordV4): UploadAssetRecordV4[] {
  const referenced = new Set([
    ...(record.active?.imageAssetIdentities ?? []),
    ...(record.mainTransaction?.candidate?.imageAssetIdentities ?? []),
  ]);
  const required = record.uploadAssets.filter(
    (asset) =>
      referenced.has(asset.assetID) ||
      [
        'CREATE_INTENDED',
        'CREATE_UNCERTAIN',
        'CREATED_UNSENT',
        'SEND_INTENDED',
        'SEND_UNCERTAIN',
        'UPLOADED',
      ].includes(asset.status),
  );
  if (required.length >= MAX_PERSISTED_UPLOAD_ASSETS) return required;
  const requiredIDs = new Set(required.map(({ assetID }) => assetID));
  const retainedHistory = record.uploadAssets
    .filter(({ assetID }) => !requiredIDs.has(assetID))
    .slice(-(MAX_PERSISTED_UPLOAD_ASSETS - required.length));
  return [...required, ...retainedHistory];
}

export function compactRecordMetadataV4(
  record: NoteSyncRecordV4,
): NoteSyncRecordV4 {
  const linkedEvidence = new Set(
    record.cleanupLedger.flatMap(({ quarantineEvidenceID }) =>
      quarantineEvidenceID ? [quarantineEvidenceID] : [],
    ),
  );
  const requiredEvidence = record.quarantineEvidence.filter(({ evidenceID }) =>
    linkedEvidence.has(evidenceID),
  );
  const requiredIDs = new Set(
    requiredEvidence.map(({ evidenceID }) => evidenceID),
  );
  const evidenceHistory = record.quarantineEvidence
    .filter(({ evidenceID }) => !requiredIDs.has(evidenceID))
    .slice(-(MAX_QUARANTINE_EVIDENCE - requiredEvidence.length));
  return {
    ...record,
    cleanupLedger: compactCleanup(record.cleanupLedger),
    quarantineEvidence:
      requiredEvidence.length > MAX_QUARANTINE_EVIDENCE
        ? requiredEvidence
        : [...requiredEvidence, ...evidenceHistory],
    uploadAssets: compactUploads(record),
  };
}

export function metadataRootByteLengthV4(root: SyncedNotesRootV4): number {
  return new TextEncoder().encode(canonicalJSON(root)).byteLength;
}

export function assertMetadataRootBudgetV4(
  root: SyncedNotesRootV4,
  maximumBytes = MAX_METADATA_ROOT_BYTES_V4,
): void {
  const actualBytes = metadataRootByteLengthV4(root);
  if (actualBytes > maximumBytes) {
    throw new MetadataBudgetExceededError(actualBytes, maximumBytes);
  }
}
