export interface RequestGate {
  acquire(): Promise<void>;
}

export interface FixedIntervalRequestGateOptions {
  requestsPerSecond: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Serializes request starts to a fixed maximum rate. */
export class FixedIntervalRequestGate implements RequestGate {
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #nextStartMs = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: FixedIntervalRequestGateOptions) {
    if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be a positive finite number.");
    }
    this.#intervalMs = 1000 / options.requestsPerSecond;
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  acquire(): Promise<void> {
    const reservation = this.#tail.then(async () => {
      const waitMs = Math.max(0, this.#nextStartMs - this.#now());
      if (waitMs > 0) await this.#sleep(waitMs);
      const startedAt = this.#now();
      this.#nextStartMs = Math.max(this.#nextStartMs, startedAt) + this.#intervalMs;
    });
    this.#tail = reservation.catch(() => undefined);
    return reservation;
  }
}
