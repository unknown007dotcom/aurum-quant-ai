// One-off, explicitly enabled operator action for this repair. Uses the existing
// saved Aurum key. Writes only Chat model preferences, never credentials, the
// analysis default, broker settings, history or orders. Remove its build flag
// after verification; ordinary builds must not reconfigure an owner's settings.
module.exports = async function configureVerifiedChat() {
  if (process.env.AURUM_CONFIGURE_VERIFIED_CHAT !== "1")
    throw new Error("Explicit Chat configuration opt-in is required.");
  const { getFirestore } = require("../lib/firebase-admin.js");
  const { credentials } = await import("../lib/nvidia-runtime.mjs");
  const { completeChat } = await import("../lib/chat-service.mjs");
  const { randomUUID } = require("node:crypto");
  const reference = getFirestore().collection("admin").doc("settings");
  const snapshot = await reference.get();
  if (!snapshot.exists)
    throw new Error(
      "Saved Aurum settings must exist; no fallback file will be copied.",
    );
  const saved = snapshot.data();
  const savedCredentials = credentials(saved, {});
  const effectiveCredentials = credentials(saved, process.env);
  if (
    !savedCredentials.length ||
    effectiveCredentials.some(
      (actual) =>
        !savedCredentials.some(
          (stored) =>
            stored.apiKey === actual.apiKey &&
            stored.baseUrl === actual.baseUrl,
        ),
    )
  )
    throw new Error(
      "The active server credential must match an existing saved Aurum credential before configuring Chat.",
    );
  const patch = {
    chatModelIds: [
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "minimaxai/minimax-m3.1-flash",
    ],
    chatDefaultModelKey: "nvidia/nemotron-3.5-lightning-30b-a3b",
  };
  const candidate = { ...saved, ...patch };
  for (const modelKey of patch.chatModelIds) {
    const started = Date.now();
    const marker = "CONFIG_" + randomUUID().slice(0, 8);
    let deltaCount = 0,
      firstTextMs = null;
    const question =
      modelKey === patch.chatDefaultModelKey
        ? `Start with ${marker}. Make a short Markdown table comparing two ways to organize a reading list, with columns Method and Benefit. Add one short takeaway.`
        : `Start with ${marker} and give one short tip for organizing a reading list.`;
    const reply = await completeChat(
      {
        modelKey,
        stream: true,
        messages: [{ role: "user", content: question }],
        settings: { style: "concise", temperature: 0.6, marketContext: false },
      },
      candidate,
      process.env,
      globalThis.fetch,
      {
        onEvent(event) {
          if (event.type === "delta" && event.text.trim()) {
            firstTextMs ??= Date.now() - started;
            deltaCount++;
          }
        },
      },
    );
    if (
      reply.model !== modelKey ||
      !reply.content.includes(marker) ||
      !deltaCount
    )
      throw new Error(
        "A proposed Chat model did not pass its genuine saved-key completion check; preferences were not saved.",
      );
    console.log(
      "[AURUM-CHAT-CONFIGURE] " +
        JSON.stringify({
          check: "preflight",
          model: reply.model,
          ok: true,
          firstTextMs,
          deltaCount,
          durationMs: Date.now() - started,
          visibleChars: reply.content.length,
          replyExcerpt: reply.content.slice(0, 240),
        }),
    );
  }
  // Compare credentials in memory only, never write/print them. A transaction
  // prevents overwriting a concurrent credential or Chat-preference change.
  const credentialSignature = JSON.stringify(savedCredentials);
  const priorPolicy = JSON.stringify([
    saved.chatModelIds,
    saved.chatDefaultModelKey,
  ]);
  await reference.firestore.runTransaction(async (transaction) => {
    const fresh = await transaction.get(reference);
    if (!fresh.exists)
      throw new Error("Aurum settings changed during verification.");
    const current = fresh.data();
    if (
      JSON.stringify(credentials(current, {})) !== credentialSignature ||
      JSON.stringify([current.chatModelIds, current.chatDefaultModelKey]) !==
        priorPolicy
    )
      throw new Error(
        "Saved AI configuration changed during verification; newer settings were not overwritten.",
      );
    transaction.set(reference, patch, { merge: true });
  });
  console.log(
    "[AURUM-CHAT-CONFIGURE] " +
      JSON.stringify({
        ok: true,
        ...patch,
        writtenFields: Object.keys(patch),
        credentialsWritten: false,
        analysisSettingsWritten: false,
        tradingSettingsWritten: false,
      }),
  );
};
