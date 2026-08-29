import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleLifecycleService } from "../src/domain/console-lifecycle.ts";

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const entries = new Map();

  const timers = {
    set(callback, delayMs) {
      const id = nextId++;
      entries.set(id, { at: now + delayMs, callback });
      return id;
    },
    clear(handle) { entries.delete(handle); }
  };

  function advance(ms) {
    const target = now + ms;
    while (true) {
      const due = [...entries.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, entry] = due;
      entries.delete(id);
      now = entry.at;
      entry.callback();
    }
    now = target;
  }

  return { timers, advance, pending: () => entries.size };
}

test("Console lifecycle grace keeps a refresh from shutting down the service", async () => {
  const fake = createFakeTimers();
  let emptyCount = 0;
  const lifecycle = createConsoleLifecycleService({
    heartbeatTtlMs: 5_000,
    emptyGraceMs: 3_000,
    timers: fake.timers,
    onEmpty: () => { emptyCount += 1; }
  });

  lifecycle.heartbeat("first-page");
  lifecycle.release("first-page");
  fake.advance(2_999);
  assert.equal(emptyCount, 0);

  lifecycle.heartbeat("refreshed-page");
  fake.advance(2_000);
  assert.equal(emptyCount, 0);

  lifecycle.release("refreshed-page");
  fake.advance(2_999);
  assert.equal(emptyCount, 0);
  fake.advance(1);
  await Promise.resolve();
  assert.equal(emptyCount, 1);
});

test("Console lifecycle remains active until every open Console tab is gone", async () => {
  const fake = createFakeTimers();
  let emptyCount = 0;
  const lifecycle = createConsoleLifecycleService({
    heartbeatTtlMs: 5_000,
    emptyGraceMs: 3_000,
    timers: fake.timers,
    onEmpty: () => { emptyCount += 1; }
  });

  lifecycle.heartbeat("tab-a");
  lifecycle.heartbeat("tab-b");
  lifecycle.release("tab-a");
  fake.advance(2_000);
  assert.equal(emptyCount, 0);

  lifecycle.heartbeat("tab-b");
  fake.advance(2_000);
  assert.equal(emptyCount, 0);

  lifecycle.release("tab-b");
  fake.advance(3_000);
  await Promise.resolve();
  assert.equal(emptyCount, 1);
});

test("Console lifecycle expires a disappeared tab when no release beacon arrives", async () => {
  const fake = createFakeTimers();
  let emptyCount = 0;
  const lifecycle = createConsoleLifecycleService({
    heartbeatTtlMs: 5_000,
    emptyGraceMs: 3_000,
    timers: fake.timers,
    onEmpty: () => { emptyCount += 1; }
  });

  lifecycle.heartbeat("crashed-tab");
  fake.advance(4_999);
  assert.equal(emptyCount, 0);
  fake.advance(1);
  assert.equal(emptyCount, 0);
  fake.advance(2_999);
  assert.equal(emptyCount, 0);
  fake.advance(1);
  await Promise.resolve();
  assert.equal(emptyCount, 1);
});

test("stopping Console lifecycle tracking cancels pending shutdown work", async () => {
  const fake = createFakeTimers();
  let emptyCount = 0;
  const lifecycle = createConsoleLifecycleService({
    heartbeatTtlMs: 5_000,
    emptyGraceMs: 3_000,
    timers: fake.timers,
    onEmpty: () => { emptyCount += 1; }
  });

  lifecycle.heartbeat("tab");
  lifecycle.release("tab");
  lifecycle.stop();
  assert.equal(fake.pending(), 0);
  fake.advance(10_000);
  await Promise.resolve();
  assert.equal(emptyCount, 0);
});
