// Exercises the real terminal controller with mocked market/provider HTTP only.
// No live AI call, trading command, or order is sent by this test.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const FAST = "openai/gpt-oss-20b";
const LARGE = "openai/gpt-oss-120b";
const RETIRED = "meta/llama-3.1-70b-instruct";
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://test.invalid").pathname;
    const file = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
    const roots = [
      "/",
      "/index.html",
      "/app.js",
      "/styles.css",
      "/logo.svg",
      "/favicon.svg",
      "/candle_guide.png",
    ];
    if (
      !roots.includes(pathname) &&
      !/^\/(assets|modules)\/[^.]/.test(pathname)
    ) {
      res.writeHead(404);
      return res.end();
    }
    const body = await fs.readFile(file);
    const type = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
      ".png": "image/png",
      ".webp": "image/webp",
    }[path.extname(file)];
    res.writeHead(200, { "Content-Type": type || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  let browser;
  try {
    const options = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE_PATH)
      Object.assign(options, {
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        args: ["--no-sandbox", "--no-zygote", "--single-process"],
      });
    browser = await chromium.launch(options);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      // Chart painting is unrelated to request routing. Keep its API callable
      // without downloading a third-party CDN library in CI.
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
    const calls = [];
    const errors = [];
    const prohibited = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const candles = Array.from({ length: 240 }, (_, i) => ({
      datetime: new Date(Date.UTC(2026, 9, 19) + i * 900000).toISOString(),
      open: 4000 + i * 0.15,
      close: 4000.08 + i * 0.15,
      high: 4000.4 + i * 0.15,
      low: 3999.8 + i * 0.15,
      volume: 100,
      complete: true,
    }));
    const plan = {
      researcher: {
        summary: "Test analysis only. Stay flat.",
        direction: "Stay Flat",
        riskNote: "Synthetic test data.",
      },
      trader: {
        entryZone: "N/A",
        takeProfitLevels: "N/A",
        stopLoss: "N/A",
        positionSizing: "N/A",
        timeHorizon: "N/A",
        invalidation: "Reassess using real market data.",
      },
      equations: { review: "Test only." },
    };
    const config = {
      configured: true,
      defaultModelKey: "fast",
      models: [
        { key: "fast", id: FAST, label: "GPT-OSS 20B" },
        { key: "large", id: LARGE, label: "GPT-OSS 120B" },
      ],
    };
    const json = (route, payload) => route.fulfill({ json: payload });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/chat") return json(route, config);
      if (url.pathname === "/api/ai-decision") {
        calls.push({ url: request.url(), body: request.postDataJSON() });
        return json(route, {
          model: LARGE,
          aiUsed: true,
          fallbackUsed: false,
          choices: [{ message: { content: JSON.stringify(plan) } }],
          debateUsed: false,
          debateAttempted: 0,
          debateSuccessful: 0,
        });
      }
      if (url.pathname === "/api/settings" || url.pathname === "/settings")
        return json(route, {
          isAdmin: false,
          settings: {
            nvidiaModels: [
              { key: "legacy", id: RETIRED, label: "Retired model" },
            ],
            defaultModelKey: "legacy",
            botMode: "manual",
            botEnabled: false,
          },
        });
      if (url.hostname.endsWith("workers.dev")) {
        if (request.method() !== "GET" && url.pathname !== "/history-log")
          prohibited.push({ method: request.method(), path: url.pathname });
        if (url.pathname === "/market-mtf")
          return json(route, {
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
        if (url.pathname === "/bot")
          return json(route, {
            botEnabled: false,
            mode: "manual",
            config: { botMode: "manual", botEnabled: false },
            runtime: {},
            openTrades: [],
            recentHistory: [],
          });
        if (url.pathname === "/live-price")
          return json(route, { price: 4035.93, instrument: "XAU_USD" });
        return json(route, {
          ok: true,
          entries: [],
          metrics: {},
          rules: {},
          news: [],
        });
      }
      if (url.hostname === "127.0.0.1") return route.continue();
      return route.fulfill({
        contentType: url.pathname.endsWith(".css")
          ? "text/css"
          : "application/javascript",
        body: "",
      });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.waitForFunction(
      () =>
        state.models.some((model) => model.id === "openai/gpt-oss-20b") &&
        typeof window.syncAiBackendSettings === "function",
    );
    const endpoints = await page.evaluate(() => ({
      ai: apiUrl("/ai-decision"),
      market: apiUrl("/market-mtf"),
      ids: state.models.map((model) => model.id),
    }));
    assert.equal(endpoints.ai, "/api/ai-decision");
    assert.match(endpoints.market, /workers\.dev\/market-mtf$/);
    assert.ok(endpoints.ids.includes(LARGE));
    assert.ok(!endpoints.ids.includes(RETIRED));
    await page.evaluate(() => {
      state.selectedModelKey = "large";
      state.models.find((model) => model.key === "large").apiKey =
        "browser-test-secret";
      saveLocalSettings();
    });
    assert.ok(
      !(
        await page.evaluate(() =>
          localStorage.getItem("xauusd-analyzer-settings-v1"),
        )
      ).includes("browser-test-secret"),
    );
    await page.evaluate(() => runAnalysis());
    assert.equal(
      calls.length,
      1,
      `Expected one AI request; status: ${await page.locator("#statusText").innerText()}; errors: ${errors.join(" | ")}`,
    );
    assert.equal(new URL(calls[0].url).origin, base);
    assert.equal(calls[0].body.model, LARGE);
    assert.equal(calls[0].body.selectedModelKey, "large");
    assert.ok(!JSON.stringify(calls[0].body).includes("browser-test-secret"));
    assert.ok(!Object.hasOwn(calls[0].body, "apiKey"));
    assert.ok(!Object.hasOwn(calls[0].body, "baseUrl"));
    assert.ok(calls[0].body.prompt.length > 0);
    assert.deepEqual(prohibited, []);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Terminal analysis uses the same-origin AI backend, preserves model IDs, and sends no credentials or trading commands.",
    );
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
