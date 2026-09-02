import { describe, expect, it } from 'vite-plus/test';

import { withNoteSyncLock } from '../note-sync-lock';

describe('withNoteSyncLock', () => {
  it('serializes overlapping work for the same library and note', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withNoteSyncLock(1, 'NOTE', async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
    });
    const second = withNoteSyncLock(1, 'NOTE', () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toStrictEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toStrictEqual(['first-start', 'first-end', 'second']);
  });

  it('allows different libraries or notes to proceed independently', async () => {
    const events: string[] = [];

    await Promise.all([
      withNoteSyncLock(1, 'NOTE-A', () => {
        events.push('a');
      }),
      withNoteSyncLock(2, 'NOTE-A', () => {
        events.push('library-b');
      }),
      withNoteSyncLock(1, 'NOTE-B', () => {
        events.push('note-b');
      }),
    ]);

    expect(events.toSorted()).toStrictEqual(['a', 'library-b', 'note-b']);
  });
});
