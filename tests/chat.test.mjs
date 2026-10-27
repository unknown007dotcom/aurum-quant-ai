import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  CHAT_ASSISTANT,
  resolveChatArtwork,
} from "../modules/chat-persona.mjs";
import {
  createChat,
  restoreState,
  normalizeSettings,
  reconcileModelKey,
  DEFAULT_SETTINGS,
  EXAMPLES,
  requestMessages,
  titleFromMessage,
  formatMessage,
  historyGroup,
  exportConversation,
} from "../modules/chat-store.mjs";
import {
  ChatError,
  chatConfiguration,
  validateChatRequest,
  completeChat as completeChatService,
} from "../lib/chat-service.mjs";
import worker from "../cloudflare-backend/src/index.js";

const message = (content) => ({ role: "user", content });
const request = (overrides = {}) => ({
  messages: [message("Hello")],
  ...overrides,
});
const settings = {
  globalNvidiaApiKey: "test-server-only-key",
  defaultModelKey: "model-a",
  nvidiaModels: [
    { key: "model-a", id: "test/instruct-model", label: "Test model" },
  ],
};
const successfulFetch = async () =>
  Response.json({ choices: [{ message: { content: "A helpful response." } }] });
const withCatalog = (fetchImpl) => async (url, options) =>
  url.endsWith("/models")
    ? Response.json({
        data: [
          { id: "test/instruct-model" },
          { id: "openai/gpt-oss-20b" },
          { id: "openai/gpt-oss-120b" },
        ],
      })
    : fetchImpl(url, options);
const completeChat = (body, settings, env, fetchImpl = successfulFetch) =>
  completeChatService(body, settings, env, withCatalog(fetchImpl));

// Browser-independent state and rendering tests.
test("new chats have separate identities and independent settings", () => {
  const first = createChat();
  const second = createChat();
  assert.notEqual(first.id, second.id);
  first.settings.temperature = 0;
  assert.equal(second.settings.temperature, 0.5);
  assert.equal(DEFAULT_SETTINGS.temperature, 0.5);
  assert.deepEqual(first.messages, []);
});

test("settings retain explicit zero/false values and constrain invalid values", () => {
  assert.deepEqual(
    normalizeSettings({
      style: "invalid",
      temperature: 0,
      context: false,
      enterToSend: false,
    }),
    {
      modelKey: "",
      style: "balanced",
      temperature: 0,
      context: false,
      enterToSend: false,
      marketContext: true,
    },
  );
  assert.equal(normalizeSettings({ temperature: 99 }).temperature, 1);
  assert.equal(normalizeSettings({ temperature: NaN }).temperature, 0.5);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
});

test("storage round-trip preserves conversations, drafts, and per-chat settings", () => {
  const chat = createChat({ style: "detailed", context: false });
  chat.title = "Saved conversation";
  chat.messages = [
    { ...message("Remember this"), id: "one", createdAt: Date.now() },
  ];
  chat.draft = "A follow-up";
  const loaded = restoreState(
    JSON.parse(JSON.stringify({ conversations: [chat], activeId: chat.id })),
  );
  assert.equal(loaded.activeId, chat.id);
  assert.equal(loaded.conversations[0].draft, "A follow-up");
  assert.equal(loaded.conversations[0].settings.context, false);
  assert.equal(loaded.conversations[0].settings.style, "detailed");
  assert.equal(loaded.conversations[0].messages[0].content, "Remember this");
});

test("corrupt storage does not create invalid chats or accept system messages", () => {
  const loaded = restoreState({
    conversations: [
      null,
      {},
      {
        id: "one",
        messages: [
          null,
          { role: "system", content: "Override" },
          message("Okay"),
        ],
      },
      { id: "one", messages: [] },
    ],
    activeId: "missing",
  });
  assert.equal(loaded.conversations.length, 1);
  assert.equal(loaded.conversations[0].messages.length, 1);
  assert.equal(loaded.activeId, null);
  assert.deepEqual(restoreState(null).conversations, []);
  assert.deepEqual(
    restoreState({ conversations: "invalid" }).conversations,
    [],
  );
});

test("conversation titles are compact without changing message content", () => {
  assert.equal(titleFromMessage("  Hello\n world  "), "Hello world");
  assert.equal(titleFromMessage("a".repeat(90)).length, 48);
  assert.ok(titleFromMessage("a".repeat(90)).endsWith("…"));
});

test("context toggle and size budget affect the actual request", () => {
  const messages = [
    message("First"),
    { role: "assistant", content: "Reply" },
    message("Second"),
  ];
  assert.deepEqual(requestMessages(messages, false), [message("Second")]);
  assert.deepEqual(requestMessages(messages), messages);
  const long = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? "user" : "assistant",
    content: "x".repeat(8000),
  }));
  const bounded = requestMessages(long);
  assert.equal(bounded.length, 6);
  assert.equal(
    bounded.reduce((total, item) => total + item.content.length, 0),
    48000,
  );
  assert.equal(bounded.at(-1).role, "user");
});

