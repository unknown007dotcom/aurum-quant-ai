// Temporary, explicitly enabled, read-only configuration-source diagnostic.
// Use existing Aurum credentials in memory only. Never print keys, hashes,
// URLs, settings documents, provider error bodies, passwords or private reasoning.
module.exports = async function diagnoseSavedAiSettings() {
  const { getAdminSettings, getFirestore } = require("../lib/firebase-admin.js");
  const { credentials, discoverModels, requestCompletion, NVIDIA_BASE_URL } = await import("../lib/nvidia-runtime.mjs");
  const { randomUUID } = require("node:crypto");
  const saved = await getAdminSettings();
  const bundled = require("../data/settings.json");
  const savedKeys = credentials(saved, {});
  const effectiveKeys = credentials(saved, process.env);
  const bundledKeys = credentials(bundled, {});
  const same = (a, b) => a.apiKey === b.apiKey && a.baseUrl === b.baseUrl;
  const hasKey = (value) => typeof value === "string" && Boolean(value.trim());
  let databaseStatus = "unavailable", databaseMatchesLoaded = false;
  try {
    const snapshot = await getFirestore().collection("admin").doc("settings").get();
    databaseStatus = snapshot.exists ? "present" : "missing";
    if (snapshot.exists) {
      const databaseKeys = credentials(snapshot.data(), {});
      databaseMatchesLoaded = databaseKeys.length === savedKeys.length && databaseKeys.every((key, index) => same(key, savedKeys[index]));
    }
  } catch { /* No raw database error details in logs. */ }
  const summarize = (settings, keys) => ({
    credentialCount: keys.length,
    globalKeyPresent: hasKey(settings.globalNvidiaApiKey),
    globalPoolCount: Array.isArray(settings.globalNvidiaApiKeys) ? settings.globalNvidiaApiKeys.filter(hasKey).length : 0,
    modelCount: (settings.nvidiaModels || []).length + (settings.debateModels || []).length,
    defaultModelKey: typeof settings.defaultModelKey === "string" ? settings.defaultModelKey.slice(0, 180) : "",
  });
  console.log("[AI-SETTINGS-SOURCE] " + JSON.stringify({
    databaseStatus, databaseMatchesLoaded,
    environmentOverridePresent: hasKey(process.env.NVIDIA_API_KEY),
    aiSettingsAdminConfigured: hasKey(process.env.ADMIN_PASSWORD),
    saved: summarize(saved, savedKeys), bundled: summarize(bundled, bundledKeys),
    effectiveCredentialCount: effectiveKeys.length,
    effectiveUsesSavedKey: effectiveKeys.some((key) => savedKeys.some((savedKey) => same(key, savedKey))),
    savedKeysAllInBundledCopy: savedKeys.every((key) => bundledKeys.some((bundledKey) => same(key, bundledKey))),
  }));
  const candidates = [];
  const add = (keys, source) => keys.forEach((key, index) => {
    if (key.baseUrl !== NVIDIA_BASE_URL) return;
    const label = `${source}-${index + 1}`;
    const existing = candidates.find((candidate) => same(candidate.key, key));
    if (existing) existing.sources.push(label);
    else candidates.push({ key, sources: [label] });
  });
  // Do not let an environment override hide the actual saved application key.
  add(savedKeys, "saved-settings");
  add(effectiveKeys, "effective-server");
  add(bundledKeys, "bundled-settings");
  const results = [];
  for (const candidate of candidates.slice(0, 4)) {
    let runtime;
    try {
      runtime = await discoverModels({ nvidiaModels: [{ id: "openai/gpt-oss-20b", ...candidate.key }] });
    } catch (error) {
      console.log("[AI-SETTINGS-PROBE] " + JSON.stringify({ sources: candidate.sources, stage: "catalog", ok: false, code: error.code || "configuration_error" }));
      if (error.code === "rate_limited") break;
      continue;
    }
    const models = ["openai/gpt-oss-20b", "google/gemma-3-4b-it"]
      .map((id) => runtime.models.find((model) => model.id === id)).filter(Boolean);
    for (const model of models) {
      const started = Date.now();
      let firstTextMs = null, deltaCount = 0;
      try {
        const marker = "SETTINGS_" + randomUUID().slice(0, 8);
        const reply = await requestCompletion(model, [{ role: "user", content: `Start with ${marker} and give one short tip for organizing a reading list. This is a connectivity test.` }], {
          stream: true, temperature: 0, maxTokens: 256,
          timeoutMs: 20000, deadline: started + 20000, idleTimeoutMs: 15000,
          onDelta(text) { if (text.trim()) { firstTextMs ??= Date.now() - started; deltaCount++; } },
        });
        const result = { sources: candidate.sources, model: model.id, ok: true, firstTextMs, deltaCount, durationMs: Date.now() - started, visibleChars: reply.content.length, markerMatched: reply.content.includes(marker), replyExcerpt: reply.content.slice(0, 180) };
        results.push(result);
        console.log("[AI-SETTINGS-PROBE] " + JSON.stringify(result));
      } catch (error) {
        console.log("[AI-SETTINGS-PROBE] " + JSON.stringify({ sources: candidate.sources, model: model.id, ok: false, firstTextMs, deltaCount, durationMs: Date.now() - started, code: error.code || "provider_error", status: error.upstreamStatus || error.status, timeoutPhase: error.timeoutPhase }));
        // Do not rotate keys or continue model probes to work around rate limits.
        if (error.code === "rate_limited") throw new Error("Saved-settings verification was rate limited; no further requests were sent.");
        if (error.code === "invalid_key") break;
      }
    }
  }
  console.log("[AI-SETTINGS-SOURCE] " + JSON.stringify({ check: "complete", workingSources: [...new Set(results.flatMap((result) => result.sources))], workingModels: [...new Set(results.map((result) => result.model))], settingsChanged: false }));
  if (!results.length) throw new Error("No existing Aurum settings credential produced an answer in this diagnostic. No settings were changed.");
};
