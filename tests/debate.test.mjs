import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  completeAnalysis,
  ANALYSIS_MODES,
  validateAnalysisRequest,
} from "../lib/analysis-service.mjs";
import { discoverModels, selectModel } from "../lib/nvidia-runtime.mjs";
import {
  debatePreferences,
  debateVerdict,
  planDebate,
  publicDebate,
  runDebate,
} from "../lib/debate-service.mjs";

const FAST = "openai/gpt-oss-20b";
const BOLT = "nvidia/nemotron-3.5-bolt-e4b";
const OTHER = "example/configured-instruct";
const REVIEW =
  "Market evidence is missing. No supported entry or invalidation can be established. Verdict: WAIT.";
const PLAN = JSON.stringify({
  researcher: {
    summary:
      "No current market data was provided. Stay flat until structure is confirmed.",
    direction: "Stay Flat",
    riskNote: "Prices and liquidity evidence are missing.",
  },
  trader: {
    entryZone: "N/A",
    takeProfitLevels: "N/A",
    stopLoss: "N/A",
    positionSizing: "N/A",
    timeHorizon: "N/A",
    invalidation: "Provide timestamped candles before considering an entry.",
  },
  equations: {
    review: "Momentum and volatility measurements were not supplied.",
  },
});
const settings = {
  globalNvidiaApiKey: "server-only-test-key",
  nvidiaModels: [{ key: "main", id: FAST }],
  debateModels: [{ id: OTHER, bias: "both" }],
};
const answer = (content) =>
  Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
function provider(
  respond = (body) => answer(body.response_format ? PLAN : REVIEW),
  ids = [FAST, BOLT, OTHER],
) {
  const calls = [];
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.endsWith("/models"))
      return Response.json({ data: ids.map((id) => ({ id })) });
    return respond(body, options);
  };
  return { fetch, calls, completions: () => calls.filter((call) => call.body) };
}
const analyze = (mock, body = {}, configured = settings) =>
  completeAnalysis(
    { prompt: "No market data supplied.", ...body },
    configured,
    {},
    mock.fetch,
  );

test("Fast uses three actual perspectives, never arbitrary first catalog entries or fabricated independent-model counts", async () => {
  const mock = provider();
  const result = await analyze(mock);
  assert.equal(result.aiUsed, true);
  assert.equal(result.debateMode, "fast");
  assert.equal(result.debateSuccessful, 3);
  assert.equal(result.debateDistinctModels, 2);
  assert.equal(result.debateRequests, 3);
  assert.deepEqual(
    result.debateResponses.map((entry) => entry.bias),
    ["bullish", "bearish", "redteam"],
  );
  assert.deepEqual(result.debateConsensus, {
    buy: 0,
    sell: 0,
    wait: 3,
    unclassified: 0,
  });
  assert.match(result.debateNotice, /not independent model votes/);
  const reviews = mock
    .completions()
    .filter((call) => !call.body.response_format);
  assert.ok(reviews.every((call) => [FAST, BOLT].includes(call.body.model)));
  const synthesis = mock.completions().at(-1);
  assert.match(
    synthesis.body.messages[1].content,
    /3 perspectives from 2 distinct model/,
  );
  assert.match(
    synthesis.body.messages[1].content,
    /Market evidence is missing/,
  );
  assert.ok(!JSON.stringify(result).includes("server-only-test-key"));
  assert.ok(result.timings.totalMs >= result.timings.debateMs);
});

test("debate settings survive runtime deduplication when the same model is also the primary", async () => {
  const mock = provider(undefined, [FAST]);
  const result = await analyze(
    mock,
    {},
    { ...settings, debateModels: [{ id: FAST }] },
  );
  assert.equal(result.debateSuccessful, 3);
  assert.equal(result.debateDistinctModels, 1);
  assert.match(result.debateNotice, /1 distinct model/);
});

