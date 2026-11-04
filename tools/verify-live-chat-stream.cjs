// Explicit live verification: /api/chat only, with synthetic text and market
// lookup disabled. No provider secrets, trading, settings or history writes.
const { randomUUID } = require("node:crypto");
const http = require("node:http");

async function verifyChatStreaming({
  origin = process.env.AURUM_VERIFY_ORIGIN ||
    "https://aurum-quant-ai.vercel.app",
  fetchImpl = globalThis.fetch,
  modelIds,
  requestTimeoutMs = 150000,
  emit = (record) =>
    console.log("[LIVE-CHAT-STREAM] " + JSON.stringify(record)),
  label = "deployed-chat",
} = {}) {
  const { readChatResponse } = await import("../modules/chat-stream.mjs");
  const base = new URL(origin).origin;
  const records = [];
  const report = (record) => {
    records.push(record);
    emit({ label, ...record });
  };
  let configuration;
  try {
    const response = await fetchImpl(base + "/api/chat", {
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
    configuration = await response.json();
    const models = Array.isArray(configuration.models)
      ? configuration.models
      : [];
    report({
      check: "configuration",
      ok: response.ok && configuration.configured === true && models.length > 0,
      httpStatus: response.status,
      configured: configuration.configured === true,
      defaultModelKey: configuration.defaultModelKey,
      defaultModel: models.find(
        (model) => model.key === configuration.defaultModelKey,
      )?.id,
      modelCount: models.length,
    });
    if (!records.at(-1).ok) return { ok: false, records };
  } catch (error) {
    report({ check: "configuration", ok: false, error: error.name });
    return { ok: false, records };
  }
  const fast = configuration.models.find(
    (model) => model.id === "openai/gpt-oss-20b",
  );
  const probes = modelIds
    ? modelIds.slice(0, 4).map((id) => ({
        check: "catalog-model-stream",
        model: id,
        modelKey: configuration.models.find((model) => model.id === id)?.key,
      }))
    : [{ check: "default-stream", modelKey: "" }];
  if (!modelIds)
    probes.push({
      check: "saved-selection-stream",
      modelKey: fast?.key || "gpt-oss-default",
      expectRecovery: !fast,
    });
  for (const probe of probes) {
    if (probe.modelKey === undefined) {
      report({
        check: probe.check,
        model: probe.model,
        ok: false,
        code: "model_unavailable",
      });
      continue;
    }
    const started = Date.now();
    const marker = "CHAT_" + randomUUID().slice(0, 8);
    const attempts = [];
    let firstTextMs = null,
      deltaCount = 0,
      stream = false;
    let httpStatus;
    try {
      const response = await fetchImpl(base + "/api/chat", {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({
          stream: true,
          modelKey: probe.modelKey,
          settings: { style: "concise", temperature: 0, marketContext: false },
          messages: [
            {
              role: "user",
              content: `Start with ${marker}, then give three short numbered tips for organizing a reading list. This is a connectivity test; no market information is needed.`,
            },
          ],
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      httpStatus = response.status;
      stream =
        response.headers.get("content-type")?.includes("text/event-stream") ||
        false;
      const reply = await readChatResponse(response, (event) => {
        if (event.type === "start") {
          attempts.push({
            model: event.model,
            startMs: Date.now() - started,
            firstTextMs: null,
          });
          emit({
            label,
            check: probe.check,
            stage: "attempt",
            model: event.model,
            elapsedMs: Date.now() - started,
          });
        }
        if (event.type === "delta") {
          deltaCount++;
          if (event.text.trim() && firstTextMs === null) {
            firstTextMs = Date.now() - started;
            emit({
              label,
              check: probe.check,
              stage: "first-text",
              elapsedMs: firstTextMs,
            });
          }
          if (event.text.trim() && attempts.at(-1)?.firstTextMs === null)
            attempts.at(-1).firstTextMs = Date.now() - started;
        }
      });
      report({
        check: probe.check,
        ok:
          stream &&
          deltaCount > 0 &&
          firstTextMs !== null &&
          reply.content.trim().length > 20 &&
          (!probe.expectRecovery || reply.modelFallbackUsed === true),
        recoveryExpected: Boolean(probe.expectRecovery),
        httpStatus,
        stream,
        model: reply.model,
        modelFallbackUsed: Boolean(reply.modelFallbackUsed),
        firstTextMs,
        durationMs: Date.now() - started,
        deltaCount,
        visibleChars: reply.content.length,
        markerMatched: reply.content.includes(marker),
        // Only this verifier's synthetic answer is sampled, never user history.
        replyExcerpt: reply.content.slice(0, 240),
        attempts,
      });
    } catch (error) {
      report({
        check: probe.check,
        ok: false,
        httpStatus,
        stream,
        code: typeof error.code === "string" ? error.code : error.name,
        timeoutPhase: error.timeoutPhase,
        firstTextMs,
        durationMs: Date.now() - started,
        deltaCount,
        attempts,
      });
    }
  }
  return {
    ok: records.every((record) => record.ok),
    checkedAt: new Date().toISOString(),
    records,
    tradesExecuted: false,
  };
}

// In a release build, exercise the actual PACKAGED Node handler over HTTP with
// genuine configured provider requests. This is separate from public deployment
// verification; it does not claim that preview authentication/CDN was tested.
async function withPackagedChat(handler, run) {
  const server = http.createServer(async (req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (value) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
      return res;
    };
    if (new URL(req.url, "http://local.invalid").pathname !== "/api/chat")
      return res
        .status(404)
        .json({ message: "Only chat verification is permitted." });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      req.body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      await handler(req, res);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ message: "Chat verification handler failed." });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { verifyChatStreaming, withPackagedChat };
if (require.main === module)
  verifyChatStreaming()
    .then((report) => {
      if (!report.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.error("Live chat verification could not complete.");
      process.exitCode = 1;
    });
