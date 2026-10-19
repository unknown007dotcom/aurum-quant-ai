// Chat has its own storage namespace; it never changes trading settings or history.
export const STORAGE_KEY = "aurum-chat-workspace-v1";
export const IMAGE_KEY = "aurum-chat-image-v1";
export const MAX_CHATS = 50;
export const MAX_MESSAGES = 100;
export const DEFAULT_SETTINGS = Object.freeze({
  modelKey: "",
  style: "balanced",
  temperature: 0.5,
  context: true,
  enterToSend: true,
});

export const EXAMPLES = Object.freeze([
  {
    id: "market",
    title: "Understanding market structure",
    messages: [
      {
        role: "user",
        content:
          "How can I make sense of market structure without overcomplicating it?",
      },
      {
        role: "assistant",
        content:
          "Start with the bigger picture, then zoom in. You only need a few building blocks.\n\n**1. Follow the swings**\nHigher highs and higher lows suggest an uptrend. Lower highs and lower lows suggest a downtrend. If neither is clear, the market may be ranging.\n\n**2. Watch what changes**\nA break of structure can support the existing trend. A change of character is an early clue that the pattern might be shifting—not a guarantee of a reversal.\n\n**3. Keep the context**\nA small move on a five-minute chart can be noise inside a larger daily trend. Start with a higher timeframe, then look for confirmation.\n\nWould you like to walk through a hypothetical example? I don't have live prices in this chat.",
      },
    ],
  },
  {
    id: "routine",
    title: "A more mindful trading routine",
    messages: [
      {
        role: "user",
        content: "Help me create a calmer, more consistent trading routine.",
      },
      {
        role: "assistant",
        content:
          "Try a simple three-part routine built around decisions you can control.\n\n**Before the session**\n- Review scheduled news and your higher-timeframe context.\n- Write down your risk limit and the conditions for taking a trade.\n- Decide what would make you sit out.\n\n**During the session**\nUse your checklist before every entry. If a setup is unclear, waiting is a valid decision. Never increase risk just to recover a loss.\n\n**After the session**\nRecord your reasoning, not just the result. Note one thing you did well and one thing to improve next time.\n\nConsistency is a process, not a promise of profit. Which part of your current routine feels hardest to maintain?",
      },
    ],
  },
  {
    id: "ideas",
    title: "Finding a fresh perspective",
    messages: [
      {
        role: "user",
        content: "I'm stuck on an idea. How do I find a fresh perspective?",
      },
      {
        role: "assistant",
        content:
          "Let's make a little room for a different angle.\n\nTry these three questions:\n\n- **What are you assuming?** Pick one assumption and imagine the opposite is true.\n- **Who sees it differently?** Think about a beginner, a skeptic, or the person who would actually use your idea.\n- **What is the smallest experiment?** A tiny test often teaches more than another hour of thinking.\n\nTell me a little about your idea, and we'll explore it together.",
      },
    ],
  },
]);

export function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function normalizeSettings(value = {}) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    modelKey:
      typeof settings.modelKey === "string"
        ? settings.modelKey.slice(0, 180)
        : "",
    style: ["concise", "balanced", "detailed"].includes(settings.style)
      ? settings.style
      : "balanced",
    temperature:
      typeof settings.temperature === "number" &&
      Number.isFinite(settings.temperature)
        ? Math.min(1, Math.max(0, settings.temperature))
        : 0.5,
    context: typeof settings.context === "boolean" ? settings.context : true,
    enterToSend:
      typeof settings.enterToSend === "boolean" ? settings.enterToSend : true,
  };
}

export function createChat(settings = DEFAULT_SETTINGS) {
  const now = Date.now();
  return {
    id: newId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
    settings: normalizeSettings(settings),
    draft: "",
    error: "",
  };
}

const isTimestamp = (value) =>
  typeof value === "number" && Number.isFinite(new Date(value).getTime());

