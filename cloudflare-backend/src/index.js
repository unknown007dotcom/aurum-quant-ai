const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_INSTRUMENT = "XAU_USD";
const HISTORY_LIMIT = 150;
const MIN_DEPTH = 0.10;
const ALLOWED_ORIGINS = [
  "https://aurum-quant-ai.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const GRANULARITY_MAP = {
  "1min": "M1",
  "5min": "M5",
  "15min": "M15",
  "1h": "H1",
  "4h": "H4",
  "1day": "D",
  "1week": "W",
  "1month": "M",
};

const CACHE_TTL_SECONDS = 7200; // 2 hours — auto-deleted by Cloudflare after expiry

/**
 * Compresses raw candle JSON array into an ultra-minimized flat array of numbers.
 * Mapping: [0]=Unix Timestamp, [1]=Open, [2]=High, [3]=Low, [4]=Close, [5]=Volume
 * Achieves ~66% storage reduction versus verbose JSON keys.
 */
function compressCandles(rawCandles) {
  if (!Array.isArray(rawCandles)) return [];
  return rawCandles.map(c => [
    Math.floor(new Date(c.datetime).getTime() / 1000), // Index [0]: Unix Timestamp (seconds)
    c.open,                                            // Index [1]: Open
    c.high,                                            // Index [2]: High
    c.low,                                             // Index [3]: Low
    c.close,                                           // Index [4]: Close
    c.volume || 0                                      // Index [5]: Volume
  ]);
}

/**
 * Inflates the flat number arrays back into the standard JSON objects the frontend/AI expects.
 */
function inflateCandles(flatCandles) {
  if (!Array.isArray(flatCandles)) return [];
  return flatCandles.map(item => ({
    datetime: new Date(item[0] * 1000).toISOString(),
    open: item[1],
    high: item[2],
    low: item[3],
    close: item[4],
    volume: item[5],
    complete: true
  }));
}

/**
 * Fetches candle data using Cloudflare KV as a high-speed edge cache with auto-expiry.
 * Cache-Aside Pattern: KV read → (HIT? inflate & return) : (MISS? OANDA fetch → compress → KV write with TTL → return)
 */
async function fetchCandlesWithCache(env, options = {}) {
  const instrument = normalizeInstrument(options.instrument || DEFAULT_INSTRUMENT);
  const timeframe = String(options.timeframe || "15min");
  const count = clampInt(options.count, 1000, 30, 2500);
  
  // Use a master cache key without the requested count, so we build a single growing dataset per timeframe
  const cacheKey = `candles:${instrument}:${timeframe}:master`;

  // 1. Attempt to read existing history from the Cloudflare KV Edge Cache
  let cachedCandles = [];
  let cacheHit = false;
  try {
    if (env.CANDLE_CACHE) {
      const cachedData = await env.CANDLE_CACHE.get(cacheKey);
      if (cachedData) {
        const flatArray = JSON.parse(cachedData);
        cachedCandles = inflateCandles(flatArray);
        if (cachedCandles.length > 0) {
          cacheHit = true;
        }
      }
    }
  } catch (err) {
    console.error("KV read error:", err);
  }

  // Define timeframe freshness threshold in milliseconds
  const timeframeMs = {
    "1min": 1 * 60 * 1000,
    "5min": 5 * 60 * 1000,
    "15min": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1day": 24 * 60 * 60 * 1000,
    "1week": 7 * 24 * 60 * 60 * 1000,
    "1month": 30 * 24 * 60 * 60 * 1000
  };
  const duration = timeframeMs[timeframe] || (15 * 60 * 1000);

  // Check if cache is fresh enough.
  // Cache is fresh if the latest candle's timestamp is within the timeframe duration.
  let isFresh = false;
  if (cacheHit && cachedCandles.length > 0) {
    const lastCandle = cachedCandles.at(-1);
    const lastTime = new Date(lastCandle.datetime).getTime();
    if (Date.now() - lastTime < duration) {
      isFresh = true;
    }
  }

  // If the cache is fresh, return the uncut dataset directly! (Extremely fast Cache Hit!)
  if (isFresh) {
    return {
      source: "KV_CACHE",
      candles: cachedCandles
    };
  }

  // 2. Cache is stale or missing -> Fetch fresh rolling window from OANDA
  // To grow the history, we always request the fresh rolling window (the count requested, up to 2500)
  const freshCandles = await fetchCandles(env, { instrument, timeframe, count });

  if (Array.isArray(freshCandles) && freshCandles.length > 0) {
    // 3. Merge new candles into the permanent cached history (avoiding duplicate datetimes)
    const mergedMap = new Map();
    
    // Add existing history first
    cachedCandles.forEach(c => {
      if (c.datetime) mergedMap.set(c.datetime, c);
    });
    
    // Add/overwrite with fresh candles (so any incomplete candles get updated!)
    freshCandles.forEach(c => {
      if (c.datetime) mergedMap.set(c.datetime, c);
    });

    // Convert back to array, sort chronologically ascending
    let mergedList = Array.from(mergedMap.values()).sort((a, b) => a.datetime.localeCompare(b.datetime));

    // Cap the permanent history database to a very generous 5,000 candles to keep performance optimal
    if (mergedList.length > 5000) {
      mergedList = mergedList.slice(-5000);
    }

    // 4. Save the expanded history back to KV PERMANENTLY (No expiration TTL! Never deleted!)
    if (env.CANDLE_CACHE) {
      try {
        const compressed = compressCandles(mergedList);
        await env.CANDLE_CACHE.put(cacheKey, JSON.stringify(compressed));
      } catch (err) {
        console.error("KV write error:", err);
      }
    }

    return {
      source: "OANDA_LIVE_MERGED",
      candles: mergedList
    };
  }

  // Fallback to whatever is cached if OANDA fetch failed
  if (cachedCandles.length > 0) {
    return {
      source: "KV_CACHE_FALLBACK",
      candles: cachedCandles
    };
  }

  return { source: "OANDA_LIVE", candles: freshCandles };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "aurum-quant-edge" }, request);
      }
      if (url.pathname === "/market-mtf" && request.method === "GET") {
        return handleMarketMtfResponse(url, env, request);
      }
      if (url.pathname === "/bot") {
        return jsonResponse(await handleBot(request, env, ctx), request);
      }
      if (url.pathname === "/history-log") {
        return jsonResponse(await handleHistoryLog(request, env), request);
      }
      if (url.pathname === "/ai-decision" && request.method === "POST") {
        return jsonResponse(await handleAiDecision(request, env), request);
      }
      if (url.pathname === "/settings") {
        return jsonResponse(await handleSettings(request, env), request);
      }
      if (url.pathname === "/oanda/account" && request.method === "GET") {
        return jsonResponse(await loadAccountSummary(env), request);
      }
      if (url.pathname === "/oanda/history" && request.method === "GET") {
        return jsonResponse(await loadClosedTrades(env), request);
      }
      return jsonResponse({ message: "Not found." }, request, 404);
    } catch (error) {
      return jsonResponse({ message: error?.message || "Worker request failed." }, request, 502);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBotTick(env, { source: "cron", executeTrades: true }).catch(console.error));
  }
};

async function handleMarketMtfResponse(url, env, request) {
  const symbol = normalizeInstrument(url.searchParams.get("symbol") || DEFAULT_INSTRUMENT);
  const entryTf = String(url.searchParams.get("entryTf") || "15min");
  const outputsize = clampInt(url.searchParams.get("outputsize"), 1000, 30, 2500);
  const payload = await fetchMtfPayload(env, { instrument: symbol, entryTf, outputsize });
  const cacheStatus = payload.cache_status || "MISS";
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Cache": cacheStatus,
      ...corsHeaders(request),
    },
  });
}

