// Shared NVIDIA transport for chat, analysis, model discovery, and health.
// Secrets and provider URLs come from server configuration, never from a chat body.
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const PREFERRED_CHAT_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "meta/llama-3.3-70b-instruct",
];
const catalogCaches = new WeakMap();
const healthCaches = new WeakMap();
const TTL = 5 * 60 * 1000;

export class NvidiaError extends Error {
  constructor(
    message,
    status = 502,
    code = "provider_error",
    upstreamStatus = null,
  ) {
    super(message);
    this.name = "NvidiaError";
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

export function isChatModel(id) {
  if (typeof id !== "string" || !id.trim() || id.length > 180) return false;
  if (
    /embed|rerank|retriev|reward|guard|safety|gliner|detector|calibration|deplot|ocdr|ocr|riva|parakeet|whisper|stable.?diffusion|\bflux\b|bge-|\bclip\b|protein|fold|weather|forecast|cuopt|nvclip/i.test(
      id,
    )
  )
    return false;
  return /instruct|chat|gpt-oss|deepseek|qwen|nemotron|mistral|minimax|kimi|yi-large|solar|gemma.*-it|jamba|granite/i.test(
    id,
  );
}

export function secureBaseUrl(value = NVIDIA_BASE_URL) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new NvidiaError(
      "The AI provider URL is invalid.",
      503,
      "invalid_configuration",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NvidiaError(
      "The AI provider must use a secure HTTPS URL without credentials or query parameters.",
      503,
      "invalid_configuration",
    );
  }
  return url.href.replace(/\/+$/, "");
}

export function serverModels(settings = {}, env = {}) {
  const source = [
    ...(Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels : []),
    ...(Array.isArray(settings.debateModels) ? settings.debateModels : []),
  ];
  const globalKey =
    [
      env.NVIDIA_API_KEY,
      settings.globalNvidiaApiKey,
      ...(Array.isArray(settings.globalNvidiaApiKeys)
        ? settings.globalNvidiaApiKeys
        : []),
    ]
      .find((key) => typeof key === "string" && key.trim())
      ?.trim() || "";
  return source
    .filter((model) => model && typeof model.id === "string" && model.id.trim())
    .map((model) => ({
      key: String(model.key || model.id),
      id: model.id.trim(),
      label: String(model.label || model.id),
      apiKey: String(
        env.NVIDIA_API_KEY || model.apiKey || globalKey || "",
      ).trim(),
      baseUrl: secureBaseUrl(model.baseUrl || NVIDIA_BASE_URL),
      debate:
        Array.isArray(settings.debateModels) &&
        settings.debateModels.includes(model) &&
        model.isDebateParticipant !== false,
    }));
}

export function credentials(settings = {}, env = {}) {
  if (typeof env.NVIDIA_API_KEY === "string" && env.NVIDIA_API_KEY.trim())
    return [{ apiKey: env.NVIDIA_API_KEY.trim(), baseUrl: NVIDIA_BASE_URL }];
  const candidates = [];
  const add = (key, baseUrl = NVIDIA_BASE_URL) => {
    if (typeof key !== "string" || !key.trim()) return;
    const apiKey = key.trim();
    const base = secureBaseUrl(baseUrl);
    if (
      !candidates.some(
        (item) => item.apiKey === apiKey && item.baseUrl === base,
      )
    )
      candidates.push({ apiKey, baseUrl: base });
  };
  add(settings.globalNvidiaApiKey);
  (Array.isArray(settings.globalNvidiaApiKeys)
    ? settings.globalNvidiaApiKeys
    : []
  ).forEach((key) => add(key));
  for (const model of serverModels(settings, {}))
    add(model.apiKey, model.baseUrl);
  return candidates.slice(0, 4);
}

function cacheFor(root, fetchImpl) {
  if (!root.has(fetchImpl)) root.set(fetchImpl, new Map());
  return root.get(fetchImpl);
}
async function credentialId(candidate) {
  const bytes = new TextEncoder().encode(
    `${candidate.baseUrl}\n${candidate.apiKey}`,
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function visibleText(payload) {
  const value = payload?.choices?.[0]?.message?.content;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value))
    return value
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  return "";
}

async function requestJson(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      throw new NvidiaError(
        "The AI provider timed out. Please try again.",
        504,
        "timeout",
      );
    throw new NvidiaError(
      "The AI provider could not be reached. Please try again.",
      502,
      "network_error",
    );
  } finally {
    clearTimeout(timer);
  }
}

