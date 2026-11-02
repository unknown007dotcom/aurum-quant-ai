const { getAdminSettings } = require("../lib/firebase-admin");
const service = import("../lib/chat-service.mjs");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ message: "Method not allowed." });
  }
  const {
    activeChatConfiguration,
    completeChat,
    validateChatRequest,
    ChatError,
  } = await service;
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

    // Chat and analysis use the same server configuration and NVIDIA catalog.
    // Do not send chat through an independently deployed Worker or stale settings.
    const settings = (await getAdminSettings()) || {};
    const payload =
      req.method === "GET"
        ? await activeChatConfiguration(settings, process.env)
        : await completeChat(body, settings, process.env);
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(error instanceof ChatError ? error.status : 500).json({
      code: error.code || "provider_error",
      message:
        error instanceof ChatError
          ? error.message
          : "Chat is temporarily unavailable. Please try again.",
    });
  }
};