async function handleBot(request, env, ctx) {
  if (request.method === "GET") {
    return getBotStatus(env);
  }

  if (request.method !== "POST") {
    throw new Error("Method not allowed.");
  }

  assertAdmin(request, env);
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "").toLowerCase();
  if (action === "start") {
    const status = await updateBotSettings(env, { botEnabled: true });
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(runBotTick(env, { source: "manual-start-trigger", executeTrades: true }).catch(console.error));
    }
    return { ok: true, action: "start", status };
  }
  if (action === "stop") {
    const status = await updateBotSettings(env, { botEnabled: false });
    return { ok: true, action: "stop", status };
  }
  if (action === "tick") {
    const result = await runBotTick(env, { source: "manual-ui", executeTrades: false });
    return { ok: true, action: "tick", result };
  }
  if (action === "run-live-tick") {
    const result = await runBotTick(env, { source: "manual-trigger", executeTrades: true });
    return { ok: true, action: "run-live-tick", result };
  }
  if (action === "save-config") {
    const patch = sanitizeBotPatch(body.config || {});
    const status = await updateBotSettings(env, patch);
    return { ok: true, action: "save-config", status };
  }
  throw new Error("Unsupported bot action.");
}

async function handleHistoryLog(request, env) {
  if (request.method === "GET") {
    const limit = clampInt(new URL(request.url).searchParams.get("limit"), 100, 1, 200);
    const entries = await loadHistoryEntries(env);
    return { entries: entries.slice(0, limit) };
  }
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const entry = body?.entry && typeof body.entry === "object" ? body.entry : null;
    if (!entry) throw new Error("Missing history entry.");
    const source = String(body?.source || "manual");
    const saved = await appendHistoryEntry(env, {
      ...entry,
      source,
      syncId: String(entry.syncId || entry.id || `${Date.now()}`),
      timestampIso: String(entry.timestampIso || entry.timestamp || new Date().toISOString()),
      createdAt: Number(entry.createdAt || Date.now()),
    });
    return { ok: true, entry: saved };
  }
  throw new Error("Method not allowed.");
}

async function handleSettings(request, env) {
  const url = new URL(request.url);
  const action = String(url.searchParams.get("action") || "");
  const settings = await loadSettings(env);
  const supplied = String(request.headers.get("x-admin-password") || "");
  const adminPassword = String(env.ADMIN_PASSWORD || "CHANGE_ME_PASSWORD").trim();
  const isAdmin = supplied === adminPassword;

  if (request.method === "GET") {
    if (action === "metrics") {
      return { metrics: computeMetrics(await loadHistoryEntries(env)) };
    }
    return { settings: isAdmin ? settings : sanitizePublicSettings(settings), isAdmin };
  }

  if (request.method !== "POST") {
    throw new Error("Method not allowed.");
  }

  assertAdmin(request, env);
  const body = await request.json().catch(() => ({}));
  if (action === "fetch-nvidia") {
    return handleFetchNvidia(body);
  }
  const next = { ...settings, ...body };
  await saveSettings(env, next);
  return { ok: true };
}

function resolveBestModelReplacement(modelId, availableModels) {
  const list = Array.isArray(availableModels) ? availableModels : [];
  if (list.length === 0) return modelId;

  const id = String(modelId || "").toLowerCase().trim();
  const exactMatch = list.find((m) => String(m.id || "").toLowerCase().trim() === id);
  if (exactMatch) return exactMatch.id;

  const isLlama = id.includes("llama");
  const isGemma = id.includes("gemma");
  const isMistral = id.includes("mistral");
  const is70B = id.includes("70b");
  const is8B = id.includes("8b");

  let match = list.find((m) => {
    const mId = String(m.id || "").toLowerCase();
    if (isLlama && !mId.includes("llama")) return false;
    if (isGemma && !mId.includes("gemma")) return false;
    if (isMistral && !mId.includes("mistral")) return false;
    if (is70B && !mId.includes("70b")) return false;
    if (is8B && !mId.includes("8b")) return false;
    return true;
  });
  if (match) return match.id;

  match = list.find((m) => {
    const mId = String(m.id || "").toLowerCase();
    if (isLlama && mId.includes("llama")) return true;
    if (isGemma && mId.includes("gemma")) return true;
    if (isMistral && mId.includes("mistral")) return true;
    return false;
  });
  if (match) return match.id;

  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "mistralai/mistral-7b-instruct-v0.3",
  ];
  const smoke = preferred.map((prefId) => list.find((m) => m.id === prefId)).find(Boolean) ||
    list.find((m) => /(?:instruct|chat|gpt-oss)/i.test(m.id));
  if (smoke) return smoke.id;

  return list[0].id;
}