function upstreamError(status) {
  if (status === 401 || status === 403)
    return new NvidiaError(
      "The AI provider rejected the configured key. Update the server's NVIDIA API key.",
      503,
      "invalid_key",
      status,
    );
  if (status === 404 || status === 410)
    return new NvidiaError(
      "That model has been removed or is no longer available from NVIDIA. Choose an active model.",
      503,
      "model_unavailable",
      status,
    );
  if (status === 429)
    return new NvidiaError(
      "The AI provider is rate-limiting requests. Wait a moment before retrying.",
      429,
      "rate_limited",
      status,
    );
  return new NvidiaError(
    "The AI provider could not complete this request. Try another model.",
    502,
    "provider_error",
    status,
  );
}

export async function discoverModels(
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  const configured = serverModels(settings, env);
  const candidates = credentials(settings, env);
  if (!candidates.length)
    throw new NvidiaError(
      "AI isn't configured yet. Add a permanent NVIDIA_API_KEY in the server environment or protected AI settings.",
      503,
      "missing_key",
    );
  let lastError;
  for (const candidate of candidates) {
    const token = await credentialId(candidate);
    const cache = cacheFor(catalogCaches, fetchImpl);
    let ids =
      cache.get(token)?.expires > Date.now() ? cache.get(token).ids : null;
    if (!ids) {
      try {
        const { response, payload } = await requestJson(
          `${candidate.baseUrl}/models`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${candidate.apiKey}`,
            },
          },
          10000,
          fetchImpl,
        );
        if (!response.ok) throw upstreamError(response.status);
        if (!Array.isArray(payload?.data))
          throw new NvidiaError(
            "NVIDIA returned an invalid model catalog.",
            502,
            "invalid_catalog",
          );
        ids = [
          ...new Set(
            payload.data.map((model) => model?.id).filter(isChatModel),
          ),
        ];
        if (!ids.length)
          throw new NvidiaError(
            "No conversational models are available for this NVIDIA key.",
            503,
            "no_models",
          );
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(token, { ids, expires: Date.now() + TTL });
      } catch (error) {
        lastError = error;
        if (error.code === "invalid_key") continue;
        throw error;
      }
    }
    const available = new Set(ids);
    const seen = new Set();
    const models = [];
    for (const model of configured) {
      if (
        model.baseUrl !== candidate.baseUrl ||
        !available.has(model.id) ||
        seen.has(model.id)
      )
        continue;
      seen.add(model.id);
      models.push({ ...model, ...candidate });
    }
    for (const id of ids)
      if (!seen.has(id))
        models.push({ key: id, id, label: id, debate: false, ...candidate });
    const priority = (id) => {
      const index = PREFERRED_CHAT_MODELS.indexOf(id);
      return index < 0 ? 99 : index;
    };
    models.sort((a, b) => priority(a.id) - priority(b.id));
    const primaryIds = new Set(
      (Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels : []).map(
        (model) => model?.id,
      ),
    );
    const preferred =
      models.find((model) => model.key === settings.defaultModelKey) ||
      models.find((model) => primaryIds.has(model.id)) ||
      models[0];
    return {
      models,
      defaultModelKey: preferred.key,
      configured,
      unavailableModels: configured
        .filter((model) => !available.has(model.id))
        .map(({ key, id }) => ({ key, id })),
      credentialId: token,
    };
  }
  throw (
    lastError ||
    new NvidiaError(
      "No working NVIDIA credential is configured.",
      503,
      "invalid_key",
    )
  );
}

export function publicModels(runtime) {
  return {
    models: runtime.models.map(({ key, id, label }) => ({ key, id, label })),
    defaultModelKey: runtime.defaultModelKey,
    configured: true,
    catalogChecked: true,
    completionVerified: false,
    unavailableModels: runtime.unavailableModels,
  };
}

export function selectModel(runtime, requestedKey = "", requestedId = "") {
  const key = requestedKey || requestedId || runtime.defaultModelKey;
  const match = runtime.models.find(
    (model) =>
      model.key === key ||
      model.id === key ||
      (requestedId && model.id === requestedId),
  );
  if (match) return { model: match, replaced: false };
  if (
    !requestedKey ||
    runtime.configured.some(
      (model) =>
        model.key === requestedKey ||
        model.id === requestedKey ||
        (requestedId && model.id === requestedId),
    )
  ) {
    return {
      model:
        runtime.models.find((model) => model.key === runtime.defaultModelKey) ||
        runtime.models[0],
      replaced: true,
    };
  }
  throw new NvidiaError(
    "That model is no longer available. Choose another active model.",
    400,
    "invalid_model",
  );
}

export async function requestCompletion(
  model,
  messages,
  options = {},
  fetchImpl = globalThis.fetch,
) {
  const reasoning = /gpt-oss|deepseek|qwq|thinking/i.test(model.id);
  const maxTokens = Math.min(
    8000,
    Math.max(reasoning ? 2048 : 64, options.maxTokens || 1200),
  );
  const body = {
    model: model.id,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: maxTokens,
    stream: false,
  };
  if (model.id.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  const started = Date.now();
  const { response, payload } = await requestJson(
    `${secureBaseUrl(model.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    options.timeoutMs || 30000,
    fetchImpl,
  );
  if (!response.ok) throw upstreamError(response.status);
  const content = visibleText(payload);
  if (!content)
    throw new NvidiaError(
      "The model returned no visible answer. Choose another model or try again.",
      502,
      "empty_response",
      response.status,
    );
  return {
    payload,
    content,
    model: model.id,
    durationMs: Date.now() - started,
  };
}

export async function completeWithFallback(
  runtime,
  selected,
  messages,
  options = {},
  fetchImpl = globalThis.fetch,
) {
  const candidates = [
    selected.model,
    ...runtime.models.filter((model) =>
      PREFERRED_CHAT_MODELS.includes(model.id),
    ),
  ]
    .filter(
      (model, index, all) =>
        all.findIndex((other) => other.id === model.id) === index,
    )
    .slice(0, 3);
  const deadline = options.deadline || Date.now() + 60000;
  const failures = [];
  for (const model of candidates) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) break;
    try {
      const result = await requestCompletion(
        model,
        messages,
        {
          ...options,
          timeoutMs: Math.min(options.timeoutMs || 30000, remaining),
        },
        fetchImpl,
      );
      return {
        ...result,
        modelFallbackUsed: selected.replaced || model.id !== selected.model.id,
        failures,
      };
    } catch (error) {
      if (!(error instanceof NvidiaError)) throw error;
      failures.push({
        model: model.id,
        code: error.code,
        status: error.upstreamStatus || error.status,
      });
      if (error.code === "invalid_key" || error.code === "rate_limited")
        throw error;
    }
  }
  const last = failures.at(-1);
  if (last?.code === "timeout" || Date.now() >= deadline)
    throw new NvidiaError(
      "The AI response exceeded its time limit. Please try again.",
      504,
      "timeout",
    );
  throw new NvidiaError(
    "None of the active AI models returned a usable answer. Check AI health and try again.",
    502,
    last?.code || "provider_error",
  );
}

export async function checkNvidiaHealth(
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  let runtime;
  try {
    runtime = await discoverModels(settings, env, fetchImpl);
    const selected = selectModel(runtime);
    const token = `${runtime.credentialId}:${selected.model.id}`;
    const cache = cacheFor(healthCaches, fetchImpl);
    if (cache.get(token)?.expires > Date.now()) return cache.get(token).result;
    const result = await completeWithFallback(
      runtime,
      selected,
      [{ role: "user", content: "Reply with only OK." }],
      {
        maxTokens: 256,
        temperature: 0,
        timeoutMs: 20000,
        deadline: Date.now() + 30000,
      },
      fetchImpl,
    );
    const health = {
      provider: "NVIDIA",
      keyConfigured: true,
      keyValid: true,
      selectedModel: result.model,
      selectedModelAvailable: true,
      completionVerified: true,
      status: "healthy",
      lastCheckedAt: Date.now(),
      error: null,
      activeModelCount: runtime.models.length,
      unavailableConfiguredModels: runtime.unavailableModels.length,
    };
    if (cache.size > 16) cache.clear();
    cache.set(token, { result: health, expires: Date.now() + 60000 });
    return health;
  } catch (error) {
    return {
      provider: "NVIDIA",
      keyConfigured: error.code !== "missing_key",
      keyValid: error.code === "invalid_key" ? false : null,
      selectedModel: runtime?.models[0]?.id || null,
      selectedModelAvailable: false,
      completionVerified: false,
      status: "unhealthy",
      lastCheckedAt: Date.now(),
      error:
        error instanceof NvidiaError
          ? error.message
          : "AI health check failed.",
      errorCode: error.code || "provider_error",
    };
  }
}
