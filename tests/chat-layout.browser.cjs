// Run with `npm run test:chat-layout` after `npx playwright install chromium`.
// Uses a temporary static server and mocked AI responses: no live provider calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://test.invalid").pathname;
    const file = path.resolve(ROOT, `.${pathname}`);
    const allowed =
      [
        "chat.html",
        "chat.css",
        "chat.js",
        "favicon.svg",
        "modules/chat-store.mjs",
      ].some((name) => file === path.join(ROOT, name)) ||
      file.startsWith(path.join(ROOT, "assets") + path.sep);
    if (!allowed) {
      res.writeHead(404);
      return res.end();
    }
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

async function screenshot(page, name) {
  if (!process.env.CHAT_SCREENSHOT_DIR) return;
  await fs.mkdir(process.env.CHAT_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(process.env.CHAT_SCREENSHOT_DIR, `${name}.png`),
  });
}

async function layout(page) {
  return page.evaluate(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        bottom: rect.bottom,
        visible: style.visibility !== "hidden" && style.display !== "none",
        inert: el.inert,
        ariaHidden: el.getAttribute("aria-hidden"),
        modal: el.getAttribute("aria-modal"),
      };
    };
    return {
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      scrollY,
      settings: box("chatSettingsPanel"),
      history: box("historyPanel"),
      chat: box("conversationMain"),
      composer: box("composerForm"),
    };
  });
}

async function run() {
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  let browser;
  try {
    const options = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE_PATH) {
      options.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
      options.args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process",
      ];
    }
    browser = await chromium.launch(options);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const pageErrors = [];
    const posts = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/chat", (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            models: [{ key: "test", id: "test/model", label: "Test model" }],
            defaultModelKey: "test",
            configured: true,
          },
        });
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          content: "The settings panel is working.",
          model: "test/model",
        },
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/chat.html`);
    await page.locator('#providerStatus[data-state="configured"]').waitFor();

    for (const width of [
      1920, 1440, 1366, 1280, 1181, 1180, 1100, 1024, 1000, 960, 900, 899, 820,
      801, 800, 768, 700, 641,
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(
        () =>
          !document.getElementById("chatSettingsPanel").inert &&
          document.getElementById("historyPanel").inert ===
            matchMedia("(max-width: 899px)").matches,
      );
      const view = await layout(page);
      assert.equal(
        view.settings.visible,
        true,
        `Settings hidden at ${width}px`,
      );
      assert.notEqual(
        view.settings.ariaHidden,
        "true",
        `Settings inaccessible at ${width}px`,
      );
      assert.equal(view.settings.inert, false);
      assert.ok(
        Math.abs(view.settings.right - width) < 2,
        `Settings not right-aligned at ${width}px`,
      );
      assert.ok(
        view.settings.left >= view.chat.right - 1,
        `Settings overlays chat at ${width}px`,
      );
      assert.ok(
        view.settings.width >= 230,
        `Settings too narrow at ${width}px`,
      );
      assert.ok(view.chat.width >= 390, `Chat too narrow at ${width}px`);
      assert.ok(
        view.composer.right <= view.chat.right + 1,
        `Composer overlaps settings at ${width}px`,
      );
      assert.equal(
        view.history.visible,
        width >= 900,
        `History breakpoint mismatch at ${width}px`,
      );
      assert.equal(
        view.history.inert,
        width < 900,
        `History accessibility mismatch at ${width}px`,
      );
      assert.equal(view.overflow, false, `Horizontal overflow at ${width}px`);
      assert.equal(view.scrollY, 0, `Page scroll at ${width}px`);
      assert.equal(
        await page.locator("#chatSettingsToggle").isVisible(),
        false,
      );
      if ([1280, 1024, 900, 800, 641].includes(width))
        await screenshot(page, `docked-${width}`);
    }
    console.log(
      "PASS: Settings remains visible and right-aligned across 18 desktop/tablet widths.",
    );

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator("#chatModel").selectOption("test");
    await page.locator('[name="responseStyle"][value="detailed"]').check();
    await page.locator("#messageInput").fill("Test the docked settings.");
    await page.locator("#sendButton").click();
    await page
      .getByText("The settings panel is working.", { exact: true })
      .waitFor();
    assert.equal(posts[0].modelKey, "test");
    assert.equal(posts[0].settings.style, "detailed");
    await page.reload();
    await page.locator(".message.assistant").waitFor();
    assert.equal((await layout(page)).settings.inert, false);
    assert.equal(
      await page
        .locator('[name="responseStyle"][value="detailed"]')
        .isChecked(),
      true,
    );
    console.log(
      "PASS: Docked controls work, affect requests, and survive reload.",
    );

    for (const width of [640, 600, 520, 430, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(
        () => document.getElementById("chatSettingsPanel").inert,
      );
      assert.equal((await layout(page)).settings.visible, false);
      const toggle = page.locator("#chatSettingsToggle");
      assert.equal(await toggle.isVisible(), true);
      assert.match(await toggle.innerText(), /Settings/);
      await toggle.click();
      const opened = await layout(page);
      assert.equal(opened.settings.visible, true);
      assert.equal(opened.settings.inert, false);
      assert.equal(opened.settings.modal, "true");
      assert.equal(opened.chat.inert, true);
      assert.ok(Math.abs(opened.settings.right - width) < 2);
      assert.equal(opened.overflow, false);
      if (width === 390) await screenshot(page, "phone-settings-open");
      await page.keyboard.press("Escape");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(
        await toggle.evaluate((el) => el === document.activeElement),
        true,
      );
      if (width === 390) await screenshot(page, "phone-settings-button");
    }
    console.log(
      "PASS: Phones show a labeled Settings control and an accessible right-hand drawer.",
    );

    // An open modal must become a normal, interactive sidebar when resizing.
    await page.setViewportSize({ width: 640, height: 844 });
    await page.locator("#chatSettingsToggle").click();
    await page.setViewportSize({ width: 641, height: 844 });
    await page.waitForFunction(
      () => !document.getElementById("conversationMain").inert,
    );
    assert.equal((await layout(page)).settings.modal, null);
    assert.equal((await layout(page)).settings.visible, true);
    assert.equal(await page.locator("#sidebarBackdrop").isVisible(), false);
    await page.setViewportSize({ width: 899, height: 844 });
    await page.locator("#historyToggle").click();
    await page.setViewportSize({ width: 900, height: 844 });
    await page.waitForFunction(
      () => !document.getElementById("conversationMain").inert,
    );
    const restored = await layout(page);
    assert.equal(restored.history.modal, null);
    assert.equal(restored.history.visible, true);
    assert.equal(restored.settings.visible, true);
    assert.equal(restored.settings.inert, false);
    assert.equal(await page.locator("#sidebarBackdrop").isVisible(), false);
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS: Drawer-to-docked resizing clears modal state; no browser errors.",
    );
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