test("explicit opt-outs win across browser/server duplicates and are never resurrected as automatic backups", async () => {
  const preferences = debatePreferences(
    { debateModels: [{ id: FAST, isDebateParticipant: false }, { id: OTHER }] },
    { debateModels: [{ id: FAST, isDebateParticipant: true }] },
  );
  assert.equal(preferences.enabled.has(FAST), false);
  const mock = provider();
  const result = await analyze(mock, {
    debateModels: [
      { id: FAST, isDebateParticipant: false },
      { id: BOLT, isDebateParticipant: false },
    ],
  });
  assert.equal(result.debateDistinctModels, 1);
  assert.ok(result.debateResponses.every((entry) => entry.modelId === OTHER));
  assert.ok(
    mock
      .completions()
      .filter((call) => !call.body.response_format)
      .every((call) => call.body.model === OTHER),
  );
});

test("off/no enabled participants skip debate without impairing the final analysis", async () => {
  for (const [body, configured] of [
    [{ debateMode: "off" }, settings],
    [
      {},
      {
        ...settings,
        debateModels: [{ id: OTHER, isDebateParticipant: false }],
      },
    ],
    [{}, { ...settings, debateModels: [] }],
  ]) {
    const mock = provider();
    const result = await analyze(mock, body, configured);
    assert.equal(result.debateAttempted, 0);
    assert.equal(result.debateSuccessful, 0);
    assert.equal(result.aiUsed, true);
    assert.equal(mock.completions().length, 1);
  }
  assert.equal(
    validateAnalysisRequest({ prompt: "Test", debateMode: "off" }).mode,
    "off",
  );
});

test("Deep/Full honor configured roles, bound fanout and disclose backup model identities", async () => {
  for (const [mode, count] of [
    ["deep", 4],
    ["full", 6],
  ]) {
    const mock = provider((body) =>
      body.model === OTHER
        ? Response.json({}, { status: 404 })
        : answer(body.response_format ? PLAN : REVIEW),
    );
    const result = await analyze(
      mock,
      { debateMode: mode },
      { ...settings, debateModels: [{ id: OTHER, bias: "redteam" }] },
    );
    assert.equal(result.debatePlanned, count);
    assert.equal(result.debateSuccessful, count);
    assert.ok(
      result.debateResponses.every(
        (entry) =>
          entry.requestedModelId === OTHER &&
          entry.modelFallbackUsed &&
          entry.bias === "redteam",
      ),
    );
    assert.ok(
      result.debateResponses.every((entry) =>
        [FAST, BOLT].includes(entry.modelId),
      ),
    );
    assert.equal(result.debateDistinctModels, 2);
    assert.ok(result.debateFailures.some((entry) => entry.statusCode === 404));
    assert.ok(result.debateRequests <= count * 2);
  }
});

test("failed participants enter a temporary credential-scoped cooldown, not a permanent catalog blacklist", async () => {
  let fail = true;
  const mock = provider((body) =>
    body.model === OTHER && fail
      ? Response.json({}, { status: 410 })
      : answer(body.response_format ? PLAN : REVIEW),
  );
  await analyze(mock, { debateMode: "deep" });
  const before = mock
    .completions()
    .filter((call) => call.body.model === OTHER).length;
  fail = false;
  const second = await analyze(mock, { debateMode: "deep" });
  assert.equal(
    mock.completions().filter((call) => call.body.model === OTHER).length,
    before,
  );
  assert.ok(
    second.debateFailures.some(
      (entry) => entry.code === "cooldown" && entry.skipped,
    ),
  );
  // A rotated server credential is a new scope; the old failure must not stick.
  const rotated = await analyze(
    mock,
    { debateMode: "deep" },
    { ...settings, globalNvidiaApiKey: "rotated-test-key" },
  );
  assert.ok(
    mock.completions().filter((call) => call.body.model === OTHER).length >
      before,
  );
  assert.ok(rotated.debateResponses.some((entry) => entry.modelId === OTHER));
});

test("success/failure cache is isolated by transport as well as credential", async () => {
  const broken = provider((body) =>
    body.response_format ? answer(PLAN) : Response.json({}, { status: 410 }),
  );
  assert.equal((await analyze(broken)).debateSuccessful, 0);
  const healthy = provider();
  assert.equal((await analyze(healthy)).debateSuccessful, 3);
});

