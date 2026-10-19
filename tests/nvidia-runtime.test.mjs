import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  discoverModels,
  publicModels,
  credentials,
  isChatModel,
  selectModel,
  requestCompletion,
  completeWithFallback,
  checkNvidiaHealth,
  NvidiaError,
} from "../lib/nvidia-runtime.mjs";
import { preserveAiCredentials } from "../lib/ai-settings.mjs";
import {
  completeAnalysis,
  validateAnalysisRequest,
} from "../lib/analysis-service.mjs";
import { completeChat, activeChatConfiguration } from "../lib/chat-service.mjs";

const FAST = "openai/gpt-oss-20b";
const LARGE = "openai/gpt-oss-120b";
const RETIRED = "meta/llama-3.1-70b-instruct";
const settings = {
  defaultModelKey: "old-main",
  nvidiaModels: [{ key: "old-main", id: RETIRED, apiKey: "stored-key" }],
};
const answer = (content) =>
  Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
const plan = JSON.stringify({
  researcher: {
    summary: "Insufficient market data. Stay flat.",
    direction: "Stay Flat",
    riskNote: "Connectivity test, not a signal.",
  },
  trader: {
    entryZone: "N/A",
    takeProfitLevels: "N/A",
    stopLoss: "N/A",
    positionSizing: "N/A",
    timeHorizon: "N/A",
    invalidation: "Supply confirmed market data.",
  },
  equations: { review: "No live prices supplied." },
});
function provider(ids = [FAST, LARGE], respond = () => answer("OK")) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({
      url,
      options,
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (url.endsWith("/models"))
      return Response.json({ data: ids.map((id) => ({ id })) });
    return respond(JSON.parse(options.body), options, url);
  };
  return { fetch, calls };
}

test("retired defaults are replaced by catalog-listed models, not silently renamed", async () => {
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  assert.equal(runtime.models[0].id, FAST);
  assert.ok(!runtime.models.some((model) => model.id === RETIRED));
  assert.deepEqual(runtime.unavailableModels, [
    { key: "old-main", id: RETIRED },
  ]);
  const chosen = selectModel(runtime, "old-main");
  assert.equal(chosen.model.id, FAST);
  assert.equal(chosen.replaced, true);
  const visible = publicModels(runtime);
  assert.equal(visible.completionVerified, false);
  assert.equal(visible.catalogChecked, true);
  assert.ok(!JSON.stringify(visible).includes("stored-key"));
});

test("server environment credentials override obsolete stored per-model keys", async () => {
  const mock = provider();
  const runtime = await discoverModels(
    settings,
    { NVIDIA_API_KEY: "rotated-key" },
    mock.fetch,
  );
  await requestCompletion(
    runtime.models[0],
    [{ role: "user", content: "Hello" }],
    {},
    mock.fetch,
  );
  assert.ok(
    mock.calls.every(
      (call) => call.options.headers.Authorization === "Bearer rotated-key",
    ),
  );
  assert.deepEqual(credentials(settings, { NVIDIA_API_KEY: "rotated-key" }), [
    { apiKey: "rotated-key", baseUrl: "https://integrate.api.nvidia.com/v1" },
  ]);
});

test("model discovery accepts server-side debate credentials without exposing them", async () => {
  const mock = provider();
  const result = await activeChatConfiguration(
    { debateModels: [{ key: "fast", id: FAST, apiKey: "debate-key" }] },
    {},
    mock.fetch,
  );
  assert.equal(result.configured, true);
  assert.equal(result.models[0].id, FAST);
  assert.ok(!JSON.stringify(result).includes("debate-key"));
});

test("catalog cache distinguishes full credentials, including matching prefixes", async () => {
  const mock = provider();
  await discoverModels({}, { NVIDIA_API_KEY: "same-prefix-123-a" }, mock.fetch);
  await discoverModels({}, { NVIDIA_API_KEY: "same-prefix-123-a" }, mock.fetch);
  await discoverModels({}, { NVIDIA_API_KEY: "same-prefix-123-b" }, mock.fetch);
  assert.equal(mock.calls.length, 2);
});

test("catalog errors are not cached as permanent bad-key results", async () => {
  let attempt = 0;
  const fetch = async () =>
    ++attempt === 1
      ? Response.json({}, { status: 429 })
      : Response.json({ data: [{ id: FAST }] });
  await assert.rejects(
    discoverModels(settings, {}, fetch),
    (error) => error.code === "rate_limited",
  );
  assert.equal((await discoverModels(settings, {}, fetch)).models[0].id, FAST);
  assert.equal(attempt, 2);
});

