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
  ".png": "image/png",
  ".webp": "image/webp",
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
        "modules/chat-persona.mjs",
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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
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

    const assertMiraPortrait = async () => {
      await page.waitForFunction(() => {
        const image = document.getElementById("customImage");
        return (
          image.dataset.artwork === "default" &&
          image.complete &&
          image.naturalWidth > 0 &&
          image.src.endsWith("/assets/mira-assistant.webp")
        );
      });
      assert.equal(await page.locator("#customImage").isVisible(), true);
      assert.equal(await page.locator("#imagePlaceholder").isVisible(), false);
      assert.equal(await page.locator("#removeImageButton").isVisible(), false);
      assert.match(
        await page.locator("#customImage").getAttribute("alt"),
        /Mira.*AI assistant/,
      );
    };
    await assertMiraPortrait();
    assert.match(
      await page.locator(".conversation-heading h1").innerText(),
      /Mira/,
    );
    assert.equal(
      await page.locator(".assistant-profile h3").innerText(),
      "Mira",
    );
    assert.match(
      await page.locator('label[for="messageInput"]').innerText(),
      /Mira/,
    );
    console.log(
      "PASS: Mira's portrait and assistant identity load by default.",
    );

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

    assert.equal(
      await page.locator(".message.assistant .message-meta strong").innerText(),
      "Mira",
    );
    const upload = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 80;
      canvas.height = 80;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e6c587";
      ctx.fillRect(0, 0, 80, 80);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator("#imageInput").setInputFiles({
      name: "custom.png",
      mimeType: "image/png",
      buffer: Buffer.from(upload, "base64"),
    });
    await page.waitForFunction(
      () =>
        document.getElementById("customImage").dataset.artwork === "custom" &&
        Boolean(localStorage.getItem("aurum-chat-image-v1")),
    );
    assert.equal(await page.locator("#removeImageButton").isVisible(), true);
    await page.reload();
    await page.waitForFunction(
      () =>
        document.getElementById("customImage").dataset.artwork === "custom" &&
        document.getElementById("customImage").naturalWidth > 0,
    );
    await page.locator("#removeImageButton").click();
    await assertMiraPortrait();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("aurum-chat-image-v1")),
      null,
    );
    await page.reload();
    await assertMiraPortrait();
    await page.evaluate(() =>
      localStorage.setItem("aurum-chat-image-v1", "data:image/png;base64,AAAA"),
    );
    await page.reload();
    await assertMiraPortrait();
    await page.evaluate(() => localStorage.removeItem("aurum-chat-image-v1"));
    console.log(
      "PASS: Custom uploads persist, Restore Mira works, and broken images fall back safely.",
    );

    // A missing bundled portrait should reveal a usable fallback, not loop requests.
    const fallbackPage = await page.context().newPage();
    let portraitRequests = 0;
    await fallbackPage.route("**/api/chat", (route) =>
      route.fulfill({ json: { models: [], configured: false } }),
    );
    await fallbackPage.route("**/assets/mira-assistant.webp", (route) => {
      portraitRequests++;
      return route.fulfill({ status: 404, body: "Not found" });
    });
    await fallbackPage.goto(
      `http://127.0.0.1:${server.address().port}/chat.html`,
    );
    await fallbackPage.locator("#imagePlaceholder").waitFor();
    assert.equal(
      await fallbackPage.locator("#uploadImageButton").isVisible(),
      true,
    );
    assert.equal(portraitRequests, 1);
    await fallbackPage.close();
    console.log(
      "PASS: Missing portrait has a usable fallback without repeated requests.",
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
    // A deleted server model may not even appear in unavailableModels. Reopen
    // history after startup as well: the old UI only repaired the active chat.
    await page.setViewportSize({ width: 1280, height: 900 });
    const recoverySeed = await page.evaluate(() => {
      const key = "aurum-chat-workspace-v1";
      const saved = JSON.parse(localStorage.getItem(key));
      saved.defaults.modelKey = "gpt-oss-default";
      saved.conversations[0].settings.modelKey = "deleted-custom-key";
      saved.conversations.push({
        id: "older-conversation",
        title: "Earlier saved conversation",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settings: { ...saved.defaults, modelKey: "removed-from-server" },
        messages: [
          {
            id: "saved-question",
            role: "user",
            content: "My earlier question",
            createdAt: Date.now(),
          },
        ],
        error: "That model is no longer available.",
        draft: "",
      });
      return saved;
    });
    // Seed the next document, after the current page's pagehide persistence.
    await page.addInitScript((saved) => {
      if (sessionStorage.getItem("recovery-test-seeded")) return;
      sessionStorage.setItem("recovery-test-seeded", "1");
      localStorage.setItem("aurum-chat-workspace-v1", JSON.stringify(saved));
    }, recoverySeed);
    const postCount = posts.length;
    await page.reload();
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    const recovered = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("aurum-chat-workspace-v1")),
    );
    assert.equal(recovered.defaults.modelKey, "");
    assert.ok(
      recovered.conversations.every((chat) => chat.settings.modelKey === ""),
    );
    assert.deepEqual(
      recovered.conversations[0].messages,
      recoverySeed.conversations[0].messages,
    );
    assert.equal(
      posts.length,
      postCount,
      "Catalog recovery must not resend messages automatically",
    );
    await page
      .getByRole("button", {
        name: "Open Earlier saved conversation",
        exact: true,
      })
      .click();
    assert.equal(await page.locator("#chatModel").inputValue(), "");
    await page.locator("#retryButton").click();
    await page
      .getByText("The settings panel is working.", { exact: true })
      .waitFor();
    assert.equal(posts.at(-1).modelKey, "");
    assert.equal(posts.at(-1).messages.at(-1).content, "My earlier question");
    assert.equal(await page.locator("#chatError").isVisible(), false);
    await page.locator("#chatModel").selectOption("test");
    await page.reload();
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    assert.equal(await page.locator("#chatModel").inputValue(), "test");
    console.log(
      "PASS: Stale selections recover across saved history without losing messages; retry works and valid selections persist.",
    );

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
