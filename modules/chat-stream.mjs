// Shared, incremental SSE decoding. Network chunks are NOT event or UTF-8
// boundaries. Used by the provider transport and the browser's chat reader.
export async function* readEventStream(body, { signal, onChunk } = {}) {
  if (!body?.getReader) throw new Error("The response stream is unavailable.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const maxEventChars = 256 * 1024;
  let buffer = "";
  let event = "message";
  let data = [];
  let eventChars = 0;
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const consumeLine = (line) => {
    if (!line) {
      const frame = data.length ? { event, data: data.join("\n") } : null;
      event = "message";
      data = [];
      eventChars = 0;
      return frame;
    }
    eventChars += line.length;
    if (eventChars > maxEventChars)
      throw new Error("The response event is too large.");
    if (line.startsWith(":")) return null; // heartbeat/comment
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    return null;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (!done) onChunk?.();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/[\r\n]/)) >= 0) {
        // Wait for the next chunk to distinguish a split CRLF from a lone CR.
        if (!done && buffer[newline] === "\r" && newline === buffer.length - 1)
          break;
        const line = buffer.slice(0, newline);
        const length =
          buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(newline + length);
        const frame = consumeLine(line);
        if (frame) yield frame;
      }
      if (buffer.length + eventChars > maxEventChars)
        throw new Error("The response event is too large.");
      if (done) {
        if (buffer) consumeLine(buffer);
        const frame = consumeLine("");
        if (frame) yield frame;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}

const interrupted = () =>
  new Error("The response was interrupted. Please try again.");
const publicReply = (payload) => {
  if (typeof payload?.content !== "string" || !payload.content.trim())
    throw new Error("The AI returned an empty response. Please try again.");
  return {
    content: payload.content.slice(0, 32000),
    model: typeof payload.model === "string" ? payload.model.slice(0, 180) : "",
    ...(payload.market ? { market: payload.market } : {}),
    ...(payload.modelFallbackUsed === true ? { modelFallbackUsed: true } : {}),
  };
};

function publicChatError(payload, fallback) {
  const error = new Error(
    typeof payload?.message === "string"
      ? payload.message.slice(0, 500)
      : fallback,
  );
  if (typeof payload?.code === "string" && /^[a-z_]{1,60}$/.test(payload.code))
    error.code = payload.code;
  if (["first_token", "idle", "deadline"].includes(payload?.timeoutPhase))
    error.timeoutPhase = payload.timeoutPhase;
  return error;
}

// Keep JSON compatibility for older deployments/providers. A streamed reply is
// only complete after a `done` event; a dropped connection is never a success.
export async function readChatResponse(response, onEvent, { signal } = {}) {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw publicChatError(
        payload,
        "Chat is temporarily unavailable. Please try again.",
      );
    return publicReply(payload);
  }
  let characters = 0;
  for await (const frame of readEventStream(response.body, { signal })) {
    if (!["start", "delta", "done", "error"].includes(frame.event)) continue;
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      throw interrupted();
    }
    if (!payload || typeof payload !== "object") throw interrupted();
    if (frame.event === "error")
      throw publicChatError(payload, interrupted().message);
    if (frame.event === "done") return publicReply(payload);
    if (frame.event === "start") {
      characters = 0;
      onEvent?.({
        type: "start",
        model:
          typeof payload.model === "string" ? payload.model.slice(0, 180) : "",
        modelFallbackUsed: payload.modelFallbackUsed === true,
        ...(payload.market ? { market: payload.market } : {}),
      });
    } else {
      if (typeof payload.text !== "string") throw interrupted();
      const text = payload.text.slice(0, Math.max(0, 32000 - characters));
      characters += text.length;
      if (text) onEvent?.({ type: "delta", text });
    }
  }
  throw interrupted();
}
