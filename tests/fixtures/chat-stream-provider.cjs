// Preloaded ONLY by chat-stream.browser.cjs. Real HTTP server, fake provider;
// no external API, credentials from disk, market reads, or trading commands.
const http = require("node:http");
const MODEL = "example/browser-instruct";
const adminPath = require.resolve("../../lib/firebase-admin");
require.cache[adminPath] = {
  exports: {
    getAdminSettings: async () => ({
      globalNvidiaApiKey: "test-only-key",
      nvidiaModels: [
        { id: MODEL, key: "browser-test", label: "Browser test model" },
      ],
      defaultModelKey: "browser-test",
    }),
  },
};
process.env.NVIDIA_API_KEY = "test-only-key";
const send = (value) => {
  if (process.connected) process.send(value);
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once("listening", () =>
    send({ type: "ready", port: this.address().port }),
  );
  return listen.apply(this, args);
};
const encoder = new TextEncoder();
const streams = new Map();
let plan = { initial: "" };
let sequence = 0;
const write = (stream, payload) => {
  if (!stream.closed)
    stream.controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
    );
};
const delta = (stream, text) =>
  write(stream, { choices: [{ delta: { content: text } }] });

globalThis.fetch = async (url, options) => {
  if (url.endsWith("/models")) return Response.json({ data: [{ id: MODEL }] });
  if (!url.endsWith("/chat/completions"))
    throw new Error("Unexpected test network request");
  const id = ++sequence;
  const body = JSON.parse(options.body);
  const stream = { closed: false, completed: false };
  const response = new Response(
    new ReadableStream({
      start(controller) {
        stream.controller = controller;
        streams.set(id, stream);
        write(stream, {
          choices: [
            {
              delta: { reasoning_content: "PRIVATE REASONING MUST NOT APPEAR" },
            },
          ],
        });
        if (plan.initial) delta(stream, plan.initial);
      },
      cancel() {
        stream.closed = true;
        if (!stream.completed) send({ type: "cancelled", id });
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  options.signal.addEventListener(
    "abort",
    () => send({ type: "aborted", id }),
    { once: true },
  );
  send({ type: "provider-request", id, body });
  return response;
};
process.on("message", (message) => {
  if (message.command === "plan") plan = message.plan;
  const stream = streams.get(message.id);
  if (stream && !stream.closed) {
    if (message.command === "chunk") delta(stream, message.text);
    if (message.command === "finish-without-close") {
      if (message.text) delta(stream, message.text);
      write(stream, { choices: [{ delta: {}, finish_reason: "stop" }] });
      stream.completed = true;
      // Keep the transport open: the terminal choice must be enough for the
      // real handler/browser to complete, cancel the reader and allow sending.
    }
    if (message.command === "finish") {
      if (message.text) delta(stream, message.text);
      write(stream, { choices: [{ delta: {}, finish_reason: "stop" }] });
      stream.controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      stream.completed = true;
      stream.closed = true;
      stream.controller.close();
    }
    if (message.command === "fail") {
      write(stream, { error: { message: "PRIVATE PROVIDER ERROR" } });
      stream.closed = true;
      stream.controller.close();
    }
  }
  send({ type: "ack", commandId: message.commandId });
});
