// Opt-in public terminal verification. Actual market feed, actual browser-built
// prompt and actual AI response. History/trading/settings writes stay intercepted.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { chromium } = require("playwright");
const {
  assertTerminalSkillsReply,
} = require("./terminal-skills-live-check.cjs");
const ORIGIN =
  process.env.AURUM_VERIFY_ORIGIN || "https://aurum-quant-ai.vercel.app";
(async () => {
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
      requests = [];
    let blockedHistoryWrites = 0;
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
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      if (
        url.origin === ORIGIN &&
        url.pathname === "/api/chat" &&
        method === "GET"
      )
        return route.continue();
      if (
        url.origin === ORIGIN &&
        url.pathname === "/api/ai-decision" &&
        method === "POST"
      ) {
        const body = request.postDataJSON();
        assert.equal(body.terminalSkills?.enabled, true);
        assert.ok(
          body.terminalSkills.candles.length >= 15 &&
            body.terminalSkills.candles.length <= 256,
        );
        assert.equal(body.terminalSkills.riskBudgetUsd, null);
        assert.ok(!Object.hasOwn(body, "apiKey"));
        requests.push({
          promptChars: body.prompt.length,
          candles: body.terminalSkills.candles.length,
          mode: body.debateMode,
        });
        // No prompt replacement and no synthetic candles.
        return route.continue();
      }
      if (
        method === "GET" &&
        ["/api/settings", "/settings"].includes(url.pathname)
      )
        return route.fulfill({ json: { isAdmin: false, settings: {} } });
      if (url.hostname === "aurum-quant-edge.aurum-quant-ai.workers.dev") {
        if (
          method === "GET" &&
          ["/market-mtf", "/live-price"].includes(url.pathname)
        )
          return route.continue();
        if (method === "POST" && url.pathname === "/history-log") {
          blockedHistoryWrites++;
          return route.fulfill({ json: { ok: true, diagnosticOnly: true } });
        }
        if (method === "GET" && url.pathname === "/bot")
          return route.fulfill({
            json: {
              mode: "manual",
              botEnabled: false,
              config: { botMode: "manual", botEnabled: false },
              runtime: {},
              openTrades: [],
              recentHistory: [],
            },
          });
        if (
          method === "GET" &&
          ["/intel", "/options-intel", "/learning-feedback"].includes(
            url.pathname,
          )
        )
          return route.fulfill({
            json: { ok: true, entries: [], metrics: {}, rules: {}, news: [] },
          });
        prohibited.push(`${method} ${url.pathname}`);
        return route.abort();
      }
      if (
        url.origin === ORIGIN &&
        method === "GET" &&
        !url.pathname.startsWith("/api/")
      )
        return route.continue();
      if (method !== "GET" || url.pathname.startsWith("/api/")) {
        prohibited.push(`${method} ${url.pathname}`);
        return route.abort();
      }
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: "",
      });
    });
    const started = Date.now();
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/ai-decision" &&
        response.request().method() === "POST",
      { timeout: 120000 },
    );
    responsePromise.catch(() => {}); // Navigation errors must not leave an unhandled waiter.
    await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded" });
    const response = await responsePromise;
    const payload = await response.json();
    assert.equal(response.status(), 200, payload.message || payload.code);
    const details = await assertTerminalSkillsReply(payload);
    await page.waitForFunction(
      () => state.lastAiResult && !state.isRunning,
      null,
      { timeout: 10000 },
    );
    assert.match(
      await page.locator("#analysisSkillsRunStatus").innerText(),
      /included in this AI request/,
    );
    assert.ok(await page.locator("#analysisSkillsPanel").isVisible());
    assert.equal(
      await page.locator("#analysisSkillsMetrics article").count(),
      4,
    );
    assert.match(
      await page.locator("#analysisSkillsValidation").innerText(),
      /NOT RUN/,
    );
    assert.ok((await page.locator("#aiOutput").innerText()).length > 60);
    assert.equal(await page.locator("#analysisRiskBudget").inputValue(), "");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#analysisSkillsPanel").scrollIntoViewIfNeeded();
    const bounds = await page.locator("#analysisSkillsPanel").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert.equal(
      requests.length,
      1,
      "Research must not trigger another analysis request",
    );
    assert.deepEqual(prohibited, []);
    assert.deepEqual(errors, []);
    const report = {
      checkedAt: new Date().toISOString(),
      origin: ORIGIN,
      ok: true,
      ...details,
      requests,
      durationMs: Date.now() - started,
      browserErrors: 0,
      mobileLayout: true,
      blockedHistoryWrites,
      actualMarketPrompt: true,
      tradesExecuted: false,
    };
    console.log("[LIVE-TERMINAL-SKILLS] " + JSON.stringify(report));
    if (process.env.AURUM_VERIFY_REPORT)
      await fs.writeFile(
        process.env.AURUM_VERIFY_REPORT,
        JSON.stringify(report, null, 2),
      );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  const message = String(error.message).replace(
    /nvapi-[a-z0-9_-]+/gi,
    "[REDACTED]",
  );
  console.error("[LIVE-TERMINAL-SKILLS-FAILED] " + message.slice(-4000));
  process.exitCode = 1;
});
