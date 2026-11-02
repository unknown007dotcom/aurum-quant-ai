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
    "nvidia/nemotron-parse",
    "nvidia/nemotron-parse-2.0",
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

const sseResponse = (chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
            ),
          );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const hangingSseResponse = () =>
  new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "text/event-stream" },
  });

test("streaming completions aggregate SSE chunks into the visible answer", async () => {
  const mock = provider([FAST], () =>
    sseResponse(["Hello ", "streamed ", "world"]),
  );
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const result = await requestCompletion(
    runtime.models[0],
    [{ role: "user", content: "Hi" }],
    { stream: true, timeoutMs: 5000, idleTimeoutMs: 1000 },
    mock.fetch,
  );
  assert.equal(result.content, "Hello streamed world");
  assert.equal(mock.calls.at(-1).body.stream, true);
});

test("a model that rejects streaming is retried once with a buffered request", async () => {
  const mock = provider([FAST], (body) =>
    body.stream ? Response.json({}, { status: 400 }) : answer("Buffered answer"),
  );
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const result = await requestCompletion(
    runtime.models[0],
    [{ role: "user", content: "Hi" }],
    { stream: true, timeoutMs: 5000, idleTimeoutMs: 1000 },
    mock.fetch,
  );
  assert.equal(result.content, "Buffered answer");
  const completions = mock.calls.filter((call) => call.body);
  assert.equal(completions.length, 2);
  assert.equal(completions[0].body.stream, true);
  assert.equal(completions[1].body.stream, false);
});

test("a stream that stops producing tokens fails as a timeout, not a hang", async () => {
  const mock = provider([FAST], () => hangingSseResponse());
  const runtime = await discoverModels(settings, {}, mock.fetch);
  await assert.rejects(
    requestCompletion(
      runtime.models[0],
      [{ role: "user", content: "Hi" }],
      { stream: true, timeoutMs: 5000, idleTimeoutMs: 25 },
      mock.fetch,
    ),
    (error) => error.code === "timeout" && error.status === 504,
  );
});

test("a hung selected model stream falls back to a faster model", async () => {
  const slowId = "example/slow-instruct";
  const mock = provider([slowId, FAST], (body) =>
    body.model === slowId
      ? hangingSseResponse()
      : sseResponse(["Fast ", "answer"]),
  );
  const runtime = await discoverModels(
    {
      globalNvidiaApiKey: "key",
      defaultModelKey: slowId,
      nvidiaModels: [{ id: slowId }],
    },
    {},
    mock.fetch,
  );
  const result = await completeWithFallback(
    runtime,
    selectModel(runtime),
    [{ role: "user", content: "Hello" }],
    {
      stream: true,
      idleTimeoutMs: 30,
      timeoutMs: 1000,
      deadline: Date.now() + 5000,
    },
    mock.fetch,
  );
  assert.equal(result.content, "Fast answer");
  assert.equal(result.model, FAST);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(result.failures[0].code, "timeout");
});

test("the final fallback candidate may use the remaining deadline beyond the per-attempt cap", async () => {
  const mock = provider(
    [FAST],
    (body, options) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(answer("Slow but complete")),
          80,
        );
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      }),
  );
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const result = await completeWithFallback(
    runtime,
    selectModel(runtime),
    [{ role: "user", content: "Hello" }],
    { timeoutMs: 10, deadline: Date.now() + 2000 },
    mock.fetch,
  );
  assert.equal(result.content, "Slow but complete");
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
    body.response_format ? answer(plan) : Response.json({}, { status: 410 }),
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
  assert.equal(result.debateAttempted, 3);
  assert.equal(result.debateSuccessful, 0);
  assert.equal(result.debateResponses.length, 0);
  assert.ok(result.debateMetrics.every(entry => !entry.success));
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

test("legacy and removed browser selections recover using only the server catalog", async () => {
  for (const modelKey of [
    "gpt-oss-default",
    "deleted-custom-key",
    "openai/gpt-oss-120b",
  ]) {
    const mock = provider([FAST]);
    const result = await completeChat(
      { modelKey, messages: [{ role: "user", content: "Hi Mira" }] },
      settings,
      {},
      mock.fetch,
    );
    assert.equal(result.model, FAST);
    assert.equal(result.modelFallbackUsed, true);
    assert.equal(mock.calls.at(-1).body.model, FAST);
  }
});

test("an explicit valid model key wins over a stale conflicting model ID", async () => {
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  assert.equal(selectModel(runtime, LARGE, FAST).model.id, LARGE);
});

