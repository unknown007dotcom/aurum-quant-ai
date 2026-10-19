const { getAdminSettings } = require("../lib/firebase-admin");
const service = import("../lib/chat-service.mjs");
const DEFAULT_EDGE = "https://aurum-quant-edge.aurum-quant-ai.workers.dev";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ message: "Method not allowed." });
  }
  const { chatConfiguration, completeChat, validateChatRequest, ChatError } =
    await service;
  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new ChatError("Send a valid JSON chat request.");
      }
    }
    if (req.method === "POST") validateChatRequest(body);

    // The terminal stores its production AI settings in the edge Worker's KV.
    // Preserve that configuration; use the local handler when a local key is set,
    // or when the edge route has not been deployed / is unreachable.
    if (!process.env.NVIDIA_API_KEY) {
      const edge = (process.env.CLOUDFLARE_WORKER_URL || DEFAULT_EDGE).replace(
        /\/+$/,
        "",
      );
      let upstream;
      try {
        upstream = await fetch(`${edge}/chat`, {
          method: req.method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: req.method === "POST" ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(req.method === "GET" ? 5000 : 65000),
          redirect: "error",
        });
      } catch {
        /* Local settings fallback below, just like the other local APIs. */
      }
      if (upstream && ![404, 405].includes(upstream.status)) {
        const payload = await upstream.json().catch(() => null);
        if (payload && (payload.models || payload.content || payload.message)) {
          return res.status(upstream.status).json(payload);
        }
      }
    }

    const settings = (await getAdminSettings()) || {};
    const payload =
      req.method === "GET"
        ? chatConfiguration(settings, process.env)
        : await completeChat(body, settings, process.env);
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error instanceof ChatError ? error.status : 500).json({
      message:
        error instanceof ChatError
          ? error.message
          : "Chat is temporarily unavailable. Please try again.",
    });
  }
};
