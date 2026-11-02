import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  requestCompletion,
  completeWithFallback,
  selectModel,
} from "../lib/nvidia-runtime.mjs";

const MODEL = {
  id: "example/selected-instruct",
  key: "selected",
  apiKey: "test-only-key",
  baseUrl: "https://provider.example/v1",
};
const FAST = { ...MODEL, id: "openai/gpt-oss-20b", key: "fallback" };
const MESSAGES = [{ role: "user", content: "Explain a simple concept." }];
const encoder = new TextEncoder();
const runtime = { models: [MODEL, FAST], defaultModelKey: MODEL.key };
const clock = (t) =>
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: 1_800_000_000_000,
  });
const observe = (promise) => {
  const result = { settled: false };
  result.done = promise.then(
    (value) => {
      Object.assign(result, { settled: true, value });
    },
    (error) => {
      Object.assign(result, { settled: true, error });
    },
  );
  return result;
};
function stream() {
  let controller;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const write = (text) => {
    if (!cancelled) controller.enqueue(encoder.encode(text));
  };
  const event = (value) => write(`data: ${JSON.stringify(value)}\n\n`);
  return {
    response,
    get cancelled() {
      return cancelled;
    },
    token: (content) => event({ choices: [{ delta: { content } }] }),
    reasoning: () =>
      event({
        choices: [{ delta: { reasoning_content: "PRIVATE REASONING" } }],
      }),
    heartbeat: () => write(": still-connected\n\n"),
    // Intentionally leave the socket open. finish_reason itself is terminal.
    finish: (reason = "stop", content = "") =>
      event({ choices: [{ delta: { content }, finish_reason: reason }] }),
    done: () => write("data: [DONE]\n\n"),
  };
}
const options = () => ({
  stream: true,
  timeoutMs: 45000,
  idleTimeoutMs: 20000,
  deadline: Date.now() + 110000,
});

test(
  "a terminal finish_reason completes the reply without waiting for DONE or socket close",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        { ...options(), signal: controller.signal },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    upstream.token("A complete ");
    upstream.finish("stop", "answer.");
    await nextTurn();
    assert.equal(
      result.settled,
      true,
      "A complete provider answer must not turn into a timeout while waiting for transport EOF",
    );
    assert.equal(result.error, undefined);
    assert.equal(result.value.content, "A complete answer.");
    assert.equal(upstream.cancelled, true);
  },
);

test(
  "the first-answer window is separate from the inter-token idle limit",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        { ...options(), signal: controller.signal },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    // Provider headers can arrive immediately, before cold-start/prefill finishes.
    t.mock.timers.tick(25000);
    await nextTurn();
    assert.equal(
      result.settled,
      false,
      "Do not apply the 20s inter-token timer before any answer token exists",
    );
    upstream.token("The first visible answer");
    upstream.done();
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value.content, "The first visible answer");
  },
);

test(
  "an actively writing selected model survives its 45s startup cap without restarting the answer",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const calls = [];
    const result = observe(
      completeWithFallback(
        runtime,
        selectModel(runtime),
        MESSAGES,
        { ...options(), signal: controller.signal },
        async (_url, request) => {
          const id = JSON.parse(request.body).model;
          calls.push(id);
          return id === MODEL.id
            ? upstream.response
            : Response.json({
                choices: [{ message: { content: "Unexpected fallback" } }],
              });
        },
      ),
    );
    await nextTurn();
    upstream.token("Writing");
    await nextTurn();
    for (let index = 0; index < 7; index++) {
      t.mock.timers.tick(10000);
      upstream.token(" more");
      await nextTurn();
    }
    assert.deepEqual(
      calls,
      [MODEL.id],
      "Healthy token progress must not trigger a new model at 45 seconds",
    );
    upstream.done();
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value.content, "Writing" + " more".repeat(7));
    assert.equal(result.value.modelFallbackUsed, false);
  },
);

test(
  "headers and heartbeat comments cannot keep a genuinely stalled answer alive",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        { ...options(), signal: controller.signal },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    upstream.token("Partial answer");
    await nextTurn();
    t.mock.timers.tick(15000);
    upstream.heartbeat();
    await nextTurn();
    t.mock.timers.tick(5001);
    await nextTurn();
    assert.equal(
      result.settled,
      true,
      "Only answer-token progress should refresh the inter-token timer",
    );
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.timeoutPhase, "idle");
    assert.equal(upstream.cancelled, true);
  },
);

test(
  "reasoning-only progress still has a bounded first-visible-answer window and remains private",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const deltas = [];
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        {
          ...options(),
          signal: controller.signal,
          onDelta: (text) => deltas.push(text),
        },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    for (let index = 0; index < 4; index++) {
      t.mock.timers.tick(10000);
      upstream.reasoning();
      await nextTurn();
    }
    t.mock.timers.tick(5001);
    await nextTurn();
    assert.equal(result.settled, true);
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.timeoutPhase, "first_token");
    assert.deepEqual(deltas, []);
  },
);