test("rate limits stop queued roles and do not trigger a fallback request storm", async () => {
  const mock = provider((body) =>
    body.response_format
      ? answer(PLAN)
      : Response.json({ error: "private upstream detail" }, { status: 429 }),
  );
  const result = await analyze(mock, { debateMode: "full" });
  assert.equal(result.aiUsed, true);
  assert.equal(result.debateSuccessful, 0);
  assert.ok(result.debateRequests <= ANALYSIS_MODES.full.concurrency);
  assert.ok(result.debateSkipped >= 3);
  assert.ok(
    result.debateFailures.some((entry) => entry.code === "rate_limited"),
  );
  assert.ok(!JSON.stringify(result).includes("private upstream detail"));
});

test("one-word replies and obvious prompt echoes are failures, not successful debate votes", async () => {
  for (const content of [
    "OK",
    "Your review perspective: Give the case and its counter-risk. End with Verdict: BUY",
  ]) {
    const mock = provider((body) =>
      answer(body.response_format ? PLAN : content),
    );
    const result = await analyze(mock);
    assert.equal(result.aiUsed, true);
    assert.equal(result.debateSuccessful, 0);
    assert.ok(
      result.debateFailures.some((entry) => entry.code === "empty_debate"),
    );
  }
});

test("verdicts require explicit unambiguous declarations, not bullish/bearish keywords", () => {
  assert.equal(
    debateVerdict(
      "Bullish case is not confirmed; bearish pressure alone is inconclusive.",
    ),
    null,
  );
  assert.equal(debateVerdict("No data. **Verdict:** WAIT"), "wait");
  assert.equal(debateVerdict("Verdict: BUY"), "buy");
  assert.equal(debateVerdict("Vote: SELL."), "sell");
  assert.equal(debateVerdict("Verdict: Stay Flat"), "wait");
  assert.equal(debateVerdict("Verdict: BUY or Verdict: SELL"), null);
});

test("substantive reviews without a vote remain visible, but are explicitly unclassified", async () => {
  const mock = provider((body) =>
    answer(
      body.response_format
        ? PLAN
        : "Missing candles prevent a directional assessment; please supply timestamped prices.",
    ),
  );
  const result = await analyze(mock);
  assert.equal(result.debateSuccessful, 3);
  assert.deepEqual(result.debateConsensus, {
    buy: 0,
    sell: 0,
    wait: 0,
    unclassified: 3,
  });
});

test("successful debate is preserved on final-analysis failure without fabricating a trade plan", async () => {
  const mock = provider((body) =>
    answer(body.response_format ? "Invalid final answer" : REVIEW),
  );
  await assert.rejects(analyze(mock), (error) => {
    assert.equal(error.code, "invalid_analysis");
    assert.equal(error.debate.debateSuccessful, 3);
    assert.equal(error.debate.debateResponses.length, 3);
    assert.equal(error.debate.debateDistinctModels, 2);
    assert.match(error.debate.debateNotice, /not an accepted trade plan/);
    assert.ok(!Object.hasOwn(error.debate, "choices"));
    assert.ok(!JSON.stringify(error.debate).includes("server-only-test-key"));
    return true;
  });
});

test("browser keys/endpoints and nonexistent IDs cannot supply debate credentials or escape server discovery", async () => {
  const mock = provider();
  const result = await analyze(mock, {
    debateModels: [
      { id: OTHER, apiKey: "browser-secret", baseUrl: "https://evil.invalid" },
      { id: "invented/model", apiKey: "browser-secret" },
    ],
  });
  assert.ok(
    mock.calls.every((call) =>
      call.url.startsWith("https://integrate.api.nvidia.com/v1/"),
    ),
  );
  assert.ok(
    mock.calls.every(
      (call) =>
        call.options.headers.Authorization === "Bearer server-only-test-key",
    ),
  );
  assert.ok(!JSON.stringify(result).includes("browser-secret"));
  assert.ok(
    mock.completions().every((call) => call.body.model !== "invented/model"),
  );
});