const echoedTemplate = JSON.stringify({
  researcher: {
    summary:
      "Explain the institutional narrative. You MUST explicitly reference HTF Alignment, FVGs, active Liquidity Pools, Session Levels, and Liquidity Sweeps in your overview. If Red-Team identifies a trap, prioritize it.",
    direction: "Stay Flat",
    riskNote: "Summarize the RED-TEAM CRITIC's strongest argument.",
  },
  trader: {
    ...JSON.parse(plan).trader,
    invalidation: "Specific trigger or structural failure point",
  },
  equations: {
    review:
      "Discuss Equation 1 (Momentum), Equation 2 (Volatility), Equation 3 (Max-Pain).",
  },
});

test("analysis repairs a template echo once instead of accepting instructions as an answer", async () => {
  let attempt = 0;
  const mock = provider([FAST], () =>
    answer(++attempt === 1 ? echoedTemplate : plan),
  );
  const result = await completeAnalysis(
    { prompt: "No market data supplied." },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(attempt, 2);
  assert.equal(result.aiUsed, true);
  assert.equal(
    JSON.parse(result.choices[0].message.content).researcher.summary,
    JSON.parse(plan).researcher.summary,
  );
  const calls = mock.calls.filter((call) => call.body);
  assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
  assert.match(
    calls[1].body.messages.at(-1).content,
    /previous.*invalid|previous.*template/i,
  );
  assert.ok(calls[1].body.max_tokens >= 4096);
});

test("repeated template echoes fail honestly after one bounded correction", async () => {
  const mock = provider([FAST], () => answer(echoedTemplate));
  await assert.rejects(
    completeAnalysis({ prompt: "No market data." }, settings, {}, mock.fetch),
    (error) => error.code === "invalid_analysis",
  );
  assert.equal(mock.calls.filter((call) => call.body).length, 2);
});

test("empty required analysis fields are not treated as a completed answer", async () => {
  for (const path of [
    ["researcher", "summary"],
    ["researcher", "riskNote"],
    ["trader", "invalidation"],
    ["equations", "review"],
  ]) {
    const data = JSON.parse(plan);
    data[path[0]][path[1]] = "";
    const mock = provider([FAST], () => answer(JSON.stringify(data)));
    await assert.rejects(
      completeAnalysis({ prompt: "No market data." }, settings, {}, mock.fetch),
      (error) => error.code === "invalid_analysis",
    );
  }
});

test("reasoning that exhausts the output budget gets one larger-budget retry, never exposed reasoning", async () => {
  let attempt = 0;
  const mock = provider([FAST], () =>
    ++attempt === 1
      ? Response.json({
          choices: [
            {
              message: {
                content: null,
                reasoning_content: "private reasoning",
              },
              finish_reason: "length",
            },
          ],
        })
      : answer("Here is the actual answer."),
  );
  const result = await completeChat(
    { messages: [{ role: "user", content: "Explain a concept" }] },
    settings,
    {},
    mock.fetch,
  );
  assert.equal(attempt, 2);
  assert.equal(result.content, "Here is the actual answer.");
  assert.ok(mock.calls.at(-1).body.max_tokens >= 4096);
  assert.ok(!JSON.stringify(result).includes("private reasoning"));
});

test("an invalid analysis candidate cannot prevent fallback to a valid model", async () => {
  const other = "example/selected-instruct";
  const mock = provider([other, FAST], (body) =>
    answer(body.model === other ? echoedTemplate : plan),
  );
  const result = await completeAnalysis(
    { prompt: "No market data.", selectedModelKey: other },
    { globalNvidiaApiKey: "key" },
    {},
    mock.fetch,
  );
  assert.equal(result.model, FAST);
  assert.equal(result.modelFallbackUsed, true);
  assert.equal(result.responseRepaired, true);
  assert.equal(mock.calls.filter((call) => call.body).length, 3);
});

test("correction never starts after the overall analysis deadline", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const mock = provider([FAST], () => {
    clock += 65001;
    return answer(echoedTemplate);
  });
  await assert.rejects(
    completeAnalysis({ prompt: "No market data." }, settings, {}, mock.fetch),
    (error) => error.code === "timeout",
  );
  assert.equal(mock.calls.filter((call) => call.body).length, 1);
});

test("directional output without actual levels is not accepted as a completed plan", async () => {
  const incomplete = JSON.parse(plan);
  incomplete.researcher.summary =
    "The supplied synthetic example shows a bullish break of structure.";
  incomplete.researcher.direction = "Buy";
  delete incomplete.trader.entryZone;
  const mock = provider([FAST], () => answer(JSON.stringify(incomplete)));
  await assert.rejects(
    completeAnalysis(
      { prompt: "Synthetic test only." },
      settings,
      {},
      mock.fetch,
    ),
    (error) => error.code === "invalid_analysis",
  );
});