test(
  "streaming negotiation and buffered compatibility share one attempt budget",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const rejectStream = Promise.withResolvers();
    const signals = [];
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        { ...options(), signal: controller.signal },
        async (_url, request) => {
          signals.push(request.signal);
          if (JSON.parse(request.body).stream) return rejectStream.promise;
          return new Promise((_resolve, reject) =>
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            ),
          );
        },
      ),
    );
    await nextTurn();
    t.mock.timers.tick(40000);
    rejectStream.resolve(Response.json({}, { status: 400 }));
    await nextTurn();
    assert.equal(signals.length, 2);
    t.mock.timers.tick(5001);
    await nextTurn();
    assert.equal(
      result.settled,
      true,
      "A 400/422 must not restart a fresh 45s timer for the JSON retry",
    );
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.timeoutPhase, "first_token");
    assert.equal(signals[1].aborted, true);
  },
);

test(
  "steady progress never extends the overall generation deadline",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const result = observe(
      requestCompletion(
        MODEL,
        MESSAGES,
        {
          ...options(),
          signal: controller.signal,
          deadline: Date.now() + 50000,
        },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    upstream.token("Answer");
    await nextTurn();
    for (let index = 0; index < 4; index++) {
      t.mock.timers.tick(10000);
      upstream.token(" continues");
      await nextTurn();
    }
    t.mock.timers.tick(10001);
    await nextTurn();
    assert.equal(result.settled, true);
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.timeoutPhase, "deadline");
    assert.equal(upstream.cancelled, true);
  },
);

test(
  "a first-answer timeout falls back with bounded, secret-free per-attempt diagnostics",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const diagnostics = [],
      models = [];
    const result = observe(
      completeWithFallback(
        runtime,
        selectModel(runtime),
        MESSAGES,
        {
          ...options(),
          onAttemptFailure: (failure) => diagnostics.push(failure),
        },
        async (_url, request) => {
          const model = JSON.parse(request.body).model;
          models.push(model);
          return model === MODEL.id
            ? upstream.response
            : Response.json({
                choices: [{ message: { content: "Recovered answer" } }],
              });
        },
      ),
    );
    await nextTurn();
    t.mock.timers.tick(45001);
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value.model, FAST.id);
    assert.equal(result.value.modelFallbackUsed, true);
    assert.deepEqual(models, [MODEL.id, FAST.id]);
    assert.equal(upstream.cancelled, true);
    assert.deepEqual(diagnostics, [
      {
        model: MODEL.id,
        code: "timeout",
        status: 504,
        durationMs: 45001,
        timeoutPhase: "first_token",
      },
    ]);
    assert.deepEqual(result.value.failures, diagnostics);
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /test-only-key|provider\.example|Explain a simple concept/,
    );
  },
);

test(
  "the final streaming candidate can wait for its first answer within the remaining overall budget",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const onlyModel = { models: [MODEL], defaultModelKey: MODEL.key };
    const result = observe(
      completeWithFallback(
        onlyModel,
        selectModel(onlyModel),
        MESSAGES,
        { ...options(), signal: controller.signal },
        async () => upstream.response,
      ),
    );
    await nextTurn();
    t.mock.timers.tick(70000);
    await nextTurn();
    assert.equal(result.settled, false);
    upstream.finish("stop", "Cold model's complete answer.");
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value.content, "Cold model's complete answer.");
  },
);

test(
  "chat still has bounded fallback when every other historic preferred model has left the catalog",
  { timeout: 2000 },
  async (t) => {
    clock(t);
    const upstream = stream();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const alternate = {
      ...MODEL,
      id: "mistralai/mistral-7b-instruct-v0.3",
      key: "alternate",
    };
    const current = { models: [FAST, alternate], defaultModelKey: FAST.key };
    const calls = [];
    const result = observe(
      completeWithFallback(
        current,
        selectModel(current),
        MESSAGES,
        { ...options(), catalogFallback: true, signal: controller.signal },
        async (_url, request) => {
          const id = JSON.parse(request.body).model;
          calls.push(id);
          return id === FAST.id
            ? upstream.response
            : Response.json({
                choices: [
                  {
                    message: {
                      content: "A genuine answer from an active alternative",
                    },
                  },
                ],
              });
        },
      ),
    );
    await nextTurn();
    t.mock.timers.tick(45001);
    await nextTurn();
    assert.deepEqual(
      calls,
      [FAST.id, alternate.id],
      "A retired hard-coded fallback list must not leave a stalled model with the whole 110s budget",
    );
    await result.done;
    assert.equal(result.error, undefined);
    assert.equal(result.value.model, alternate.id);
    assert.equal(result.value.modelFallbackUsed, true);
    assert.equal(upstream.cancelled, true);
  },
);

test("catalog fallback is chat-only, deduplicated, and capped at three actual catalog models", async () => {
  const current = {
    models: [
      FAST,
      ...["alpha", "beta", "gamma", "delta"].map((id) => ({
        ...MODEL,
        id: `example/${id}-instruct`,
      })),
    ],
    defaultModelKey: FAST.key,
  };
  const calls = [];
  const fetch = async (_url, request) => {
    calls.push(JSON.parse(request.body).model);
    return Response.json({}, { status: 503 });
  };
  await assert.rejects(
    completeWithFallback(current, selectModel(current), MESSAGES, {}, fetch),
  );
  assert.deepEqual(
    calls,
    [FAST.id],
    "Analysis keeps the existing candidate policy unless explicitly opted in",
  );
  calls.length = 0;
  await assert.rejects(
    completeWithFallback(
      current,
      selectModel(current),
      MESSAGES,
      { catalogFallback: true },
      fetch,
    ),
  );
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  assert.ok(
    calls.every((id) => current.models.some((model) => model.id === id)),
  );
});