async function handleAiDecision(request, env) {
  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return { message: "Missing AI prompt." };
  }

  const settings = await loadSettings(env);

  // --- Collect all available API keys (deduplicated, ordered by priority) ---
  const candidateKeys = [];
  const addKey = (k) => { const s = String(k || "").trim(); if (s && !candidateKeys.includes(s)) candidateKeys.push(s); };

  // 1. Keys from the request body models (frontend localStorage carries per-model apiKey)
  const bodyModels = Array.isArray(body.models) ? body.models : [];
  const bodyDebateModels = Array.isArray(body.debateModels) ? body.debateModels : [];
  const selectedKey = String(body.selectedModelKey || "");
  const selectedModel = bodyModels.find((m) => m.key === selectedKey) || bodyModels[0];
  if (selectedModel?.apiKey) addKey(selectedModel.apiKey);
  bodyModels.forEach((m) => addKey(m?.apiKey));
  bodyDebateModels.forEach((m) => addKey(m?.apiKey));

  // 2. Body-level direct key
  addKey(body.apiKey);

  // 3. Global key from KV settings (admin saved)
  addKey(settings.globalNvidiaApiKey);

  // 4. Array of global keys from KV settings
  if (Array.isArray(settings.globalNvidiaApiKeys)) {
    settings.globalNvidiaApiKeys.forEach((k) => addKey(k));
  }

  // 5. Environment secret
  addKey(env.NVIDIA_API_KEY);

  // --- Resolve model ID and base URL ---
  const kvModels = Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels : [];
  const allModels = [...bodyModels, ...kvModels];
  const model = allModels.find((m) => m.key === selectedKey) || allModels[0] || {};
  const modelId = String(model?.id || body.model || "").trim();
  const baseUrl = String(model?.baseUrl || body.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!candidateKeys.length) {
    return createTextPayload(buildServerFallbackSummary(prompt, { reason: "No configured AI model or API key. Save your NVIDIA API key in Admin Settings." }), "server-fallback");
  }

  const access = await resolveWorkingNvidiaAccess(candidateKeys, baseUrl);
  if (!access.ok) {
    return {
      ...createTextPayload(buildServerFallbackSummary(prompt, { reason: access.message }), modelId || "server-fallback"),
      fallbackUsed: true,
      fallbackReason: sanitizeProviderFailureReason(access.message),
      keysAttempted: candidateKeys.length,
    };
  }

  const selectedModelId = access.modelIds.has(modelId)
    ? modelId
    : resolveBestModelReplacement(modelId, access.models);

  if (!selectedModelId) {
    return {
      ...createTextPayload(buildServerFallbackSummary(prompt, { reason: "No NVIDIA chat models are available to this key. Import NVIDIA models again from Settings." }), "server-fallback"),
      fallbackUsed: true,
      fallbackReason: "No available NVIDIA models.",
      keysAttempted: candidateKeys.length,
    };
  }

  try {
    const response = await fetch(`${access.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${access.apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModelId,
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2,
        max_tokens: 1200,
        stream: false,
        messages: [
          { role: "system", content: buildSummarySystemPrompt() },
          { role: "user", content: prompt },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      return normalizeAiPayload(payload, prompt);
    }

    const reason = payload?.error?.message || payload?.message || `AI HTTP ${response.status}`;
    return {
      ...createTextPayload(buildServerFallbackSummary(prompt, { reason }), selectedModelId),
      fallbackUsed: true,
      fallbackReason: sanitizeProviderFailureReason(reason),
      keysAttempted: candidateKeys.length,
    };
  } catch (fetchErr) {
    const reason = fetchErr?.message || "Network error calling AI provider.";
    return {
      ...createTextPayload(buildServerFallbackSummary(prompt, { reason }), selectedModelId),
      fallbackUsed: true,
      fallbackReason: sanitizeProviderFailureReason(reason),
      keysAttempted: candidateKeys.length,
    };
  }
}

async function resolveWorkingNvidiaAccess(candidateKeys, baseUrl) {
  const cleanBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const errors = [];
  for (const apiKey of candidateKeys.slice(0, 5)) {
    try {
      const response = await fetch(`${cleanBase}/models`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        const models = Array.isArray(payload?.data)
          ? payload.data
              .map((item) => ({ id: String(item?.id || "").trim(), label: String(item?.id || "").trim() }))
              .filter((item) => item.id)
          : [];
        const validationModel = pickNvidiaSmokeTestModel(models);
        if (!validationModel) {
          errors.push("NVIDIA returned a model catalog, but no chat-capable validation model was found.");
          continue;
        }
        const smoke = await validateNvidiaChatAccess({
          apiKey,
          baseUrl: cleanBase,
          modelId: validationModel.id,
        });
        if (!smoke.ok) {
          errors.push(smoke.message || `NVIDIA chat validation failed for ${validationModel.id}.`);
          continue;
        }
        return {
          ok: true,
          apiKey,
          baseUrl: cleanBase,
          models,
          modelIds: new Set(models.map((item) => item.id)),
        };
      }
      errors.push(payload?.error?.message || payload?.message || `NVIDIA models HTTP ${response.status}`);
    } catch (error) {
      errors.push(error?.message || "Unable to reach NVIDIA model catalog.");
    }
  }
  return { ok: false, message: errors.filter(Boolean).join(" | ") || "All NVIDIA keys failed model-catalog validation." };
}

function pickNvidiaSmokeTestModel(models) {
  const list = Array.isArray(models) ? models : [];
  const preferred = [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "openai/gpt-oss-20b",
    "mistralai/mistral-7b-instruct-v0.3",
  ];
  return preferred.map((id) => list.find((model) => model.id === id)).find(Boolean) ||
    list.find((model) => /(?:instruct|chat|gpt-oss)/i.test(model.id));
}

async function validateNvidiaChatAccess({ apiKey, baseUrl, modelId, signal }) {
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const response = await fetch(`${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        temperature: 0,
        max_tokens: 4,
        stream: false,
        messages: [
          { role: "user", content: "Reply OK." },
        ],
      }),
      signal: signal || controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        message: payload?.error?.message || payload?.message || `NVIDIA chat validation HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, statusCode: 504, message: `NVIDIA chat validation timed out for ${modelId}.` };
    }
    return { ok: false, statusCode: 502, message: error?.cause?.code ? `${error.message} (${error.cause.code})` : error?.message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeAiPayload(payload, prompt) {
  const text = extractAiText(payload);
  if (!text) return payload;
  try {
    JSON.parse(stripJsonFence(text));
    return payload;
  } catch {
    return setAiText(payload, JSON.stringify(buildStructuredSummaryFromText(text, prompt), null, 2));
  }
}

async function getBotStatus(env) {
  const settings = await loadSettings(env);
  const runtime = await loadRuntime(env);
  const [price, openTrades, accountSummary, closedTrades, history] = await Promise.all([
    fetchPrice(env, { instrument: settings.botInstrument || DEFAULT_INSTRUMENT }).catch(() => null),
    listOpenTrades(env, { instrument: settings.botInstrument || DEFAULT_INSTRUMENT }).catch(() => []),
    loadAccountSummary(env).catch(() => null),
    loadClosedTrades(env).catch(() => ({ trades: [] })),
    loadHistoryEntries(env),
  ]);

  return {
    configured: Boolean(env.OANDA_API_TOKEN),
    environment: normalizeEnvironment(settings.oandaEnvironment || env.OANDA_ENVIRONMENT || "practice"),
    instrument: normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT),
    botEnabled: Boolean(settings.botEnabled),
    botMode: normalizeBotMode(settings.botMode),
    units: clampInt(settings.botUnits, 10, 1, 1000000),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
    pollIntervalSeconds: clampInt(settings.botPollIntervalSeconds, 60, 15, 3600),
    latestPrice: price?.mid || runtime?.lastPrice || null,
    latestPriceTime: price?.time || runtime?.lastPriceTime || "",
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
    openTrades,
    accountSummary: accountSummary?.account || null,
    recentClosedTrades: Array.isArray(closedTrades?.trades) ? closedTrades.trades.slice(0, 12) : [],
    recentHistory: history.slice(0, 20),
    runtime,
  };
}

async function runBotTick(env, options = {}) {
  const settings = await loadSettings(env);
  const runtime = await loadRuntime(env);
  const executeTrades = Boolean(options.executeTrades);
  const instrument = normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT);
  const botConfig = {
    instrument,
    botEnabled: Boolean(settings.botEnabled),
    botMode: normalizeBotMode(settings.botMode),
    units: clampInt(settings.botUnits, 10, 1, 1000000),
    stopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    takeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    cooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
  };

  const [mtfData, latestPrice, openTrades] = await Promise.all([
    fetchMtfPayload(env, { instrument, entryTf: "15min", outputsize: 1000 }),
    fetchPrice(env, { instrument }),
    listOpenTrades(env, { instrument }).catch(() => []),
  ]);

  const analysis = analyzeMtfData(mtfData, latestPrice);
  applyBotRiskProfile(analysis, botConfig);
  const windowCheck = checkTradingWindow();

  let action = "analysis-generated";
  let reason = "Analysis complete.";

  if (!botConfig.botEnabled) {
    action = "skipped";
    reason = "Bot is stopped.";
  } else if (!windowCheck.allowed) {
    action = "blocked";
    reason = windowCheck.reason;
  }

  // Generate Alert if any liquidity sweeps were detected OR a perfect signal is present
  const isPerfectSignal = (analysis.decision.score >= 3 && analysis.trend === "bullish") || (analysis.decision.score <= -2 && analysis.trend === "bearish");
  if (action !== "skipped" && action !== "blocked") {
    if (Array.isArray(analysis.sweeps) && analysis.sweeps.length > 0) {
      reason = `CRT Event: ${analysis.sweeps.map(s => `${s.name} (${s.condition})`).join(", ")}`;
      action = "alert-sweep";
    } else if (isPerfectSignal) {
      reason = `PERFECT SIGNAL: ${analysis.decision.action} Confluence fully aligned!`;
      action = "alert-sweep";
    }
  }

  const nextRuntime = {
    lastTickAt: Date.now(),
    lastSource: String(options.source || "manual"),
    lastPrice: latestPrice?.mid || analysis.price,
    lastPriceTime: latestPrice?.time || "",
    lastDecision: analysis.decision.action,
    lastConfidence: analysis.decision.confidence,
    lastReason: reason,
    lastAction: action,
    lastAnalysis: {
      trend: analysis.trend,
      summary: analysis.decision.tradePlan,
      tp1: analysis.decision.tp1,
      tp2: analysis.decision.tp2,
      stopPrice: analysis.decision.stopPrice,
    },
    openTradesCount: Array.isArray(openTrades) ? openTrades.length : 0,
    lastExecutedAt: action === "alert-sweep" ? Date.now() : runtime?.lastExecutedAt || null,
    lastOrderId: "",
  };

  await saveRuntime(env, nextRuntime);
  await appendHistoryEntry(env, {
    id: `bot-${Date.now()}`,
    title: `Bot Tick ${new Date().toLocaleTimeString("en-US", { hour12: false })}`,
    timestampIso: new Date().toISOString(),
    timeframe: "15min",
    price: String(analysis.price),
    summary: analysis.decision.tradePlan,
    executionOverview: [
      `Direction: ${analysis.decision.action}`,
      `Confidence: ${analysis.decision.confidence}%`,
      `Stop: ${analysis.decision.stopPrice}`,
      `Target: ${analysis.decision.tp2}`,
    ],
    aiOverlay: reason,
    botAction: action,
    syncId: `bot-${Date.now()}`,
    createdAt: Date.now(),
  });

  return {
    ok: true,
    analysis,
    latestPrice,
    action,
    reason,
    orderResponse,
    status: await getBotStatus(env),
  };
}

async function loadAccountSummary(env) {
  const config = await getOandaConfig(env);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/summary`);
}

