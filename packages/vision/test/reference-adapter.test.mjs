import assert from "node:assert/strict";
import test from "node:test";
import { prepareInferenceImage } from "../../media/src/index.ts";
import { FixedIntervalRequestGate, MoondreamVisionProvider, MoondreamVisualClassifier, VisionProviderError, VisualClassifierError } from "../src/index.ts";

const source = { sourceId: "fixture", receivedAt: "2026-08-27T18:00:00Z" };
function image(mimeType = "image/jpeg", bytes = new Uint8Array([1, 2, 3])) {
  return prepareInferenceImage({ id: "frame-1", bytes, mimeType, width: 10, height: 10, orientationNormalized: true, source });
}

const nativePayloads = {
  query: { request_id: "req-query", answer: "  red apples  " },
  caption: { request_id: "req-caption", caption: "  Apples on a conveyor.  " },
  detect: { request_id: "req-detect", objects: [{ x_min: 0.1, y_min: 0.2, x_max: 0.4, y_max: 0.6 }] },
  point: { request_id: "req-point", points: [{ x: 0.25, y: 0.75 }] },
  segment: { request_id: "req-segment", path: " M 0 0 L 1 1 ", bbox: { x_min: 0.05, y_min: 0.1, x_max: 0.8, y_max: 0.9 } }
};

const normalizedResults = {
  query: { capability: "query", text: "red apples" },
  caption: { capability: "caption", text: "Apples on a conveyor." },
  detect: { capability: "detect", boxes: [{ xMin: 0.1, yMin: 0.2, xMax: 0.4, yMax: 0.6 }] },
  point: { capability: "point", points: [{ x: 0.25, y: 0.75 }] },
  segment: { capability: "segment", regions: [{ path: "M 0 0 L 1 1", bbox: { xMin: 0.05, yMin: 0.1, xMax: 0.8, yMax: 0.9 } }] }
};

test("Moondream validates and normalizes all five native skill responses", async () => {
  const bodies = new Map();
  const provider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    fetchImpl: async (input, init) => {
      const capability = new URL(String(input)).pathname.split("/").at(-1);
      bodies.set(capability, JSON.parse(String(init.body)));
      return new Response(JSON.stringify(nativePayloads[capability]), { status: 200 });
    }
  });

  for (const capability of ["query", "caption", "detect", "point", "segment"]) {
    const response = await provider.execute({ capability, image: image(), prompt: "find blemishes on the apples" });
    assert.deepEqual(response.result, normalizedResults[capability]);
    assert.equal(response.capability, capability);
    assert.equal(response.requestId, `req-${capability}`);
  }

  assert.equal(bodies.get("query").question, "find blemishes on the apples");
  assert.equal(bodies.get("detect").object, "find blemishes on the apples");
  assert.equal(bodies.get("point").object, "find blemishes on the apples");
  assert.equal(bodies.get("segment").object, "find blemishes on the apples");
  assert.equal("question" in bodies.get("caption"), false);
  assert.equal("object" in bodies.get("caption"), false);
  assert.equal(bodies.get("caption").length, "normal");
});

test("Moondream rejects malformed native capability payloads instead of leaking raw JSON", async () => {
  const invalid = {
    query: { answer: "   " },
    caption: { caption: 42 },
    detect: { objects: [{ x_min: 0.1, y_min: 0.2, x_max: 1.2, y_max: 0.6 }] },
    point: { points: [{ x: -0.1, y: 0.5 }] },
    segment: { path: "M 0 0", bbox: { x_min: 0.8, y_min: 0.1, x_max: 0.2, y_max: 0.9 } }
  };

  for (const capability of ["query", "caption", "detect", "point", "segment"]) {
    const provider = new MoondreamVisionProvider({
      apiKey: "test",
      model: "moondream3.1-9B-A2B",
      fetchImpl: async () => new Response(JSON.stringify(invalid[capability]), { status: 200 })
    });
    await assert.rejects(
      provider.execute({ capability, image: image(), prompt: "blemish" }),
      (error) => error instanceof VisionProviderError && error.code === "invalid_response"
    );
  }

  const zeroAreaProvider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    fetchImpl: async () => new Response(JSON.stringify({ objects: [{ x_min: 0.2, y_min: 0.2, x_max: 0.2, y_max: 0.5 }] }), { status: 200 })
  });
  await assert.rejects(
    zeroAreaProvider.execute({ capability: "detect", image: image(), prompt: "blemish" }),
    (error) => error instanceof VisionProviderError && error.code === "invalid_response"
  );
});

