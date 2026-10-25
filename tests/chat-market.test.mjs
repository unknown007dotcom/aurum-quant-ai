import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getMarketSnapshot,
  marketConfiguration,
  marketSystemContext,
  publicMarketEvidence,
  wantsMarketContext,
} from "../lib/chat-market-context.mjs";
import {
  completeChat,
  activeChatConfiguration,
  validateChatRequest,
} from "../lib/chat-service.mjs";
import {
  normalizeMarketEvidence,
  marketEvidenceText,
} from "../modules/chat-market-evidence.mjs";
import {
  createChat,
  restoreState,
  exportConversation,
  normalizeSettings,
} from "../modules/chat-store.mjs";

// All market/provider traffic is injected. No credentials, orders or real APIs.
const NOW = Date.UTC(2026, 9, 26, 12);
const ENV = {
  OANDA_API_TOKEN: "server-oanda-token",
  OANDA_ACCOUNT_ID: "private-account",
  OANDA_ENVIRONMENT: "practice",
};
const iso = (value) => new Date(value).toISOString();
const user = (content) => ({ role: "user", content });
function api(options = {}) {
  const calls = [];
  const now = options.now || (() => NOW);
  const fetch = async (url, config) => {
    const parsed = new URL(url);
    calls.push({ url, config });
    if (options.respond) return options.respond(parsed, config);
    if (parsed.pathname.endsWith("/pricing"))
      return Response.json({
        time: iso(now()),
        prices: [
          {
            instrument: "XAU_USD",
            time: iso(now() - 1000),
            status: "tradeable",
            tradeable: true,
            bids: [{ price: "3995.710" }],
            asks: [{ price: "3995.910" }],
            ...options.quote,
          },
        ],
      });
    const timeframe = parsed.searchParams.get("granularity");
    const step = timeframe === "H1" ? 3600000 : 900000;
    const candles = Array.from({ length: 32 }, (_, i) => ({
      time: iso(now() - (32 - i) * step),
      complete: true,
      mid: { o: "3994", h: "3997", l: "3992", c: String(3994 + i * 0.02) },
    }));
    return Response.json({
      instrument: "XAU_USD",
      granularity: timeframe,
      candles: options.candles ? options.candles(candles, timeframe) : candles,
    });
  };
  return { calls, fetch };
}
const snapshot = (mock, env = ENV, options = {}) =>
  getMarketSnapshot({}, env, mock.fetch, { now: () => NOW, ...options });

function chatApi(marketOptions = {}) {
  const broker = api({ now: Date.now, ...marketOptions });
  const providerCalls = [];
  const fetch = async (url, options) => {
    if (url.startsWith("https://api-fx")) return broker.fetch(url, options);
    assert.ok(url.startsWith("https://integrate.api.nvidia.com/v1/"));
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "openai/gpt-oss-20b" }] });
    providerCalls.push(JSON.parse(options.body));
    return Response.json({
      choices: [
        {
          message: { content: "A real provider response in this mocked test." },
          finish_reason: "stop",
        },
      ],
    });
  };
  return { fetch, broker, providerCalls };
}
const chatEnv = { ...ENV, NVIDIA_API_KEY: "server-nvidia-token" };

test("market intent uses the current gold request and relevant user follow-ups, not every conversation", () => {
  for (const text of [
    "XAU/USD live price?",
    "Analyze XAUUSD",
    "Gold today",
    "Do you have access to the OANDA API?",
    "आज सोने का भाव?",
  ])
    assert.equal(wantsMarketContext([user(text)]), true, text);
  assert.equal(
    wantsMarketContext([
      user("Gold trend?"),
      { role: "assistant", content: "Prior answer" },
      user("What is the price now?"),
    ]),
    true,
  );
  assert.equal(
    wantsMarketContext([user("Gold trend?"), user("Why is it closed?")]),
    true,
  );
  for (const text of [
    "Hello",
    "Write a poem",
    "What is BTC price now?",
    "Explain the stock market",
  ])
    assert.equal(
      wantsMarketContext([user("Gold trend?"), user(text)]),
      false,
      text,
    );
  assert.equal(
    wantsMarketContext([
      { role: "assistant", content: "Gold" },
      user("What price?"),
    ]),
    false,
  );
  assert.equal(wantsMarketContext([user("XAUUSD")], false), false);
});

