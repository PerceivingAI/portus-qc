export function startConsoleLifecycle({
  heartbeatMs = 1_500,
  onPageHide,
  sessionId = globalThis.crypto.randomUUID(),
  fetchImpl = globalThis.fetch,
  navigatorRef = globalThis.navigator,
  windowRef = globalThis.window,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval
} = {}) {
  let heartbeatTimer;

  const pathFor = (action) => `/api/console/session/${encodeURIComponent(sessionId)}/${action}`;

  async function heartbeat() {
    try {
      await fetchImpl(pathFor("heartbeat"), { method: "POST", cache: "no-store", keepalive: true });
    } catch {
      // The local service may already be stopping; lifecycle heartbeats are best-effort.
    }
  }

  function release() {
    const path = pathFor("release");
    if (navigatorRef.sendBeacon(path)) return;
    void fetchImpl(path, { method: "POST", cache: "no-store", keepalive: true }).catch(() => undefined);
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    void heartbeat();
    heartbeatTimer = setIntervalImpl(() => { void heartbeat(); }, heartbeatMs);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearIntervalImpl(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  windowRef.addEventListener("pageshow", startHeartbeat);
  windowRef.addEventListener("pagehide", () => {
    stopHeartbeat();
    release();
    onPageHide?.();
  });
  startHeartbeat();

  return { sessionId, stop: stopHeartbeat };
}
