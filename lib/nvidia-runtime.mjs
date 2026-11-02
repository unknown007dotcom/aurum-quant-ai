import { readEventStream } from "../modules/chat-stream.mjs";

// Shared NVIDIA transport for chat, analysis, model discovery, and health.
// Secrets and provider URLs come from server configuration, never from a chat body.
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const PREFERRED_CHAT_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "meta/llama-3.3-70b-instruct",
];
// Recovery hints, not an availability assertion. Each must still be in the
// live catalog. The final generic pool prevents another all-retired allowlist.
const CHAT_RECOVERY_MODELS = [
  "nvidia/nemotron-3.5-bolt-e4b",
  "google/gemma-4-31b-it",
  "google/gemma-3-12b-it",
  "google/gemma-3-4b-it",
  "ibm/granite-3.0-8b-instruct",
];
function catalogChatFallbacks(models) {
  const priority = (id) => {
    const known = CHAT_RECOVERY_MODELS.indexOf(id);
    if (known >= 0) return known;
    // Prefer modest general chat models to huge/coding/vision/reasoning models.
    const size = Number(id.match(/(?:^|[-/])(\d+(?:\.\d+)?)b(?:[-/]|$)/i)?.[1]);
    return 100 + (size || 1000);
  };
  return models
    .filter(
      (model) =>
        isChatModel(model.id) &&
        !/code|coder|codestral|vision|(?:^|[-/])vl(?:[-/]|$)|reasoning|thinking|deepseek|qwq/i.test(
          model.id,
        ),
    )
    .sort((a, b) => priority(a.id) - priority(b.id));
}
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
    /embed|rerank|retriev|reward|guard|safety|gliner|detector|calibration|deplot|ocdr|ocr|riva|parakeet|whisper|stable.?diffusion|\bflux\b|bge-|\bclip\b|protein|fold|weather|forecast|cuopt|nvclip|nemotron-parse/i.test(
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

function forwardAbort(signal, controller) {
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

async function requestJson(url, options, timeoutMs, fetchImpl, signal) {
  const controller = new AbortController();
  const unlinkAbort = forwardAbort(signal, controller);
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    controller.signal.throwIfAborted();
    return { response, payload };
  } catch (error) {
    signal?.throwIfAborted();
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
    unlinkAbort();
  }
}

function completionTimeout(phase = "deadline") {
  const messages = {
    first_token:
      "The AI provider did not start an answer in time. Please retry or choose another model.",
    idle: "The AI provider stopped sending answer text. Please retry or choose another model.",
    deadline: "The AI response exceeded its time limit. Please try again.",
  };
  const error = new NvidiaError(
    messages[phase] || messages.deadline,
    504,
    "timeout",
  );
  error.timeoutPhase = Object.hasOwn(messages, phase) ? phase : "deadline";
  return error;
}

// Three separate limits: waiting for the first visible answer, silence between
// answer tokens, and the overall generation deadline. Headers/heartbeats/private
// reasoning are not visible progress. A healthy answer may outlive its startup
// window, but never the overall deadline. Buffered-only endpoints still work.
async function requestStreamingCompletion(
  url,
  options,
  timeoutMs,
  idleTimeoutMs,
  fetchImpl,
  { onDelta, signal, deadline = Date.now() + timeoutMs } = {},
) {
  const controller = new AbortController();
  const unlinkAbort = forwardAbort(signal, controller);
  let timeoutPhase;
  let idleTimer;
  let hasVisibleAnswer = false;
  const abortTimeout = (phase) => {
    if (controller.signal.aborted) return;
    timeoutPhase = phase;
    controller.abort();
  };
  const absoluteTimer = setTimeout(
    () => abortTimeout("deadline"),
    Math.max(1, deadline - Date.now()),
  );
  const firstTokenTimer = setTimeout(
    () => abortTimeout("first_token"),
    Math.max(1, timeoutMs),
  );
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortTimeout("idle"),
      Math.max(1, idleTimeoutMs),
    );
  };
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch {}
      throw upstreamError(response.status);
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!response.body || contentType.includes("application/json")) {
      const payload = await response.json().catch(() => null);
      controller.signal.throwIfAborted();
      const content = visibleText(payload);
      if (content) onDelta?.(content);
      return {
        response,
        payload,
        content,
        finishReason: payload?.choices?.[0]?.finish_reason || null,
      };
    }
    let content = "";
    let finishReason = null;
    let streamModel = null;
    let usage = null;
    let streamDone = false;
    for await (const frame of readEventStream(response.body, {
      signal: controller.signal,
    })) {
      if (frame.data.trim() === "[DONE]") {
        streamDone = true;
        break;
      }
      let event;
      try {
        event = JSON.parse(frame.data);
      } catch {
        throw new NvidiaError(
          "The AI response was interrupted. Please try again.",
          502,
          "incomplete_stream",
        );
      }
      // Do not forward provider errors, usage, tools, or private reasoning.
      if (event?.error || frame.event === "error")
        throw new NvidiaError(
          "The AI provider interrupted the response. Please try again.",
          502,
          "provider_error",
        );
      streamModel = event?.model || streamModel;
      usage = event?.usage || usage;
      const choice = event?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta ?? choice?.message;
      const text =
        typeof delta?.content === "string"
          ? delta.content
          : Array.isArray(delta?.content)
            ? delta.content
                .map((part) =>
                  typeof part?.text === "string" ? part.text : "",
                )
                .join("")
            : "";
      if (text) {
        content += text;
        if (!hasVisibleAnswer && content.trim()) {
          hasVisibleAnswer = true;
          clearTimeout(firstTokenTimer);
        }
        if (hasVisibleAnswer) resetIdleTimer();
        onDelta?.(text);
      }
      // OpenAI-compatible servers can keep the transport alive after the
      // terminal choice (e.g. waiting to emit usage or [DONE]). Do not turn an
      // already complete answer into an idle timeout. Process its last delta
      // first, then cancel the reader without waiting for the socket to close.
      if (finishReason) break;
    }
    if (!streamDone && !finishReason)
      throw new NvidiaError(
        "The AI response was interrupted. Please try again.",
        502,
        "incomplete_stream",
      );
    const trimmed = content.trim();
    return {
      response,
      payload: {
        model: streamModel,
        usage,
        choices: [
          { message: { content: trimmed }, finish_reason: finishReason },
        ],
      },
      content: trimmed,
      finishReason,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof NvidiaError) throw error;
    if (
      timeoutPhase ||
      error?.name === "AbortError" ||
      error?.name === "TimeoutError"
    )
      throw completionTimeout(timeoutPhase);
    throw new NvidiaError(
      "The AI provider could not be reached. Please try again.",
      502,
      "network_error",
    );
  } finally {
    clearTimeout(absoluteTimer);
    clearTimeout(firstTokenTimer);
    clearTimeout(idleTimer);
    unlinkAbort();
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
  // Saved browser keys outlive model imports and provider retirements. Resolve
  // only against the server catalog; never send an unknown client model upstream.
  const find = (value) =>
    value &&
    runtime.models.find((model) => model.key === value || model.id === value);
  const requested = find(requestedKey) || find(requestedId);
  if (requested) return { model: requested, replaced: false };
  const fallback = find(runtime.defaultModelKey) || runtime.models[0];
  if (!fallback)
    throw new NvidiaError(
      "No conversational models are available.",
      503,
      "no_models",
    );
  return {
    model: fallback,
    replaced: Boolean(requestedKey || requestedId),
  };
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
  const streaming = options.stream === true;
  const body = {
    model: model.id,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: maxTokens,
    stream: streaming,
  };
  if (model.id.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  // Only server-side analysis code opts into structured output, never chat input.
  if (options.jsonOutput) body.response_format = { type: "json_object" };
  const started = Date.now();
  const timeoutMs = options.timeoutMs || 30000;
  const deadline = options.deadline || started + timeoutMs;
  // Negotiating stream:true and retrying stream:false share one startup budget.
  // Only a visible streaming answer can continue up to the overall deadline.
  const attemptDeadline = Math.min(deadline, started + timeoutMs);
  const remainingAttempt = () => {
    options.signal?.throwIfAborted();
    const remaining = attemptDeadline - Date.now();
    if (remaining <= 0)
      throw completionTimeout(
        streaming && Date.now() < deadline ? "first_token" : "deadline",
      );
    return remaining;
  };
  const buildRequestOptions = (useStream) => ({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: useStream
        ? "text/event-stream, application/json"
        : "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({ ...body, stream: useStream }),
  });
  const endpoint = `${secureBaseUrl(model.baseUrl)}/chat/completions`;
  let response;
  let payload;
  let content;
  let finishReason;
  let streamed = null;
  if (streaming) {
    try {
      streamed = await requestStreamingCompletion(
        endpoint,
        buildRequestOptions(true),
        remainingAttempt(),
        options.idleTimeoutMs || 20000,
        fetchImpl,
        { onDelta: options.onDelta, signal: options.signal, deadline },
      );
    } catch (error) {
      // A model/endpoint that rejects streaming outright gets one buffered
      // retry; timeouts, auth and rate limits keep their normal handling.
      if (
        !(error instanceof NvidiaError) ||
        ![400, 422].includes(error.upstreamStatus || 0)
      )
        throw error;
    }
  }
  if (streamed) {
    response = streamed.response;
    payload = streamed.payload;
    content = streamed.content;
    finishReason = streamed.finishReason;
  } else {
    const result = await requestJson(
      endpoint,
      buildRequestOptions(false),
      remainingAttempt(),
      fetchImpl,
      options.signal,
    ).catch((error) => {
      if (streaming && error instanceof NvidiaError && error.code === "timeout")
        throw completionTimeout(
          Date.now() < deadline ? "first_token" : "deadline",
        );
      throw error;
    });
    response = result.response;
    payload = result.payload;
    if (!response.ok) throw upstreamError(response.status);
    content = visibleText(payload);
    finishReason = payload?.choices?.[0]?.finish_reason;
    if (content) options.onDelta?.(content);
  }
  if (!content)
    throw new NvidiaError(
      "The model returned no visible answer. Choose another model or try again.",
      502,
      finishReason === "length" ? "output_limit" : "empty_response",
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
    ...(options.catalogFallback ? catalogChatFallbacks(runtime.models) : []),
  ]
    .filter(
      (model, index, all) =>
        all.findIndex((other) => other.id === model.id) === index,
    )
    .slice(0, 3);
  const deadline = options.deadline || Date.now() + 60000;
  const failures = [];
  let correctionUsed = false;
  for (const [candidateIndex, model] of candidates.entries()) {
    let attemptMessages = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) break;
      const attemptStarted = Date.now();
      try {
        options.signal?.throwIfAborted();
        options.onAttempt?.({
          model: model.id,
          modelFallbackUsed:
            selected.replaced || model.id !== selected.model.id,
        });
        // Reserve time for fallback while a candidate is still starting. A
        // streaming answer that is already writing uses idle + overall limits,
        // not this startup cap. Buffered analysis retains its per-attempt cap.
        // The final candidate can use the remaining request budget.
        const isLastCandidate = candidateIndex === candidates.length - 1;
        const attemptTimeoutMs = isLastCandidate
          ? remaining
          : Math.min(options.timeoutMs || 30000, remaining);
        const result = await requestCompletion(
          model,
          attemptMessages,
          {
            ...options,
            maxTokens: attempt
              ? Math.min(8000, Math.max(4096, (options.maxTokens || 1200) * 2))
              : options.maxTokens,
            timeoutMs: Math.max(1, attemptTimeoutMs),
            deadline,
          },
          fetchImpl,
        );
        // A 200 with arbitrary text is not necessarily a usable analysis.
        // Validate before accepting a candidate so repair/fallback can happen.
        const content = options.validateContent
          ? options.validateContent(result.content)
          : result.content;
        return {
          ...result,
          content,
          modelFallbackUsed:
            selected.replaced || model.id !== selected.model.id,
          responseRepaired: correctionUsed,
          failures,
        };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof NvidiaError)) throw error;
        const failure = {
          model: model.id,
          code: error.code,
          status: error.upstreamStatus || error.status,
          durationMs: Math.max(0, Date.now() - attemptStarted),
          ...(error.timeoutPhase ? { timeoutPhase: error.timeoutPhase } : {}),
        };
        failures.push(failure);
        // A server-only diagnostic callback: no prompts, keys, URLs, raw
        // provider errors, reasoning or answer text are included.
        options.onAttemptFailure?.(failure);
        if (error.code === "invalid_key" || error.code === "rate_limited")
          throw error;
        const canCorrect =
          error.code === "output_limit" ||
          (error.code === "invalid_analysis" && options.repairMessage);
        if (
          !correctionUsed &&
          !attempt &&
          canCorrect &&
          deadline - Date.now() >= 1000
        ) {
          correctionUsed = true;
          if (error.code === "invalid_analysis")
            attemptMessages = [
              ...messages,
              { role: "user", content: options.repairMessage },
            ];
          continue;
        }
        break;
      }
    }
  }
  const last = failures.at(-1);
  if (last?.code === "timeout" || Date.now() >= deadline) {
    const error = completionTimeout(
      Date.now() >= deadline ? "deadline" : last?.timeoutPhase,
    );
    error.failures = failures;
    throw error;
  }
  if (last?.code === "invalid_analysis")
    throw new NvidiaError(
      "The AI could not produce a complete analysis. Please retry; no AI trade plan was accepted.",
      502,
      "invalid_analysis",
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