test("configuration discloses capability, never credentials/account IDs or arbitrary endpoints", () => {
  const config = marketConfiguration({}, ENV);
  assert.equal(config.configured, true);
  assert.equal(config.readOnly, true);
  assert.equal(config.instrument, "XAU_USD");
  assert.equal(marketConfiguration().configured, false);
  for (const environment of [
    "https://evil.example",
    "__proto__",
    "constructor",
  ])
    assert.equal(
      marketConfiguration({}, { ...ENV, OANDA_ENVIRONMENT: environment })
        .configured,
      false,
    );
  assert.ok(!JSON.stringify(config).includes(ENV.OANDA_API_TOKEN));
  assert.ok(!JSON.stringify(config).includes(ENV.OANDA_ACCOUNT_ID));
});

test("only three bounded, fixed-instrument read requests are permitted; all credentials stay server-side", async () => {
  const mock = api();
  const result = await snapshot(mock);
  assert.equal(result.status, "live");
  assert.equal(result.quote.mid, 3995.81);
  assert.equal(result.quote.ageSeconds, 1);
  assert.equal(result.quote.spread, 0.2);
  assert.equal(result.candles.M15.samples, 32);
  assert.equal(result.candles.H1.recentCompleted.length, 8);
  assert.equal(mock.calls.length, 3);
  for (const { url, config } of mock.calls) {
    assert.equal(new URL(url).hostname, "api-fxpractice.oanda.com");
    assert.equal(config.method, "GET");
    assert.equal(config.redirect, "error");
    assert.equal(config.headers.Authorization, `Bearer ${ENV.OANDA_API_TOKEN}`);
    assert.ok(!/orders|positions|openTrades|transactions|balance/.test(url));
    assert.ok(url.includes("XAU_USD"));
    assert.ok(config.signal);
  }
  const publicData = JSON.stringify(publicMarketEvidence(result));
  for (const secret of [
    ENV.OANDA_API_TOKEN,
    ENV.OANDA_ACCOUNT_ID,
    "Authorization",
    "recentCompleted",
    "Bearer",
  ])
    assert.ok(!publicData.includes(secret));
});

test("environment credentials override stored credentials without allowing browser URLs", async () => {
  const mock = api();
  const result = await getMarketSnapshot(
    {
      oandaApiToken: "old",
      oandaAccountId: "old-account",
      oandaEnvironment: "practice",
      baseUrl: "https://evil.example",
    },
    { ...ENV, OANDA_ENVIRONMENT: "live" },
    mock.fetch,
    { now: () => NOW },
  );
  assert.equal(result.environment, "live");
  assert.ok(
    mock.calls.every(
      (call) =>
        call.url.startsWith("https://api-fxtrade.oanda.com/") &&
        call.config.headers.Authorization === "Bearer server-oanda-token",
    ),
  );
});

test("closed-market quotes remain last-known and old tradeable quotes are stale", async () => {
  const closed = await snapshot(
    api({
      quote: {
        time: iso(NOW - 2 * 86400000),
        status: "non-tradeable",
        tradeable: false,
      },
    }),
  );
  assert.equal(closed.status, "market_closed");
  assert.equal(closed.quote.ageSeconds, 172800);
  const stale = await snapshot(api({ quote: { time: iso(NOW - 120000) } }));
  assert.equal(stale.status, "stale");
  const unknown = await snapshot(
    api({ quote: { status: "unknown", tradeable: undefined } }),
  );
  assert.equal(unknown.status, "stale");
});

test("an envelope timestamp must never turn an untimestamped quote into a live quote", async () => {
  const result = await snapshot(api({ quote: { time: undefined } }));
  assert.equal(result.status, "unavailable");
  assert.equal(result.error.code, "invalid_data");
  assert.equal(result.quote, null);
});

