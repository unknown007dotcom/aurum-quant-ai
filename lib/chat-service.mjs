import { CHAT_ASSISTANT } from "../modules/chat-persona.mjs";
import {
  getMarketNews,
  newsConfiguration,
  wantsNewsContext,
  publicNewsEvidence,
  newsSystemInstructions,
  newsDataMessage,
} from "./market-news.mjs";
import {
  getMarketSnapshot,
  marketConfiguration,
  marketSystemContext,
  publicMarketEvidence,
  wantsMarketContext,
} from "./chat-market-context.mjs";
import {
  credentials,
  discoverModels,
  publicModels,
  selectModel,
  completeWithFallback,
  NvidiaError,
} from "./nvidia-runtime.mjs";

// A conversational endpoint, deliberately separate from the trading/decision engine.
// Shared by the Node/Vercel handler and the Cloudflare Worker.
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = {
  key: "gpt-oss-default",
  id: "openai/gpt-oss-20b",
  label: "GPT-OSS 20B",
};
const STYLES = {
  concise:
    "Be concise and direct. Prefer a short answer unless the user requests detail.",
  balanced: "Give a clear, balanced answer with enough detail to be useful.",
  detailed:
    "Explain thoughtfully in depth, with examples and structure where helpful.",
};
// Generation budget starts only after model discovery/market lookup, so a
// cold catalog fetch cannot eat into the time models have to answer.
const CHAT_GENERATION_DEADLINE_MS = 110000;
// This limits startup, not a reply that is actively streaming. The existing
// 110s overall generation deadline and 20s between-token limit remain bounded.
const CHAT_FIRST_ANSWER_TIMEOUT_MS = 45000;
const CHAT_STREAM_IDLE_TIMEOUT_MS = 20000;
// Very long histories slow time-to-first-token on every model. Keep the most
// recent turns that fit a provider budget; the full transcript stays in the UI.
const MAX_PROVIDER_CONTEXT_CHARS = 32000;

function providerContext(messages) {
  const kept = [];
  let characters = 0;
  for (const message of [...messages].reverse()) {
    if (
      kept.length &&
      characters + message.content.length > MAX_PROVIDER_CONTEXT_CHARS
    )
      break;
    kept.unshift(message);
    characters += message.content.length;
  }
  return kept;
}

export class ChatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

// Optional, server-owned Chat Mode policy. Keep analysis's model catalog/default
// and the saved NVIDIA credentials untouched. A catalog entry is not evidence of
// a working completion; an owner can enable the models actually verified for chat.
function applyChatModelSettings(runtime, settings) {
  let models = runtime.models;
  if (Object.hasOwn(settings, "chatModelIds")) {
    const ids = settings.chatModelIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 32 ||
      ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 180)
    ) {
      const error = new ChatError(
        "The saved Chat Mode model configuration is invalid.",
        503,
      );
      error.code = "invalid_configuration";
      throw error;
    }
    // Preserve the owner's order, resolve only against the server-side catalog,
    // and never let a chat request supply credentials, an endpoint, or this policy.
    models = [...new Set(ids.map((id) => id.trim()))]
      .map((id) => runtime.models.find((model) => model.id === id))
      .filter(Boolean);
    if (!models.length) {
      const error = new ChatError(
        "None of the models enabled in Aurum's Chat Mode settings are currently available.",
        503,
      );
      error.code = "no_models";
      throw error;
    }
  }
  const preferred =
    models.find(
      (model) =>
        model.key === settings.chatDefaultModelKey ||
        model.id === settings.chatDefaultModelKey,
    ) ||
    models.find((model) => model.key === runtime.defaultModelKey) ||
    models[0];
  return { ...runtime, models, defaultModelKey: preferred.key };
}

