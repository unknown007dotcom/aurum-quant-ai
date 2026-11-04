import { test } from "node:test";
import assert from "node:assert/strict";
import { activeChatConfiguration, completeChat } from "../lib/chat-service.mjs";
import { discoverModels, selectModel } from "../lib/nvidia-runtime.mjs";

const OLD = "openai/gpt-oss-20b";
const PRIMARY = "nvidia/nemotron-3.5-lightning-30b-a3b";
const SECONDARY = "minimaxai/minimax-m3.1-flash";
const settings = {
  globalNvidiaApiKey: "test-saved-aurum-key",
  nvidiaModels: [
    { key: "main-analysis", id: OLD, label: "Analysis selection" },
  ],
  defaultModelKey: "main-analysis",
  chatModelIds: [PRIMARY, SECONDARY],
  chatDefaultModelKey: PRIMARY,
};
const question = {
  messages: [{ role: "user", content: "Explain a reading list." }],
  settings: { marketContext: false },
};
function provider(ids = [OLD, SECONDARY, PRIMARY], fail = []) {
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(
      options.headers.Authorization === "Bearer test-saved-aurum-key",
      true,
      "Use the saved application key, not a client key",
    );
    if (url.endsWith("/models"))
      return Response.json({ data: ids.map((id) => ({ id })) });
    assert.ok(
      url.endsWith("/chat/completions"),
      "No broker or unrelated requests",
    );
    const body = JSON.parse(options.body);
    calls.push(body.model);
    if (fail.includes(body.model)) return Response.json({}, { status: 503 });
    return Response.json({
      choices: [
        {
          message: { content: "A helpful response from the configured model." },
        },
      ],
    });
  };
  return { calls, fetch };
}

test("Chat uses its saved model policy and key without changing analysis's catalog or default", async () => {
  const mock = provider();
  const original = JSON.stringify(settings);
  const config = await activeChatConfiguration(settings, {}, mock.fetch);
  assert.deepEqual(
    config.models.map((model) => model.id),
    [PRIMARY, SECONDARY],
  );
  assert.equal(config.defaultModelKey, PRIMARY);
  assert.equal(config.configured, true);
  assert.doesNotMatch(
    JSON.stringify(config),
    /test-saved-aurum-key|apiKey|baseUrl/,
  );
  const shared = await discoverModels(settings, {}, mock.fetch);
  assert.equal(shared.models.length, 3);
  assert.equal(
    selectModel(shared).model.id,
    OLD,
    "The analysis selection is unaffected by Chat-only configuration",
  );
  assert.equal(JSON.stringify(settings), original);
});

test("saved retired, stalled and legacy Chat selections recover immediately through the configured default", async () => {
  for (const modelKey of [
    OLD,
    "main-analysis",
    "gpt-oss-default",
    "removed-selection",
  ]) {
    const mock = provider();
    const events = [];
    const reply = await completeChat(
      { ...question, modelKey },
      settings,
      {},
      mock.fetch,
      { onEvent: (event) => events.push(event) },
    );
    assert.deepEqual(
      mock.calls,
      [PRIMARY],
      "Do not spend another startup window on a model not enabled for Chat",
    );
    assert.equal(reply.model, PRIMARY);
    assert.equal(reply.modelFallbackUsed, true);
    assert.equal(events[0].model, PRIMARY);
    assert.equal(events[0].modelFallbackUsed, true);
  }
});

test("an enabled user's model choice is preserved, while provider failure falls back only within Chat's allowed models", async () => {
  const healthy = provider();
  const selected = await completeChat(
    { ...question, modelKey: SECONDARY },
    settings,
    {},
    healthy.fetch,
  );
  assert.deepEqual(healthy.calls, [SECONDARY]);
  assert.equal(selected.model, SECONDARY);
  assert.equal(selected.modelFallbackUsed, undefined);
  const failed = provider(undefined, [PRIMARY]);
  const recovered = await completeChat(question, settings, {}, failed.fetch);
  assert.deepEqual(failed.calls, [PRIMARY, SECONDARY]);
  assert.equal(recovered.model, SECONDARY);
  assert.equal(recovered.modelFallbackUsed, true);
});

test("if an enabled default disappears, Chat uses the remaining enabled catalog model", async () => {
  const mock = provider([OLD, SECONDARY]);
  const config = await activeChatConfiguration(settings, {}, mock.fetch);
  assert.deepEqual(
    config.models.map((model) => model.id),
    [SECONDARY],
  );
  assert.equal(config.defaultModelKey, SECONDARY);
  const result = await completeChat(
    { ...question, modelKey: PRIMARY },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(result.model, SECONDARY);
  assert.deepEqual(mock.calls, [SECONDARY]);
});

test("an empty/unavailable or malformed Chat policy fails closed rather than silently enabling other models", async () => {
  const absent = provider([OLD]);
  await assert.rejects(
    activeChatConfiguration(settings, {}, absent.fetch),
    (error) => error.code === "no_models" && error.status === 503,
  );
  await assert.rejects(
    completeChat(question, settings, {}, absent.fetch),
    (error) => error.code === "no_models",
  );
  assert.deepEqual(absent.calls, []);
  for (const chatModelIds of [
    [],
    "all",
    [null],
    [""],
    ["x".repeat(181)],
    Array(33).fill(PRIMARY),
  ]) {
    const mock = provider();
    await assert.rejects(
      activeChatConfiguration({ ...settings, chatModelIds }, {}, mock.fetch),
      (error) => error.code === "invalid_configuration",
    );
    assert.deepEqual(mock.calls, []);
  }
});

test("browser input cannot override the server's Chat model policy or saved credentials", async () => {
  const mock = provider();
  const result = await completeChat(
    {
      ...question,
      modelKey: OLD,
      chatModelIds: [OLD],
      settings: {
        ...question.settings,
        chatModelIds: [OLD],
        chatDefaultModelKey: OLD,
        apiKey: "client-key",
        baseUrl: "https://untrusted.example",
      },
    },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(result.model, PRIMARY);
  assert.deepEqual(mock.calls, [PRIMARY]);
});

test("without an explicit Chat policy, existing model configuration remains backward compatible", async () => {
  const { chatModelIds, chatDefaultModelKey, ...legacy } = settings;
  const mock = provider();
  const config = await activeChatConfiguration(legacy, {}, mock.fetch);
  assert.equal(config.models.length, 3);
  assert.equal(config.defaultModelKey, "main-analysis");
  const result = await completeChat(question, legacy, {}, mock.fetch);
  assert.deepEqual(mock.calls, [OLD]);
  assert.equal(result.model, OLD);
});

test("Chat defaults accept a stable model ID even when the owner's imported UI key changes", async () => {
  const mock = provider();
  const config = await activeChatConfiguration(
    {
      ...settings,
      nvidiaModels: [
        ...settings.nvidiaModels,
        { key: "renamed-import", id: PRIMARY, label: "Preferred chat" },
      ],
    },
    {},
    mock.fetch,
  );
  assert.equal(config.defaultModelKey, "renamed-import");
  assert.deepEqual(
    config.models.map((model) => model.id),
    [PRIMARY, SECONDARY],
  );
});
