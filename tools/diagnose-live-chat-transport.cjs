// Temporary read-only compatibility check using ONLY the key saved in Aurum.
// No credential values, hashes, provider URLs, error bodies or reasoning in logs.
module.exports = async function diagnoseSavedKeyRequests() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { discoverModels, requestCompletion, visibleText } = await import("../lib/nvidia-runtime.mjs");
  const settings = await getAdminSettings();
  const runtime = await discoverModels(settings, {});
  const model = runtime.models.find((entry) => entry.id === "openai/gpt-oss-20b");
  if (!model) throw new Error("The documented comparison model is not in the active catalog.");
  const messages = [{ role: "user", content: "Which number is larger, 9.11 or 9.8?" }];
  const records = [];
  // Match NVIDIA's currently published model-page sample (not our client defaults).
  const started = Date.now();
  try {
    const response = await fetch(model.baseUrl + "/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${model.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: model.id, messages, temperature: 1, top_p: 1, max_tokens: 4096, stream: false }),
    });
    const headersMs = Date.now() - started;
    const payload = await response.json();
    const content = visibleText(payload);
    const record = { check: "nvidia-documented-json", savedSettingsKey: true, model: model.id, ok: response.ok && Boolean(content), status: response.status, headersMs, durationMs: Date.now() - started, visibleChars: content.length, replyExcerpt: content.slice(0, 180) };
    records.push(record);
    console.log("[SAVED-KEY-COMPATIBILITY] " + JSON.stringify(record));
    if (response.status === 401 || response.status === 403 || response.status === 429) throw new Error("Provider access rejected; no additional requests permitted.");
  } catch (error) {
    if (error.message === "Provider access rejected; no additional requests permitted.") throw error;
    console.log("[SAVED-KEY-COMPATIBILITY] " + JSON.stringify({ check: "nvidia-documented-json", savedSettingsKey: true, ok: false, durationMs: Date.now() - started, error: error.name }));
  }
  const probe = async (name, documented) => {
    const started = Date.now();
    let headersMs = null, status, firstTextMs = null, deltaCount = 0;
    try {
      const result = await requestCompletion(model, messages, {
        stream: true, temperature: documented ? 1 : 0.6, maxTokens: documented ? 4096 : 1400,
        timeoutMs: 30000, deadline: started + 30000, idleTimeoutMs: 20000,
        onDelta(text) { if (text.trim()) { firstTextMs ??= Date.now() - started; deltaCount++; } },
      }, async (url, options) => {
        if (documented) {
          const body = JSON.parse(options.body);
          delete body.reasoning_effort;
          body.top_p = 1;
          options = { ...options, headers: { ...options.headers, Accept: "text/event-stream" }, body: JSON.stringify(body) };
        }
        const response = await fetch(url, options);
        headersMs = Date.now() - started;
        status = response.status;
        return response;
      });
      const record = { check: name, savedSettingsKey: true, model: model.id, ok: true, headersMs, status, firstTextMs, deltaCount, durationMs: Date.now() - started, visibleChars: result.content.length, replyExcerpt: result.content.slice(0, 180) };
      records.push(record);
      console.log("[SAVED-KEY-COMPATIBILITY] " + JSON.stringify(record));
    } catch (error) {
      console.log("[SAVED-KEY-COMPATIBILITY] " + JSON.stringify({ check: name, savedSettingsKey: true, ok: false, headersMs, status, firstTextMs, deltaCount, durationMs: Date.now() - started, code: error.code || "provider_error" }));
      if (["invalid_key", "rate_limited"].includes(error.code)) throw new Error("Provider access rejected; no additional requests permitted.");
    }
  };
  await probe("documented-payload-sse", true);
  await probe("app-payload-default-temperature", false);
  if (!records.some((record) => record.ok)) throw new Error("The saved Aurum key was used, but neither documented nor app request payloads produced an answer. No settings changed.");
};
