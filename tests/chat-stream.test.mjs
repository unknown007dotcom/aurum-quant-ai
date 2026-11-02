import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import { readEventStream, readChatResponse } from "../modules/chat-stream.mjs";
import { completeChat, validateChatRequest } from "../lib/chat-service.mjs";
import { createChatStream, CHAT_STREAM_HEADERS } from "../lib/chat-stream.mjs";
import worker from "../cloudflare-backend/src/index.js";

const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);
const encoder = new TextEncoder();
const model = "example/test-instruct";
const fallbackModel = "openai/gpt-oss-20b";
const settings = {
  globalNvidiaApiKey: "test-private-key",
  nvidiaModels: [{ id: model, key: model }],
  defaultModelKey: model,
};
const input = {
  stream: true,
  messages: [{ role: "user", content: "Explain a simple comparison." }],
  settings: { marketContext: false },
};
const sse = (text) => new Response(text, { headers: CHAT_STREAM_HEADERS });
const event = (name, payload) =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
const providerEvent = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const provider =
  (respond, models = [model]) =>
  async (url, options) => {
    if (url.endsWith("/models"))
      return Response.json({ data: models.map((id) => ({ id })) });
    assert.ok(url.endsWith("/chat/completions"), "No unrelated network calls");
    return respond(JSON.parse(options.body), options);
  };
function controlledStream() {
  let controller;
  let closed = false;
  const cancelled = Promise.withResolvers();
  const response = sse(
    new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        closed = true;
        cancelled.resolve();
      },
    }),
  );
  const raw = (text) => {
    if (!closed) controller.enqueue(encoder.encode(text));
  };
  const close = () => {
    if (!closed) {
      closed = true;
      controller.close();
    }
  };
  return {
    response,
    raw,
    close,
    cancelled: cancelled.promise,
    delta: (text) =>
      raw(providerEvent({ choices: [{ delta: { content: text } }] })),
    finish: () => {
      raw(
        providerEvent({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      );
      close();
    },
  };
}

test("SSE parser handles one-byte UTF-8 chunks, CRLF, comments and multiline data", async () => {
  const bytes = encoder.encode(
    ': keep-alive\r\n\r\nevent: delta\r\ndata: {"text":\r\ndata: "नमस्ते 🪙 ₹"}\r\n\r\nevent: done\ndata: {}\n\n',
  );
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readEventStream(body)) frames.push(frame);
  assert.deepEqual(frames, [
    { event: "delta", data: '{"text":\n"नमस्ते 🪙 ₹"}' },
    { event: "done", data: "{}" },
  ]);
});

test("SSE cancellation interrupts a blocked reader and releases its lock", async () => {
  const stream = controlledStream();
  const abort = new AbortController();
  const read = (async () => {
    for await (const _ of readEventStream(stream.response.body, {
      signal: abort.signal,
    })) {
    }
  })();
  abort.abort();
  await assert.rejects(read, { name: "AbortError" });
  await stream.cancelled;
  assert.equal(stream.response.body.locked, false);
});

test("SSE reader bounds malformed/oversized events", async () => {
  await assert.rejects(async () => {
    for await (const _ of readEventStream(
      sse("data: " + "x".repeat(300000)).body,
    )) {
    }
  }, /too large/);
});

test("browser reader exposes deltas before completion and uses authoritative final metadata", async () => {
  const stream = controlledStream();
  const received = Promise.withResolvers();
  const events = [];
  let completed = false;
  const result = readChatResponse(stream.response, (value) => {
    events.push(value);
    if (value.type === "delta") received.resolve();
  }).then((value) => {
    completed = true;
    return value;
  });
  stream.raw(
    event("start", { model }) + event("delta", { text: "First words " }),
  );
  await received.promise;
  assert.equal(
    completed,
    false,
    "No artificial typewriter after buffering the full response",
  );
  assert.equal(events.at(-1).text, "First words ");
  const market = { provider: "OANDA", readOnly: true };
  stream.raw(
    event("delta", { text: "arrive." }) +
      event("done", { content: "First words arrive.", model, market }),
  );
  stream.close();
  assert.deepEqual(await result, {
    content: "First words arrive.",
    model,
    market,
  });
});

test("browser reader rejects dropped/malformed streams and safe error events, not a false success", async () => {
  for (const text of [
    event("delta", { text: "Only half" }),
    "event: delta\ndata: broken JSON\n\n",
    event("delta", { text: 4 }),
    event("done", { content: " " }),
    event("error", { message: "Try another model." }),
  ])
    await assert.rejects(readChatResponse(sse(text)), Error);
  await assert.rejects(
    readChatResponse(
      Response.json({ message: "Unavailable" }, { status: 503 }),
    ),
    /Unavailable/,
  );
});

