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
async function verifyChatHttp() {
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
    `Expected the conversation code ${marker}; received ${JSON.stringify(followup.payload.content ?? null).slice(0, 400)} (first reply: ${JSON.stringify(first.payload.content).slice(0, 100)})`,
  );
  emit({
    check: "saved-model-and-conversation-context",
    ok: true,
    model: followup.payload.model,
    modelFallbackUsed: Boolean(followup.payload.modelFallbackUsed),
    durationMs: followup.durationMs,
  });
}
async function verifyAnalysisHttp() {
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
  const reviews = analysis.payload.debateResponses;
  assert.ok(
    Array.isArray(reviews) && reviews.length > 0,
    "A working final summary alone does not verify the debate",
  );
  assert.equal(analysis.payload.debatePlanned, 3);
  assert.equal(analysis.payload.debateSuccessful, reviews.length);
  assert.equal(
    analysis.payload.debateDistinctModels,
    new Set(reviews.map((review) => review.modelId)).size,
  );
  assert.ok(
    reviews.every(
      (review) =>
        typeof review.output === "string" &&
        review.output.trim().split(/\s+/).length >= 5,
    ),
  );
  assert.ok(
    reviews.every((review) => !["buy", "sell"].includes(review.vote)),
    "No-data reviews must not propose a direction",
  );
  assert.ok(
    analysis.payload.timings.debateMs <= 9000,
    "Fast debate exceeded its phase budget plus scheduling tolerance",
  );
  emit({
    check: "meaningful-structured-analysis",
    ok: true,
    model: analysis.payload.model,
    aiUsed: true,
    fallbackUsed: false,
    direction: plan.researcher.direction,
    debateCompleted: reviews.length,
    debateDistinctModels: analysis.payload.debateDistinctModels,
    debateModels: [...new Set(reviews.map((review) => review.modelId))],
    debateTimings: analysis.payload.timings,
    debateFailures: (analysis.payload.debateFailures || []).map(
      ({ modelId, code, skipped }) => ({ modelId, code, skipped }),
    ),
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
      if (url.origin === ORIGIN) {
        const chatApi =
          url.pathname === "/api/chat" &&
          ["GET", "POST"].includes(request.method());
        const staticAsset =
          request.method() === "GET" && !url.pathname.startsWith("/api/");
        if (chatApi || staticAsset) return route.continue();
      }
      if (request.method() !== "GET" || url.pathname.startsWith("/api/"))
        prohibited.push(url.pathname);
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
  const failures = [];
  const checks = [
    ["http-chat", verifyChatHttp],
    ["http-analysis", verifyAnalysisHttp],
  ];
  if (process.argv.includes("--browser")) {
    checks.push(["browser-chat", verifyBrowser]);
    checks.push([
      "browser-debate",
      () => require("./verify-debate-browser.cjs")(ORIGIN, emit),
    ]);
  }
  for (const [check, run] of checks) {
    try {
      await run();
    } catch (error) {
      failures.push(check);
      emit({
        check,
        ok: false,
        message: String(error.message)
          .replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]")
          .slice(0, 700),
      });
    }
  }
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
  if (failures.length)
    throw new Error(`Live checks failed: ${failures.join(", ")}`);
  emit({ check: "complete", ok: true, tradesExecuted: false });
})().catch((error) => {
  console.error(
    String(error.message).replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]"),
  );
  process.exitCode = 1;
});
