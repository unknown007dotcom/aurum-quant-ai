// Opt-in, synthetic provider diagnostics only. Do not log headers, credentials,
// provider URLs, request bodies, error bodies or private reasoning.
const { randomUUID } = require("node:crypto");
module.exports = async function diagnoseChatTransport() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { discoverModels, requestCompletion } = await import("../lib/nvidia-runtime.mjs");
  const settings = await getAdminSettings();
  const runtime = await discoverModels(settings, process.env);
  const specs = [
    { id: "nvidia/nemotron-3.5-bolt-e4b", stream: true, strictAccept: true },
    { id: "google/gemma-4-31b-it", stream: true, strictAccept: true },
  ];
  const run = async (spec) => {
    const model = runtime.models.find((model) => model.id === spec.id);
    if (!model) { console.log("[CHAT-TRANSPORT] " + JSON.stringify({ ...spec, available: false })); return; }
    const started = Date.now();
    const metrics = { ...spec, available: true, headersMs: null, firstTextMs: null, deltaCount: 0 };
    try {
      const marker = "PROBE_" + randomUUID().slice(0, 8);
      const result = await requestCompletion(model, [{ role: "user", content: `Reply with ${marker} and one short tip for organizing a reading list.` }], {
        stream: spec.stream, temperature: 0, maxTokens: 1536, timeoutMs: 90000, deadline: started + 90000,
        onDelta(text) { if (text.trim()) { metrics.firstTextMs ??= Date.now() - started; metrics.deltaCount++; } },
      }, async (url, options) => {
        if (spec.strictAccept) options = { ...options, headers: { ...options.headers, Accept: "text/event-stream" } };
        const response = await fetch(url, options);
        metrics.headersMs = Date.now() - started;
        metrics.httpStatus = response.status;
        metrics.contentType = response.headers.get("content-type");
        console.log("[CHAT-TRANSPORT-HEADERS] " + JSON.stringify(metrics));
        return response;
      });
      console.log("[CHAT-TRANSPORT] " + JSON.stringify({ ...metrics, ok: true, durationMs: Date.now() - started, replyExcerpt: result.content.slice(0, 200) }));
    } catch (error) {
      console.log("[CHAT-TRANSPORT] " + JSON.stringify({ ...metrics, ok: false, durationMs: Date.now() - started, code: error.code, timeoutPhase: error.timeoutPhase }));
    }
  };
  const curlModel = runtime.models.find((model) => model.id === "openai/gpt-oss-20b");
  if (curlModel) {
    // Compare another HTTP client without placing credentials in argv or logs.
    const { spawn } = require("node:child_process");
    const marker = "CURL_" + randomUUID().slice(0, 8);
    const body = { model: curlModel.id, messages: [{ role: "user", content: `Reply with ${marker} and one short reading-list tip.` }], stream: false, temperature: 0, max_tokens: 2048, reasoning_effort: "low" };
    await new Promise((resolve) => {
      const child = spawn("curl", ["--config", "-", "--write-out", "\\n__METRICS__%{http_code}|%{time_starttransfer}|%{time_total}"], { stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (data) => { if (output.length < 262144) output += data; });
      child.on("error", () => { console.log("[CHAT-CURL] unavailable"); resolve(); });
      child.on("close", (exitCode) => {
        const [text, timing = ""] = output.split("\n__METRICS__");
        const [httpStatus, firstByteSeconds, durationSeconds] = timing.trim().split("|");
        let payload; try { payload = JSON.parse(text); } catch {}
        const content = payload?.choices?.[0]?.message?.content;
        console.log("[CHAT-CURL] " + JSON.stringify({ model: curlModel.id, exitCode, httpStatus, firstByteSeconds, durationSeconds, visibleChars: typeof content === "string" ? content.length : 0, ...(typeof content === "string" && content.trim() ? { replyExcerpt: content.slice(0, 200) } : {}) }));
        resolve();
      });
      const config = [
        "silent", "show-error", "max-time = 20", 'request = "POST"',
        `url = ${JSON.stringify(curlModel.baseUrl + "/chat/completions")}`,
        `header = ${JSON.stringify("Authorization: Bearer " + curlModel.apiKey)}`,
        'header = "Content-Type: application/json"', 'header = "Accept: application/json"',
        `data = ${JSON.stringify(JSON.stringify(body))}`,
      ].join("\n");
      child.stdin.on("error", () => {});
      child.stdin.end(config);
    });
  }
  for (let index = 0; index < specs.length; index += 2) await Promise.all(specs.slice(index, index + 2).map(run));
};
