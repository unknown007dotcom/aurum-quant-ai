// Read-only, bounded alternative-model checks using the existing Aurum key.
// No credentials, hashes, URLs, error bodies, or private reasoning are logged.
module.exports = async function verifySavedKeyAlternatives() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { discoverModels, requestCompletion } = await import("../lib/nvidia-runtime.mjs");
  const { randomUUID } = require("node:crypto");
  const settings = await getAdminSettings();
  const runtime = await discoverModels(settings, {});
  const ids = [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "minimaxai/minimax-m3.1-flash",
    "nvidia/nemotron-nano-3-30b-a3b",
    "google/gemma-3-12b-it",
  ];
  const working = [];
  for (const id of ids) {
    const model = runtime.models.find((model) => model.id === id);
    if (!model) continue;
    const started = Date.now();
    let firstTextMs = null, deltaCount = 0;
    try {
      const marker = "AURUM_" + randomUUID().slice(0, 8);
      const result = await requestCompletion(model, [{ role: "user", content: `Start with ${marker} and give one short tip for organizing a reading list.` }], {
        stream: true, temperature: 0.6, maxTokens: 700,
        timeoutMs: 25000, deadline: started + 25000, idleTimeoutMs: 20000,
        onDelta(text) { if (text.trim()) { firstTextMs ??= Date.now() - started; deltaCount++; } },
      });
      const record = { model: id, ok: true, savedSettingsKey: true, firstTextMs, deltaCount, durationMs: Date.now() - started, visibleChars: result.content.length, markerMatched: result.content.includes(marker), replyExcerpt: result.content.slice(0, 180) };
      working.push(record);
      console.log("[AURUM-ALTERNATIVE] " + JSON.stringify(record));
    } catch (error) {
      console.log("[AURUM-ALTERNATIVE] " + JSON.stringify({ model: id, ok: false, savedSettingsKey: true, firstTextMs, deltaCount, durationMs: Date.now() - started, code: error.code || "provider_error", status: error.upstreamStatus || error.status }));
      if (["invalid_key", "rate_limited"].includes(error.code)) throw new Error("Provider access rejected; no further model requests were made.");
    }
  }
  console.log("[AURUM-ALTERNATIVE] " + JSON.stringify({ check: "complete", workingModels: working.map((record) => record.model), settingsChanged: false }));
  if (!working.length) throw new Error("The saved key was used; no tested alternative returned an answer. No settings changed.");
};
