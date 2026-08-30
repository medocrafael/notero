export interface RuntimeClock {
  addMs(instant: string, durationMs: number): string;
  compare(left: string, right: string): number;
  nowEpochMs(): number;
  nowISOString(): string;
  sleep(milliseconds: number): Promise<void>;
}

export class SystemRuntimeClock implements RuntimeClock {
  public addMs(instant: string, durationMs: number): string {
    return new Date(Date.parse(instant) + durationMs).toISOString();
  }

  public compare(left: string, right: string): number {
    return Math.sign(Date.parse(left) - Date.parse(right));
  }

  public nowEpochMs(): number {
    return Date.now();
  }

  public nowISOString(): string {
    return new Date(this.nowEpochMs()).toISOString();
  }

  public async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}

export const SYSTEM_RUNTIME_CLOCK: RuntimeClock = new SystemRuntimeClock();