function configuredModels(settings = {}, env = {}) {
  const pool = [
    env.NVIDIA_API_KEY,
    settings.globalNvidiaApiKey,
    ...(Array.isArray(settings.globalNvidiaApiKeys)
      ? settings.globalNvidiaApiKeys
      : []),
    env.NVIDIA_API_KEY,
  ];
  const globalKey =
    pool.find((key) => typeof key === "string" && key.trim())?.trim() || "";
  const models = Array.isArray(settings.nvidiaModels)
    ? settings.nvidiaModels.filter(
        (model) => model && typeof model.id === "string" && model.id.trim(),
      )
    : [];
  return (models.length ? models : [DEFAULT_MODEL]).map((model) => ({
    key: String(model.key || model.id),
    id: model.id.trim(),
    label: String(model.label || model.id),
    apiKey:
      env.NVIDIA_API_KEY ||
      (typeof model.apiKey === "string" && model.apiKey.trim()) ||
      globalKey,
    baseUrl: String(model.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  }));
}

export function chatConfiguration(settings = {}, env = {}) {
  const models = configuredModels(settings, env);
  return {
    models: models.map(({ key, id, label }) => ({ key, id, label })),
    defaultModelKey: models.some(
      (model) => model.key === settings.defaultModelKey,
    )
      ? settings.defaultModelKey
      : models[0].key,
    configured: models.some((model) => Boolean(model.apiKey)),
    marketData: marketConfiguration(settings, env),
    newsData: newsConfiguration(),
  };
}

export function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ChatError("A valid chat request is required.");
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 40
  )
    throw new ChatError("Send between 1 and 40 conversation messages.");
  let total = 0;
  const messages = body.messages.map((message) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw new ChatError("Messages must contain user or assistant text.");
    }
    if (message.content.length > 8000)
      throw new ChatError("Each message must be 8,000 characters or fewer.");
    total += message.content.length;
    return { role: message.role, content: message.content.trim() };
  });
  if (total > 48000)
    throw new ChatError(
      "This conversation is too long. Start a new chat or turn off conversation context.",
    );
  if (messages.at(-1).role !== "user")
    throw new ChatError("The last message must be from you.");
  if (
    body.modelKey !== undefined &&
    (typeof body.modelKey !== "string" || body.modelKey.length > 180)
  )
    throw new ChatError("Invalid model selection.");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new ChatError("Streaming must be enabled or disabled.");
  const options =
    body.settings && typeof body.settings === "object" ? body.settings : {};
  const style = Object.hasOwn(STYLES, options.style)
    ? options.style
    : "balanced";
  const temperature =
    typeof options.temperature === "number" &&
    Number.isFinite(options.temperature)
      ? Math.min(1, Math.max(0, options.temperature))
      : 0.5;
  if (
    options.marketContext !== undefined &&
    typeof options.marketContext !== "boolean"
  )
    throw new ChatError("Market context must be enabled or disabled.");
  if (
    options.newsContext !== undefined &&
    typeof options.newsContext !== "boolean"
  )
    throw new ChatError("News context must be enabled or disabled.");
  return {
    messages,
    newsContext: options.newsContext !== false,
    modelKey: body.modelKey || "",
    style,
    temperature,
    marketContext: options.marketContext !== false,
  };
}

export async function activeChatConfiguration(
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  if (!credentials(settings, env).length) {
    return {
      ...chatConfiguration(settings, env),
      catalogChecked: false,
      completionVerified: false,
    };
  }
  try {
    return {
      ...publicModels(
        applyChatModelSettings(
          await discoverModels(settings, env, fetchImpl),
          settings,
        ),
      ),
      marketData: marketConfiguration(settings, env),
      newsData: newsConfiguration(),
    };
  } catch (error) {
    throw asChatError(error);
  }
}

function asChatError(error) {
  if (error instanceof ChatError) return error;
  const result = new ChatError(
    error instanceof NvidiaError
      ? error.message
      : "Chat is temporarily unavailable. Please try again.",
    error instanceof NvidiaError ? error.status : 500,
  );
  result.code = error.code || "provider_error";
  if (["first_token", "idle", "deadline"].includes(error.timeoutPhase))
    result.timeoutPhase = error.timeoutPhase;
  return result;
}