async function loadClosedTrades(env) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument((await loadSettings(env)).botInstrument || config.instrument);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/trades`, {
    query: {
      state: "CLOSED",
      instrument,
      count: 20,
    },
  });
}

async function fetchMtfPayload(env, options = {}) {
  const instrument = normalizeInstrument(options.instrument || DEFAULT_INSTRUMENT);
  const entryTf = String(options.entryTf || "15min");
  
  // BUG FIX: Increase default saved candles to 1,000 (clamped up to 2,500)
  const outputsize = clampInt(options.outputsize, 1000, 30, 2500);

  // Fetch all timeframes in parallel using the KV edge cache (now storing 1,000 candles!)
  const [m5Payload, m15Payload, h1Payload, h4Payload, dailyPayload, weeklyPayload, monthlyPayload] = await Promise.all([
    fetchCandlesWithCache(env, { instrument, timeframe: "5min", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "15min", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1h", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "4h", count: outputsize }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1day", count: outputsize }),
    // Weekly and Monthly are naturally shorter timeframes, so we clamp them safely:
    fetchCandlesWithCache(env, { instrument, timeframe: "1week", count: Math.min(outputsize, 1000) }),
    fetchCandlesWithCache(env, { instrument, timeframe: "1month", count: Math.min(outputsize, 500) }),
  ]);

  // Determine aggregate cache status for the X-Cache header
  const allPayloads = [m5Payload, m15Payload, h1Payload, h4Payload, dailyPayload, weeklyPayload, monthlyPayload];
  const allFromCache = allPayloads.every(p => p.source === "KV_CACHE");
  const noneFromCache = allPayloads.every(p => p.source === "OANDA_LIVE");
  const cacheStatus = allFromCache ? "HIT" : noneFromCache ? "MISS" : "PARTIAL_MISS";

  return {
    status: "ok",
    provider: "oanda",
    cache_status: cacheStatus,
    data: [
      { id: "5min", values: m5Payload.candles, symbolUsed: instrument },
      { id: "15min", values: m15Payload.candles, symbolUsed: instrument },
      { id: "entry", values: entryTf === "15min" ? m15Payload.candles : m5Payload.candles, symbolUsed: instrument },
      { id: "h1", values: h1Payload.candles, symbolUsed: instrument },
      { id: "4h", values: h4Payload.candles, symbolUsed: instrument },
      { id: "1day", values: dailyPayload.candles, symbolUsed: instrument },
      { id: "1week", values: weeklyPayload.candles, symbolUsed: instrument },
      { id: "1month", values: monthlyPayload.candles, symbolUsed: instrument },
      { id: "benchmark", values: dailyPayload.candles, symbolUsed: instrument },
      { id: "alpha_vantage", data: null, symbolUsed: "" },
    ],
  };
}

async function fetchPrice(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/pricing`, {
    query: { instruments: instrument },
  });
  const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
  return {
    instrument,
    time: String(price?.time || ""),
    bid: normalizeNumber(price?.closeoutBid || price?.bids?.[0]?.price, Number.NaN),
    ask: normalizeNumber(price?.closeoutAsk || price?.asks?.[0]?.price, Number.NaN),
    mid: midpoint(price),
    status: String(price?.status || ""),
  };
}

async function fetchCandles(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const granularity = GRANULARITY_MAP[String(options.timeframe || "15min")] || "M15";
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/instruments/${encodeURIComponent(instrument)}/candles`, {
    query: {
      price: "M",
      granularity,
      count: clampInt(options.count, 200, 30, 5000),
    },
  });
  return (Array.isArray(payload?.candles) ? payload.candles : [])
    .filter((row) => row?.mid)
    .map((row) => ({
      datetime: String(row.time || ""),
      open: normalizeNumber(row.mid?.o, 0),
      high: normalizeNumber(row.mid?.h, 0),
      low: normalizeNumber(row.mid?.l, 0),
      close: normalizeNumber(row.mid?.c, 0),
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
      complete: row.complete === true || row.complete === "true" || row.complete === undefined,
    }));
}

async function listOpenTrades(env, options = {}) {
  const config = await getOandaConfig(env);
  const payload = await oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/openTrades`);
  const trades = Array.isArray(payload?.trades) ? payload.trades : [];
  const instrument = normalizeInstrument(options.instrument || "");
  return instrument ? trades.filter((row) => String(row.instrument || "") === instrument) : trades;
}

async function createMarketOrder(env, options = {}) {
  const config = await getOandaConfig(env);
  const instrument = normalizeInstrument(options.instrument || config.instrument);
  const units = clampInt(options.units, 0, -1000000000, 1000000000);
  return oandaRequest(config, `/v3/accounts/${encodeURIComponent(config.accountId)}/orders`, {
    method: "POST",
    body: {
      order: {
        units: String(units),
        instrument,
        timeInForce: "FOK",
        type: "MARKET",
        positionFill: "DEFAULT",
        stopLossOnFill: { price: formatPrice(options.stopLoss) },
        takeProfitOnFill: { price: formatPrice(options.takeProfit) },
      },
    },
  });
}

async function getOandaConfig(env) {
  const settings = await loadSettings(env);
  const environment = normalizeEnvironment(settings.oandaEnvironment || env.OANDA_ENVIRONMENT || "practice");
  const token = String(settings.oandaApiToken || env.OANDA_API_TOKEN || "").trim();
  let accountId = String(settings.oandaAccountId || env.OANDA_ACCOUNT_ID || "").trim();
  if (!accountId && token) {
    try {
      accountId = await discoverAccountId(token, environment);
    } catch (e) {
      console.warn("Could not auto-discover OANDA account ID:", e.message);
    }
  }
  return {
    token,
    accountId,
    instrument: normalizeInstrument(settings.botInstrument || env.OANDA_INSTRUMENT || DEFAULT_INSTRUMENT),
    baseUrl: environment === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com",
    environment,
  };
}

async function discoverAccountId(token, environment) {
  if (!token) throw new Error("OANDA_API_TOKEN is not configured.");
  const baseUrl = environment === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const response = await fetch(`${baseUrl}/v3/accounts`, {
    method: "GET",
    headers: oandaHeaders(token),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || `OANDA accounts lookup failed (${response.status}).`);
  }
  return String(payload?.accounts?.[0]?.id || "").trim();
}

