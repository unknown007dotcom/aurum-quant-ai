// One final read-only control: test at most two OTHER already-configured NVIDIA
// credentials for the SAME provider/model. No keys, hashes, URLs, requests,
// provider error bodies or private reasoning are logged or persisted.
module.exports = async function diagnoseConfiguredCredentials() {
  const { getAdminSettings } = require("../lib/firebase-admin.js");
  const { credentials, discoverModels, requestCompletion } = await import("../lib/nvidia-runtime.mjs");
  const settings = await getAdminSettings();
  const runtime = await discoverModels(settings, process.env);
  const model = runtime.models.find((model) => model.id === "openai/gpt-oss-20b");
  if (!model) { console.log("[CHAT-CREDENTIAL-CONTROL] No catalog-listed comparison model."); return; }
  const alternatives = credentials(settings, process.env)
    .filter((candidate) => candidate.baseUrl === model.baseUrl && candidate.apiKey !== model.apiKey)
    .slice(0, 2);
  console.log("[CHAT-CREDENTIAL-CONTROL] " + JSON.stringify({ alternativeCount: alternatives.length, sameProviderOnly: true }));
  for (const [index, candidate] of alternatives.entries()) {
    const started = Date.now();
    try {
      const result = await requestCompletion({ ...model, ...candidate }, [{ role: "user", content: "Give one short tip for organizing a reading list." }], { stream: false, maxTokens: 256, temperature: 0, timeoutMs: 20000 });
      console.log("[CHAT-CREDENTIAL-CONTROL] " + JSON.stringify({ alternative: index + 1, ok: true, model: model.id, durationMs: Date.now() - started, visibleChars: result.content.length, replyExcerpt: result.content.slice(0, 200) }));
    } catch (error) {
      console.log("[CHAT-CREDENTIAL-CONTROL] " + JSON.stringify({ alternative: index + 1, ok: false, model: model.id, durationMs: Date.now() - started, code: error.code, status: error.upstreamStatus || error.status }));
    }
  }
};
