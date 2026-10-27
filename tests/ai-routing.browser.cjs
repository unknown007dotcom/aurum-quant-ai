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
  const { evaluateTerminalSkills, terminalSkillsPrompt } = await import(
    "../modules/terminal-analysis-skills.mjs"
  );
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
    const candles = Array.from({ length: 1000 }, (_, i) => ({
      datetime: new Date(Date.now() - (1000 - i) * 900000).toISOString(),
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
    const successfulAnalysis = {
      model: LARGE,
      aiUsed: true,
      fallbackUsed: false,
      choices: [{ message: { content: JSON.stringify(plan) } }],
      debateUsed: false,
      debateAttempted: 0,
      debateSuccessful: 0,
    };
    let responsePayload = successfulAnalysis;
    let responseStatus = 200;
    let responseDelay = 0;
    let skillsModuleBlocked = false;
    const json = (route, payload) => route.fulfill({ json: payload });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        skillsModuleBlocked &&
        url.pathname === "/modules/terminal-analysis-skills.mjs"
      )
        return route.fulfill({ status: 404, body: "Not found" });
      if (url.pathname === "/api/chat") return json(route, config);
      if (url.pathname === "/api/ai-decision") {
        const body = request.postDataJSON();
        const review = evaluateTerminalSkills(body.terminalSkills);
        if (review) review.usedInPrompt = Boolean(terminalSkillsPrompt(review));
        calls.push({ url: request.url(), body });
        if (responseDelay)
          await new Promise((resolve) => setTimeout(resolve, responseDelay));
        return route.fulfill({
          status: responseStatus,
          json: {
            ...responsePayload,
            ...(review ? { analysisSkills: review } : {}),
            debateMode: request.postDataJSON().debateMode,
          },
        });
      }
      if (url.pathname === "/api/settings" || url.pathname === "/settings") {
        if (request.method() !== "GET")
          prohibited.push({ method: request.method(), path: url.pathname });
        return json(route, {
          isAdmin: false,
          isBasic: true,
          settings: {
            nvidiaModels: [
              { key: "legacy", id: RETIRED, label: "Retired model" },
            ],
            defaultModelKey: "legacy",
            botMode: "manual",
            botEnabled: false,
          },
        });
      }
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
        state.models.some(
          (model) => model.key === "fast" && model.id === "openai/gpt-oss-20b",
        ) && typeof window.syncAiBackendSettings === "function",
    );
    // Wait for the page's real automatic analysis, then measure an explicit
    // user run. No arbitrary sleep racing the 500ms initialization timer.
    await page.waitForFunction(() => state.lastAiResult && !state.isRunning);
    calls.length = 0;
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
    assert.ok(
      calls[0].body.prompt.length < 90000,
      "Market prompt must leave room for server-side learning context.",
    );
    assert.equal(calls[0].body.debateMode, "fast");
    assert.deepEqual(prohibited, []);
    assert.deepEqual(errors, []);

    assert.ok(await page.locator("#analysisSkillsPanel").isVisible());
    assert.equal(calls[0].body.terminalSkills.enabled, true);
    assert.equal(calls[0].body.terminalSkills.candles.length, 256);
    assert.equal(
      await page.locator("#analysisSkillsQualityValue").innerText(),
      "256 / 256",
    );
    assert.match(
      await page.locator("#analysisSkillsAtrValue").innerText(),
      /0\.6/,
    );
    assert.match(
      await page.locator("#analysisSkillsRunStatus").innerText(),
      /included in this AI request/,
    );
    assert.match(
      await page.locator("#analysisSkillsValidation").innerText(),
      /NOT RUN/,
    );
    await page.locator("#analysisRiskBudget").fill("50");
    await page.locator("#analysisRiskBudget").press("Tab");
    const beforeBudgetRun = calls.length;
    await page.evaluate(() => runAnalysis());
    assert.equal(
      calls.length,
      beforeBudgetRun + 1,
      "Skills must not fan out extra AI requests",
    );
    assert.equal(calls.at(-1).body.terminalSkills.riskBudgetUsd, 50);
    await page.locator("#analysisSkillsEnabled").uncheck();
    await page.evaluate(() => runAnalysis());
    assert.ok(!Object.hasOwn(calls.at(-1).body, "terminalSkills"));
    assert.equal(await page.locator("#aiBadge").innerText(), "COMPLETE");
    assert.match(
      await page.locator("#analysisSkillsBadge").innerText(),
      /^off$/i,
    );
    await page.reload();
    await page.waitForFunction(() => state.lastAiResult && !state.isRunning);
    assert.equal(
      await page.locator("#analysisSkillsEnabled").isChecked(),
      false,
    );
    assert.equal(await page.locator("#analysisRiskBudget").inputValue(), "50");
    await page.locator("#analysisSkillsEnabled").check();
    await page.evaluate(() => runAnalysis());
    await page.evaluate(() => {
      const review = JSON.parse(
        JSON.stringify(state.lastAiResult.ai.analysisSkills),
      );
      review.quality.issues = [
        '<img src=x onerror="window.skillsInjected=true">',
      ];
      renderTerminalSkills(
        review,
        "<script>window.skillsInjected=true</script>",
      );
    });
    assert.equal(
      await page
        .locator("#analysisSkillsPanel img, #analysisSkillsPanel script")
        .count(),
      0,
    );
    assert.ok(!(await page.evaluate(() => window.skillsInjected)));

    const partialCouncil = {
      ...successfulAnalysis,
      debateUsed: true,
      debatePlanned: 3,
      debateAttempted: 2,
      debateSuccessful: 2,
      debateNotice:
        "Two completed perspectives, one skipped role. Review evidence, not just vote counts.",
      timings: { debateMs: 1200, summaryMs: 2100, totalMs: 3300 },
      debateResponses: [
        {
          participantId: "role-1",
          modelId: FAST,
          modelLabel: '<img src=x onerror="window.debateInjected=true">',
          bias: "bullish",
          output:
            "Market data is missing. Verdict: WAIT. <script>window.debateInjected=true</script>",
          vote: "wait",
          durationMs: 500,
          modelFallbackUsed: true,
          requestedModelId: RETIRED,
        },
        {
          participantId: "role-2",
          modelId: LARGE,
          modelLabel: "Larger reviewer",
          bias: "bearish",
          output:
            "Bullish and bearish signals both need confirmation. No explicit vote.",
          vote: null,
          durationMs: 1200,
        },
      ],
      debateFailures: [
        {
          participantId: "role-1",
          modelId: RETIRED,
          modelLabel: "Unavailable model",
          role: "bullish",
          statusCode: 404,
          code: "model_unavailable",
          sanitizedError: "The requested model was removed.",
          durationMs: 52,
        },
        {
          participantId: "role-3",
          modelId: RETIRED,
          modelLabel: "Skipped reviewer",
          role: "redteam",
          skipped: true,
          code: "budget",
          statusCode: 504,
          sanitizedError: "Skipped to preserve the final-answer budget.",
          durationMs: 0,
        },
      ],
    };
    responsePayload = partialCouncil;
    await page.evaluate(() => runAnalysis());
    assert.ok(await page.locator("#consensusPanel").isVisible());
    assert.match(
      await page.locator("#debateRunSummary").innerText(),
      /2\/3 perspectives · 2 distinct models · debate 1.2s/,
    );
    assert.equal(await page.locator("#debateWaitVotes").innerText(), "1");
    assert.equal(await page.locator("#debateBuyVotes").innerText(), "0");
    assert.match(
      await page.locator("#debateRunNotice").innerText(),
      /no explicit verdict/,
    );
    await page.locator("#viewDebateDetailsButton").click();
    assert.equal(
      await page.locator("#debateCouncilModal").getAttribute("aria-hidden"),
      "false",
    );
    assert.equal(await page.locator("#debateModelList button").count(), 2);
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /Backup used:/,
    );
    assert.equal(await page.locator("#debateModelList img").count(), 0);
    assert.equal(
      await page.locator("#debateModelOutputContainer script").count(),
      0,
    );
    assert.ok(!(await page.evaluate(() => window.debateInjected)));
    await page.locator("#tabDebateFailed").click();
    assert.equal(
      await page.locator("#tabDebateFailed").getAttribute("aria-selected"),
      "true",
    );
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /404[\s\S]*removed/,
    );
    await page.locator("#debateModelList button").nth(1).click();
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /Skipped[\s\S]*final-answer budget/,
    );
    await page.locator("#tabDebateFailed").focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(
      await page.locator("#tabDebateSuccess").getAttribute("aria-selected"),
      "true",
    );
    if (process.env.AURUM_TEST_DEBATE_SCREENSHOTS)
      await page.screenshot({ path: "scratch/debate-desktop.png" });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#debateCouncilModal").getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "viewDebateDetailsButton",
    );

    // All failed, empty success tab, then a deliberately disabled council.
    responsePayload = {
      ...partialCouncil,
      debateResponses: [],
      debateSuccessful: 0,
      debateNotice:
        "All debate requests failed. Final analysis remains available.",
    };
    await page.evaluate(() => runAnalysis());
    assert.equal(await page.locator("#aiBadge").innerText(), "COMPLETE");
    await page.locator("#viewDebateDetailsButton").click();
    assert.equal(
      await page.locator("#tabDebateFailed").getAttribute("aria-selected"),
      "true",
    );
    await page.locator("#tabDebateSuccess").click();
    assert.equal(await page.locator("#debateModelList button").count(), 0);
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /All debate requests failed/,
    );
    await page.locator("#closeDebateCouncilModal").click();
    responsePayload = {
      ...successfulAnalysis,
      debateNotice: "Debate is off for this run.",
    };
    await page.evaluate(() => runAnalysis());
    await page.locator("#viewDebateDetailsButton").click();
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /Debate is off/,
    );
    await page.locator("#tabDebateFailed").click();
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /No failed or skipped/,
    );
    await page.locator("#closeDebateCouncilModal").click();

    // A failed summary does not erase genuine reviews or pretend to be AI.
    responseStatus = 502;
    responsePayload = {
      ...partialCouncil,
      choices: undefined,
      aiUsed: false,
      fallbackUsed: false,
      code: "invalid_analysis",
      message: "Final AI analysis failed.",
    };
    await page.evaluate(() => runAnalysis());
    assert.equal(await page.locator("#aiBadge").innerText(), "AI UNAVAILABLE");
    assert.equal(
      await page.locator("#analysisSkillsMetrics article").count(),
      4,
    );
    assert.match(
      await page.locator("#analysisSkillsRunStatus").innerText(),
      /AI did not complete/,
    );
    assert.equal(
      await page.evaluate(() => state.lastAiResult.ai.debateResponses.length),
      2,
    );
    assert.equal(await page.evaluate(() => state.isRunning), false);
    responseStatus = 200;
    responsePayload = partialCouncil;
    responseDelay = 1500;
    const pendingAnalysis = page.evaluate(() => runAnalysis());
    await page.waitForFunction(() =>
      document.getElementById("statusText").textContent.includes("elapsed"),
    );
    await pendingAnalysis;
    responseDelay = 0;
    assert.equal(await page.locator("#aiBadge").innerText(), "COMPLETE");
    const finishedStatus = await page.locator("#statusText").innerText();
    // Wait one timer tick specifically to detect a leaked progress interval.
    await page.waitForTimeout(1100);
    assert.equal(await page.locator("#statusText").innerText(), finishedStatus);

    // Real controls, including mocked BASIC authorization; never save server
    // settings or touch a trading command just to change a browser preference.
    await page.locator("#settingsToggle").click();
    await page.locator("#passwordInput").fill("test-only-password");
    await page.locator("#submitPasswordButton").click();
    await page.locator("#settingsPanel.open").waitFor();
    assert.match(
      await page.locator("#debateModeSelect .custom-select-button").innerText(),
      /Fast/,
    );
    for (const mode of ["full", "off", "deep"]) {
      await page.locator("#debateModeSelect .custom-select-button").click();
      await page.locator(`#debateModeSelect [data-value="${mode}"]`).click();
      assert.equal(await page.evaluate(() => state.debateMode), mode);
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("xauusd-analyzer-settings-v1"))
              .debateMode,
        ),
        mode,
      );
    }
    await page.locator("#closeSettings").click();
    await page.evaluate(() => runAnalysis());
    assert.equal(calls.at(-1).body.debateMode, "deep");
    await page.reload();
    await page.waitForFunction(() => state.lastAiResult && !state.isRunning);
    assert.equal(await page.evaluate(() => state.debateMode), "deep");
    assert.equal(calls.at(-1).body.debateMode, "deep");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#viewDebateDetailsButton").click();
    assert.ok(await page.locator("#tabDebateSuccess").isVisible());
    assert.ok(await page.locator("#tabDebateFailed").isVisible());
    await page.locator("#tabDebateFailed").click();
    await page.locator("#debateModelList button").nth(1).click();
    assert.match(
      await page.locator("#debateModelOutputContainer").innerText(),
      /Skipped/,
    );
    const bounds = await page
      .locator("#debateCouncilModal .password-card")
      .boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 845);
    if (process.env.AURUM_TEST_DEBATE_SCREENSHOTS)
      await page.screenshot({ path: "scratch/debate-mobile.png" });
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    assert.deepEqual(prohibited, []);
    await page.keyboard.press("Escape");
    await page.locator("#analysisSkillsPanel").scrollIntoViewIfNeeded();
    const skillsBounds = await page
      .locator("#analysisSkillsPanel")
      .boundingBox();
    assert.ok(
      skillsBounds.x >= 0 && skillsBounds.x + skillsBounds.width <= 391,
    );
    if (process.env.AURUM_TEST_DEBATE_SCREENSHOTS)
      await page.screenshot({ path: "scratch/terminal-skills-mobile.png" });
    skillsModuleBlocked = true;
    await page.reload();
    await page.waitForFunction(() => state.lastAiResult && !state.isRunning);
    assert.ok(!Object.hasOwn(calls.at(-1).body, "terminalSkills"));
    assert.equal(await page.locator("#aiBadge").innerText(), "COMPLETE");
    assert.match(
      await page.locator("#analysisSkillsRunStatus").innerText(),
      /Research checks unavailable/,
    );
    skillsModuleBlocked = false;
    await page.reload();
    await page.waitForFunction(() => state.lastAiResult && !state.isRunning);
    assert.equal(calls.at(-1).body.terminalSkills.enabled, true);
    assert.deepEqual(prohibited, []);
    assert.deepEqual(errors, []);
    await page.evaluate(() => document.getElementById("analysisSkillsMetrics").remove());
    await page.evaluate(() => runAnalysis());
    assert.equal(await page.locator("#aiBadge").innerText(), "COMPLETE");
    assert.equal(await page.evaluate(() => state.isRunning), false);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Main-page research checks, bounded request input, opt-out and budget persistence, safe rendering, mobile layout, AI-failure disclosure and optional-module failure/recovery. No new provider or trading calls.",
    );
    console.log(
      "PASS: Debate tabs, partial/all-failed/empty states, safe text rendering, summary failure recovery, progress timer, saved modes, keyboard and mobile layout.",
    );
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
