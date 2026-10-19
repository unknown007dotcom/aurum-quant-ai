// A shared, explicitly AI identity for the chat UI, exports, and provider prompt.
export const CHAT_ASSISTANT = Object.freeze({
  name: "Mira",
  portrait: "./assets/mira-assistant.webp",
  avatar: "./assets/mira-avatar.webp",
  portraitAlt: "Anime portrait of Mira, your AI assistant",
});

// Only local raster uploads may replace the bundled portrait. Never load a
// third-party URL or an executable image format from browser storage.
export function resolveChatArtwork(value) {
  const isCustom =
    typeof value === "string" &&
    value.length < 2 * 1024 * 1024 &&
    /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value);
  return {
    src: isCustom ? value : CHAT_ASSISTANT.portrait,
    alt: isCustom ? "Your custom chat artwork" : CHAT_ASSISTANT.portraitAlt,
    isCustom,
  };
}
