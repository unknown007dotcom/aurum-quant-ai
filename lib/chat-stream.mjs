import {
  ChatError,
  completeChat,
  validateChatRequest,
} from "./chat-service.mjs";

export const CHAT_STREAM_HEADERS = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
});

// One protocol for Node/Vercel and the Worker. Only public answer text and safe
// metadata leave the service; upstream events, credentials and reasoning do not.
export function createChatStream(
  body,
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
  { signal, onAttemptFailure } = {},
) {
  validateChatRequest(body); // Keep invalid requests as HTTP errors, before headers.
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat;
  const abort = () => abortController.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    clearInterval(heartbeat);
    signal?.removeEventListener("abort", abort);
  };
  return new ReadableStream({
    start(controller) {
      const write = (text) => {
        if (!closed && !abortController.signal.aborted)
          controller.enqueue(encoder.encode(text));
      };
      const send = ({ type, ...payload }) =>
        write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      write(": connected\n\n");
      // Keep proxies alive during model discovery, market lookup or reasoning.
      heartbeat = setInterval(() => write(": keep-alive\n\n"), 15000);
      heartbeat.unref?.();
      completeChat(body, settings, env, fetchImpl, {
        onEvent: send,
        signal: abortController.signal,
        onAttemptFailure,
      })
        .then((reply) => send({ type: "done", ...reply }))
        .catch((error) => {
          if (!abortController.signal.aborted)
            send({
              type: "error",
              code:
                error instanceof ChatError
                  ? error.code || "provider_error"
                  : "provider_error",
              ...(error instanceof ChatError && error.timeoutPhase
                ? { timeoutPhase: error.timeoutPhase }
                : {}),
              message:
                error instanceof ChatError
                  ? error.message
                  : "Chat is temporarily unavailable. Please try again.",
            });
        })
        .finally(() => {
          cleanup();
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
      cleanup();
      abortController.abort();
    },
  });
}
