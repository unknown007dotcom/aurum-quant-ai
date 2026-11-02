// Real chat.js -> real local HTTP/Node handler -> real NVIDIA SSE parser.
// The upstream provider is gated via IPC, so assertions happen while generation
// is definitely unfinished. No external provider calls or trading operations.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const STORAGE = "aurum-chat-workspace-v1";
const initial =
  "## Hypothetical comparison\nThese are educational examples, not live prices or trade signals.\n\n| Approach | Context | Entry idea | Invalidation | Risk | Timeframe |\n| :--- | :--- | :--- | :--- | ---: | :---: |\n| **Patient** | Higher-timeframe trend | Wait for confirmation | Structure changes | 1% | H1 |";

async function run() {
  const child = fork(path.join(ROOT, "server.js"), [], {
    cwd: ROOT,
    execArgv: [
      "--require",
      path.join(__dirname, "fixtures/chat-stream-provider.cjs"),
    ],
    env: { ...process.env, PORT: "0" },
    silent: true,
  });
  const messages = [],
    waiters = new Set();
  let commandId = 0;
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  child.on("message", (message) => {
    messages.push(message);
    for (const waiter of [...waiters])
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
  });
  const waitFor = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for test server: " + logs));
      }, 10000);
      waiters.add(waiter);
    });
  };
  const command = async (value) => {
    const id = ++commandId;
    child.send({ ...value, commandId: id });
    await waitFor(
      (message) => message.type === "ack" && message.commandId === id,
    );
  };
  let browser;
  try {
    const ready = await waitFor((message) => message.type === "ready");
    const options = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE_PATH)
      Object.assign(options, {
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--no-zygote",
          "--single-process",
        ],
      });
    browser = await chromium.launch(options);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${ready.port}`;
    const errors = [],
      forbidden = [],
      posts = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        (url.pathname.startsWith("/api/") && url.pathname !== "/api/chat")
      )
        forbidden.push(request.url());
      if (url.pathname === "/api/chat" && request.method() === "POST")
        posts.push(request.postDataJSON());
    });
    await page.goto(`${origin}/chat.html`);
    await page.locator('#providerStatus[data-state="configured"]').waitFor();
    const savedChat = () =>
      page.evaluate((key) => {
        const saved = JSON.parse(localStorage.getItem(key));
        return saved.conversations.find((chat) => chat.id === saved.activeId);
      }, STORAGE);
    let lastRequest = 0;
    const nextRequest = async () => {
      const request = await waitFor(
        (message) =>
          message.type === "provider-request" && message.id > lastRequest,
      );
      lastRequest = request.id;
      return request;
    };
    const start = async (question, text) => {
      await command({ command: "plan", plan: { initial: text } });
      await page.locator("#messageInput").fill(question);
      await page.locator("#sendButton").click();
      const request = await nextRequest();
      await page.locator('.message[data-streaming="true"]').waitFor();
      return request;
    };
    const finish = async (request, text = "") => {
      await command({ command: "finish", id: request.id, text });
      await page
        .locator('.message[data-streaming="true"]')
        .waitFor({ state: "detached" });
      assert.equal(
        await page.locator("#messageInput").getAttribute("readonly"),
        null,
      );
    };
    const waitForText = (text) =>
      page.waitForFunction(
        (value) =>
          document
            .querySelector('.message[data-streaming="true"] .message-body')
            ?.textContent.includes(value),
        text,
      );

    const request = await start(
      "Compare two hypothetical approaches in a table.",
      initial,
    );
    await page.locator('[data-streaming="true"] table').waitFor();
    assert.equal(posts[0].stream, true);
    assert.equal(request.body.stream, true);
    assert.equal(
      await page.locator("#sendButton").getAttribute("aria-label"),
      "Stop response",
    );
    assert.equal(
      await page.locator('[data-streaming="true"] .message-actions').count(),
      0,
    );
    assert.match(
      await page.locator('[data-streaming="true"] .typing-label').innerText(),
      /Writing/,
    );
    assert.doesNotMatch(
      await page.locator("#messages").innerText(),
      /PRIVATE REASONING/,
    );
    await page.evaluate(() => {
      window.__originalQuestion = document.querySelector(".message.user");
    });

    // Visible semantic tables at desktop, tablet, and narrow phone widths while
    // the provider connection is still open; no full-page horizontal overflow.
    for (const width of [1440, 1024, 900, 820, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page
        .locator('[data-streaming="true"] .message-table-scroll')
        .evaluate((wrapper) => {
          const table = wrapper.querySelector("table");
          const th = table.querySelector("th");
          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            chatOverflow:
              document.getElementById("messageScroll").scrollWidth >
              document.getElementById("messageScroll").clientWidth,
            wrapperWidth: wrapper.clientWidth,
            wrapperLeft: wrapper.getBoundingClientRect().left,
            wrapperRight: wrapper.getBoundingClientRect().right,
            tableWidth: table.getBoundingClientRect().width,
            cellWidth: th.getBoundingClientRect().width,
            scrollable: getComputedStyle(wrapper).overflowX,
            scope: th.scope,
            whiteSpace: getComputedStyle(th).whiteSpace,
            headerBackground: getComputedStyle(th).backgroundColor,
            bodyBackground: getComputedStyle(wrapper).backgroundColor,
          };
        });
      assert.equal(layout.pageOverflow, false, `Page overflow at ${width}px`);
      assert.equal(layout.chatOverflow, false, `Chat overflow at ${width}px`);
      assert.ok(layout.wrapperWidth > 180);
      assert.ok(layout.wrapperLeft >= 0 && layout.wrapperRight <= width);
      assert.ok(
        layout.tableWidth > layout.wrapperWidth,
        "Wide tables should scroll locally",
      );
      assert.ok(
        layout.cellWidth >= 120,
        "Do not squeeze columns into unreadable slivers",
      );
      assert.equal(layout.scrollable, "auto");
      assert.equal(layout.scope, "col");
      assert.equal(layout.whiteSpace, "normal");
      assert.notEqual(layout.headerBackground, layout.bodyBackground);
    }
    console.log(
      "PASS: Real provider text and readable tables appear before generation finishes at seven desktop/mobile widths.",
    );

    const wrapper = page.locator(
      '[data-streaming="true"] .message-table-scroll',
    );
    await wrapper.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-streaming="true"] .message-table-scroll')
          .scrollLeft > 0,
    );
    await wrapper.evaluate((el) => {
      el.scrollLeft = 120;
    });
    const second =
      "\n| Momentum | Confirmed move | Wait for a pullback | Trend fails | 0.5% | M15 🪙 |";
    await command({ command: "chunk", id: request.id, text: second });
    await waitForText("Momentum");
    assert.ok(
      await wrapper.evaluate(
        (el) => el.scrollLeft >= 115 && document.activeElement === el,
      ),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__originalQuestion === document.querySelector(".message.user"),
      ),
      true,
    );
    assert.equal(
      await page.locator('[data-streaming="true"] tbody tr').count(),
      2,
    );
    console.log(
      "PASS: Table keyboard scrolling, horizontal position, and focus survive incremental rendering without rebuilding history.",
    );

    const rows = Array.from(
      { length: 22 },
      (_, index) =>
        `\n| Example ${index + 1} | Hypothetical context | Wait for confirmation | Setup invalid | 1% | H1 |`,
    ).join("");
    await command({ command: "chunk", id: request.id, text: rows });
    await waitForText("Example 22");
    await page.locator("#messageScroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    const tail =
      "\n| Final row | For learning | No order execution | Reassess | 1% | H4 |";
    await command({ command: "chunk", id: request.id, text: tail });
    await waitForText("Final row");
    assert.equal(
      await page.locator("#messageScroll").evaluate((el) => el.scrollTop),
      0,
      "Do not pull a reader back to the bottom",
    );
    const summary =
      "\n\n**Takeaway:** keep the examples hypothetical and manage uncertainty.";
    await finish(request, summary);
    assert.equal(
      await page.locator("#messageScroll").evaluate((el) => el.scrollTop),
      0,
    );
    const complete = initial + second + rows + tail + summary;
    assert.equal((await savedChat()).messages.at(-1).content, complete);
    assert.equal((await savedChat()).messages.length, 2);
    assert.equal(
      await page.locator(".message-model").innerText(),
      "example/browser-instruct",
    );
    await page.reload();
    await page.locator(".message.assistant table").waitFor();
    assert.equal(await page.locator(".message.assistant tbody tr").count(), 25);
    assert.equal((await savedChat()).messages.at(-1).content, complete);
    console.log(
      "PASS: Long streaming replies respect reader scroll position and persist exactly once with tables/model after reload.",
    );

    // Copy/export keep original Markdown, not generated HTML.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          window.__copied = text;
        },
      });
    });
    await page.getByRole("button", { name: "Copy assistant response" }).click();
    assert.equal(await page.evaluate(() => window.__copied), complete);
    await page.locator("#conversationMenu summary").click();
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#exportChatButton").click();
    const download = await downloadEvent;
    const chunks = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).toString().includes(complete));
    if (process.env.CHAT_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.CHAT_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#messageScroll").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: path.join(
          process.env.CHAT_SCREENSHOT_DIR,
          "chat-table-desktop.png",
        ),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(
          process.env.CHAT_SCREENSHOT_DIR,
          "chat-table-mobile.png",
        ),
      });
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    // Failed regeneration keeps the good answer; a successful retry replaces it.
    await command({ command: "plan", plan: { initial: "Replacement draft" } });
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    const failedRegeneration = await nextRequest();
    await waitForText("Replacement draft");
    await command({ command: "fail", id: failedRegeneration.id });
    await page.locator("#chatError").waitFor();
    assert.equal((await savedChat()).messages.at(-1).content, complete);
    assert.equal((await savedChat()).messages.length, 2);
    assert.doesNotMatch(
      await page.locator("#chatError").innerText(),
      /PRIVATE/,
    );
    await command({ command: "plan", plan: { initial: "A better response" } });
    await page.locator("#retryButton").click();
    const regeneration = await nextRequest();
    await waitForText("A better response");
    await finish(regeneration, ".");
    assert.equal(
      (await savedChat()).messages.at(-1).content,
      "A better response.",
    );
    assert.equal((await savedChat()).messages.length, 2);
    assert.equal(await page.locator("#chatError").isVisible(), false);
    console.log(
      "PASS: Copy/export preserve Markdown; failed regeneration preserves the original and retry replaces it without duplicates.",
    );

    await page.locator("#newChatButton").click();
    const stopping = await start(
      "Stop response test.",
      "Keep this partial output",
    );
    await waitForText("Keep this partial output");
    await page
      .getByRole("button", { name: "Stop response", exact: true })
      .click();
    await waitFor(
      (message) => message.type === "aborted" && message.id === stopping.id,
    );
    await waitFor(
      (message) => message.type === "cancelled" && message.id === stopping.id,
    );
    await command({
      command: "chunk",
      id: stopping.id,
      text: "LATE TEXT MUST NOT APPEAR",
    });
    assert.equal(
      (await savedChat()).messages.at(-1).content,
      "Keep this partial output",
    );
    assert.equal((await savedChat()).messages.at(-1).incomplete, true);
    assert.equal(await page.locator('[data-streaming="true"]').count(), 0);
    await page.reload();
    await page.locator(".message-error-note").waitFor();
    await command({
      command: "plan",
      plan: { initial: "Complete replacement" },
    });
    await page.locator("#retryButton").click();
    const retry = await nextRequest();
    assert.equal(
      retry.body.messages.filter((message) => message.role === "assistant")
        .length,
      0,
    );
    await waitForText("Complete replacement");
    await finish(retry);
    assert.equal((await savedChat()).messages.length, 2);
    assert.equal(
      (await savedChat()).messages.at(-1).content,
      "Complete replacement",
    );
    assert.ok(!(await savedChat()).messages.at(-1).incomplete);
    assert.equal(await page.locator(".message-error-note").count(), 0);
    console.log(
      "PASS: Stop aborts the upstream provider, preserves labeled partial text across reload, and retry replaces it cleanly.",
    );

    await page.locator("#newChatButton").click();
    const interrupted = await start(
      "Interruption test.",
      "Partial answer before connection failure",
    );
    await waitForText("Partial answer before connection failure");
    await command({ command: "fail", id: interrupted.id });
    await page.locator("#chatError").waitFor();
    assert.equal((await savedChat()).messages.at(-1).incomplete, true);
    assert.equal(await page.locator('[data-streaming="true"]').count(), 0);
    assert.doesNotMatch(await page.locator("#messages").innerText(), /PRIVATE/);

    await page.locator("#newChatButton").click();
    const navigation = await start(
      "Navigation isolation test.",
      "This belongs to the previous conversation",
    );
    await waitForText("This belongs to the previous conversation");
    await page.locator("#newChatButton").click();
    await waitFor(
      (message) => message.type === "aborted" && message.id === navigation.id,
    );
    await command({
      command: "chunk",
      id: navigation.id,
      text: "LATE TEXT MUST NOT APPEAR",
    });
    assert.equal(await page.locator("#welcomeScreen").isVisible(), true);
    assert.equal(await page.locator("#messages").isVisible(), false);
    const empty = await start("Stop before tokens test.", "");
    await page
      .getByRole("button", { name: "Stop response", exact: true })
      .click();
    await waitFor(
      (message) => message.type === "aborted" && message.id === empty.id,
    );
    assert.equal(
      (await savedChat()).messages.length,
      1,
      "No empty assistant message on early stop",
    );
    console.log(
      "PASS: Interrupted replies stay visibly incomplete, navigation isolates in-flight responses, and early Stop creates no empty message.",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(forbidden, []);
    console.log(
      "PASS: No browser exceptions, external browser requests, or trading/API side effects.",
    );
  } finally {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
