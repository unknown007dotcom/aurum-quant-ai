// Real chat controller + isolated mocked AI/market evidence; no real APIs/orders.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://test.invalid").pathname;
    if (
      !["/chat.html", "/chat.js", "/chat.css", "/favicon.svg"].includes(
        pathname,
      ) &&
      !/^\/(assets|modules)\/[\w-]/.test(pathname)
    ) {
      res.writeHead(404);
      return res.end();
    }
    const file = path.join(ROOT, pathname);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    });
    res.end(await fs.readFile(file));
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
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [],
      posts = [],
      forbidden = [];
    let marketStatus = "live",
      failChat = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin) {
        forbidden.push(req.url());
        return route.abort();
      }
      if (url.pathname === "/api/chat") {
        if (req.method() === "GET")
          return route.fulfill({
            json: {
              configured: true,
              models: [
                { key: "main", id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
              ],
              defaultModelKey: "main",
              marketData: {
                configured: true,
                readOnly: true,
                provider: "OANDA",
                instrument: "XAU_USD",
              },
            },
          });
        const body = req.postDataJSON();
        posts.push(body);
        if (failChat)
          return route.fulfill({
            status: 503,
            json: { message: "Simulated AI interruption. Retry is available." },
          });
        const now = Date.now();
        const market =
          marketStatus === "none" || !body.settings.marketContext
            ? null
            : {
                provider: "OANDA",
                instrument: "XAU_USD",
                readOnly: true,
                status: marketStatus,
                environment: "practice",
                checkedAt: new Date(now).toISOString(),
                cached: false,
                quote:
                  marketStatus === "unavailable"
                    ? null
                    : {
                        bid: 4001.15,
                        ask: 4001.35,
                        mid: 4001.25,
                        time: new Date(
                          now - (marketStatus === "live" ? 1000 : 86400000),
                        ).toISOString(),
                        tradeable: marketStatus !== "market_closed",
                      },
                error:
                  marketStatus === "unavailable"
                    ? {
                        code: "unauthorized",
                        message: '<img src=x onerror="window.injected=true">',
                      }
                    : undefined,
                accountId: "MUST-NOT-BE-STORED",
                apiKey: "MUST-NOT-BE-STORED",
              };
        return route.fulfill({
          json: {
            content:
              "A response to your question, with the available evidence.",
            model: "openai/gpt-oss-20b",
            ...(market ? { market } : {}),
          },
        });
      }
      if (req.method() !== "GET" || url.pathname.startsWith("/api/")) {
        forbidden.push(req.url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin + "/chat.html");
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    assert.equal(await page.locator("#useMarketContext").isChecked(), true);
    assert.match(
      await page.locator("#marketContextNote").innerText(),
      /Read-only OANDA/,
    );
    async function send(text) {
      const before = await page
        .locator(".message.assistant .message-body")
        .count();
      await page.waitForFunction(
        () =>
          !document.querySelector(".typing-indicator") &&
          !document.getElementById("messageInput").readOnly,
      );
      await page.locator("#messageInput").fill(text);
      assert.equal(await page.locator("#messageInput").inputValue(), text);
      await page.locator("#sendButton").click({ timeout: 5000 });
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll(".message.assistant .message-body").length >
            count || !document.getElementById("chatError").hidden,
        before,
      );
    }
    await send("What is the XAU/USD quote?");
    let card = page.locator(".market-evidence").last();
    assert.equal(await card.getAttribute("data-status"), "live");
    assert.match(
      await card.innerText(),
      /OANDA · XAU\/USD · read-only · practice feed/,
    );
    assert.match(await card.innerText(), /Mid \$4,001.250/);
    assert.match(await card.innerText(), /Quote .*UTC.*Not streaming/s);
    assert.equal(posts.at(-1).settings.marketContext, true);
    assert.ok(!JSON.stringify(posts).includes("OANDA_API_TOKEN"));
    await page.reload();
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    assert.equal(await page.locator(".market-evidence").count(), 1);
    const stored = await page.evaluate(() =>
      localStorage.getItem("aurum-chat-workspace-v1"),
    );
    assert.ok(!stored.includes("MUST-NOT-BE-STORED"));
    await page.addInitScript(() => {
      const key = "aurum-chat-workspace-v1";
      const state = JSON.parse(localStorage.getItem(key) || "null");
      const message = state?.conversations
        ?.flatMap((chat) => chat.messages)
        .find((message) => message.market?.quote);
      if (message) {
        message.market.quote.time = new Date(Date.now() - 600000).toISOString();
        localStorage.setItem(key, JSON.stringify(state));
      }
    });
    await page.reload();
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    assert.match(
      await page.locator(".market-evidence").first().innerText(),
      /Historical snapshot · not a live price/,
    );
    await page.locator("#useMarketContext").uncheck();
    await send("Gold price with market lookup disabled?");
    assert.equal(posts.at(-1).settings.marketContext, false);
    assert.equal(
      await page
        .locator(".message.assistant")
        .last()
        .locator(".market-evidence")
        .count(),
      0,
    );
    await page.reload();
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    assert.equal(await page.locator("#useMarketContext").isChecked(), false);
    await page.locator("#useMarketContext").check();
    marketStatus = "market_closed";
    await send("Is the gold market open?");
    assert.match(
      await page.locator(".market-evidence").last().innerText(),
      /Not tradeable when checked · last-known quote/,
    );
    marketStatus = "unavailable";
    await send("Can you retrieve OANDA now?");
    assert.equal(await page.locator("#chatError").isHidden(), true);
    assert.match(
      await page.locator(".market-evidence").last().innerText(),
      /OANDA rejected the server connection/,
    );
    assert.equal(await page.evaluate(() => window.injected || false), false);
    assert.ok(
      !(await page.locator(".market-evidence").last().innerText()).includes(
        "<img",
      ),
    );
    marketStatus = "none";
    await send("Hello Mira. Explain how you can help.");
    assert.equal(
      await page
        .locator(".message.assistant")
        .last()
        .locator(".market-evidence")
        .count(),
      0,
    );
    failChat = true;
    await send("A request with a simulated AI failure");
    assert.match(
      await page.locator("#chatErrorText").innerText(),
      /Simulated AI interruption/,
    );
    failChat = false;
    await page.locator("#retryButton").click();
    await page.waitForFunction(
      () =>
        document.getElementById("chatError").hidden &&
        !document.querySelector(".typing-indicator"),
    );
    marketStatus = "live";
    await send("Fetch a fresh XAU/USD quote again");
    for (const width of [641, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator(".market-evidence").last().scrollIntoViewIfNeeded();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      const box = await page.locator(".market-evidence").last().boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    }
    await page.locator("#chatSettingsToggle").click();
    await page.locator("#useMarketContext").uncheck();
    assert.equal(await page.locator("#useMarketContext").isChecked(), false);
    await page.locator("#chatSettingsPanel [data-close-drawer]").click();
    if (process.env.CHAT_MARKET_SCREENSHOT)
      await page.screenshot({ path: process.env.CHAT_MARKET_SCREENSHOT });
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    console.log(
      "PASS: Read-only OANDA provenance, timestamps, closed/stale/unavailable states, opt-out persistence, ordinary-chat and error recovery, safe metadata, mobile layout; no broker/order calls from the browser.",
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
