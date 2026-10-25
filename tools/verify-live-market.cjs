// Explicit opt-in verification of real OANDA -> server -> model -> browser data.
// Uses only /api/chat. No orders, bot commands, settings or history writes.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const assertMarketReply = require("./assert-market-reply.cjs");
const ORIGIN =
  process.env.AURUM_VERIFY_ORIGIN || "https://aurum-quant-ai.vercel.app";
const QUESTION = assertMarketReply.QUESTION;
const records = [];
const emit = (record) => {
  records.push(record);
  console.log("[LIVE-MARKET] " + JSON.stringify(record));
};
const recordReply = (check, payload, started) => {
  const market = assertMarketReply(payload);
  emit({
    check,
    ok: true,
    model: payload.model,
    marketStatus: market.status,
    provider: market.provider,
    environment: market.environment,
    quoteTime: market.quote.time,
    checkedAt: market.checkedAt,
    mid: market.quote.mid,
    candles: market.candles,
    durationMs: Date.now() - started,
    readOnly: true,
    tradesExecuted: false,
  });
  return market;
};
async function verifyHttp() {
  const configuration = await fetch(ORIGIN + "/api/chat", {
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(configuration.status, 200);
  const config = await configuration.json();
  assert.equal(config.marketData?.configured, true);
  assert.equal(config.marketData.readOnly, true);
  const started = Date.now();
  const response = await fetch(ORIGIN + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: QUESTION }],
      settings: { style: "concise", temperature: 0, marketContext: true },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.message || payload.code);
  recordReply("real-oanda-chat-http", payload, started);
}
async function verifyBrowser() {
  const { chromium } = require("playwright");
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
      prohibited = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (
        url.origin === ORIGIN &&
        url.pathname === "/api/chat" &&
        ["GET", "POST"].includes(request.method())
      )
        return route.continue();
      if (
        url.origin === ORIGIN &&
        request.method() === "GET" &&
        !url.pathname.startsWith("/api/")
      )
        return route.continue();
      prohibited.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    await page.goto(ORIGIN + "/chat.html", { waitUntil: "domcontentloaded" });
    await page
      .locator('#providerStatus[data-state="configured"]')
      .waitFor({ timeout: 30000 });
    assert.equal(await page.locator("#useMarketContext").isChecked(), true);
    await page.locator('input[name="responseStyle"][value="concise"]').check();
    await page.locator("#messageInput").fill(QUESTION);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/chat" &&
        response.request().method() === "POST",
      { timeout: 90000 },
    );
    const started = Date.now();
    await page.locator("#sendButton").click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const payload = await response.json();
    const market = assertMarketReply(payload);
    await page
      .locator(".message.assistant .market-evidence")
      .waitFor({ timeout: 10000 });
    const visible = await page
      .locator(".message.assistant .message-body")
      .last()
      .innerText();
    assert.ok(visible.trim().length > 30);
    const evidence = await page.locator(".market-evidence").last().innerText();
    assert.ok(evidence.includes(market.quote.time));
    assert.match(evidence, /OANDA · XAU\/USD · read-only/);
    if (market.status !== "live")
      assert.match(evidence, /last-known|Stale|Historical/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".market-evidence").last().scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.reload();
    await page.locator(".market-evidence").last().waitFor();
    assert.ok(
      (await page.locator(".market-evidence").last().innerText()).includes(
        market.quote.time,
      ),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(prohibited, []);
    recordReply("real-oanda-browser-answer-and-provenance", payload, started);
    emit({
      check: "browser-layout-and-history",
      ok: true,
      mobileLayout: true,
      provenancePreserved: true,
      browserErrors: 0,
      tradesExecuted: false,
    });
  } finally {
    await browser.close();
  }
}
(async () => {
  let failed = false;
  for (const [name, run] of [
    ["http", verifyHttp],
    ...(process.argv.includes("--browser") ? [["browser", verifyBrowser]] : []),
  ]) {
    try {
      await run();
    } catch (error) {
      failed = true;
      emit({
        check: name,
        ok: false,
        message: String(error.message).slice(0, 800),
      });
    }
  }
  const report = {
    checkedAt: new Date().toISOString(),
    origin: ORIGIN,
    ok: !failed,
    records,
    tradesExecuted: false,
  };
  if (process.env.AURUM_VERIFY_REPORT)
    await fs.writeFile(
      process.env.AURUM_VERIFY_REPORT,
      JSON.stringify(report, null, 2),
    );
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(String(error.message));
  process.exitCode = 1;
});
