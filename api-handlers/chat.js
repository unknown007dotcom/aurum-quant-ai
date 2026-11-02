const { once } = require("node:events");
const { getAdminSettings } = require("../lib/firebase-admin");
const service = import("../lib/chat-service.mjs");
const streaming = import("../lib/chat-stream.mjs");

// The runtime constructs this allowlisted record: model/code/status/timing only.
// Never log requests, credentials, provider bodies, reasoning, or answer text.
const logAttemptFailure = (failure) =>
  console.warn("[chat-provider-attempt]", JSON.stringify(failure));

async function streamReply(req, res, body, settings) {
  const { createChatStream, CHAT_STREAM_HEADERS } = await streaming;
  // The browser may have stopped while server settings were loading.
  if (req.aborted || res.destroyed || res.writableEnded) return;
  const controller = new AbortController();
  const reader = createChatStream(
    body,
    settings,
    process.env,
    globalThis.fetch,
    {
      signal: controller.signal,
      onAttemptFailure: logAttemptFailure,
    },
  ).getReader();
  const disconnect = () => {
    if (!res.writableEnded) controller.abort();
    reader.cancel().catch(() => {});
  };
  req.once?.("aborted", disconnect);
  res.once("close", disconnect);
  try {
    res.status(200);
    for (const [name, value] of Object.entries(CHAT_STREAM_HEADERS))
      res.setHeader(name, value);
    res.flushHeaders?.();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done || controller.signal.aborted) break;
      if (!res.write(Buffer.from(value)))
        await once(res, "drain", { signal: controller.signal });
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    req.off?.("aborted", disconnect);
    res.off("close", disconnect);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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
    if (req.method === "POST" && body.stream === true)
      return await streamReply(req, res, body, settings);
    const payload =
      req.method === "GET"
        ? await activeChatConfiguration(settings, process.env)
        : await completeChat(body, settings, process.env, globalThis.fetch, {
            onAttemptFailure: logAttemptFailure,
          });
    return res.status(200).json(payload);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "The response was interrupted. Please try again." })}\n\n`,
      );
      return res.end();
    }
    return res.status(error instanceof ChatError ? error.status : 500).json({
      code: error.code || "provider_error",
      ...(error instanceof ChatError && error.timeoutPhase
        ? { timeoutPhase: error.timeoutPhase }
        : {}),
      message:
        error instanceof ChatError
          ? error.message
          : "Chat is temporarily unavailable. Please try again.",
    });
  }
};
