// Opt-in, synthetic provider diagnostics only. Do not log headers, credentials,
// provider URLs, request bodies, error bodies or private reasoning.
const { randomUUID } = require("node:crypto");
module.exports = async function diagnoseChatTransport() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { discoverModels, requestCompletion } = await import("../lib/nvidia-runtime.mjs");
  const settings = await getAdminSettings();
  const runtime = await discoverModels(settings, process.env);
  const specs = [
    { id: "openai/gpt-oss-20b", stream: false },
    { id: "openai/gpt-oss-20b", stream: true, strictAccept: true },
    { id: "nvidia/nemotron-3.5-bolt-e4b", stream: false },
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
        stream: spec.stream, temperature: 0, maxTokens: 256, timeoutMs: 20000, deadline: started + 20000,
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
  for (let index = 0; index < specs.length; index += 2) await Promise.all(specs.slice(index, index + 2).map(run));
};
