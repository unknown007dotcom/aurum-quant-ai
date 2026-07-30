const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const { getAdminSettings } = require("../lib/firebase-admin");

let healthCache = null;
const HEALTH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ message: "Method not allowed." });
    return;
  }

  try {
    const health = await checkAiHealth();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(health);
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      provider: "NVIDIA",
      keyConfigured: false,
      keyValid: false,
      selectedModel: null,
      selectedModelAvailable: false,
      lastCheckedAt: Date.now(),
      status: "unhealthy",
      error: error?.message || "Health check failed."
    });
  }
};

async function checkAiHealth() {
  if (healthCache && Date.now() - healthCache.lastCheckedAt < HEALTH_CACHE_TTL_MS) {
    return healthCache;
  }

  const settings = await safeLoadSettings();
  const globalNvidiaKeys = normalizeNvidiaKeyPool(settings?.globalNvidiaApiKeys, settings?.globalNvidiaApiKey);
  const summaryModels = normalizeModels(settings?.nvidiaModels, globalNvidiaKeys);
  const selectedModelId = summaryModels[0]?.id || "meta/llama-3.1-8b-instruct";

  const keyConfigured = globalNvidiaKeys.length > 0 || Boolean(summaryModels[0]?.apiKey);
  if (!keyConfigured) {
    const result = {
      provider: "NVIDIA",
      keyConfigured: false,
      keyValid: false,
      selectedModel: selectedModelId,
      selectedModelAvailable: false,
      lastCheckedAt: Date.now(),
      status: "unhealthy",
      error: "NVIDIA API key is missing."
    };
    healthCache = result;
    return result;
  }

  const candidateKey = globalNvidiaKeys[0] || summaryModels[0]?.apiKey;
  const baseUrl = sanitizeBaseUrl(summaryModels[0]?.baseUrl || DEFAULT_BASE_URL);

  const validation = await validateNvidiaChatAccess({
    apiKey: candidateKey,
    baseUrl,
    modelId: selectedModelId,
  });

  const result = {
    provider: "NVIDIA",
    keyConfigured: true,
    keyValid: validation.ok,
    selectedModel: selectedModelId,
    selectedModelAvailable: validation.ok,
    lastCheckedAt: Date.now(),
    status: validation.ok ? "healthy" : "unhealthy",
    error: validation.ok ? null : validation.message || "Model validation failed."
  };

  if (validation.ok) {
    healthCache = result;
  }

  return result;
}

async function safeLoadSettings() {
  try {
    return (await getAdminSettings()) || {};
  } catch {
    return {};
  }
}

function normalizeNvidiaKeyPool(keysArray, singleKey) {
  const pool = [];
  const add = (k) => {
    const s = String(k || "").trim();
    if (s && !pool.includes(s)) pool.push(s);
  };
  if (Array.isArray(keysArray)) keysArray.forEach(add);
  add(singleKey);
  if (process.env.NVIDIA_API_KEY) add(process.env.NVIDIA_API_KEY);
  return pool;
}

function normalizeModels(models, keys) {
  if (!Array.isArray(models)) return [];
  const defaultKey = keys[0] || "";
  return models
    .filter(m => m && m.id)
    .map(m => ({
      id: String(m.id).trim(),
      label: String(m.label || m.id).trim(),
      apiKey: String(m.apiKey || defaultKey).trim(),
      baseUrl: String(m.baseUrl || DEFAULT_BASE_URL).trim(),
    }));
}

function sanitizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function validateNvidiaChatAccess({ apiKey, baseUrl, modelId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.1,
        max_tokens: 32,
        stream: false,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Say OK." },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = payload?.error?.message || payload?.message || `NVIDIA HTTP ${response.status}`;
      if (/model output must contain|output text or tool calls/i.test(errMsg)) {
        return { ok: true };
      }
      return { ok: false, message: errMsg };
    }
    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, message: "NVIDIA health check request timed out." };
    }
    return { ok: false, message: error?.message || "NVIDIA connection error." };
  } finally {
    clearTimeout(timeout);
  }
}