test("unsupported task models never enter chat or debate pools", async () => {
  for (const id of [
    "baai/bge-m3",
    "nvidia/nv-embedqa",
    "nvidia/llama-guard-4",
    "nvidia/ai-synthetic-video-detector",
    "google/deplot",
    "nvidia/gliner-pii",
  ])
    assert.equal(isChatModel(id), false);
  const mock = provider([FAST, "baai/bge-m3", "nvidia/nv-embedqa"]);
  const runtime = await discoverModels(settings, {}, mock.fetch);
  assert.deepEqual(
    runtime.models.map((model) => model.id),
    [FAST],
  );
});

test("reasoning models get a usable token budget instead of a 32-token health probe", async () => {
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  await requestCompletion(
    runtime.models[0],
    [{ role: "user", content: "OK?" }],
    { maxTokens: 32, temperature: 0 },
    mock.fetch,
  );
  const request = mock.calls.at(-1).body;
  assert.equal(request.reasoning_effort, "low");
  assert.ok(request.max_tokens >= 2048);
  assert.equal(request.temperature, 0);
});

test("a listed model returning 410 falls back with the actual model disclosed", async () => {
  const selectedId = "example/other-instruct";
  const mock = provider([selectedId, FAST], (body) =>
    body.model === selectedId
      ? Response.json({}, { status: 410 })
      : answer("A real answer"),
  );
  const runtime = await discoverModels(
    {
      globalNvidiaApiKey: "key",
      defaultModelKey: selectedId,
      nvidiaModels: [{ id: selectedId }],
    },
    {},
    mock.fetch,
  );
  const result = await completeWithFallback(
    runtime,
    selectModel(runtime),
    [{ role: "user", content: "Hello" }],
    {},
    mock.fetch,
  );
  assert.equal(result.content, "A real answer");
  assert.equal(result.model, FAST);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(result.failures[0].status, 410);
});

test("rate limiting and authentication failures stop instead of retrying every model", async () => {
  for (const status of [401, 403, 429]) {
    const mock = provider([FAST, LARGE], () =>
      Response.json(
        { error: { message: "PRIVATE PROVIDER DETAILS" } },
        { status },
      ),
    );
    const runtime = await discoverModels(settings, {}, mock.fetch);
    await assert.rejects(
      completeWithFallback(
        runtime,
        selectModel(runtime),
        [{ role: "user", content: "Hello" }],
        {},
        mock.fetch,
      ),
      (error) => {
        assert.ok(!error.message.includes("PRIVATE"));
        assert.equal(error.status, status === 429 ? 429 : 503);
        return true;
      },
    );
    assert.equal(mock.calls.filter((call) => call.body).length, 1);
  }
});

test("HTTP 200 with only reasoning or empty content is never healthy", async () => {
  const mock = provider([FAST], () =>
    Response.json({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Internal reasoning, not an answer.",
          },
        },
      ],
    }),
  );
  const health = await checkNvidiaHealth(settings, {}, mock.fetch);
  assert.equal(health.status, "unhealthy");
  assert.equal(health.completionVerified, false);
  assert.equal(health.selectedModelAvailable, false);
});

test("health requires a real visible reply and caches successful probes briefly", async () => {
  const mock = provider();
  const first = await checkNvidiaHealth(settings, {}, mock.fetch);
  const second = await checkNvidiaHealth(settings, {}, mock.fetch);
  assert.equal(first.status, "healthy");
  assert.equal(first.selectedModel, FAST);
  assert.equal(first.completionVerified, true);
  assert.deepEqual(first, second);
  assert.equal(mock.calls.filter((call) => call.body).length, 1);
});

test("expired request budget prevents starting additional model requests", async () => {
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  await assert.rejects(
    completeWithFallback(
      runtime,
      selectModel(runtime),
      [{ role: "user", content: "Hello" }],
      { deadline: Date.now() - 1 },
      mock.fetch,
    ),
    (error) => error.code === "timeout" && error.status === 504,
  );
  assert.equal(mock.calls.filter((call) => call.body).length, 0);
});

