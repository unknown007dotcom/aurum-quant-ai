// Opt-in production-browser smoke test. Only chat configuration and an actual
// no-data AI request reach the server. Market fixtures are synthetic; history,
// learning feedback, settings writes and every trading command stay blocked.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

module.exports = async function verifyDebateBrowser(origin, emit) {
  const options = { headless: true };
  if (process.env.CHROMIUM_EXECUTABLE_PATH)
    Object.assign(options, {
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--no-zygote", "--single-process"],
    });
  const browser = await chromium.launch(options);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [],
      prohibited = [],
      completions = [];
    let ignoredHistoryWrites = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      let stub;
      stub = new Proxy(
        function () {
          return stub;
        },
        {
          get(_target, name) {
            if (name === "then") return undefined;
            if (name === Symbol.toPrimitive) return () => 0;
            if (name === "length") return 0;
            return stub;
          },
        },
      );
      window.LightweightCharts = {
        createChart: () => stub,
        createSeriesMarkers: () => stub,
        CandlestickSeries: stub,
        LineSeries: stub,
        HistogramSeries: stub,
        LineStyle: {},
        CrosshairMode: {},
        ColorType: {},
      };
      window.TradingView = {
        widget: function () {
          return stub;
        },
      };
    });
    const candles = Array.from({ length: 1000 }, (_, i) => ({
      datetime: new Date(Date.UTC(2026, 9, 19) + i * 900000).toISOString(),
      open: 4000 + i * 0.15,
      close: 4000.08 + i * 0.15,
      high: 4000.4 + i * 0.15,
      low: 3999.8 + i * 0.15,
      volume: 100,
      complete: true,
    }));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      const json = (payload) => route.fulfill({ json: payload });
      if (
        url.origin === origin &&
        url.pathname === "/api/chat" &&
        method === "GET"
      )
        return route.continue();
      if (
        url.origin === origin &&
        url.pathname === "/api/ai-decision" &&
        method === "POST"
      ) {
        const body = request.postDataJSON();
        assert.equal(body.debateMode, "fast");
        assert.ok(!Object.hasOwn(body, "apiKey"));
        completions.push(body.debateMode);
        // The real browser/controller/request path is used, but no synthetic
        // chart prices are submitted as live financial evidence.
        return route.continue({
          postData: JSON.stringify({
            ...body,
            // This specific regression is intentionally no-data. Never attach
            // synthetic research candles while claiming no market evidence.
            terminalSkills: { enabled: false },
            temperature: 0,
            prompt:
              "Connectivity test only. No live market data is supplied. Explain what is missing, choose Stay Flat and N/A for all price fields. Do not propose or execute an order.",
          }),
        });
      }
      if (
        (url.pathname === "/api/settings" || url.pathname === "/settings") &&
        method === "GET"
      )
        return json({ isAdmin: false, settings: {} });
      if (url.hostname.endsWith("workers.dev")) {
        if (url.pathname === "/history-log" && method === "POST") {
          ignoredHistoryWrites++;
          return json({ ok: true, diagnosticOnly: true });
        }
        if (url.pathname === "/market-mtf" && method === "GET")
          return json({
            status: "ok",
            data: [
              "entry",
              "5min",
              "15min",
              "h1",
              "4h",
              "1day",
              "1week",
              "1month",
              "benchmark",
            ].map((id) => ({ id, values: candles, symbolUsed: "XAU_USD" })),
          });
        if (url.pathname === "/bot" && method === "GET")
          return json({
            botEnabled: false,
            mode: "manual",
            config: { botMode: "manual", botEnabled: false },
            runtime: {},
            openTrades: [],
            recentHistory: [],
          });
        if (url.pathname === "/live-price" && method === "GET")
          return json({ price: 4035.93, instrument: "XAU_USD" });
        if (
          ["/learning-feedback", "/intel", "/options-intel"].includes(
            url.pathname,
          ) &&
          method === "GET"
        )
          return json({
            ok: true,
            entries: [],
            metrics: {},
            rules: {},
            news: [],
          });
        prohibited.push(`${method} ${url.pathname}`);
        return route.abort();
      }
      if (
        url.origin === origin &&
        method === "GET" &&
        (url.pathname === "/" ||
          /^\/(?:index\.html|app\.js|styles\.css|logo\.svg|favicon\.svg|candle_guide\.png|modules\/|assets\/)/.test(
            url.pathname,
          ))
      )
        return route.continue();
      if (method !== "GET" || url.pathname.startsWith("/api/")) {
        prohibited.push(`${method} ${url.pathname}`);
        return route.abort();
      }
      // Third-party charts/fonts are not part of an AI-response verification.
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: "",
      });
    });
    const started = Date.now();
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => state.lastAiResult && !state.isRunning,
      null,
      { timeout: 120000 },
    );
    const actual = await page.evaluate(() => ({
      aiUsed: state.lastAiResult.ai.aiUsed,
      direction: state.lastAiResult.data.researcher.direction,
      successful: state.lastAiResult.ai.debateSuccessful,
      distinctModels: state.lastAiResult.ai.debateDistinctModels,
      responses: state.lastAiResult.ai.debateResponses,
      failures: state.lastAiResult.ai.debateFailures,
      timings: state.lastAiResult.ai.timings,
    }));
    assert.equal(actual.aiUsed, true);
    assert.equal(actual.direction, "Stay Flat");
    assert.ok(
      actual.successful > 0,
      "The browser must receive genuine participant reviews",
    );
    assert.equal(actual.responses.length, actual.successful);
    assert.ok(await page.locator("#consensusPanel").isVisible());
    await page.locator("#viewDebateDetailsButton").click();
    assert.equal(
      await page.locator("#debateModelList button").count(),
      actual.successful,
    );
    const displayed = await page
      .locator("#debateModelOutputContainer")
      .innerText();
    assert.ok(displayed.includes(actual.responses[0].output));
    await page.locator("#tabDebateFailed").click();
    assert.equal(
      await page.locator("#tabDebateFailed").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(
      await page.locator("#debateModelList button").count(),
      actual.failures.length,
    );
    await page.locator("#tabDebateSuccess").click();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page
      .locator("#debateCouncilModal .password-card")
      .boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.x + bounds.width <= 391 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 845,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#debateCouncilModal").getAttribute("aria-hidden"),
      "true",
    );
    assert.deepEqual(completions, ["fast"]);
    assert.deepEqual(errors, []);
    assert.deepEqual(prohibited, []);
    emit({
      check: "browser-visible-no-data-debate",
      ok: true,
      successful: actual.successful,
      distinctModels: actual.distinctModels,
      models: [...new Set(actual.responses.map((entry) => entry.modelId))],
      timings: actual.timings,
      durationMs: Date.now() - started,
      successAndFailureTabs: true,
      mobileLayout: true,
      browserErrors: 0,
      marketData:
        "synthetic layout fixture; replaced with no-data prompt before real AI request",
      ignoredHistoryWrites,
      tradesExecuted: false,
    });
  } finally {
    await browser.close();
  }
};