export function restoreState(value) {
  const source = value && typeof value === "object" ? value : {};
  const seen = new Set();
  const conversations = (
    Array.isArray(source.conversations) ? source.conversations : []
  )
    .slice(0, MAX_CHATS)
    .filter(
      (chat) =>
        chat &&
        typeof chat.id === "string" &&
        chat.id.length < 100 &&
        Array.isArray(chat.messages),
    )
    .filter((chat) => !seen.has(chat.id) && seen.add(chat.id))
    .map((chat) => ({
      id: chat.id,
      title:
        typeof chat.title === "string"
          ? chat.title.slice(0, 80) || "Untitled conversation"
          : "Untitled conversation",
      createdAt: isTimestamp(chat.createdAt) ? chat.createdAt : Date.now(),
      updatedAt: isTimestamp(chat.updatedAt) ? chat.updatedAt : Date.now(),
      settings: normalizeSettings(chat.settings),
      draft: typeof chat.draft === "string" ? chat.draft.slice(0, 8000) : "",
      error: typeof chat.error === "string" ? chat.error.slice(0, 500) : "",
      messages: chat.messages
        .slice(0, MAX_MESSAGES)
        .filter(
          (message) =>
            message &&
            ["user", "assistant"].includes(message.role) &&
            typeof message.content === "string" &&
            message.content.trim(),
        )
        .map((message) => ({
          id:
            typeof message.id === "string" ? message.id.slice(0, 100) : newId(),
          role: message.role,
          content: message.content.slice(
            0,
            message.role === "user" ? 8000 : 32000,
          ),
          createdAt: isTimestamp(message.createdAt) ? message.createdAt : null,
          model:
            typeof message.model === "string"
              ? message.model.slice(0, 180)
              : "",
        })),
    }));
  return {
    version: 1,
    conversations,
    activeId: conversations.some((chat) => chat.id === source.activeId)
      ? source.activeId
      : null,
    defaults: normalizeSettings(source.defaults),
    draft: typeof source.draft === "string" ? source.draft.slice(0, 8000) : "",
  };
}

export function titleFromMessage(content) {
  const title = content.replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

export function requestMessages(messages, includeContext = true) {
  const valid = messages.filter(
    (message) =>
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string" &&
      message.content.trim(),
  );
  if (!includeContext) {
    const lastUser = valid.findLast((message) => message.role === "user");
    return lastUser
      ? [{ role: "user", content: lastUser.content.slice(0, 8000) }]
      : [];
  }
  const result = [];
  let characters = 0;
  for (const message of valid.slice(-40).reverse()) {
    const content = message.content.slice(0, 8000);
    if (characters + content.length > 48000) break;
    result.unshift({ role: message.role, content });
    characters += content.length;
  }
  return result;
}

export function historyGroup(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  const week = new Date(today);
  week.setDate(today.getDate() - 7);
  return date >= week ? "Previous 7 days" : "Earlier";
}

export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

// Intentionally limited Markdown: no raw HTML, remote images, or executable links.
export function formatMessage(text) {
  const inline = (value) =>
    escapeHtml(value)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const blocks = String(text).split(/(```[\s\S]*?(?:```|$))/g);
  return blocks
    .map((block) => {
      if (block.startsWith("```")) {
        const code = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
      return block
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((paragraph) => {
          const lines = paragraph.split("\n");
          if (lines.every((line) => /^\s*[-*] /.test(line)))
            return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
          if (lines.every((line) => /^\s*\d+\. /.test(line)))
            return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+\. /, ""))}</li>`).join("")}</ol>`;
          if (/^#{1,6} /.test(paragraph) && lines.length === 1)
            return `<h3>${inline(paragraph.replace(/^#{1,6} /, ""))}</h3>`;
          return `<p>${inline(paragraph).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
    })
    .join("");
}

export function exportConversation(chat) {
  const date = new Date(chat.createdAt).toLocaleString();
  return `# ${chat.title}\n\nAurum AI · ${date}\n\n${chat.messages.map((message) => `## ${message.role === "user" ? "You" : "Aurum AI"}\n\n${message.content}`).join("\n\n---\n\n")}\n\n---\nAI can make mistakes. Think critically. Trade responsibly.\n`;
}
