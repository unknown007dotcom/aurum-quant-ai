// Real Chat controller, safe source cards and responsive news desk. Network is
// completely isolated: controlled RSS snapshot/API replies, no provider/broker calls.
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const STORAGE = "aurum-chat-workspace-v1";
const types = {
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
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
    });
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
const frame = (name, payload) =>
  `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
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
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [],
      forbidden = [],
      posts = [];
    let state = "available",
      newsRequests = 0,
      networkFailure = false;
    const snapshot = () => {
      const checkedAt = new Date().toISOString();
      return {
        type: "market_news",
        readOnly: true,
        status: state,
        checkedAt,
        cached: state === "stale",
        apiKey: "PRIVATE",
        raw: "PRIVATE",
        items:
          state === "empty" || state === "unavailable"
            ? []
            : [
                {
                  id: "fixture-gold",
                  citation: "N1",
                  title:
                    'TEST fixture: Gold and the dollar <img src=x onerror="window.injected=true">',
                  url: "https://www.investing.com/news/commodities-news/test-fixture",
                  sourceId: "investing-commodities",
                  source: "SPOOFED SOURCE",
                  topic: "gold",
                  publishedAt: new Date(
                    Date.now() - (state === "stale" ? 4 * 86400000 : 60000),
                  ).toISOString(),
                  fetchedAt: checkedAt,
                  cached: state === "partial" || state === "stale",
                  privateKey: "PRIVATE",
                },
                {
                  id: "fixture-fed",
                  citation: "N2",
                  title: "TEST fixture: Federal Reserve policy update",
                  url: "https://www.federalreserve.gov/newsevents/pressreleases/test-fixture.htm",
                  sourceId: "fed-policy",
                  publishedAt: null,
                  fetchedAt: checkedAt,
                },
                {
                  id: "bad-link",
                  citation: "N3",
                  title: "Unsafe URL",
                  url: "javascript:alert(1)",
                  sourceId: "investing-commodities",
                },
                {
                  id: "bad-host",
                  title: "Spoofed publisher",
                  url: "https://evil.example",
                  sourceId: "bbc-business",
                },
              ],
        sources: [
          {
            id: "investing-commodities",
            status: state === "partial" ? "stale" : "ok",
            checkedAt,
            fetchedAt: checkedAt,
          },
          { id: "fed-policy", status: "ok", checkedAt, fetchedAt: checkedAt },
        ],
      };
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin) {
        forbidden.push(req.url());
        return route.abort();
      }
      if (url.pathname === "/api/market-news") {
        newsRequests++;
        assert.equal(req.method(), "GET");
        assert.equal(url.search, "");
        assert.equal(req.headers().authorization, undefined);
        if (networkFailure) return route.abort();
        return route.fulfill({ json: snapshot() });
      }
      if (url.pathname === "/api/chat") {
        if (req.method() === "GET")
          return route.fulfill({
            json: {
              configured: true,
              defaultModelKey: "test",
              models: [
                {
                  key: "test",
                  id: "example/news-instruct",
                  label: "Test model",
                },
              ],
              newsData: { available: true, readOnly: true },
            },
          });
        const body = req.postDataJSON();
        posts.push(body);
        const reply = {
          content:
            "The supplied headline may matter for market sentiment; it is not a guaranteed gold-price move. [N1]",
          model: "example/news-instruct",
          ...(body.settings.newsContext ? { news: snapshot() } : {}),
        };
        return route.fulfill({
          contentType: "text/event-stream",
          body:
            frame("start", { model: reply.model, news: reply.news }) +
            frame("delta", { text: reply.content }) +
            frame("done", reply),
        });
      }
      if (url.pathname.startsWith("/api/")) {
        forbidden.push(req.url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin + "/chat.html");
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    await page.locator('#marketNewsPanel[data-status="available"]').waitFor();
    await page.evaluate(() =>
      localStorage.setItem("xauusd-analyzer-settings-v1", '{"untouched":true}'),
    );
    await page
      .getByRole("button", { name: "Open market news", exact: true })
      .click();
    assert.equal(
      await page.locator("#marketNewsPanel").getAttribute("open"),
      "",
    );
    assert.equal(await page.locator("#newsList .news-item").count(), 2);
    assert.equal(await page.locator("#newsList img").count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.match(await page.locator("#newsList").innerText(), /Investing.com/);
    assert.doesNotMatch(
      await page.locator("#newsList").innerText(),
      /SPOOFED SOURCE|Unsafe URL|Spoofed publisher/,
    );
    assert.match(
      await page.locator("#newsList").innerText(),
      /Publication time unverified/,
    );
    for (const link of await page.locator("#newsList a").all()) {
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match(await link.getAttribute("rel"), /noopener/);
      assert.match(
        await link.getAttribute("href"),
        /^https:\/\/(www\.investing\.com|www\.federalreserve\.gov)\//,
      );
    }
    assert.match(
      await page.locator("#newsUpdatedAt").innerText(),
      /Feed check:/,
    );
    console.log(
      "PASS: Timestamped publisher-linked headlines render safely; no HTML execution, spoofed sources or unsafe links.",
    );

    await page.locator("#askNewsButton").click();
    assert.equal(
      posts.length,
      0,
      "Opening/discussing the feed must not silently spend AI requests",
    );
    assert.match(await page.locator("#messageInput").inputValue(), /XAU\/USD/);
    await page.locator("#sendButton").click();
    await page
      .locator(".message.assistant:not([data-streaming]) .news-evidence")
      .waitFor();
    assert.equal(posts[0].settings.newsContext, true);
    assert.equal(posts[0].news, undefined);
    const saved = async () =>
      page.evaluate((key) => {
        const state = JSON.parse(localStorage.getItem(key));
        return state.conversations.find((chat) => chat.id === state.activeId);
      }, STORAGE);
    let chat = await saved();
    assert.equal(chat.messages.at(-1).news.items.length, 2);
    assert.doesNotMatch(
      JSON.stringify(chat.messages.at(-1).news),
      /PRIVATE|javascript:|evil\.example/,
    );
    await page.locator(".news-evidence summary").click();
    assert.match(
      await page.locator(".news-evidence").innerText(),
      /Historical snapshot/,
    );
    assert.equal(await page.locator(".news-evidence a").count(), 2);
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.__copied = text;
        },
      }),
    );
    await page.getByRole("button", { name: "Copy assistant response" }).click();
    assert.match(
      await page.evaluate(() => window.__copied),
      /News sources for this reply/,
    );
    assert.match(
      await page.evaluate(() => window.__copied),
      /https:\/\/www.federalreserve.gov/,
    );
    console.log(
      "PASS: News context reaches the request, with safe source provenance persisted and copied alongside the answer.",
    );

    for (const next of ["partial", "stale", "empty", "unavailable"]) {
      state = next;
      await page.locator("#refreshNewsButton").click();
      await page.locator(`#marketNewsPanel[data-status="${next}"]`).waitFor();
      if (next === "partial")
        assert.match(await page.locator("#newsList").innerText(), /Cached/);
      if (next === "stale")
        assert.match(await page.locator("#newsList").innerText(), /Older item/);
      if (["empty", "unavailable"].includes(next))
        assert.equal(await page.locator("#newsList .news-item").count(), 0);
    }
    state = "available";
    await page.locator("#refreshNewsButton").click();
    await page.locator('#marketNewsPanel[data-status="available"]').waitFor();
    networkFailure = true;
    await page.locator("#refreshNewsButton").click();
    await page.locator('#marketNewsPanel[data-status="stale"]').waitFor();
    assert.match(await page.locator("#newsList").innerText(), /Cached/);
    networkFailure = false;
    console.log(
      "PASS: Partial, stale, empty, unavailable and transport-failure states never claim breaking/live news.",
    );

    for (const width of [1440, 1024, 900, 820, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page
        .getByRole("button", { name: "Open market news", exact: true })
        .click();
      const layout = await page
        .locator("#marketNewsPanel")
        .evaluate((el) => ({
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
          width: el.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
      assert.equal(layout.overflow, false, `Page overflow at ${width}px`);
      assert.ok(
        layout.left >= 0 && layout.right <= width && layout.width > 180,
        `News panel at ${width}px`,
      );
      if (width <= 640) {
        assert.equal(
          await page.locator("#chatSettingsPanel").getAttribute("aria-modal"),
          "true",
        );
        await page.keyboard.press("Escape");
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          "newsJumpButton",
        );
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page
      .getByRole("button", { name: "Open market news", exact: true })
      .click();
    console.log(
      "PASS: News desk remains readable at seven desktop/mobile widths; keyboard drawer focus is restored.",
    );

    await page.locator("#useNewsContext").uncheck();
    await page.locator('#marketNewsPanel[data-status="off"]').waitFor();
    assert.equal(await page.locator("#refreshNewsButton").isDisabled(), true);
    const before = newsRequests;
    await page.reload();
    await page.locator('#marketNewsPanel[data-status="off"]').waitFor();
    assert.equal(
      newsRequests,
      before,
      "Opt-out must suppress automatic fetch on reload",
    );
    assert.equal((await saved()).settings.newsContext, false);
    await page.locator("#messageInput").fill("Explain a reading list.");
    await page.locator("#sendButton").click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".message.assistant:not([data-streaming])")
          .length === 2,
    );
    assert.equal(posts.at(-1).settings.newsContext, false);
    assert.equal(
      await page
        .locator(".message.assistant")
        .last()
        .locator(".news-evidence")
        .count(),
      0,
    );
    assert.equal(
      (await saved()).messages[1].news.items.length,
      2,
      "Opt-out must not erase historical sources",
    );
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem("xauusd-analyzer-settings-v1"),
      ),
      '{"untouched":true}',
    );
    console.log(
      "PASS: Per-conversation opt-out persists, stops feed requests, and does not erase history or trading settings.",
    );

    await page.locator("#useNewsContext").check();
    await page
      .getByRole("button", { name: "Open market news", exact: true })
      .click();
    await page.locator("#refreshNewsButton").click();
    await page.locator('#marketNewsPanel[data-status="available"]').waitFor();
    const hiddenCount = newsRequests;
    await page.evaluate(() => {
      window.__hidden = true;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (window.__hidden ? "hidden" : "visible"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.locator("#refreshNewsButton").click();
    assert.equal(newsRequests, hiddenCount);
    const resumed = page.waitForResponse((response) =>
      response.url().endsWith("/api/market-news"),
    );
    await page.evaluate(() => {
      const old = Date.now;
      Date.now = () => old() + 181000;
      window.__hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await resumed;
    if (process.env.NEWS_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.NEWS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.NEWS_SCREENSHOT_DIR, "news-desktop.png"),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page
        .getByRole("button", { name: "Open market news", exact: true })
        .click();
      await page.screenshot({
        path: path.join(process.env.NEWS_SCREENSHOT_DIR, "news-mobile.png"),
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    console.log(
      "PASS: Hidden-page polling pauses and resumes when due. No browser exceptions, third-party browser fetches or trading API calls.",
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  server.close();
});
