// Explicit, opt-in live verification. Uses public chat/analysis endpoints only.
// No secrets, orders, bot commands, history writes, or settings changes.
// This makes a small number of genuine provider calls; it is not an npm test.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const ORIGIN = new URL(
  process.env.AURUM_VERIFY_ORIGIN || "https://aurum-quant-ai.vercel.app",
).origin;
const results = [];
const emit = (result) => {
  results.push(result);
  console.log("[LIVE-HTTP-AI] " + JSON.stringify(result));
};
async function post(route, body) {
  assert.ok(["/api/chat", "/api/ai-decision"].includes(route));
  const started = Date.now();
  const response = await fetch(ORIGIN + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(90000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(
    response.status,
    200,
    `${route}: HTTP ${response.status}, code ${String(payload.code || "unknown").slice(0, 80)}`,
  );
  return { payload, durationMs: Date.now() - started };
}
async function verifyHttp() {
  const marker = "AURUM_" + randomBytes(5).toString("hex").toUpperCase();
  const firstMessage = {
    role: "user",
    content: `Remember the verification code ${marker} for this conversation. Reply only with OK.`,
  };
  const first = await post("/api/chat", {
    messages: [firstMessage],
    settings: { style: "concise", temperature: 0 },
  });
  assert.equal(typeof first.payload.content, "string");
  assert.ok(first.payload.content.trim());
  emit({
    check: "default-chat",
    ok: true,
    model: first.payload.model,
    durationMs: first.durationMs,
  });
  const followup = await post("/api/chat", {
    modelKey: "gpt-oss-default",
    messages: [
      firstMessage,
      { role: "assistant", content: first.payload.content },
      {
        role: "user",
        content:
          "What verification code did I give you? Reply with the code only.",
      },
    ],
    settings: { style: "concise", temperature: 0 },
  });
  assert.ok(
    followup.payload.content?.includes(marker),
    "The reply must use the actual conversation, not a canned response",
  );
  emit({
    check: "saved-model-and-conversation-context",
    ok: true,
    model: followup.payload.model,
    modelFallbackUsed: Boolean(followup.payload.modelFallbackUsed),
    durationMs: followup.durationMs,
  });
  const analysis = await post("/api/ai-decision", {
    selectedModelKey: "gpt-oss-default",
    debateMode: "fast",
    temperature: 0,
    prompt:
      "Connectivity test only. No live market data is supplied. Explain what data is missing, choose Stay Flat and N/A for all price levels. Do not execute or propose an order.",
  });
  const { structuredAnswer } = await import("../lib/analysis-service.mjs");
  assert.equal(analysis.payload.aiUsed, true);
  assert.equal(analysis.payload.fallbackUsed, false);
  const plan = JSON.parse(
    structuredAnswer(analysis.payload.choices?.[0]?.message?.content),
  );
  assert.equal(plan.researcher.direction, "Stay Flat");
  assert.match(
    plan.researcher.summary,
    /missing|insufficient|unavailable|no (?:live )?(?:market )?data|not (?:supplied|provided|available)/i,
  );
  for (const key of [
    "entryZone",
    "takeProfitLevels",
    "stopLoss",
    "positionSizing",
    "timeHorizon",
  ])
    assert.equal(plan.trader[key], "N/A");
  emit({
    check: "meaningful-structured-analysis",
    ok: true,
    model: analysis.payload.model,
    aiUsed: true,
    fallbackUsed: false,
    direction: plan.researcher.direction,
    summary: plan.researcher.summary.slice(0, 400),
    durationMs: analysis.durationMs,
  });
}
async function verifyBrowser() {
  const { chromium } = require("playwright");
  const marker = "MIRA_" + randomBytes(5).toString("hex").toUpperCase();
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
  const browser = await chromium.launch(options);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    const prohibited = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin === ORIGIN &&
        (request.method() === "GET" ||
          (request.method() === "POST" && url.pathname === "/api/chat"))
      )
        return route.continue();
      if (request.method() !== "GET") prohibited.push(url.pathname);
      return route.abort();
    });
    await page.addInitScript(
      ({ marker }) => {
        const now = Date.now();
        const settings = {
          modelKey: "gpt-oss-default",
          style: "concise",
          temperature: 0,
          context: true,
          enterToSend: true,
        };
        localStorage.setItem(
          "aurum-chat-workspace-v1",
          JSON.stringify({
            version: 1,
            defaults: settings,
            activeId: "verification-chat",
            conversations: [
              {
                id: "verification-chat",
                title: "Live response verification",
                createdAt: now,
                updatedAt: now,
                settings,
                draft: "",
                error: "Saved model unavailable.",
                messages: [
                  {
                    id: "question",
                    role: "user",
                    content: `Reply with exactly ${marker}. This is a connectivity test.`,
                    createdAt: now,
                  },
                ],
              },
              {
                id: "other-saved-chat",
                title: "Other saved chat",
                createdAt: now,
                updatedAt: now,
                settings: { ...settings, modelKey: "deleted-custom-key" },
                messages: [
                  {
                    id: "old-question",
                    role: "user",
                    content: "What is diversification?",
                    createdAt: now,
                  },
                ],
                draft: "",
              },
            ],
          }),
        );
      },
      { marker },
    );
    await page.goto(ORIGIN + "/chat.html", { waitUntil: "domcontentloaded" });
    await page
      .locator('#providerStatus[data-state="configured"]')
      .waitFor({ timeout: 30000 });
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("aurum-chat-workspace-v1")),
    );
    assert.ok(
      saved.conversations.every((chat) => chat.settings.modelKey === ""),
      "Every stale saved selection must recover",
    );
    assert.equal(saved.conversations.length, 2);
    const started = Date.now();
    await page.locator("#retryButton").click();
    await page
      .locator(".message.assistant .message-body")
      .filter({ hasText: marker })
      .waitFor({ timeout: 90000 });
    assert.equal(await page.locator("#chatError").isVisible(), false);
    const model = await page
      .locator(".message.assistant .message-model")
      .innerText();
    assert.deepEqual(errors, []);
    assert.deepEqual(prohibited, []);
    emit({
      check: "browser-visible-mira-reply",
      ok: true,
      model,
      staleHistoryRecovered: true,
      durationMs: Date.now() - started,
      browserErrors: 0,
      tradesExecuted: false,
    });
    if (process.env.AURUM_VERIFY_SCREENSHOT)
      await page.screenshot({ path: process.env.AURUM_VERIFY_SCREENSHOT });
  } finally {
    await browser.close();
  }
}
(async () => {
  await verifyHttp();
  if (process.argv.includes("--browser")) await verifyBrowser();
  const report = {
    checkedAt: new Date().toISOString(),
    origin: ORIGIN,
    results,
    tradesExecuted: false,
  };
  if (process.env.AURUM_VERIFY_REPORT)
    await fs.writeFile(
      process.env.AURUM_VERIFY_REPORT,
      JSON.stringify(report, null, 2),
    );
  emit({ check: "complete", ok: true, tradesExecuted: false });
})().catch((error) => {
  console.error(
    String(error.message).replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]"),
  );
  process.exitCode = 1;
});