test("browser reader keeps legacy JSON compatibility and caps public text size", async () => {
  assert.deepEqual(
    await readChatResponse(Response.json({ content: "Old deployment", model })),
    { content: "Old deployment", model },
  );
  let size = 0;
  const text = "x".repeat(32000);
  const result = await readChatResponse(
    sse(
      event("delta", { text: text + "extra" }) +
        event("delta", { text: "more" }) +
        event("done", { content: text + "extra", model }),
    ),
    (value) => {
      size += value.text?.length || 0;
    },
  );
  assert.equal(size, 32000);
  assert.equal(result.content.length, 32000);
});

test("chat service forwards visible provider deltas immediately, never reasoning or tool calls", async () => {
  const stream = controlledStream();
  const started = Promise.withResolvers();
  const received = Promise.withResolvers();
  const events = [];
  const fetch = provider((_body) => {
    started.resolve();
    return stream.response;
  });
  let completed = false;
  const result = completeChat(input, settings, {}, fetch, {
    onEvent(value) {
      events.push(value);
      if (value.type === "delta") received.resolve();
    },
  }).then((reply) => {
    completed = true;
    return reply;
  });
  await started.promise;
  stream.raw(
    providerEvent({
      choices: [
        {
          delta: {
            reasoning_content: "PRIVATE REASONING",
            tool_calls: [{ arguments: "PRIVATE TOOL" }],
          },
        },
      ],
    }),
  );
  stream.delta("A useful ");
  await received.promise;
  assert.equal(completed, false);
  assert.deepEqual(events, [
    { type: "start", model, modelFallbackUsed: false },
    { type: "delta", text: "A useful " },
  ]);
  stream.raw(
    providerEvent({
      choices: [{ delta: { content: [{ type: "text", text: "answer." }] } }],
    }),
  );
  stream.finish();
  assert.equal((await result).content, "A useful answer.");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test("fallback resets a failed partial answer before emitting a different model's response", async () => {
  const fetch = provider(
    (body) =>
      body.model === model
        ? sse(
            providerEvent({
              choices: [{ delta: { content: "Failed draft" } }],
            }),
          ) // no completion marker
        : sse(
            providerEvent({
              choices: [{ delta: { content: "Replacement answer" } }],
            }) + "data: [DONE]\n\n",
          ),
    [model, fallbackModel],
  );
  const events = [];
  let visible = "";
  const reply = await readChatResponse(
    new Response(createChatStream(input, settings, {}, fetch), {
      headers: CHAT_STREAM_HEADERS,
    }),
    (value) => {
      events.push(value);
      if (value.type === "start") visible = "";
      else visible += value.text;
    },
  );
  assert.equal(visible, "Replacement answer");
  assert.equal(reply.content, visible);
  assert.equal(reply.model, fallbackModel);
  assert.equal(reply.modelFallbackUsed, true);
  assert.deepEqual(
    events.map((value) => value.type),
    ["start", "delta", "start", "delta"],
  );
  assert.equal(events[2].model, fallbackModel);
});

test("client cancellation aborts the provider and prevents retries/fallback", async () => {
  const stream = controlledStream();
  const first = Promise.withResolvers();
  const controller = new AbortController();
  let providerSignal;
  let attempts = 0;
  const fetch = provider(
    (_body, options) => {
      attempts++;
      providerSignal = options.signal;
      stream.delta("Partial text");
      return stream.response;
    },
    [model, fallbackModel],
  );
  const result = completeChat(input, settings, {}, fetch, {
    signal: controller.signal,
    onEvent(value) {
      if (value.type === "delta") first.resolve();
    },
  });
  await first.promise;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  await stream.cancelled;
  assert.equal(providerSignal.aborted, true);
  assert.equal(attempts, 1);
});

test("cancelling a public chat stream also cancels the upstream provider reader", async () => {
  const stream = controlledStream();
  const ready = Promise.withResolvers();
  const fetch = provider(() => {
    ready.resolve();
    return stream.response;
  });
  const reader = createChatStream(input, settings, {}, fetch).getReader();
  await ready.promise;
  await reader.cancel();
  await stream.cancelled;
});

test("upstream streaming errors produce a safe error event, never leaked bodies or a done event", async () => {
  const fetch = provider(() =>
    sse(providerEvent({ error: { message: "PRIVATE PROVIDER KEY" } })),
  );
  const frames = [];
  for await (const frame of readEventStream(
    createChatStream(input, settings, {}, fetch),
  ))
    frames.push(frame);
  assert.equal(frames.at(-1).event, "error");
  assert.ok(!frames.some((frame) => frame.event === "done"));
  assert.doesNotMatch(JSON.stringify(frames), /PRIVATE|test-private-key/);
});

test("providers that reject streaming still produce one buffered reply through the same protocol", async () => {
  let calls = 0;
  const fetch = provider((body) => {
    calls++;
    return body.stream
      ? Response.json({}, { status: 422 })
      : Response.json({
          choices: [{ message: { content: "Buffered compatibility" } }],
        });
  });
  const events = [];
  const reply = await readChatResponse(
    new Response(createChatStream(input, settings, {}, fetch), {
      headers: CHAT_STREAM_HEADERS,
    }),
    (value) => events.push(value),
  );
  assert.equal(reply.content, "Buffered compatibility");
  assert.equal(calls, 2);
  assert.equal(events.filter((value) => value.type === "delta").length, 1);
});

test("streaming opt-in is validated before starting a response", () => {
  assert.throws(
    () => validateChatRequest({ ...input, stream: "true" }),
    /Streaming/,
  );
  assert.throws(
    () => createChatStream({ ...input, messages: [] }, settings),
    /between 1 and 40/,
  );
});

test("Node/Vercel HTTP handler flushes text before completion and keeps JSON/validation compatibility", async () => {
  const require = createRequire(import.meta.url);
  const adminPath = require.resolve("../lib/firebase-admin");
  const handlerPath = require.resolve("../api-handlers/chat");
  const oldAdmin = require.cache[adminPath],
    oldHandler = require.cache[handlerPath];
  const oldKey = process.env.NVIDIA_API_KEY;
  const realFetch = globalThis.fetch;
  const upstream = controlledStream();
  require.cache[adminPath] = {
    exports: { getAdminSettings: async () => settings },
  };
  delete require.cache[handlerPath];
  process.env.NVIDIA_API_KEY = "test-only-key";
  globalThis.fetch = provider(() => {
    upstream.delta("Visible before finish");
    return upstream.response;
  });
  const handler = require(handlerPath);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.body = Buffer.concat(chunks).toString() || {};
    res.status = (status) => {
      res.statusCode = status;
      return res;
    };
    res.json = (value) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    await handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/chat`;
  try {
    const response = await realFetch(url, {
      method: "POST",
      body: JSON.stringify(input),
    });
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(response.headers.get("cache-control"), /no-transform/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const first = Promise.withResolvers();
    let complete = false;
    const reply = readChatResponse(response, (value) => {
      if (value.type === "delta") first.resolve();
    }).then((value) => {
      complete = true;
      return value;
    });
    await first.promise;
    assert.equal(complete, false);
    upstream.finish();
    assert.equal((await reply).content, "Visible before finish");
    const invalid = await realFetch(url, {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get("content-type"), /application\/json/);
    globalThis.fetch = provider(() =>
      Response.json({ choices: [{ message: { content: "Legacy JSON" } }] }),
    );
    const legacy = await realFetch(url, {
      method: "POST",
      body: JSON.stringify({ ...input, stream: false }),
    });
    assert.equal((await legacy.json()).content, "Legacy JSON");
    // A disconnect during settings lookup must not start a fresh provider job.
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("Unexpected provider request");
    };
    await handler(
      { method: "POST", body: input },
      { destroyed: true, setHeader() {} },
    );
    assert.equal(called, false);
  } finally {
    upstream.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = realFetch;
    if (oldKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = oldKey;
    if (oldAdmin) require.cache[adminPath] = oldAdmin;
    else delete require.cache[adminPath];
    if (oldHandler) require.cache[handlerPath] = oldHandler;
    else delete require.cache[handlerPath];
  }
});

test("Worker streams the same public protocol without waiting for the entire generation", async () => {
  const realFetch = globalThis.fetch;
  const upstream = controlledStream();
  globalThis.fetch = provider(() => {
    upstream.delta("Worker partial");
    return upstream.response;
  });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/chat", {
        method: "POST",
        body: JSON.stringify(input),
      }),
      { AURUM_KV: { get: async () => JSON.stringify(settings) } },
      {},
    );
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const first = Promise.withResolvers();
    let complete = false;
    const result = readChatResponse(response, (value) => {
      if (value.type === "delta") first.resolve();
    }).then((value) => {
      complete = true;
      return value;
    });
    await first.promise;
    assert.equal(complete, false);
    upstream.finish();
    assert.equal((await result).content, "Worker partial");
  } finally {
    upstream.close();
    globalThis.fetch = realFetch;
  }
});

test("browser JSON and SSE errors preserve only safe timeout diagnostics", async () => {
  for (const timeoutPhase of ["first_token", "idle", "deadline"]) {
    const payload = {
      code: "timeout",
      timeoutPhase,
      message: "Please retry.",
      apiKey: "PRIVATE",
      failures: [{ internal: "PRIVATE" }],
    };
    for (const response of [
      Response.json(payload, { status: 504 }),
      sse(event("error", payload)),
    ])
      await assert.rejects(readChatResponse(response), (error) => {
        assert.equal(error.code, "timeout");
        assert.equal(error.timeoutPhase, timeoutPhase);
        assert.equal(error.message, "Please retry.");
        assert.equal(error.apiKey, undefined);
        assert.equal(error.failures, undefined);
        return true;
      });
  }
  await assert.rejects(
    readChatResponse(
      sse(
        event("error", {
          code: "https://private-provider.example/?key=PRIVATE",
          timeoutPhase: "PRIVATE",
        }),
      ),
    ),
    (error) => {
      assert.equal(error.code, undefined);
      assert.equal(error.timeoutPhase, undefined);
      return true;
    },
  );
});
