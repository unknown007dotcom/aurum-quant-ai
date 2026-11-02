import { CHAT_ASSISTANT } from "./chat-persona.mjs";
import {
  normalizeMarketEvidence,
  marketEvidenceText,
} from "./chat-market-evidence.mjs";

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
  marketContext: true,
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
          "Start with the bigger picture, then zoom in. You only need a few building blocks.\n\n**1. Follow the swings**\nHigher highs and higher lows suggest an uptrend. Lower highs and lower lows suggest a downtrend. If neither is clear, the market may be ranging.\n\n**2. Watch what changes**\nA break of structure can support the existing trend. A change of character is an early clue that the pattern might be shifting—not a guarantee of a reversal.\n\n**3. Keep the context**\nA small move on a five-minute chart can be noise inside a larger daily trend. Start with a higher timeframe, then look for confirmation.\n\nWould you like to walk through a hypothetical example? You can also ask for a timestamped, read-only OANDA gold snapshot.",
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
    marketContext:
      typeof settings.marketContext === "boolean"
        ? settings.marketContext
        : true,
    enterToSend:
      typeof settings.enterToSend === "boolean" ? settings.enterToSend : true,
  };
}

// A browser preference is not a provider credential or an authoritative catalog.
// Only reconcile after a successful configured catalog fetch; a network outage
// must not erase a user's selection. An empty key follows the server default.
export function reconcileModelKey(key, configuration = {}) {
  if (!key || !configuration.configured || !configuration.models?.length)
    return key || "";
  const models = configuration.models;
  return (
    (
      models.find((model) => model.key === key) ||
      models.find((model) => model.id === key)
    )?.key || ""
  );
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
          ...(message.role === "assistant" && message.incomplete === true
            ? { incomplete: true }
            : {}),
          ...(message.role === "assistant" &&
          normalizeMarketEvidence(message.market)
            ? { market: normalizeMarketEvidence(message.market) }
            : {}),
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
      !message.incomplete &&
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
// Parse blocks by line so tables also work immediately beside prose/headings and
// while a streamed row is still arriving. Every cell goes through HTML escaping.
function inlineMarkdown(value) {
  return String(value)
    .split(/(`+[^`\n]*?`+)/g)
    .map((part) => {
      const code = part.match(/^(`+)([\s\S]*?)\1$/);
      if (code)
        return `<code>${escapeHtml(code[2].replace(/\\\|/g, "|"))}</code>`;
      return escapeHtml(part)
        .replace(/\\\|/g, "|")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
}

function tableCells(line) {
  const cells = [];
  let cell = "";
  let codeFence = "";
  let hasPipe = false;
  const text = line.trim();
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) {
      cell += character + text[++index];
    } else if (character === "`") {
      const ticks = text.slice(index).match(/^`+/)[0];
      if (codeFence === ticks) codeFence = "";
      else if (!codeFence && text.indexOf(ticks, index + ticks.length) >= 0)
        codeFence = ticks;
      cell += ticks;
      index += ticks.length - 1;
    } else if (character === "|" && !codeFence) {
      hasPipe = true;
      cells.push(cell.trim());
      cell = "";
    } else cell += character;
  }
  cells.push(cell.trim());
  if (!hasPipe) return null;
  if (text.startsWith("|")) cells.shift();
  // Only discard an actual trailing separator, not an escaped literal pipe.
  if (cells.at(-1) === "" && text.endsWith("|")) cells.pop();
  return cells;
}

function tableHeader(lines, index) {
  const headers = tableCells(lines[index] || "");
  const separators = tableCells(lines[index + 1] || "");
  if (
    !headers?.length ||
    separators?.length !== headers.length ||
    !separators.every((cell) => /^:?-+:?$/.test(cell))
  )
    return null;
  return {
    headers,
    alignments: separators.map((cell) =>
      cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left",
    ),
  };
}

export function formatMessage(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
        code.push(lines[index++]);
      if (index < lines.length) index++;
      output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const table = tableHeader(lines, index);
    if (table) {
      const cell = (tag, value, column) =>
        `<${tag}${tag === "th" ? ' scope="col"' : ""} class="align-${table.alignments[column]}">${inlineMarkdown(value)}</${tag}>`;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim()) {
        const values = tableCells(lines[index]);
        if (!values || tableHeader(lines, index)) break;
        // Pad incomplete streaming rows and ignore surplus cells, as GFM does.
        rows.push(
          `<tr>${table.headers.map((_, column) => cell("td", values[column] || "", column)).join("")}</tr>`,
        );
        index++;
      }
      output.push(
        `<div class="message-table-scroll" role="region" aria-label="Response table. Scroll horizontally for more columns." tabindex="0"><table><thead><tr>${table.headers.map((value, column) => cell("th", value, column)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      output.push(`<h3>${inlineMarkdown(line.replace(/^#{1,6} /, ""))}</h3>`);
      index++;
      continue;
    }
    const list = /^\s*[-*] /.test(line)
      ? "ul"
      : /^\s*\d+\. /.test(line)
        ? "ol"
        : null;
    if (list) {
      const pattern = list === "ul" ? /^\s*[-*] / : /^\s*\d+\. /;
      const items = [];
      while (index < lines.length && pattern.test(lines[index]))
        items.push(
          `<li>${inlineMarkdown(lines[index++].replace(pattern, ""))}</li>`,
        );
      output.push(`<${list}>${items.join("")}</${list}>`);
      continue;
    }
    const paragraph = [line];
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:```|#{1,6} |[-*] |\d+\. )/.test(lines[index]) &&
      !tableHeader(lines, index)
    )
      paragraph.push(lines[index++]);
    output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
  }
  return output.join("");
}

export function exportConversation(chat) {
  const date = new Date(chat.createdAt).toLocaleString();
  return `# ${chat.title}\n\n${CHAT_ASSISTANT.name} · Aurum Quant AI · ${date}\n\n${chat.messages
    .map((message) => {
      const evidence =
        message.role === "assistant"
          ? marketEvidenceText(message.market)
          : null;
      return `## ${message.role === "user" ? "You" : CHAT_ASSISTANT.name}\n\n${message.incomplete ? "_Partial response — stopped or interrupted._\n\n" : ""}${message.content}${evidence ? `\n\nMarket evidence: ${evidence.heading}\n${evidence.stateLabel}\n${evidence.detail}\n${evidence.timeLabel}` : ""}`;
    })
    .join(
      "\n\n---\n\n",
    )}\n\n---\nAI can make mistakes. Think critically. Trade responsibly.\n`;
}