test("Moondream preserves numeric metrics as usage metadata", async () => {
  const provider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    fetchImpl: async () => new Response(JSON.stringify({ request_id: "req-1", caption: "ok", metrics: { input_tokens: 10, output_tokens: 2, ignored: "x" } }), { status: 200 })
  });
  const response = await provider.execute({ capability: "caption", image: image(), prompt: "ignored by native caption" });
  assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 2 });
  assert.deepEqual(response.result, { capability: "caption", text: "ok" });
});

test("Moondream rejects unsupported WebP before transport", async () => {
  const provider = new MoondreamVisionProvider({ apiKey: "test", model: "moondream3.1-9B-A2B", fetchImpl: async () => { throw new Error("must not call"); } });
  await assert.rejects(
    provider.execute({ capability: "detect", image: image("image/webp"), prompt: "reference object" }),
    (error) => error instanceof VisionProviderError && error.code === "unsupported_media"
  );
});

test("Moondream retries retryable HTTP responses and succeeds", async () => {
  let calls = 0;
  const provider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    maxAttempts: 2,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { code: "busy" } }), { status: 503, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ request_id: "req-2", objects: [] }), { status: 200 });
    }
  });
  const response = await provider.execute({ capability: "detect", image: image(), prompt: "reference object" });
  assert.equal(calls, 2);
  assert.equal(response.requestId, "req-2");
  assert.deepEqual(response.result, { capability: "detect", boxes: [] });
});

test("Moondream chat classifier uses deterministic visual classification settings and never returns reasoning", async () => {
  let captured;
  const classifier = new MoondreamVisualClassifier({
    apiKey: "test-secret",
    model: "moondream3.1-9B-A2B",
    fetchImpl: async (input, init) => {
      captured = { url: String(input), headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({
        id: "chat-1",
        choices: [{ message: { content: "  WARNING  ", reasoning: "private model reasoning must not escape" } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      }), { status: 200 });
    }
  });

  const response = await classifier.classify({
    image: image(),
    question: "Judge only image focus.",
    labels: ["ok", "warning", "fix-required"]
  });

  assert.equal(captured.url, "https://api.moondream.ai/v1/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer test-secret");
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.reasoning, true);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_completion_tokens, 256);
  assert.match(captured.body.messages[0].content[0].text, /exactly one/u);
  assert.match(captured.body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/u);
  assert.deepEqual(response, {
    label: "warning",
    provider: "moondream",
    model: "moondream3.1-9B-A2B",
    requestId: "chat-1",
    durationMs: response.durationMs,
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
  });
  assert.equal(JSON.stringify(response).includes("private model reasoning"), false);
});

test("Moondream chat classifier rejects output outside the exact allowed vocabulary", async () => {
  for (const content of ["yes", "ok.", "```ok```", "", null]) {
    const classifier = new MoondreamVisualClassifier({
      apiKey: "test",
      model: "moondream3.1-9B-A2B",
      maxAttempts: 1,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
    });
    await assert.rejects(
      classifier.classify({ image: image(), question: "Judge focus.", labels: ["ok", "warning", "fix-required"] }),
      (error) => error instanceof VisualClassifierError && error.code === "invalid_response"
    );
  }
});

test("fixed interval request gate bounds request starts without provider-specific state", async () => {
  let clock = 1_000;
  const waits = [];
  const gate = new FixedIntervalRequestGate({
    requestsPerSecond: 2,
    now: () => clock,
    sleep: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; }
  });
  await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
  assert.deepEqual(waits, [500, 500]);
});

test("native provider and classifier both honor an injected shared request gate", async () => {
  let acquisitions = 0;
  const requestGate = { acquire: async () => { acquisitions += 1; } };
  const provider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    requestGate,
    fetchImpl: async () => new Response(JSON.stringify({ answer: "ok" }), { status: 200 })
  });
  const classifier = new MoondreamVisualClassifier({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    requestGate,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  });
  await provider.execute({ capability: "query", image: image(), prompt: "What is visible?" });
  await classifier.classify({ image: image(), question: "Judge focus.", labels: ["ok", "warning", "fix-required"] });
  assert.equal(acquisitions, 2);
});

test("Moondream does not retry non-retryable authentication failures", async () => {
  let calls = 0;
  const provider = new MoondreamVisionProvider({
    apiKey: "test",
    model: "moondream3.1-9B-A2B",
    maxAttempts: 3,
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }); }
  });
  await assert.rejects(provider.execute({ capability: "query", image: image(), prompt: "what is visible?" }), VisionProviderError);
  assert.equal(calls, 1);
});