test("future, malformed, mismatched and inverted prices are rejected rather than invented", async () => {
  for (const quote of [
    { time: iso(NOW + 60000) },
    { time: "not a date" },
    { instrument: "BTC_USD" },
    { bids: [{ price: "NaN" }] },
    { bids: [{ price: "0" }] },
    { asks: [{ price: "3990" }] },
    { status: "invalid" },
  ]) {
    const result = await snapshot(api({ quote }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.quote, null);
  }
});

test("completed candles are sorted, deduplicated and checked; incomplete/future/bad candles are excluded", async () => {
  const mock = api({
    candles: (rows) => [
      ...rows.reverse(),
      rows[0],
      { ...rows[0], complete: false, time: iso(NOW - 1) },
      { ...rows[0], time: iso(NOW + 3600000) },
      { ...rows[0], mid: { o: "4000", h: "3990", l: "3980", c: "4001" } },
    ],
  });
  const result = await snapshot(mock);
  assert.equal(result.candles.M15.samples, 32);
  assert.equal(result.candles.M15.asOf, iso(NOW - 900000));
  assert.equal(result.candles.H1.recentCompleted.length, 8);
  assert.equal(result.candles.H1.rangeHigh, 3997);
});

test("missing candles do not discard a successful quote", async () => {
  const good = api();
  const mock = api({
    respond: (url, options) =>
      url.pathname.endsWith("pricing")
        ? good.fetch(url.href, options)
        : Response.json({ message: "provider internals" }, { status: 500 }),
  });
  const result = await snapshot(mock);
  assert.equal(result.status, "live");
  assert.deepEqual(result.candles, {});
  assert.deepEqual(result.warnings, [
    "M15_candles_unavailable",
    "H1_candles_unavailable",
  ]);
  assert.ok(!JSON.stringify(result).includes("provider internals"));
});

test("a hard deadline aborts every hanging read and cannot hang chat", async () => {
  const mock = api({ respond: () => new Promise(() => {}) });
  const start = Date.now();
  const result = await snapshot(mock, ENV, { timeoutMs: 30 });
  assert.equal(result.error.code, "timeout");
  assert.ok(Date.now() - start < 1000);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every((call) => call.config.signal.aborted));
});

test("a slow candle read preserves an already received quote at the deadline", async () => {
  const good = api();
  const mock = api({
    respond: (url, options) =>
      url.pathname.endsWith("pricing")
        ? good.fetch(url.href, options)
        : new Promise(() => {}),
  });
  const result = await snapshot(mock, ENV, { timeoutMs: 30 });
  assert.equal(result.status, "live");
  assert.equal(result.quote.mid, 3995.81);
  assert.equal(result.warnings.length, 2);
});