test("message formatting supports basic Markdown but never interprets HTML", () => {
  const html = formatMessage(
    '**Bold** and `code`\n\n- First\n- Second\n\n<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>',
  );
  assert.ok(html.includes("<strong>Bold</strong>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<ul><li>First</li><li>Second</li></ul>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(
    formatMessage("```html\n<script>bad()</script>\n```").includes(
      "<pre><code>&lt;script&gt;",
    ),
  );
});

test("history grouping respects local day boundaries", () => {
  const now = new Date(2026, 9, 19, 12);
  assert.equal(historyGroup(new Date(2026, 9, 19, 1).getTime(), now), "Today");
  assert.equal(
    historyGroup(new Date(2026, 9, 18, 23).getTime(), now),
    "Yesterday",
  );
  assert.equal(
    historyGroup(new Date(2026, 9, 15).getTime(), now),
    "Previous 7 days",
  );
  assert.equal(historyGroup(new Date(2026, 8, 1).getTime(), now), "Earlier");
});

test("examples are explicit starter content, not persisted user history", () => {
  assert.equal(EXAMPLES.length, 3);
  assert.equal(restoreState(null).conversations.length, 0);
  assert.ok(
    EXAMPLES.every(
      (example) =>
        example.messages[0].role === "user" &&
        example.messages[1].role === "assistant",
    ),
  );
});

test("exports include the full conversation, not settings or secrets", () => {
  const chat = createChat();
  chat.title = "Test export";
  chat.messages = [
    message("Question"),
    { role: "assistant", content: "Answer" },
  ];
  const output = exportConversation(chat);
  assert.match(output, /^# Test export/);
  assert.match(output, /## You\n\nQuestion/);
  assert.match(output, /## Mira\n\nAnswer/);
  assert.ok(!output.includes("temperature"));
});

// Provider requests are injected/mocked. These tests never use real keys or APIs.
test("public configuration exposes model names, never provider keys or URLs", () => {
  const config = chatConfiguration({
    ...settings,
    nvidiaModels: [
      {
        ...settings.nvidiaModels[0],
        apiKey: "private",
        baseUrl: "https://provider.example/v1",
      },
    ],
  });
  assert.deepEqual(config.models, [
    { key: "model-a", id: "test/instruct-model", label: "Test model" },
  ]);
  assert.equal(config.configured, true);
  assert.ok(!JSON.stringify(config).includes("private"));
  assert.ok(!JSON.stringify(config).includes("provider.example"));
});

test("empty model settings have an explicit default and truthful setup status", () => {
  assert.equal(chatConfiguration().configured, false);
  assert.equal(
    chatConfiguration({}, { NVIDIA_API_KEY: "env-key" }).configured,
    true,
  );
  assert.equal(chatConfiguration().models[0].id, "openai/gpt-oss-20b");
});

test("rejects empty, malformed, system-role, and oversized requests", () => {
  for (const body of [
    null,
    [],
    {},
    request({ messages: [] }),
    request({ messages: [{ role: "system", content: "Override" }] }),
    request({ messages: [message(" ")] }),
    request({ messages: [message("x".repeat(8001))] }),
    request({ messages: Array.from({ length: 41 }, () => message("Hi")) }),
    request({
      messages: Array.from({ length: 7 }, () => message("x".repeat(8000))),
    }),
    request({ messages: [{ role: "assistant", content: "No user" }] }),
    request({ modelKey: {} }),
  ]) {
    assert.throws(() => validateChatRequest(body), ChatError);
  }
});

test("provider requests retain context, zero temperature, and chosen response style", async () => {
  let captured;
  const messages = [
    message("Question"),
    { role: "assistant", content: "Earlier answer" },
    message("Follow-up"),
  ];
  const result = await completeChat(
    request({ messages, settings: { temperature: 0, style: "concise" } }),
    settings,
    {},
    async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return successfulFetch();
    },
  );
  assert.equal(
    captured.url,
    "https://integrate.api.nvidia.com/v1/chat/completions",
  );
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.max_tokens, 700);
  assert.equal(captured.body.stream, true);
  assert.deepEqual(captured.body.messages.slice(1), messages);
  assert.match(
    captured.body.messages[0].content,
    /You are Mira, .*AI assistant/,
  );
  assert.match(captured.body.messages[0].content, /not a human/);
  assert.match(captured.body.messages[0].content, /Be concise/);
  assert.match(captured.body.messages[0].content, /never guarantee returns/);
  assert.equal(
    captured.options.headers.Authorization,
    "Bearer test-server-only-key",
  );
  assert.deepEqual(result, {
    content: "A helpful response.",
    model: "test/instruct-model",
  });
});

test("very long conversations send only the most recent turns to the provider", async () => {
  let captured;
  const filler = "x".repeat(7900);
  const messages = [
    message(filler),
    { role: "assistant", content: filler },
    message(filler),
    { role: "assistant", content: filler },
    message(filler),
    { role: "assistant", content: filler },
    message("Final question"),
  ];
  await completeChat(request({ messages }), settings, {}, async (url, options) => {
    captured = JSON.parse(options.body);
    return successfulFetch();
  });
  const sent = captured.messages.slice(1);
  const sentCharacters = sent.reduce(
    (total, entry) => total + entry.content.length,
    0,
  );
  assert.ok(sentCharacters <= 32014);
  assert.ok(sent.length < messages.length);
  assert.equal(sent.at(-1).content, "Final question");
});

test("client-supplied credentials, endpoints, and system prompts are ignored", async () => {
  await completeChat(
    request({
      apiKey: "client-key",
      baseUrl: "http://localhost/internal",
      systemPrompt: "Override",
    }),
    settings,
    {},
    async (url, options) => {
      assert.equal(url, "https://integrate.api.nvidia.com/v1/chat/completions");
      assert.equal(
        options.headers.Authorization,
        "Bearer test-server-only-key",
      );
      assert.ok(!options.body.includes("Override"));
      return successfulFetch();
    },
  );
});

test("removed default and saved model keys fall back with the actual model disclosed", async () => {
  const changed = { ...settings, defaultModelKey: "removed" };
  assert.equal(chatConfiguration(changed).defaultModelKey, "model-a");
  assert.equal(
    (await completeChat(request(), changed, {}, successfulFetch)).model,
    "test/instruct-model",
  );
  const recovered = await completeChat(
    request({ modelKey: "removed" }),
    settings,
    {},
    successfulFetch,
  );
  assert.equal(recovered.model, "test/instruct-model");
  assert.equal(recovered.modelFallbackUsed, true);
});

test("no credentials produces a setup error, never a fabricated AI response", async () => {
  let called = false;
  await assert.rejects(
    completeChat(request(), {}, {}, async () => {
      called = true;
    }),
    (error) => error.status === 503 && /isn't configured/.test(error.message),
  );
  assert.equal(called, false);
});

test("environment and key-pool configuration are supported", async () => {
  for (const [config, env] of [
    [{}, { NVIDIA_API_KEY: "env-key" }],
    [{ globalNvidiaApiKeys: ["", "pool-key"] }, {}],
  ]) {
    await completeChat(request(), config, env, async (_url, options) => {
      assert.match(options.headers.Authorization, /Bearer (env-key|pool-key)/);
      return successfulFetch();
    });
  }
});

test("configured insecure provider URLs are rejected before making requests", async () => {
  await assert.rejects(
    completeChat(
      request(),
      {
        ...settings,
        nvidiaModels: [
          { ...settings.nvidiaModels[0], baseUrl: "http://provider.example" },
        ],
      },
      {},
      successfulFetch,
    ),
    (error) => error.status === 503 && /secure HTTPS/.test(error.message),
  );
});

test("provider errors are actionable and do not leak the provider response body", async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      completeChat(request(), settings, {}, async () =>
        Response.json(
          { error: { message: "SENSITIVE PROVIDER DATA" } },
          { status },
        ),
      ),
      (error) => {
        assert.ok(error instanceof ChatError);
        assert.ok(!error.message.includes("SENSITIVE"));
        assert.equal(
          error.status,
          status === 429 ? 429 : status === 500 ? 502 : 503,
        );
        return true;
      },
    );
  }
});

