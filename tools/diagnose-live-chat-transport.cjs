// Read-only check of the exact server-configured Aurum default, not a model
// substituted from the catalog. Never accept a client URL/key or log secrets.
module.exports = async function verifySavedModel() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { serverModels, discoverModels, requestCompletion } = await import("../lib/nvidia-runtime.mjs");
  const { randomUUID } = require("node:crypto");
  const settings = await getAdminSettings();
  const configured = serverModels(settings, {});
  const selected = configured.find((model) => model.key === settings.defaultModelKey || model.id === settings.defaultModelKey);
  if (!selected) throw new Error("The saved default does not resolve to a server-configured model.");
  let inCurrentCatalog = null;
  try { inCurrentCatalog = (await discoverModels(settings, {})).models.some((model) => model.id === selected.id); } catch {}
  console.log("[AURUM-SAVED-MODEL] " + JSON.stringify({ model: selected.id, inCurrentCatalog, savedSettingsKey: true }));
  const started = Date.now();
  let firstTextMs = null, deltaCount = 0;
  try {
    const marker = "SAVED_MODEL_" + randomUUID().slice(0, 8);
    const result = await requestCompletion(selected, [{ role: "user", content: `Start with ${marker} and give one short tip for organizing a reading list.` }], {
      stream: true, temperature: 0.6, maxTokens: 500,
      timeoutMs: 45000, deadline: started + 45000, idleTimeoutMs: 20000,
      onDelta(text) { if (text.trim()) { firstTextMs ??= Date.now() - started; deltaCount++; } },
    });
    console.log("[AURUM-SAVED-MODEL] " + JSON.stringify({ model: selected.id, ok: true, firstTextMs, deltaCount, durationMs: Date.now() - started, visibleChars: result.content.length, markerMatched: result.content.includes(marker), replyExcerpt: result.content.slice(0, 200), settingsChanged: false }));
  } catch (error) {
    console.log("[AURUM-SAVED-MODEL] " + JSON.stringify({ model: selected.id, ok: false, firstTextMs, deltaCount, durationMs: Date.now() - started, code: error.code || "provider_error", status: error.upstreamStatus || error.status, settingsChanged: false }));
    throw new Error("The exact saved Aurum model did not produce an answer. No credentials or settings were changed.");
  }
};
