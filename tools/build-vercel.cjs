// Build Output API packaging: publish only frontend assets; keep server files private.
// AURUM_VERIFY_LIVE_AI=1 gates a release on genuine provider replies. It uses
// existing server credentials, never the one-off diagnostic key.
const fs = require("node:fs/promises");
const path = require("node:path");
const { nodeFileTrace } = require("@vercel/nft");
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve(
  process.argv[2] || path.join(ROOT, ".vercel/output"),
);

function responseRecorder() {
  return {
    code: 200,
    data: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.code = code;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
    end() {},
  };
}
async function invoke(handler, route, method, body) {
  const res = responseRecorder();
  await handler(
    {
      method,
      url: `/api/index?__aurum_route=${route}`,
      query: { __aurum_route: route },
      headers: { host: "aurum.internal" },
      body,
    },
    res,
  );
  return res;
}
async function verify(handler) {
  const config = await invoke(handler, "chat", "GET");
  if (
    config.code !== 200 ||
    !config.data.configured ||
    !config.data.models?.length
  )
    throw new Error(
      "Live AI verification: no active server-side configuration.",
    );
  const modelKey = config.data.defaultModelKey;
  const started = Date.now();
  const chat = await invoke(handler, "chat", "POST", {
    // Exercise a real historic browser preference as well as default discovery.
    modelKey: "gpt-oss-default",
    messages: [
      { role: "user", content: "Reply with OK. This is a connectivity test." },
    ],
    settings: { style: "concise", temperature: 0 },
  });
  if (
    chat.code !== 200 ||
    typeof chat.data?.content !== "string" ||
    !chat.data.content.trim() ||
    (!config.data.models.some((model) => model.key === "gpt-oss-default") &&
      chat.data.modelFallbackUsed !== true)
  )
    throw new Error(
      `Live chat verification failed: ${chat.code} ${chat.data?.code || "no_reply"}`,
    );
  console.log(
    "[LIVE-AI] " +
      JSON.stringify({
        check: "chat",
        ok: true,
        model: chat.data.model,
        visibleChars: chat.data.content.length,
        durationMs: Date.now() - started,
      }),
  );
  const analysisStarted = Date.now();
  const analysis = await invoke(handler, "ai-decision", "POST", {
    selectedModelKey: modelKey,
    debateMode: "fast",
    temperature: 0,
    prompt:
      "Connectivity test only. No live market data is supplied. Explain that market data is missing, choose Stay Flat, and use N/A for all price levels. Do not invent any prices. Do not execute or propose an order.",
  });
  if (
    analysis.code !== 200 ||
    analysis.data?.aiUsed !== true ||
    analysis.data?.fallbackUsed !== false
  )
    throw new Error(
      `Live analysis verification failed: ${analysis.code} ${analysis.data?.code || "not_ai_generated"}`,
    );
  const plan = JSON.parse(analysis.data.choices[0].message.content);
  if (
    plan.researcher?.direction !== "Stay Flat" ||
    plan.trader?.entryZone !== "N/A" ||
    !/missing|insufficient|no (?:live )?market data|not (?:supplied|provided|available)/i.test(
      plan.researcher?.summary || "",
    ) ||
    /explain the institutional narrative|you must explicitly reference/i.test(
      plan.researcher?.summary || "",
    )
  )
    throw new Error(
      "Diagnostic analysis did not safely handle missing market data.",
    );
  const reviews = analysis.data.debateResponses || [];
  const distinct = new Set(reviews.map((review) => review.modelId)).size;
  if (
    analysis.data.debatePlanned !== 3 ||
    !reviews.length ||
    reviews.length !== analysis.data.debateSuccessful ||
    distinct !== analysis.data.debateDistinctModels ||
    reviews.some(
      (review) =>
        typeof review.output !== "string" ||
        review.output.trim().split(/\s+/).length < 5 ||
        ["buy", "sell"].includes(review.vote),
    ) ||
    !Number.isFinite(analysis.data.timings?.debateMs) ||
    analysis.data.timings.debateMs > 9000
  )
    throw new Error(
      "Live debate verification failed: genuine bounded reviews are required, not merely a catalog or a working final summary.",
    );
  console.log(
    "[LIVE-AI] " +
      JSON.stringify({
        check: "analysis",
        ok: true,
        model: analysis.data.model,
        aiUsed: true,
        fallbackUsed: false,
        debateAttempted: analysis.data.debateAttempted,
        debateSuccessful: analysis.data.debateSuccessful,
        debateDistinctModels: distinct,
        debateModels: [...new Set(reviews.map((review) => review.modelId))],
        timings: analysis.data.timings,
        direction: plan.researcher.direction,
        durationMs: Date.now() - analysisStarted,
        tradesExecuted: false,
      }),
  );
  return {
    checkedAt: new Date().toISOString(),
    sourceRevision: process.env.AURUM_SOURCE_REVISION || null,
    chat: { ok: true, model: chat.data.model, savedSelectionRecovered: true },
    analysis: {
      ok: true,
      model: analysis.data.model,
      aiUsed: true,
      fallbackUsed: false,
      meaningfulAnswer: true,
    },
    debate: {
      ok: true,
      mode: "fast",
      planned: analysis.data.debatePlanned,
      completed: reviews.length,
      distinctModels: distinct,
      models: [...new Set(reviews.map((review) => review.modelId))],
      timings: analysis.data.timings,
    },
    tradesExecuted: false,
  };
}
async function main() {
  if (
    path.basename(OUTPUT) !== "output" ||
    path.basename(path.dirname(OUTPUT)) !== ".vercel"
  )
    throw new Error("Output must be a .vercel/output directory.");
  await fs.rm(OUTPUT, { recursive: true, force: true });
  const staticRoot = path.join(OUTPUT, "static");
  await fs.mkdir(staticRoot, { recursive: true });
  for (const name of [
    "index.html",
    "styles.css",
    "app.js",
    "history.html",
    "history.js",
    "chat.html",
    "chat.css",
    "chat.js",
    "logo.svg",
    "favicon.svg",
    "candle_guide.png",
    "assets",
    "modules",
  ])
    await fs.cp(path.join(ROOT, name), path.join(staticRoot, name), {
      recursive: true,
    });
  const functionRoot = path.join(OUTPUT, "functions/api/index.func");
  await fs.mkdir(functionRoot, { recursive: true });
  const { fileList, warnings } = await nodeFileTrace(
    [path.join(ROOT, "api/index.js")],
    { base: ROOT, processCwd: ROOT },
  );
  for (const name of fileList) {
    if (name.startsWith("..") || path.isAbsolute(name))
      throw new Error("Runtime dependency escaped the source root.");
    const destination = path.join(functionRoot, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(ROOT, name), destination);
  }
  const wrapper = `const handler = require('./api/index.js');
module.exports = (req, res) => {
  const url = new URL(req.url, 'http://aurum.internal');
  const route = req.query?.__aurum_route || url.searchParams.get('__aurum_route');
  if (typeof route === 'string' && /^[a-z0-9-]+$/.test(route)) {
    url.pathname = '/api/' + route;
    url.searchParams.delete('__aurum_route');
    req.url = url.pathname + url.search;
    if (req.query) delete req.query.__aurum_route;
  }
  return handler(req, res);
};\n`;
  await fs.writeFile(path.join(functionRoot, "handler.cjs"), wrapper);
  await fs.writeFile(
    path.join(functionRoot, ".vc-config.json"),
    JSON.stringify({
      runtime: "nodejs24.x",
      handler: "handler.cjs",
      launcherType: "Nodejs",
      shouldAddHelpers: true,
      maxDuration: 300,
    }),
  );
  await fs.writeFile(
    path.join(OUTPUT, "config.json"),
    JSON.stringify({
      version: 3,
      routes: [
        { src: "^/api/([^/]+)/?$", dest: "/api/index?__aurum_route=$1" },
        { src: "^/$", dest: "/index.html" },
        { handle: "filesystem" },
      ],
      overrides: Object.fromEntries(
        ["chat-store.mjs", "chat-persona.mjs"].map((name) => [
          `modules/${name}`,
          { contentType: "application/javascript; charset=utf-8" },
        ]),
      ),
    }),
  );
  const handler = require(path.join(functionRoot, "handler.cjs"));
  const invalid = await invoke(handler, "chat", "POST", { messages: [] });
  if (invalid.code !== 400)
    throw new Error("Packaged API routing validation failed.");
  console.log(
    `Packaged ${fileList.size} runtime files (${warnings.size} optional dependency warnings); static output excludes private server data.`,
  );
  if (process.env.AURUM_VERIFY_LIVE_AI === "1") {
    const report = await verify(handler);
    await fs.writeFile(
      path.join(staticRoot, "ai-release-check.json"),
      JSON.stringify(report),
    );
  }
}
main()
  .then(
    () =>
      new Promise((resolve) =>
        process.stdout.write("Build validation complete.\n", resolve),
      ),
  )
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(
      String(error.message).replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]") + "\n",
      () => process.exit(1),
    );
  });