test("chat replies use active models while preserving Mira and conversation context", async () => {
  const mock = provider();
  const result = await completeChat(
    { modelKey: "old-main", messages: [{ role: "user", content: "Hi Mira" }] },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(result.model, FAST);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(mock.calls.at(-1).body.messages.at(-1).content, "Hi Mira");
  assert.match(mock.calls.at(-1).body.messages[0].content, /You are Mira/);
});

test("analysis makes real model requests without a separate reject-all smoke test", async () => {
  const mock = provider([FAST], () => answer(plan));
  const result = await completeAnalysis(
    {
      prompt: "Connectivity test. No market data supplied.",
      model: RETIRED,
      selectedModelKey: "old-main",
      apiKey: "client-key",
      baseUrl: "https://evil.example/collect",
    },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(result.aiUsed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.model, FAST);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(result.debateAttempted, 0);
  assert.equal(mock.calls.filter((call) => call.body).length, 1);
  assert.ok(
    mock.calls.every((call) =>
      call.url.startsWith("https://integrate.api.nvidia.com/v1/"),
    ),
  );
  assert.ok(
    mock.calls.every(
      (call) => call.options.headers.Authorization === "Bearer stored-key",
    ),
  );
  assert.equal(
    JSON.parse(result.choices[0].message.content).researcher.direction,
    "Stay Flat",
  );
});

test("failed debate participants do not prevent a genuine final AI analysis", async () => {
  const other = "example/debate-instruct";
  const mock = provider([FAST, other], (body) =>
    body.model === other ? Response.json({}, { status: 410 }) : answer(plan),
  );
  const result = await completeAnalysis(
    { prompt: "No market data." },
    {
      globalNvidiaApiKey: "key",
      defaultModelKey: FAST,
      nvidiaModels: [{ id: FAST }],
      debateModels: [{ id: other }],
    },
    {},
    mock.fetch,
  );
  assert.equal(result.aiUsed, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.debateAttempted, 1);
  assert.equal(result.debateSuccessful, 0);
  assert.equal(result.debateMetrics[0].statusCode, 410);
  assert.equal(result.model, FAST);
});

test("disabled debate models are not requested", async () => {
  const other = "example/debate-instruct";
  const mock = provider([FAST, other], () => answer(plan));
  const result = await completeAnalysis(
    { prompt: "No market data." },
    {
      globalNvidiaApiKey: "key",
      nvidiaModels: [{ id: FAST }],
      debateModels: [{ id: other, isDebateParticipant: false }],
    },
    {},
    mock.fetch,
  );
  assert.equal(result.debateAttempted, 0);
});

test("invalid AI JSON never becomes a fabricated trading plan", async () => {
  const mock = provider([FAST], () =>
    answer("An incomplete response with no JSON"),
  );
  await assert.rejects(
    completeAnalysis({ prompt: "No market data." }, settings, {}, mock.fetch),
    (error) => error.code === "invalid_analysis",
  );
});

test("neutral AI narrative suppresses contradictory trade levels", async () => {
  const data = JSON.parse(plan);
  data.researcher.direction = "Buy";
  data.trader.entryZone = "9999";
  const mock = provider([FAST], () => answer(JSON.stringify(data)));
  const result = await completeAnalysis(
    { prompt: "No market data." },
    settings,
    {},
    mock.fetch,
  );
  const parsed = JSON.parse(result.choices[0].message.content);
  assert.equal(parsed.researcher.direction, "Stay Flat");
  assert.equal(parsed.trader.entryZone, "N/A");
});

test("analysis failures surface as failures, never HTTP-200 server-generated AI", async () => {
  const mock = provider([FAST], () => Response.json({}, { status: 503 }));
  await assert.rejects(
    completeAnalysis({ prompt: "No market data." }, settings, {}, mock.fetch),
    NvidiaError,
  );
  for (const body of [
    {},
    null,
    { prompt: 5 },
    { prompt: "x".repeat(96001) },
    { prompt: "Hi", model: {} },
  ])
    assert.throws(() => validateAnalysisRequest(body), NvidiaError);
});

test("frontend analysis routing and model management do not regress to retired defaults", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /fetch\(apiUrl\(APP_CONFIG.aiChatPath\)/);
  assert.ok(
    !source.includes("fetch(`${EDGE_API_BASE}${APP_CONFIG.aiChatPath}`"),
  );
  assert.ok(!source.includes('modelId = "meta/llama-3.1-70b-instruct"'));
  assert.match(
    source,
    /\}\s*window.syncAiBackendSettings = syncAiBackendSettings;/,
  );
  assert.match(source, /models: state.models.map\(\(\{ key, id, label \}\)/);
});

test("saving public model metadata cannot erase working private credentials", () => {
  const saved = preserveAiCredentials(settings, {
    nvidiaModels: [{ key: FAST, id: FAST, apiKey: "" }],
    globalNvidiaApiKey: "",
    globalNvidiaApiKeys: [],
  });
  assert.equal(saved.globalNvidiaApiKey, "stored-key");
  assert.equal(saved.nvidiaModels[0].apiKey, "stored-key");
  const custom = preserveAiCredentials(settings, {
    nvidiaModels: [{ id: FAST, baseUrl: "https://other-provider.example/v1" }],
  });
  assert.equal(custom.nvidiaModels[0].apiKey, "");
});

test("tracked fallback settings contain no active NVIDIA credential", () => {
  const file = readFileSync(
    new URL("../data/settings.json", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(file, /nvapi-[A-Za-z0-9_-]{20,}/);
  assert.equal(credentials(JSON.parse(file), {}).length, 0);
});