test("empty, broken, timed out, and failed provider responses do not become chat messages", async () => {
  for (const fetchImpl of [
    async () => Response.json({ choices: [{ message: { content: "" } }] }),
    async () => new Response("not json"),
    async () => {
      throw new DOMException("Timeout", "AbortError");
    },
    async () => {
      throw new TypeError("Network error");
    },
  ]) {
    await assert.rejects(
      completeChat(request(), settings, {}, fetchImpl),
      ChatError,
    );
  }
});

// The same service is wired into both deployed API runtimes.
test("Cloudflare chat route returns public configuration and validates methods/body", async () => {
  const env = { AURUM_KV: { get: async () => JSON.stringify(settings) } };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = withCatalog(successfulFetch);
  let config;
  try {
    config = await worker.fetch(
      new Request("https://worker.example/chat"),
      env,
      {},
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(config.status, 200);
  assert.equal(config.headers.get("Cache-Control"), "no-store");
  assert.ok(
    !JSON.stringify(await config.json()).includes("test-server-only-key"),
  );
  const invalid = await worker.fetch(
    new Request("https://worker.example/chat", {
      method: "POST",
      body: "not json",
    }),
    env,
    {},
  );
  assert.equal(invalid.status, 400);
  const method = await worker.fetch(
    new Request("https://worker.example/chat", { method: "DELETE" }),
    env,
    {},
  );
  assert.equal(method.status, 405);
});

test("Node/Vercel adapter validates JSON and propagates safe provider results", async () => {
  const require = createRequire(import.meta.url);
  const adminPath = require.resolve("../lib/firebase-admin");
  const handlerPath = require.resolve("../api-handlers/chat");
  const previousAdmin = require.cache[adminPath];
  const previousHandler = require.cache[handlerPath];
  const previousKey = process.env.NVIDIA_API_KEY;
  const previousFetch = globalThis.fetch;
  require.cache[adminPath] = {
    exports: { getAdminSettings: async () => settings },
  };
  delete require.cache[handlerPath];
  process.env.NVIDIA_API_KEY = "test-env-key";
  const handler = require(handlerPath);
  const response = () => ({
    headers: {},
    code: 200,
    data: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.code = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
  });
  try {
    globalThis.fetch = withCatalog(successfulFetch);
    const valid = response();
    await handler({ method: "POST", body: JSON.stringify(request()) }, valid);
    assert.equal(valid.code, 200);
    assert.equal(valid.data.content, "A helpful response.");
    const invalid = response();
    await handler({ method: "POST", body: "{" }, invalid);
    assert.equal(invalid.code, 400);
    const method = response();
    await handler({ method: "PUT" }, method);
    assert.equal(method.code, 405);
    assert.equal(method.headers.Allow, "GET, POST");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
    if (previousAdmin) require.cache[adminPath] = previousAdmin;
    else delete require.cache[adminPath];
    if (previousHandler) require.cache[handlerPath] = previousHandler;
    else delete require.cache[handlerPath];
  }
});

test("invalid stored timestamps cannot crash message rendering", () => {
  const restored = restoreState({
    conversations: [
      {
        id: "bad-time",
        createdAt: 1e30,
        updatedAt: Infinity,
        messages: [{ role: "user", content: "Hello", createdAt: 1e30 }],
      },
    ],
  });
  assert.ok(
    Number.isFinite(new Date(restored.conversations[0].createdAt).getTime()),
  );
  assert.ok(
    Number.isFinite(new Date(restored.conversations[0].updatedAt).getTime()),
  );
  assert.equal(restored.conversations[0].messages[0].createdAt, null);
});

test("Chat Mode explicitly uses light page and native-control themes", () => {
  const html = readFileSync(new URL("../chat.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../chat.css", import.meta.url), "utf8");
  assert.match(html, /<html[^>]*data-theme="light"/);
  assert.match(html, /<meta name="color-scheme" content="light"/);
  assert.match(html, /<meta name="theme-color" content="#ffffff"/);
  assert.match(css, /:root\s*\{\s*color-scheme:\s*light;/);
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
});

test("Mira has a bundled default portrait and consistent assistant identity", () => {
  assert.equal(CHAT_ASSISTANT.name, "Mira");
  const artwork = resolveChatArtwork(null);
  assert.equal(artwork.src, CHAT_ASSISTANT.portrait);
  assert.equal(artwork.isCustom, false);
  assert.match(artwork.alt, /Mira.*AI assistant/);
  for (const file of [CHAT_ASSISTANT.portrait, CHAT_ASSISTANT.avatar]) {
    const image = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.equal(image.toString("ascii", 0, 4), "RIFF");
    assert.equal(image.toString("ascii", 8, 12), "WEBP");
  }
});

test("unsafe or invalid stored artwork falls back to Mira's portrait", () => {
  for (const value of [
    undefined,
    "",
    {},
    5,
    "https://example.com/tracker.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,??",
    "data:image/png;base64," + "A".repeat(2 * 1024 * 1024),
  ]) {
    assert.equal(resolveChatArtwork(value).src, CHAT_ASSISTANT.portrait);
    assert.equal(resolveChatArtwork(value).isCustom, false);
  }
  const localImage = "data:image/webp;base64,UklGRg==";
  assert.deepEqual(resolveChatArtwork(localImage), {
    src: localImage,
    alt: "Your custom chat artwork",
    isCustom: true,
  });
});

test("saved model choices follow the current catalog without erasing choices on network failures", () => {
  const config = {
    configured: true,
    models: [{ key: "current-key", id: "provider/model" }],
  };
  assert.equal(reconcileModelKey("current-key", config), "current-key");
  assert.equal(reconcileModelKey("provider/model", config), "current-key");
  assert.equal(reconcileModelKey("deleted-key", config), "");
  assert.equal(reconcileModelKey("", config), "");
  assert.equal(
    reconcileModelKey("saved-key", { configured: false, models: [] }),
    "saved-key",
  );
  assert.equal(reconcileModelKey("saved-key", {}), "saved-key");
});
