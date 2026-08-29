export interface ConsoleLifecycleTimerDriver {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface ConsoleLifecycleService {
  heartbeat(sessionId: string): void;
  release(sessionId: string): void;
  stop(): void;
}

export interface ConsoleLifecycleOptions {
  heartbeatTtlMs?: number;
  emptyGraceMs?: number;
  timers?: ConsoleLifecycleTimerDriver;
  onEmpty: () => void | Promise<void>;
  onError?: (error: unknown) => void;
}

const DEFAULT_HEARTBEAT_TTL_MS = 5_000;
const DEFAULT_EMPTY_GRACE_MS = 3_000;

function defaultTimers(): ConsoleLifecycleTimerDriver {
  return {
    set(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); }
  };
}

export function createConsoleLifecycleService(options: ConsoleLifecycleOptions): ConsoleLifecycleService {
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const emptyGraceMs = options.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
  if (!Number.isInteger(heartbeatTtlMs) || heartbeatTtlMs < 1) throw new Error("heartbeatTtlMs must be a positive integer.");
  if (!Number.isInteger(emptyGraceMs) || emptyGraceMs < 0) throw new Error("emptyGraceMs must be a non-negative integer.");

  const timers = options.timers ?? defaultTimers();
  const sessions = new Map<string, unknown>();
  let emptyTimer: unknown | undefined;
  let stopped = false;
  let seenSession = false;

  function clearEmptyTimer(): void {
    if (emptyTimer !== undefined) timers.clear(emptyTimer);
    emptyTimer = undefined;
  }

  function invokeEmpty(): void {
    emptyTimer = undefined;
    if (stopped || sessions.size !== 0) return;
    Promise.resolve(options.onEmpty()).catch((error) => options.onError?.(error));
  }

  function scheduleEmpty(): void {
    if (stopped || !seenSession || sessions.size !== 0 || emptyTimer !== undefined) return;
    emptyTimer = timers.set(invokeEmpty, emptyGraceMs);
  }

  function expire(sessionId: string): void {
    sessions.delete(sessionId);
    scheduleEmpty();
  }

  function heartbeat(sessionId: string): void {
    if (stopped) return;
    seenSession = true;
    clearEmptyTimer();
    const previous = sessions.get(sessionId);
    if (previous !== undefined) timers.clear(previous);
    sessions.set(sessionId, timers.set(() => expire(sessionId), heartbeatTtlMs));
  }

  function release(sessionId: string): void {
    if (stopped) return;
    const handle = sessions.get(sessionId);
    if (handle !== undefined) timers.clear(handle);
    sessions.delete(sessionId);
    scheduleEmpty();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearEmptyTimer();
    for (const handle of sessions.values()) timers.clear(handle);
    sessions.clear();
  }

  return { heartbeat, release, stop };
}