export async function completeChat(
  body,
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
  { onEvent, signal, onAttemptFailure } = {},
) {
  const input = validateChatRequest(body);
  try {
    signal?.throwIfAborted();
    // Fetch only for gold questions/follow-ups, in parallel with model discovery.
    // A bounded OANDA failure is context for the reply, not a chat failure.
    const marketTask = wantsMarketContext(input.messages, input.marketContext)
      ? getMarketSnapshot(settings, env, fetchImpl)
      : Promise.resolve(null);
    const newsTask = wantsNewsContext(input.messages, input.newsContext)
      ? getMarketNews({ fetchImpl })
      : Promise.resolve(null);
    const runtime = applyChatModelSettings(
      await discoverModels(settings, env, fetchImpl),
      settings,
    );
    const selected = selectModel(runtime, input.modelKey);
    const [market, newsSnapshot] = await Promise.all([marketTask, newsTask]);
    signal?.throwIfAborted();
    const news = newsSnapshot ? publicNewsEvidence(newsSnapshot) : null;
    const evidence = market ? publicMarketEvidence(market) : null;
    let emittedCharacters = 0;
    const messages = [
      {
        role: "system",
        content: [
          `You are ${CHAT_ASSISTANT.name}, a warm, thoughtful AI assistant in Aurum Quant AI. Help with markets, learning, brainstorming, writing, and everyday questions. Be clear that you are an AI assistant, not a human.`,
          "You can use server-supplied, read-only OANDA XAU/USD quotes and recent M15/H1 candles when a market snapshot is attached below. Curated public RSS headlines may be supplied separately. You have no arbitrary web browsing, account-balance access or order-execution tools. Never claim to place, modify or close orders. Never invent current prices, market conditions or citations. Clearly label hypothetical examples.",
          marketSystemContext(market, input.marketContext),
          newsSystemInstructions(news, input.newsContext),
          "Discuss financial topics educationally. Explain uncertainty and risk, never guarantee returns, and do not present a conversation as a trading signal.",
          "Use readable Markdown. For comparisons, use Markdown pipe tables with a header and separator row, short column labels, and concise cells. Do not wrap tables in code fences. Do not expose internal reasoning; provide a helpful final answer.",
          STYLES[input.style],
        ].join(" "),
      },
      ...(news ? [newsDataMessage(news)] : []),
      ...providerContext(input.messages),
    ];
    const result = await completeWithFallback(
      runtime,
      selected,
      messages,
      {
        temperature: input.temperature,
        maxTokens:
          input.style === "detailed"
            ? 2400
            : input.style === "concise"
              ? 700
              : 1400,
        // A cold model gets a first-answer window; once writing, only an
        // answer-token idle timeout and the overall deadline can stop it.
        stream: true,
        // Historical preferred models can disappear while the selected model
        // stays listed but stops answering. Chat may recover through other
        // general-purpose models from the same validated server catalog.
        catalogFallback: true,
        requireComplete: true,
        validateContent: news
          ? (content) => {
              const allowed = new Set(news.items.map((item) => item.citation));
              const references = content.match(/\bN\d+\b/g) || [];
              if (references.some((reference) => !allowed.has(reference)))
                throw new NvidiaError(
                  "A news reference could not be matched to the supplied sources. Please retry.",
                  502,
                  "invalid_news_citation",
                );
              return content;
            }
          : undefined,
        signal,
        onAttemptFailure,
        onAttempt: (attempt) => {
          // A fallback is a new answer, not a continuation of a failed draft.
          emittedCharacters = 0;
          onEvent?.({
            type: "start",
            ...attempt,
            ...(evidence ? { market: evidence } : {}),
            ...(news ? { news } : {}),
          });
        },
        onDelta: (text) => {
          const visible = text.slice(0, Math.max(0, 32000 - emittedCharacters));
          emittedCharacters += visible.length;
          if (visible) onEvent?.({ type: "delta", text: visible });
        },
        idleTimeoutMs: CHAT_STREAM_IDLE_TIMEOUT_MS,
        timeoutMs: CHAT_FIRST_ANSWER_TIMEOUT_MS,
        deadline: Date.now() + CHAT_GENERATION_DEADLINE_MS,
      },
      fetchImpl,
    );
    return {
      content: result.content.slice(0, 32000),
      model: result.model,
      ...(evidence ? { market: evidence } : {}),
      ...(news ? { news } : {}),
      ...(result.modelFallbackUsed ? { modelFallbackUsed: true } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw asChatError(error);
  }
}
