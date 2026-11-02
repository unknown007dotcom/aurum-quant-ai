import { CHAT_ASSISTANT } from "../modules/chat-persona.mjs";
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
  return {
    messages,
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
      ...publicModels(await discoverModels(settings, env, fetchImpl)),
      marketData: marketConfiguration(settings, env),
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
    const runtime = await discoverModels(settings, env, fetchImpl);
    const selected = selectModel(runtime, input.modelKey);
    const market = await marketTask;
    signal?.throwIfAborted();
    const evidence = market ? publicMarketEvidence(market) : null;
    let emittedCharacters = 0;
    const messages = [
      {
        role: "system",
        content: [
          `You are ${CHAT_ASSISTANT.name}, a warm, thoughtful AI assistant in Aurum Quant AI. Help with markets, learning, brainstorming, writing, and everyday questions. Be clear that you are an AI assistant, not a human.`,
          "You can use server-supplied, read-only OANDA XAU/USD quotes and recent M15/H1 candles when a market snapshot is attached below. You have no web browsing, account-balance access or order-execution tools. Never claim to place, modify or close orders. Never invent current prices, market conditions or citations. Clearly label hypothetical examples.",
          marketSystemContext(market, input.marketContext),
          "Discuss financial topics educationally. Explain uncertainty and risk, never guarantee returns, and do not present a conversation as a trading signal.",
          "Use readable Markdown. For comparisons, use Markdown pipe tables with a header and separator row, short column labels, and concise cells. Do not wrap tables in code fences. Do not expose internal reasoning; provide a helpful final answer.",
          STYLES[input.style],
        ].join(" "),
      },
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
        signal,
        onAttemptFailure,
        onAttempt: (attempt) => {
          // A fallback is a new answer, not a continuation of a failed draft.
          emittedCharacters = 0;
          onEvent?.({
            type: "start",
            ...attempt,
            ...(evidence ? { market: evidence } : {}),
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
      ...(result.modelFallbackUsed ? { modelFallbackUsed: true } : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw asChatError(error);
  }
}
