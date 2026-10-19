import { CHAT_ASSISTANT } from "../modules/chat-persona.mjs";

// A conversational endpoint, deliberately separate from the trading/decision engine.
// Shared by the Node/Vercel handler and the Cloudflare Worker.
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = {
  key: "gpt-oss-default",
  id: "openai/gpt-oss-120b",
  label: "GPT-OSS 120B",
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
      (typeof model.apiKey === "string" && model.apiKey.trim()) || globalKey,
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

export async function completeChat(
  body,
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  const input = validateChatRequest(body);
  const models = configuredModels(settings, env);
  const selectedKey =
    input.modelKey || chatConfiguration(settings, env).defaultModelKey;
  const model = models.find(
    (candidate) =>
      candidate.key === selectedKey || candidate.id === selectedKey,
  );
  if (!model)
    throw new ChatError(
      "That model is no longer available. Choose another model in Chat settings.",
    );
  if (!model.apiKey)
    throw new ChatError(
      "AI isn't configured yet. Add an NVIDIA API key in Terminal Settings, then try again.",
      503,
    );
  let base;
  try {
    base = new URL(model.baseUrl);
  } catch {
    throw new ChatError(
      "The AI provider URL in Terminal Settings is invalid.",
      503,
    );
  }
  if (base.protocol !== "https:" || base.username || base.password)
    throw new ChatError("The AI provider must use a secure HTTPS URL.", 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${model.apiKey}`,
      },
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        temperature: input.temperature,
        max_tokens:
          input.style === "detailed"
            ? 3000
            : input.style === "concise"
              ? 800
              : 1800,
        stream: false,
        messages: [
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
        ],
      }),
    });
    // Never return raw provider errors: they may include credentials or request internals.
    if (response.status === 401 || response.status === 403)
      throw new ChatError(
        "The AI provider rejected the configured key. Update it in Terminal Settings.",
        503,
      );
    if (response.status === 429)
      throw new ChatError(
        "The AI provider is busy. Give it a moment, then try again.",
        429,
      );
    if (!response.ok)
      throw new ChatError(
        "The AI provider couldn't complete this response. Try again or choose another model.",
        502,
      );
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new ChatError(
        "The model returned an empty response. Try again or choose another model.",
        502,
      );
    return { content: content.trim().slice(0, 32000), model: model.id };
  } catch (error) {
    if (error instanceof ChatError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      throw new ChatError(
        "The AI response took too long. Please try again.",
        504,
      );
    throw new ChatError(
      "Couldn't reach the AI provider. Your conversation is saved in your browser; please try again.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
