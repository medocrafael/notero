const pendingNoteSyncs = new Map<string, Promise<void>>();
const noOp = () => undefined;

export async function withNoteSyncLock<T>(
  libraryID: number,
  noteItemKey: Zotero.DataObjectKey,
  operation: () => T | Promise<T>,
): Promise<T> {
  const lockKey = `${libraryID}:${noteItemKey}`;
  const previous = pendingNoteSyncs.get(lockKey);

  let release: () => void = noOp;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preceding = previous?.catch(() => undefined) || Promise.resolve();
  const tail = preceding.then(() => current);
  pendingNoteSyncs.set(lockKey, tail);

  if (previous) await preceding;

  try {
    return await operation();
  } finally {
    release();
    if (pendingNoteSyncs.get(lockKey) === tail) {
      pendingNoteSyncs.delete(lockKey);
    }
  }
}