test("bad authentication, rate limits and provider failures expose only safe messages", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ]) {
    const mock = api({
      respond: () =>
        Response.json({ errorMessage: "SECRET account and token" }, { status }),
    });
    const result = await snapshot(mock);
    assert.equal(result.error.code, code);
    assert.equal(result.status, "unavailable");
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

test("missing credentials do not make network calls or fabricate fallback prices", async () => {
  const mock = api();
  const result = await getMarketSnapshot({}, {}, mock.fetch, {
    now: () => NOW,
  });
  assert.equal(result.error.code, "not_configured");
  assert.equal(result.quote, null);
  assert.equal(mock.calls.length, 0);
});

test("in-flight lookups coalesce and cache identity includes credentials, account and environment", async () => {
  const mock = api();
  const results = await Promise.all(
    Array.from({ length: 3 }, () => snapshot(mock)),
  );
  assert.equal(mock.calls.length, 3);
  assert.ok(results.every((result) => result.quote.mid === 3995.81));
  await snapshot(mock);
  assert.equal(mock.calls.length, 3);
  await snapshot(mock, { ...ENV, OANDA_API_TOKEN: "rotated-token" });
  await snapshot(mock, { ...ENV, OANDA_ACCOUNT_ID: "another-account" });
  await snapshot(mock, { ...ENV, OANDA_ENVIRONMENT: "live" });
  assert.equal(mock.calls.length, 12);
  const other = api();
  await snapshot(other);
  assert.equal(other.calls.length, 3);
});

test("cache hits recompute quote age and keep the original checkedAt, rather than relabel old data live", async () => {
  const mock = api({ quote: { time: iso(NOW - 89000) } });
  const first = await snapshot(mock);
  const later = await snapshot(mock, ENV, { now: () => NOW + 3000 });
  assert.equal(first.status, "live");
  assert.equal(later.status, "stale");
  assert.equal(later.quote.ageSeconds, 92);
  assert.equal(later.checkedAt, first.checkedAt);
  assert.equal(later.cached, true);
  assert.equal(mock.calls.length, 3);
});

test("transient market failures are retried after their short cooldown", async () => {
  let failing = true;
  const good = api();
  const mock = api({
    respond: (url, options) =>
      failing
        ? Response.json({}, { status: 500 })
        : good.fetch(url.href, options),
  });
  assert.equal((await snapshot(mock)).status, "unavailable");
  failing = false;
  assert.equal((await snapshot(mock)).status, "unavailable");
  assert.equal(
    (await snapshot(mock, ENV, { now: () => NOW + 4000 })).status,
    "live",
  );
  assert.equal(mock.calls.length, 6);
});

test("gold replies get actual server-fetched evidence while browser credentials, URLs and prices are ignored", async () => {
  const mock = chatApi();
  const result = await completeChat(
    {
      messages: [user("Give the latest XAU/USD quote")],
      settings: { marketContext: true },
      market: { price: 999999 },
      oandaApiToken: "client-secret",
      baseUrl: "https://evil.example",
    },
    {},
    chatEnv,
    mock.fetch,
  );
  assert.equal(result.market.quote.mid, 3995.81);
  assert.equal(result.market.readOnly, true);
  const system = mock.providerCalls[0].messages[0].content;
  assert.match(system, /SERVER-VERIFIED READ-ONLY OANDA SNAPSHOT/);
  assert.match(system, /3995\.81/);
  assert.match(system, /market_closed/);
  assert.match(
    system,
    /no web browsing, account-balance access or order-execution tools/,
  );
  assert.ok(
    !/client-secret|999999|server-oanda-token|private-account|server-nvidia-token|evil\.example/.test(
      system,
    ),
  );
});

test("ordinary conversation and explicit opt-out make no market requests", async () => {
  for (const body of [
    { messages: [user("Hello Mira")] },
    { messages: [user("Gold price?")], settings: { marketContext: false } },
  ]) {
    const mock = chatApi();
    const result = await completeChat(body, {}, chatEnv, mock.fetch);
    assert.equal(mock.broker.calls.length, 0);
    assert.ok(!Object.hasOwn(result, "market"));
    if (body.settings)
      assert.match(mock.providerCalls[0].messages[0].content, /turned off/);
  }
  assert.throws(() =>
    validateChatRequest({
      messages: [user("Gold")],
      settings: { marketContext: "yes" },
    }),
  );
});

test("an OANDA outage still permits an actual AI reply with an explicit unavailable-data disclosure", async () => {
  const mock = chatApi({
    respond: () => Response.json({ message: "SECRET" }, { status: 401 }),
  });
  const result = await completeChat(
    { messages: [user("OANDA gold price?")] },
    {},
    chatEnv,
    mock.fetch,
  );
  assert.equal(result.model, "openai/gpt-oss-20b");
  assert.match(result.content, /provider response/);
  assert.equal(result.market.status, "unavailable");
  assert.equal(result.market.quote, null);
  assert.equal(result.market.error.code, "unauthorized");
  assert.ok(!mock.providerCalls[0].messages[0].content.includes("SECRET"));
});

test("public chat configuration includes read-only capability without retrieving prices", async () => {
  const mock = chatApi();
  const result = await activeChatConfiguration({}, chatEnv, mock.fetch);
  assert.equal(result.marketData.configured, true);
  assert.equal(result.marketData.readOnly, true);
  assert.equal(mock.broker.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes("server-oanda-token"));
});

test("the system explains stale/closed/unavailable snapshots and does not claim unrestricted API access", async () => {
  const data = await snapshot(
    api({ quote: { status: "non-tradeable", tradeable: false } }),
  );
  assert.match(marketSystemContext(data, true), /last-known quote/);
  assert.match(marketSystemContext(data, true), /not a streaming feed/);
  assert.match(marketSystemContext(null, false), /turned off/);
  assert.match(marketSystemContext(null, true), /no attached market snapshot/);
});

test("market provenance survives history and export; settings and arbitrary metadata do not leak", async () => {
  const evidence = publicMarketEvidence(await snapshot(api()));
  const chat = createChat({ marketContext: false });
  chat.messages = [
    {
      id: "one",
      role: "assistant",
      content: "A timestamped quote",
      createdAt: NOW,
      market: {
        ...evidence,
        token: "secret",
        account: "private",
        url: "https://evil.example",
      },
    },
  ];
  const restored = restoreState({ conversations: [chat], activeId: chat.id });
  const saved = restored.conversations[0];
  assert.equal(saved.settings.marketContext, false);
  assert.equal(saved.messages[0].market.quote.mid, 3995.81);
  assert.ok(!/secret|private|evil/.test(JSON.stringify(saved)));
  assert.match(exportConversation(saved), /OANDA · XAU\/USD · read-only/);
  assert.match(exportConversation(saved), /Quote 2026-10-26T11:59:59/);
  assert.equal(normalizeSettings({}).marketContext, true);
});

test("old history is not displayed as a current live quote and unsupported metadata is discarded", async () => {
  const evidence = publicMarketEvidence(await snapshot(api()));
  assert.equal(marketEvidenceText(evidence, NOW).status, "live");
  assert.equal(marketEvidenceText(evidence, NOW + 600000).status, "stale");
  assert.match(
    marketEvidenceText(evidence, NOW + 600000).stateLabel,
    /Historical snapshot/,
  );
  assert.equal(
    normalizeMarketEvidence({ ...evidence, provider: "<script>" }),
    null,
  );
  assert.equal(
    normalizeMarketEvidence({ ...evidence, instrument: "BTC_USD" }),
    null,
  );
  assert.equal(normalizeMarketEvidence({ ...evidence, readOnly: false }), null);
  assert.equal(
    normalizeMarketEvidence({
      ...evidence,
      quote: { ...evidence.quote, bid: NaN },
    }).status,
    "unavailable",
  );
});

test("failed-lookup reasons survive normalization and reload without untrusted upstream text", async () => {
  const mock = api({ respond: () => new Promise(() => {}) });
  const evidence = normalizeMarketEvidence(
    publicMarketEvidence(await snapshot(mock, ENV, { timeoutMs: 15 })),
  );
  const text = marketEvidenceText(JSON.parse(JSON.stringify(evidence)), NOW);
  assert.match(text.detail, /timed out/);
  assert.ok(!JSON.stringify(evidence).includes(ENV.OANDA_API_TOKEN));
});

test("market UI is same-origin and the new module is served as JavaScript", () => {
  const js = readFileSync(new URL("../chat.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../chat.html", import.meta.url), "utf8");
  const build = readFileSync(
    new URL("../tools/build-vercel.cjs", import.meta.url),
    "utf8",
  );
  assert.ok(js.includes("marketContext: chat.settings.marketContext"));
  assert.ok(!js.includes("api-fxtrade.oanda.com"));
  assert.ok(html.includes('id="useMarketContext"'));
  assert.ok(build.includes('"chat-market-evidence.mjs"'));
});

test("malformed optional market metadata/configuration cannot crash an otherwise usable chat", () => {
  assert.equal(
    marketConfiguration({
      oandaApiToken: { toString: null },
      oandaAccountId: {},
    }).configured,
    false,
  );
  const value = {
    provider: "OANDA",
    instrument: "XAU_USD",
    readOnly: true,
    status: "unavailable",
    checkedAt: iso(NOW),
    error: { code: { toString: null, valueOf: null } },
  };
  assert.equal(normalizeMarketEvidence(value).errorCode, "unavailable");
});
