import { CHAT_ASSISTANT } from "../modules/chat-persona.mjs";
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
  return { messages, modelKey: body.modelKey || "", style, temperature };
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
    return publicModels(await discoverModels(settings, env, fetchImpl));
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
  return result;
}

export async function completeChat(
  body,
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  const input = validateChatRequest(body);
  try {
    const deadline = Date.now() + 65000;
    const runtime = await discoverModels(settings, env, fetchImpl);
    const selected = selectModel(runtime, input.modelKey);
    const messages = [
      {
        role: "system",
        content: [
          `You are ${CHAT_ASSISTANT.name}, a warm, thoughtful AI assistant in Aurum Quant AI. Help with markets, learning, brainstorming, writing, and everyday questions. Be clear that you are an AI assistant, not a human.`,
          "You do not have live market data, web browsing, or trading tools in this chat. Never invent current prices, market conditions, citations, or claim to execute trades. Clearly label hypothetical examples.",
          "Discuss financial topics educationally. Explain uncertainty and risk, never guarantee returns, and do not present a conversation as a trading signal.",
          "Use readable Markdown. Do not expose internal reasoning; provide a helpful final answer.",
          STYLES[input.style],
        ].join(" "),
      },
      ...input.messages,
    ];
    const result = await completeWithFallback(
      runtime,
      selected,
      messages,
      {
        temperature: input.temperature,
        maxTokens:
          input.style === "detailed"
            ? 3000
            : input.style === "concise"
              ? 800
              : 1800,
        timeoutMs: 30000,
        deadline,
      },
      fetchImpl,
    );
    return {
      content: result.content.slice(0, 32000),
      model: result.model,
      ...(result.modelFallbackUsed ? { modelFallbackUsed: true } : {}),
    };
  } catch (error) {
    throw asChatError(error);
  }
}