test("parallel workers and the phase deadline bound a stalled council, reserving time for synthesis", async () => {
  let active = 0,
    maxActive = 0;
  const mock = provider(
    (_body, options) =>
      new Promise((resolve, reject) => {
        active++;
        maxActive = Math.max(maxActive, active);
        // A referenced timer simulates a live socket; the request's real abort
        // timer must end it before this long timeout, not just abandon the promise.
        const timer = setTimeout(() => {
          active--;
          resolve(answer(REVIEW));
        }, 1000);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            active--;
            reject(new DOMException("Timed out", "AbortError"));
          },
          { once: true },
        );
      }),
  );
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const selected = selectModel(runtime);
  const mode = {
    ...ANALYSIS_MODES.full,
    debateMs: 45,
    debateBudgetMs: 170,
    summaryMs: 400,
    concurrency: 2,
  };
  const started = Date.now();
  const result = await runDebate(
    {
      runtime,
      selected,
      settings,
      body: { debateMode: "full" },
      prompt: "No data",
      mode,
      deadline: started + 1000,
    },
    mock.fetch,
  );
  assert.ok(maxActive <= 2);
  assert.equal(active, 0);
  assert.ok(
    Date.now() - started < 600,
    "Do not wait for the stalled provider's 1s response",
  );
  assert.equal(result.records.length, 6);
  assert.equal(publicDebate(result, "full").debateSuccessful, 0);
  assert.ok(result.metrics.some((entry) => entry.code === "timeout"));
  assert.ok(result.metrics.some((entry) => entry.skipped));
});

test("an exhausted debate budget makes zero requests and leaves an honest skipped record", async () => {
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const mode = ANALYSIS_MODES.fast;
  const selected = selectModel(runtime);
  const result = await runDebate(
    {
      runtime,
      selected,
      settings,
      body: {},
      prompt: "Test",
      mode,
      deadline: Date.now() + mode.summaryMs - 1,
    },
    mock.fetch,
  );
  assert.equal(mock.completions().length, 0);
  assert.equal(publicDebate(result, "fast").debateSkipped, 3);
});

test("bounded mode profiles, fallback planning and a single UI renderer are regression-locked", async () => {
  assert.deepEqual(
    [
      ANALYSIS_MODES.fast.maxModels,
      ANALYSIS_MODES.deep.maxModels,
      ANALYSIS_MODES.full.maxModels,
    ],
    [3, 4, 6],
  );
  for (const mode of Object.values(ANALYSIS_MODES)) {
    assert.ok(mode.concurrency <= 3);
    assert.ok(mode.totalMs >= mode.summaryMs + mode.debateBudgetMs);
  }
  const mock = provider();
  const runtime = await discoverModels(settings, {}, mock.fetch);
  const tasks = planDebate(
    runtime,
    selectModel(runtime),
    settings,
    {},
    ANALYSIS_MODES.fast,
    mock.fetch,
  );
  assert.ok(
    tasks.every((task) => !task.backup || task.backup.id !== task.primary.id),
  );
  const ui = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.equal(
    (ui.match(/function showDebateCouncilModal\(/g) || []).length,
    1,
  );
  assert.ok(
    !ui.includes("consensusChart"),
    "Do not regress to an empty chart canvas",
  );
});

test("a model is retried after its failure cooldown expires", async () => {
  const originalNow = Date.now;
  let offset = 0,
    fail = true;
  Date.now = () => originalNow() + offset;
  try {
    const mock = provider((body) =>
      body.model === OTHER && fail
        ? Response.json({}, { status: 410 })
        : answer(body.response_format ? PLAN : REVIEW),
    );
    await analyze(mock, { debateMode: "deep" });
    fail = false;
    const before = mock
      .completions()
      .filter((call) => call.body.model === OTHER).length;
    offset = 600001;
    const retried = await analyze(mock, { debateMode: "deep" });
    assert.ok(
      mock.completions().filter((call) => call.body.model === OTHER).length >
        before,
    );
    assert.ok(retried.debateResponses.some((entry) => entry.modelId === OTHER));
  } finally {
    Date.now = originalNow;
  }
});

test("a slow Deep participant is not promoted into the automatic Fast pool merely because it succeeded", async () => {
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  try {
    const mock = provider((body) => {
      if (body.model === OTHER) offset += 2000;
      return answer(body.response_format ? PLAN : REVIEW);
    });
    const deep = await analyze(mock, { debateMode: "deep" });
    assert.equal(deep.debateSuccessful, 4);
    const fast = await analyze(mock, { debateMode: "fast" });
    assert.equal(fast.debateSuccessful, 3);
    assert.ok(
      fast.debateResponses.every((entry) =>
        [FAST, BOLT].includes(entry.modelId),
      ),
    );
  } finally {
    Date.now = originalNow;
  }
});
