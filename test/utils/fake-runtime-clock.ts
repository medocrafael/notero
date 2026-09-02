import type { RuntimeClock } from '../../src/content/sync/note-sync-transaction/runtime-clock';

export class FakeRuntimeClock implements RuntimeClock {
  public readonly sleeps: number[] = [];
  private epochMilliseconds: number;

  public constructor(
    instant = '2026-08-30T00:00:00.000Z',
    private readonly advanceOnSleep = true,
  ) {
    this.epochMilliseconds = Date.parse(instant);
  }

  public addMs(instant: string, durationMs: number): string {
    return new Date(Date.parse(instant) + durationMs).toISOString();
  }

  public advance(milliseconds: number): void {
    this.epochMilliseconds += milliseconds;
  }

  public compare(left: string, right: string): number {
    return Math.sign(Date.parse(left) - Date.parse(right));
  }

  public nowEpochMs(): number {
    return this.epochMilliseconds;
  }

  public nowISOString(): string {
    return new Date(this.epochMilliseconds).toISOString();
  }

  public set(instant: string): void {
    this.epochMilliseconds = Date.parse(instant);
  }

  public async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    if (this.advanceOnSleep) this.advance(milliseconds);
  }
}