async function oandaRequest(config, path, options = {}) {
  if (!config.token) throw new Error("OANDA token is not configured.");
  if (!config.accountId) throw new Error("OANDA account ID is unavailable.");
  const url = new URL(`${config.baseUrl}${path}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method: String(options.method || "GET").toUpperCase(),
    headers: {
      ...oandaHeaders(config.token),
      ...(options.method ? { "Content-Type": "application/json" } : {}),
    },
    body: options.method ? JSON.stringify(options.body || {}) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.errorMessage || payload?.message || `OANDA HTTP ${response.status}`);
  }
  return payload;
}

function oandaHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function loadSettings(env) {
  return (await kvGetJson(env, "settings", {})) || {};
}

async function saveSettings(env, settings) {
  await env.AURUM_KV.put("settings", JSON.stringify(settings));
}

async function updateBotSettings(env, patch) {
  const current = await loadSettings(env);
  const next = { ...current, ...patch };
  await saveSettings(env, next);
  return getBotStatus(env);
}

async function loadRuntime(env) {
  return (await kvGetJson(env, "runtime", {})) || {};
}

async function saveRuntime(env, runtime) {
  await env.AURUM_KV.put("runtime", JSON.stringify(runtime));
}

async function loadHistoryEntries(env) {
  const data = await kvGetJson(env, "history", []);
  return Array.isArray(data) ? data : [];
}

async function appendHistoryEntry(env, entry) {
  const current = await loadHistoryEntries(env);
  const next = [
    {
      ...entry,
      id: String(entry.id || entry.syncId || Date.now()),
    },
    ...current,
  ]
    .slice(0, HISTORY_LIMIT)
    .sort((left, right) => {
      const leftTs = Date.parse(String(left.timestampIso || "")) || Number(left.createdAt || 0);
      const rightTs = Date.parse(String(right.timestampIso || "")) || Number(right.createdAt || 0);
      return rightTs - leftTs;
    });
  await env.AURUM_KV.put("history", JSON.stringify(next));
  return next[0];
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.AURUM_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function analyzeMtfData(mtfData, latestPrice) {
  const entry = normalizeCandles(mtfData?.data?.find((item) => item.id === "entry")?.values || []);
  const benchmark = normalizeCandles(mtfData?.data?.find((item) => item.id === "benchmark")?.values || []);
  if (entry.length < 30) throw new Error("Not enough entry candles to drive the bot.");
  const closes = entry.map((row) => row.close);
  const ema21 = exponentialMovingAverage(closes, 21).at(-1);
  const ema50 = exponentialMovingAverage(closes, 50).at(-1);
  const latestClose = entry.at(-1).close;
  let trend = "neutral";
  if (ema21 >= ema50) {
    trend = latestClose >= ema50 ? "bullish" : "bearish";
  } else {
    trend = latestClose <= ema50 ? "bearish" : "bullish";
  }
  const fvgs = detectFairValueGaps(entry);
  const obs = detectOrderBlocks(entry, fvgs);
  const structureEvents = detectStructureEvents(entry);
  const price = Number.isFinite(Number(latestPrice?.mid)) ? Number(latestPrice.mid) : entry.at(-1).close;
  const rmiValue = calculateRmi(entry);
  const rmiBias = rmiValue >= 100 ? "bullish" : "bearish";
  const htfAlignment = (Array.isArray(mtfData?.data) ? mtfData.data : [])
    .filter((row) => ["h1", "1day", "1week", "1month"].includes(row.id))
    .map((row) => {
      const values = normalizeCandles(row.values || []);
      if (values.length < 2) return `${row.id.toUpperCase()} unavailable`;
      const oldest = values[0].close;
      const latest = values.at(-1).close;
      return `${row.id.toUpperCase()} ${latest >= oldest ? "bullish" : "bearish"}`;
    });
  const sweeps = detectLiquiditySweeps(mtfData);
  const score = [
    trend === "bullish" ? 1 : -1,
    rmiBias === "bullish" ? 1 : -1,
    htfAlignment.filter((row) => row.includes(trend)).length > 1 ? 1 : 0,
    fvgs.length > 0 ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
  return {
    price,
    trend,
    fvgs,
    obs,
    structureEvents,
    htfAlignment,
    sweeps,
    rmi: { value: rmiValue, bias: rmiBias },
    decision: {
      action: trend === "bullish" ? "Buy" : "Sell",
      confidence: Math.max(55, Math.min(92, 68 + score * 6)),
      score,
      tp1: roundPrice(price + (trend === "bullish" ? 4 : -4)),
      tp2: roundPrice(price + (trend === "bullish" ? 8 : -8)),
      stopPrice: roundPrice(price + (trend === "bullish" ? -3 : 3)),
      tradePlan: [
        `Bot bias: ${trend.toUpperCase()}`,
        `RMI alignment: ${rmiBias.toUpperCase()}`,
        `HTF alignment count: ${htfAlignment.length}`,
        `FVG count: ${fvgs.length}`,
        fvgs.length > 0 ? `FVG MAP:\n${fvgs.map(f => `- ${f.side.toUpperCase()} @ ${f.price} [${f.type}]`).join("\n")}` : "",
        obs.length > 0 ? `OB MAP:\n${obs.map(o => `- ${o.side.toUpperCase()} @ ${o.price} [${o.type} (${o.strength})]`).join("\n")}` : "",
        sweeps.length > 0 ? `CRT EVENTS:\n${sweeps.map(s => `- ${s.name}: ${s.condition} -> ${s.action}`).join("\n")}` : "No recent CRT events (Sweeps/Breakouts)."
      ].filter(Boolean),
    },
  };
}

function applyBotRiskProfile(analysis, botConfig) {
  const side = analysis.decision.action === "Buy" ? 1 : -1;
  const stopDistance = Math.abs(normalizeNumber(botConfig.stopLossOffset, 3));
  const targetDistance = Math.abs(normalizeNumber(botConfig.takeProfitOffset, 6));
  analysis.decision.stopPrice = roundPrice(analysis.price + (side === 1 ? -stopDistance : stopDistance));
  analysis.decision.tp1 = roundPrice(analysis.price + (side === 1 ? targetDistance * 0.67 : targetDistance * -0.67));
  analysis.decision.tp2 = roundPrice(analysis.price + (side === 1 ? targetDistance : targetDistance * -1));
  analysis.decision.tradePlan = [
    ...analysis.decision.tradePlan,
    `Risk profile: SL ${stopDistance.toFixed(1)} / TP ${targetDistance.toFixed(1)}`,
    `Units: ${botConfig.units}`,
  ];
}

function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      open: normalizeNumber(candle?.open, Number.NaN),
      high: normalizeNumber(candle?.high, Number.NaN),
      low: normalizeNumber(candle?.low, Number.NaN),
      close: normalizeNumber(candle?.close, Number.NaN),
      complete: candle?.complete !== false,
      _ts: new Date(candle?.datetime || 0).getTime(),
    }))
    .filter((row) => Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
    .sort((left, right) => left._ts - right._ts);
}

function exponentialMovingAverage(values, period) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function calculateRmi(candles) {
  if (!candles || candles.length < 30) {
    return 100.00;
  }
  const closes = candles.map((c) => c.close);
  const period = 30;
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
  }
  const rmi = (closes.at(-1) / ema) * 100;
  return Number(rmi.toFixed(2));
}

function detectFairValueGaps(candles) {
  const out = [];
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;
  
  for (let i = 1; i < candles.length - 1; i += 1) {
    const prev = candles[i - 1]; // 1st
    const mid = candles[i];      // 2nd
    const next = candles[i + 1]; // 3rd

    const isGapUp = mid.open > prev.close;
    const isGapDown = mid.open < prev.close;

    // Bullish FVG or Gap Up
    if ((next.low > prev.high && isBull(mid)) || isGapUp) {
      let type = isGapUp ? "Gap Up FVG" : "Standard";
      if (isBull(prev) && isBull(next)) type = isGapUp ? "Gap Up (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
      else if (isBull(prev) && isBear(next)) type = isGapUp ? "Gap Up (Trade Continuation)" : "Trade Continuation";
      else if (isBear(prev) && isBull(next)) type = isGapUp ? "Gap Up (The Sweep)" : "The Sweep (Delayed Trap)";
      else if (isBear(prev) && isBear(next)) type = isGapUp ? "Gap Up (Holy Grail)" : "The Holy Grail (Ultimate Jackpot â­â­â­â­â­)";
      
      const gapPrice = isGapUp ? roundPrice((mid.open + prev.close) / 2) : roundPrice((next.low + prev.high) / 2);
      
      if (!out.some(f => f.side === "bullish" && Math.abs(f.price - gapPrice) < 0.05)) {
        out.push({ side: "bullish", type, price: gapPrice });
      }
    }
    // Bearish FVG or Gap Down
    else if ((next.high < prev.low && isBear(mid)) || isGapDown) {
      let type = isGapDown ? "Gap Down FVG" : "Standard";
      if (isBear(prev) && isBear(next)) type = isGapDown ? "Gap Down (FOMO Trap)" : "Exhaustion FVG (FOMO Trap)";
      else if (isBear(prev) && isBull(next)) type = isGapDown ? "Gap Down (Trade Continuation)" : "Trade Continuation";
      else if (isBull(prev) && isBear(next)) type = isGapDown ? "Gap Down (The Sweep)" : "The Sweep (Delayed Trap)";
      else if (isBull(prev) && isBull(next)) type = isGapDown ? "Gap Down (Holy Grail)" : "The Holy Grail (Ultimate Jackpot â­â­â­â­â­)";
      
      const gapPrice = isGapDown ? roundPrice((mid.open + prev.close) / 2) : roundPrice((next.high + prev.low) / 2);
      
      if (!out.some(f => f.side === "bearish" && Math.abs(f.price - gapPrice) < 0.05)) {
        out.push({ side: "bearish", type, price: gapPrice });
      }
    }
  }
  return out.slice(-8);
}

function detectOrderBlocks(candles, fvgs) {
  const out = [];
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  for (let i = 5; i < candles.length - 1; i += 1) {
    const prev = candles[i - 1];
    const curr = candles[i];
    
    // Bullish OB candidate (Last bearish before bullish)
    if (isBear(prev) && isBull(curr)) {
      const hasFvgAbove = fvgs.some(f => f.side === "bullish" && f.price > prev.high);
      const lookback = candles.slice(Math.max(0, i - 10), i);
      const isExtreme = lookback.every(c => c.low >= prev.low);
      
      let type = "Fake OB (SMT Trap)";
      let strength = "Weakest (90-95% fail)";
      if (hasFvgAbove) {
        if (isExtreme) {
          type = "Extreme OB (Ultimate Jackpot â­â­â­â­â­)";
          strength = "Most Powerful (5-10% fail)";
        } else {
          type = "Decisional OB (Trap / Inducement)";
          strength = "Medium (50-60% fail)";
        }
      }
      out.push({ side: "bullish", type, strength, price: prev.low });
    }
    // Bearish OB candidate (Last bullish before bearish)
    else if (isBull(prev) && isBear(curr)) {
      const hasFvgBelow = fvgs.some(f => f.side === "bearish" && f.price < prev.low);
      const lookback = candles.slice(Math.max(0, i - 10), i);
      const isExtreme = lookback.every(c => c.high <= prev.high);
      
      let type = "Fake OB (SMT Trap)";
      let strength = "Weakest (90-95% fail)";
      if (hasFvgBelow) {
        if (isExtreme) {
          type = "Extreme OB (Ultimate Jackpot â­â­â­â­â­)";
          strength = "Most Powerful (5-10% fail)";
        } else {
          type = "Decisional OB (Trap / Inducement)";
          strength = "Medium (50-60% fail)";
        }
      }
      out.push({ side: "bearish", type, strength, price: prev.high });
    }
  }
  return out.slice(-8);
}

function detectStructureEvents(candles) {
  const out = [];
  for (let i = 2; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const pivot = candles[i - 2];
    if (current.high > previous.high && previous.high <= pivot.high) out.push(`BOS up through ${roundPrice(previous.high)}`);
    if (current.low < previous.low && previous.low >= pivot.low) out.push(`Liquidity sweep below ${roundPrice(previous.low)}`);
  }
  return out.slice(-6);
}

function midpoint(price) {
  const bid = normalizeNumber(price?.closeoutBid || price?.bids?.[0]?.price, Number.NaN);
  const ask = normalizeNumber(price?.closeoutAsk || price?.asks?.[0]?.price, Number.NaN);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return Number(((bid + ask) / 2).toFixed(3));
  return normalizeNumber(price?.closeoutBid || price?.closeoutAsk || 0, 0);
}

function formatPrice(value) {
  return Number(value || 0).toFixed(Math.abs(Number(value || 0)) >= 100 ? 3 : 5);
}

function roundPrice(value) {
  return Number(Number(value).toFixed(3));
}

function checkTradingWindow() {
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const current = `${String(etNow.getHours()).padStart(2, "0")}:${String(etNow.getMinutes()).padStart(2, "0")}`;
  if (current < "08:00") return { allowed: false, reason: `Pre-session lockout (${current} ET).` };
  if (current >= "16:30") return { allowed: false, reason: `Late-session lockout (${current} ET).` };
  return { allowed: true, reason: `Trading window open (${current} ET).` };
}

function checkCooldown(lastExecutedAt, cooldownMinutes) {
  if (!Number.isFinite(Number(lastExecutedAt))) return { allowed: true, reason: "No prior execution." };
  const remainingMs = Number(lastExecutedAt) + cooldownMinutes * 60 * 1000 - Date.now();
  if (remainingMs > 0) return { allowed: false, reason: `Cooldown active for ${Math.ceil(remainingMs / 60000)} more minute(s).` };
  return { allowed: true, reason: "Cooldown cleared." };
}

function sanitizePublicSettings(settings) {
  return {
    botMode: normalizeBotMode(settings.botMode),
    botEnabled: Boolean(settings.botEnabled),
    botInstrument: normalizeInstrument(settings.botInstrument || DEFAULT_INSTRUMENT),
    oandaEnvironment: normalizeEnvironment(settings.oandaEnvironment || "practice"),
    botUnits: clampInt(settings.botUnits, 10, 1, 1000000),
    botStopLossOffset: normalizeNumber(settings.botStopLossOffset, 3),
    botTakeProfitOffset: normalizeNumber(settings.botTakeProfitOffset, 6),
    botCooldownMinutes: clampInt(settings.botCooldownMinutes, 15, 1, 1440),
    botPollIntervalSeconds: clampInt(settings.botPollIntervalSeconds, 60, 15, 3600),
    defaultModelKey: String(settings.defaultModelKey || ""),
    nvidiaModels: Array.isArray(settings.nvidiaModels) ? settings.nvidiaModels.map((item) => ({
      key: String(item.key || ""),
      id: String(item.id || ""),
      label: String(item.label || item.id || ""),
      baseUrl: String(item.baseUrl || DEFAULT_BASE_URL),
    })) : [],
  };
}

function computeMetrics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let wins = 0;
  let losses = 0;
  list.forEach((row) => {
    const outcome = String(row?.learningOutcome || row?.botAction || "").toLowerCase();
    if (outcome.includes("win")) wins += 1;
    if (outcome.includes("loss")) losses += 1;
  });
  const total = list.length;
  return {
    totalAnalyses: total,
    uniqueDevices: new Set(list.map((row) => String(row?.deviceId || row?.source || ""))).size,
    globalTotal: total,
    globalWins: wins,
    globalLosses: losses,
    globalWinRate: total > 0 ? (wins / total) * 100 : 0,
    debateAttemptedTotal: 0,
    debateSuccessfulTotal: 0,
    inputLimitErrors: 0,
    aiTimeoutErrors: 0,
  };
}

async function handleFetchNvidia(body) {
  const apiKey = String(body.apiKey || "").trim();
  const baseUrl = String(body.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!apiKey) throw new Error("Missing NVIDIA API key.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `NVIDIA HTTP ${response.status}`);
    const models = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => ({ id: String(item?.id || ""), label: String(item?.id || "") }))
          .filter((item) => item.id && item.id.length > 0)
      : [];
    const smokeModel = pickNvidiaSmokeTestModel(models);
    if (!smokeModel) {
      throw new Error("NVIDIA returned a catalog, but no chat-capable model was found to validate this key.");
    }
    const smoke = await validateNvidiaChatAccess({ apiKey, baseUrl, modelId: smokeModel.id, signal: controller.signal });
    if (!smoke.ok) {
      throw new Error(smoke.message || "NVIDIA key could fetch models but failed a chat validation request.");
    }
    return { models, count: models.length, baseUrl, validated: true, validationModel: smokeModel.id };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("NVIDIA model import timed out. Check the key, network, or try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSummarySystemPrompt() {
  return [
    "You are the Lead Institutional Arbiter for XAUUSD.",
    "STRICT SECURITY & ISOLATION RULE: You MUST analyze Gold (XAUUSD) completely in isolation. NEVER reference, correlate, or compare Gold with any other asset, Forex currency, index, or commodity (such as DXY, EURUSD, S&P 500, Silver, Crude Oil, or any benchmarks/proxies). All SMC structure and momentum calculations must be derived purely from XAU/USD's own price history. Do not discuss or compare other symbols under any circumstances.",
    "Output exactly one valid JSON object with this shape:",
    "{",
    '  "researcher": { "summary": "...", "direction": "Buy | Sell | Stay Flat", "riskNote": "..." },',
    '  "trader": { "entryZone": "...", "takeProfitLevels": "...", "stopLoss": "...", "positionSizing": "...", "timeHorizon": "...", "invalidation": "..." },',
    '  "equations": { "review": "..." },',
    '  "scorecard": { "tdsScore": 0, "confluence": "Low | Medium | High", "grade": "Skip | Watch | Active", "confidence": 0, "drivers": ["..."] }',
    "}",
    "If the setup is weak or invalid, use Stay Flat and N/A values.",
  ].join("\n");
}

function buildServerFallbackSummary(promptText, meta = {}) {
  const directionMatch = /Rule Engine Direction:\s*([^\n]+)/i.exec(promptText) || /Rule Engine Decision:\s*([^\n]+)/i.exec(promptText);
  const ruleDirection = directionMatch?.[1] || "";
  const direction = /sell|bear/i.test(ruleDirection) ? "Sell" : /buy|bull/i.test(ruleDirection) ? "Buy" : "Stay Flat";
  const trendMatch = /Trend:\s*([^\n]+)/i.exec(promptText);
  const rmiMatch = /RMI:\s*([0-9.-]+)\s*\(([^)]+)\)/i.exec(promptText);
  const fvgMatch = /Fair Value Gaps:\s*([^\n]+)/i.exec(promptText);
  const priceMatch = /Current Price:\s*([0-9.]+)/i.exec(promptText);
  const scorecard = buildDeterministicScorecard({
    direction,
    trend: trendMatch?.[1] || "",
    rmi: Number(rmiMatch?.[1]),
    rmiBias: rmiMatch?.[2] || "",
    fairValueGaps: fvgMatch?.[1] || "",
  });
  const modelReason = sanitizeProviderFailureReason(meta.reason || "AI provider unavailable.");
  const summary = scorecard.grade === "Active"
    ? `Local arbiter accepted the ${direction} bias using rule-engine confluence while the upstream AI model is unavailable.`
    : `Local arbiter kept the setup on watch because confluence is not strong enough while the upstream AI model is unavailable.`;

  return JSON.stringify({
    researcher: {
      summary,
      direction: scorecard.grade === "Active" ? direction : "Stay Flat",
      riskNote: `${modelReason} Local scorecard is deterministic and should be treated as a safety fallback, not an AI consensus.`,
    },
    trader: {
      entryZone: scorecard.grade === "Active" ? `Wait for confirmation near ${priceMatch?.[1] || "current price"} structure.` : "N/A",
      takeProfitLevels: scorecard.grade === "Active" ? "T1 at nearby liquidity, T2 at next displacement leg, runner after break-even." : "N/A",
      stopLoss: scorecard.grade === "Active" ? "Invalidate beyond the opposite structural close." : "N/A",
      positionSizing: scorecard.grade === "Active" ? "Use reduced risk until a configured AI model confirms the setup." : "N/A",
      timeHorizon: scorecard.grade === "Active" ? "Intraday" : "N/A",
      invalidation: "Opposite structural close.",
    },
    equations: {
      review: [
        `Momentum: ${scorecard.drivers.find((item) => item.startsWith("RMI")) || "RMI not available"}.`,
        `Volatility/structure: ${scorecard.drivers.find((item) => item.startsWith("Trend")) || "trend not available"}.`,
        `Crowding proxy: ${scorecard.drivers.find((item) => item.startsWith("FVG")) || "no FVG impulse detected"}.`,
      ].join(" "),
    },
    scorecard,
  });
}

function sanitizeProviderFailureReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "AI provider is not configured.";
  if (/HTTP\s*(401|403)|forbidden|unauthorized|invalid api key|permission/i.test(text)) {
    return "NVIDIA rejected the configured API key. Re-save a valid NVIDIA key in Settings, then import NVIDIA models so the app can use a model available to that key.";
  }
  if (/HTTP\s*404|not found|model/i.test(text)) {
    return "The configured NVIDIA model is not available to this key. Import NVIDIA models again from Settings and select one of the imported models.";
  }
  return text.replace(/\bAI HTTP\s*\d+\b/gi, "AI provider error");
}

function extractAiText(payload) {
  const fromChoices = payload?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) return fromChoices.trim();
  const fromOutput = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof fromOutput === "string" && fromOutput.trim()) return fromOutput.trim();
  const textField = payload?.text;
  if (typeof textField === "string" && textField.trim()) return textField.trim();
  return "";
}

function setAiText(payload, text) {
  if (payload?.choices?.[0]?.message) {
    payload.choices[0].message.content = text;
    return payload;
  }
  if (payload?.output?.[0]?.content?.[0]) {
    payload.output[0].content[0].text = text;
    return payload;
  }
  return {
    ...payload,
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
        },
      },
    ],
  };
}

function stripJsonFence(text) {
  let cleanText = String(text || "").trim();
  if (cleanText.startsWith("```json")) return cleanText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  if (cleanText.startsWith("```")) return cleanText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  return cleanText;
}

function buildStructuredSummaryFromText(aiText, contextPrompt) {
  const raw = String(aiText || "").trim();
  const context = String(contextPrompt || "");
  const ruleDirection = /Rule Engine Direction:\s*([^\n]+)/i.exec(context)?.[1] || "";
  const direction =
    /\b(sell|bearish|short)\b/i.test(raw) ? "Sell" :
    /\b(buy|bullish|long)\b/i.test(raw) ? "Buy" :
    /\b(sell|bearish|short)\b/i.test(ruleDirection) ? "Sell" :
    /\b(buy|bullish|long)\b/i.test(ruleDirection) ? "Buy" :
    "Stay Flat";
  const isFlat = direction === "Stay Flat";
  const priceLine = /Current Price:\s*([^\n]+)/i.exec(context)?.[1]?.trim() || "current market price";

  return {
    researcher: {
      summary: raw || "AI response did not include a narrative summary.",
      direction,
      riskNote: "AI response was normalized into the required JSON trade-plan format.",
    },
    trader: {
      entryZone: isFlat ? "N/A" : `Wait for confirmation near ${priceLine} structure.`,
      takeProfitLevels: isFlat ? "N/A" : "Use nearest liquidity as T1, next displacement leg as T2, then trail after break-even.",
      stopLoss: isFlat ? "N/A" : "Invalidate beyond the opposite structural close.",
      positionSizing: isFlat ? "N/A" : "Use reduced risk until clean execution confirmation.",
      timeHorizon: isFlat ? "N/A" : "Intraday",
      invalidation: isFlat ? "Re-evaluate after a confirmed CHoCH/BOS with displacement." : "Opposite structural close.",
    },
    equations: {
      review: "AI response did not provide a dedicated equations block; use the generated market equations panel for momentum, volatility, and max-pain context.",
    },
  };
}

function buildDeterministicScorecard({ direction, trend, rmi, rmiBias, fairValueGaps }) {
  let score = 0;
  const drivers = [];
  const lowerDirection = String(direction || "").toLowerCase();
  const lowerTrend = String(trend || "").toLowerCase();
  const lowerRmiBias = String(rmiBias || "").toLowerCase();
  const fvgText = String(fairValueGaps || "").toLowerCase();

  if (lowerDirection === "buy" || lowerDirection === "sell") {
    score += 25;
    drivers.push(`Rule engine direction: ${direction}`);
  }
  if ((lowerDirection === "buy" && lowerTrend.includes("bull")) || (lowerDirection === "sell" && lowerTrend.includes("bear"))) {
    score += 25;
    drivers.push(`Trend alignment: ${trend}`);
  } else if (lowerTrend) {
    score += 10;
    drivers.push(`Trend present: ${trend}`);
  }
  if (Number.isFinite(rmi)) {
    const rmiDistance = Math.abs(rmi - 50);
    const rmiPoints = rmiDistance >= 12 ? 20 : rmiDistance >= 7 ? 12 : 6;
    score += rmiPoints;
    drivers.push(`RMI momentum: ${rmi.toFixed(2)} (${rmiBias || "neutral"})`);
  }
  if ((lowerDirection === "buy" && lowerRmiBias.includes("bull")) || (lowerDirection === "sell" && lowerRmiBias.includes("bear"))) {
    score += 15;
  }
  if (fvgText && !fvgText.includes("none")) {
    score += 15;
    drivers.push(`FVG impulse: ${fairValueGaps}`);
  }

  const tdsScore = Math.max(0, Math.min(100, Math.round(score)));
  const confluence = tdsScore >= 75 ? "High" : tdsScore >= 55 ? "Medium" : "Low";
  const grade = tdsScore >= 75 ? "Active" : tdsScore >= 55 ? "Watch" : "Skip";
  return {
    tdsScore,
    confluence,
    grade,
    confidence: tdsScore,
    drivers: drivers.slice(0, 5),
  };
}

function createTextPayload(text, modelId) {
  return {
    model: modelId,
    choices: [
      {
        message: {
          role: "assistant",
          content: String(text || "").trim(),
        },
      },
    ],
  };
}

function assertAdmin(request, env) {
  const supplied = String(request.headers.get("x-admin-password") || "");
  const adminPassword = String(env.ADMIN_PASSWORD || "CHANGE_ME_PASSWORD").trim();
  if (supplied !== adminPassword) {
    throw new Error("Unauthorized.");
  }
}

function jsonResponse(payload, request, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  };
}

function normalizeInstrument(value) {
  return String(value || DEFAULT_INSTRUMENT).trim().toUpperCase().replace("/", "_");
}

function normalizeEnvironment(value) {
  return String(value || "practice").toLowerCase() === "live" ? "live" : "practice";
}

function normalizeBotMode(value) {
  const mode = String(value || "manual").toLowerCase();
  return ["manual", "paper", "live"].includes(mode) ? mode : "manual";
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function sanitizeBotPatch(config) {
  return {
    botMode: normalizeBotMode(config.botMode),
    botInstrument: normalizeInstrument(config.botInstrument || DEFAULT_INSTRUMENT),
    oandaEnvironment: normalizeEnvironment(config.oandaEnvironment || "practice"),
    botUnits: clampInt(config.botUnits, 10, 1, 1000000),
    botStopLossOffset: normalizeNumber(config.botStopLossOffset, 3),
    botTakeProfitOffset: normalizeNumber(config.botTakeProfitOffset, 6),
    botCooldownMinutes: clampInt(config.botCooldownMinutes, 15, 1, 1440),
    botPollIntervalSeconds: clampInt(config.botPollIntervalSeconds, 60, 15, 3600),
  };
}

function checkBreakoutFVG(candles, breakoutIdx, isUpside) {
  if (breakoutIdx < 1 || breakoutIdx >= candles.length - 1) return false;
  const prev = candles[breakoutIdx - 1];
  const next = candles[breakoutIdx + 1];
  if (isUpside) {
    // Bullish FVG: next candle's low > previous candle's high
    return next.low > prev.high;
  } else {
    // Bearish FVG: next candle's high < previous candle's low
    return next.high < prev.low;
  }
}

function detectLiquiditySweeps(mtfData) {
  const MIN_DEPTH = 0.10; // Minimum $0.10 depth beyond level to qualify
  const getCandles = (id) => normalizeCandles(mtfData?.data?.find(d => d.id === id)?.values || []);
  const monthly = getCandles("1month");
  const weekly = getCandles("1week");
  const daily = getCandles("1day");
  const h4 = getCandles("4h");
  const h1 = getCandles("h1");
  const m15 = getCandles("15min");
  const m5 = getCandles("5min");
  
  const sweeps = [];
  const diagnosticLogs = [];

  const evaluateEvent = (levelName, levelPrice, childCandles, isHigh) => {
    const closedCandles = childCandles.filter(c => c.complete !== false);
    if (closedCandles.length < 2) return;
    // Use second-to-last closed candle to avoid live candle
    const candidates = closedCandles.slice(-6, -1);

    for (const current of candidates) {
      const bodySize = Math.abs(current.close - current.open);
      const totalRange = current.high - current.low;
      const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0;

      if (isHigh) {
        const wickDepth = current.high - levelPrice;
        // SWEEP: wicked above, closed below
        if (current.high > levelPrice && current.close < levelPrice && wickDepth > MIN_DEPTH) {
          sweeps.push({ name: levelName, price: levelPrice, condition: "Sweep Out (Fakeout)", action: "Sell Reversal", status: "SWEPT", bodyPct: (bodyRatio * 100).toFixed(1) + "%" });
          return; // found event, stop
        }
        // Close above level
        if (current.close > levelPrice) {
          const closeDepth = current.close - levelPrice;
          if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
            // Check FVG
            const candleIdx = closedCandles.indexOf(current);
            const hasFVG = checkBreakoutFVG(closedCandles, candleIdx, true);
            if (hasFVG) {
              sweeps.push({ name: levelName, price: levelPrice, condition: "Breakout (True BOS)", action: "Buy Continuation", status: "BROKEN", bodyPct: (bodyRatio * 100).toFixed(1) + "%", fvg: true });
              return;
            }
            // Weak close - PENDING, don't push to results
          }
          // Else: close beyond but not strong enough - skip
        }
      } else {
        const wickDepth = levelPrice - current.low;
        // SWEEP: wicked below, closed above
        if (current.low < levelPrice && current.close > levelPrice && wickDepth > MIN_DEPTH) {
          sweeps.push({ name: levelName, price: levelPrice, condition: "Sweep Out (Fakeout)", action: "Buy Reversal", status: "SWEPT", bodyPct: (bodyRatio * 100).toFixed(1) + "%" });
          return;
        }
        // Close below level
        if (current.close < levelPrice) {
          const closeDepth = levelPrice - current.close;
          if (closeDepth > MIN_DEPTH && bodyRatio >= 0.70) {
            const candleIdx = closedCandles.indexOf(current);
            const hasFVG = checkBreakoutFVG(closedCandles, candleIdx, false);
            if (hasFVG) {
              sweeps.push({ name: levelName, price: levelPrice, condition: "Breakout (True BOS)", action: "Sell Continuation", status: "BROKEN", bodyPct: (bodyRatio * 100).toFixed(1) + "%", fvg: true });
              return;
            }
          }
        }
      }
    }
  };

  // 0.5 Quarterly (Parent) -> Monthly (Child)
  if (monthly.length >= 4) {
    const prevQ = monthly.slice(-4, -1);
    const pqh = Math.max(...prevQ.map(c => c.high));
    const pql = Math.min(...prevQ.map(c => c.low));
    evaluateEvent("PQH (Prev Quarter High)", pqh, monthly, true);
    evaluateEvent("PQL (Prev Quarter Low)", pql, monthly, false);
  }

  // 1. Monthly (Parent) -> Weekly (Child)
  if (monthly.length >= 2) {
    const prev = monthly[monthly.length - 2];
    evaluateEvent("PMH (Prev Month High)", prev.high, weekly, true);
    evaluateEvent("PML (Prev Month Low)", prev.low, weekly, false);
  }

  // 2. Weekly (Parent) -> Daily (Child)
  if (weekly.length >= 2) {
    const prev = weekly[weekly.length - 2];
    evaluateEvent("PWH (Prev Week High)", prev.high, daily, true);
    evaluateEvent("PWL (Prev Week Low)", prev.low, daily, false);
  }

  // 3. Daily (Parent) -> 4H (Child)
  if (daily.length >= 2) {
    const prev = daily[daily.length - 2];
    evaluateEvent("PDH (Prev Day High)", prev.high, h4, true);
    evaluateEvent("PDL (Prev Day Low)", prev.low, h4, false);
  }

  // 3.5 4H (Parent) -> 15M (Child)
  if (h4.length >= 2) {
    const prev = h4[h4.length - 2];
    evaluateEvent("P4H (Prev 4H High)", prev.high, m15, true);
    evaluateEvent("P4L (Prev 4H Low)", prev.low, m15, false);
  }

  // 4. Session High/Low (Asian/London) -> 5M (Child)
  if (h1.length > 0) {
    const lastTime = new Date(h1[h1.length - 1]._ts);
    const todayStr = lastTime.toISOString().split("T")[0];
    const currentHourUTC = lastTime.getUTCHours();
    
    let asianHigh = -Infinity, asianLow = Infinity;
    let londonHigh = -Infinity, londonLow = Infinity;
    let hasAsian = false, hasLondon = false;
    
    h1.forEach(c => {
      const d = new Date(c._ts);
      if (d.toISOString().split("T")[0] === todayStr) {
        const hour = d.getUTCHours();
        // Asian session: 00:00 to 07:00 UTC
        if (hour >= 0 && hour < 7) {
          asianHigh = Math.max(asianHigh, c.high);
          asianLow = Math.min(asianLow, c.low);
          hasAsian = true;
        }
        // London session: 07:00 to 12:00 UTC
        else if (hour >= 7 && hour < 12) {
          londonHigh = Math.max(londonHigh, c.high);
          londonLow = Math.min(londonLow, c.low);
          hasLondon = true;
        }
      }
    });
    
    // Only evaluate session if it's strictly over based on the current hour of the latest H1 candle
    if (hasAsian && currentHourUTC >= 7) {
      evaluateEvent("Asian High", asianHigh, m5, true);
      evaluateEvent("Asian Low", asianLow, m5, false);
    }
    if (hasLondon && currentHourUTC >= 12) {
      evaluateEvent("London High", londonHigh, m5, true);
      evaluateEvent("London Low", londonLow, m5, false);
    }
  }

  return sweeps;
}

function buildDetectionLog(levelName, levelPrice, candle, decision, reason, calculations) {
  const istTime = new Date(candle._ts || Date.now()).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return {
    timestamp: istTime,
    level: levelName,
    levelPrice: roundPrice(levelPrice),
    candle: { open: roundPrice(candle.open), high: roundPrice(candle.high), low: roundPrice(candle.low), close: roundPrice(candle.close) },
    decision,
    reason,
    ...calculations
  };
}
