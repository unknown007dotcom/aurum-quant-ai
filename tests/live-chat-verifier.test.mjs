import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  verifyChatStreaming,
  withPackagedChat,
} = require("../tools/verify-live-chat-stream.cjs");
const model = "openai/gpt-oss-20b";
const configuration = {
  configured: true,
  defaultModelKey: "fast",
  models: [{ id: model, key: "fast" }],
};
const event = (type, value) =>
  `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const answer =
  event("start", { model }) +
  event("delta", { text: "Keep a list. " }) +
  event("delta", { text: "Sort it by topic and choose one book." }) +
  event("done", {
    model,
    content: "Keep a list. Sort it by topic and choose one book.",
  });
const stream = (text) =>
  new Response(text, { headers: { "Content-Type": "text/event-stream" } });

test("the opt-in live verifier exercises only chat, validates real stream events and emits safe metrics", async () => {
  const emitted = [],
    posts = [];
  const report = await verifyChatStreaming({
    origin: "https://app.example/chat.html",
    emit: (entry) => emitted.push(entry),
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://app.example/api/chat");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      if (options.method !== "POST") return Response.json(configuration);
      const body = JSON.parse(options.body);
      posts.push(body);
      assert.equal(body.stream, true);
      assert.equal(body.settings.marketContext, false);
      assert.equal(body.settings.temperature, 0);
      assert.match(body.messages[0].content, /CHAT_[a-z0-9]+/);
      assert.equal(Object.hasOwn(options.headers, "Authorization"), false);
      return stream(answer);
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.tradesExecuted, false);
  assert.deepEqual(
    posts.map((post) => post.modelKey),
    ["", "fast"],
  );
  for (const entry of report.records.slice(1)) {
    assert.equal(entry.deltaCount, 2);
    assert.equal(entry.stream, true);
    assert.ok(Number.isFinite(entry.firstTextMs));
    assert.ok(entry.visibleChars > 20);
    assert.equal(entry.model, model);
  }
  assert.equal(
    emitted.filter((entry) => entry.stage === "first-text").length,
    2,
  );
});

test("the live verifier distinguishes phase-specific errors, dropped streams and non-streaming replies from success", async () => {
  for (const response of [
    () =>
      stream(
        event("error", {
          code: "timeout",
          timeoutPhase: "first_token",
          message: "PRIVATE ERROR DETAIL",
        }),
      ),
    () => stream(event("delta", { text: "Incomplete answer" })),
    () =>
      Response.json({
        content: "A completed but buffered answer without any streamed text.",
      }),
  ]) {
    const emitted = [];
    const report = await verifyChatStreaming({
      origin: "https://app.example",
      emit: (entry) => emitted.push(entry),
      fetchImpl: async (_url, options) =>
        options.method === "POST" ? response() : Response.json(configuration),
    });
    assert.equal(report.ok, false);
    assert.equal(
      report.records.length,
      3,
      "Failure must not prevent an explicit fast-model diagnostic",
    );
    assert.equal(report.records[1].ok, false);
    assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE ERROR DETAIL/);
  }
});

test("the live verifier does not send completions when configuration is unavailable", async () => {
  let requests = 0;
  const report = await verifyChatStreaming({
    origin: "https://app.example",
    emit() {},
    fetchImpl: async (_url, options) => {
      requests++;
      assert.notEqual(options.method, "POST");
      return Response.json({ configured: false });
    },
  });
  assert.equal(report.ok, false);
  assert.equal(requests, 1);
});

test(
  "packaged verification uses HTTP streaming without exposing unrelated API routes",
  { timeout: 5000 },
  async () => {
    let calls = 0;
    await withPackagedChat(
      async (req, res) => {
        calls++;
        if (req.method === "GET") return res.status(200).json(configuration);
        assert.equal(req.body.stream, true);
        res.setHeader("Content-Type", "text/event-stream");
        res.end(answer);
      },
      async (origin) => {
        const blocked = await fetch(origin + "/api/bot", { method: "POST" });
        assert.equal(blocked.status, 404);
        const report = await verifyChatStreaming({ origin, emit() {} });
        assert.equal(report.ok, true);
      },
    );
    assert.equal(calls, 3);
  },
);

test("explicit live model diagnostics are capped and never send a model missing from the catalog", async () => {
  const selected = [];
  const report = await verifyChatStreaming({
    origin: "https://app.example",
    emit() {},
    modelIds: ["missing/model", model],
    requestTimeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      if (options.method !== "POST") return Response.json(configuration);
      selected.push(JSON.parse(options.body).modelKey);
      return stream(answer);
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.records[1].code, "model_unavailable");
  assert.equal(report.records[2].ok, true);
  assert.deepEqual(selected, ["fast"]);
});

test("live verification still exercises a legacy saved selection when Chat no longer enables GPT-OSS", async () => {
  const active = "example/active-instruct";
  for (const recovers of [true, false]) {
    const requests = [];
    const report = await verifyChatStreaming({
      origin: "https://app.example",
      emit() {},
      fetchImpl: async (_url, options) => {
        if (options.method !== "POST")
          return Response.json({
            configured: true,
            defaultModelKey: active,
            models: [{ key: active, id: active }],
          });
        const body = JSON.parse(options.body);
        requests.push(body.modelKey);
        const recovered = Boolean(body.modelKey) && recovers;
        return stream(
          event("start", { model: active, modelFallbackUsed: recovered }) +
            event("delta", {
              text: "A real answer from the configured replacement model.",
            }) +
            event("done", {
              model: active,
              modelFallbackUsed: recovered,
              content: "A real answer from the configured replacement model.",
            }),
        );
      },
    });
    assert.deepEqual(requests, ["", "gpt-oss-default"]);
    assert.equal(report.records[2].recoveryExpected, true);
    assert.equal(
      report.ok,
      recovers,
      "A silently lost legacy-selection recovery must fail verification",
    );
  }
});
