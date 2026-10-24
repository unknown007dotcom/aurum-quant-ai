import {
  STORAGE_KEY,
  IMAGE_KEY,
  MAX_CHATS,
  MAX_MESSAGES,
  DEFAULT_SETTINGS,
  EXAMPLES,
  newId,
  normalizeSettings,
  reconcileModelKey,
  createChat,
  restoreState,
  titleFromMessage,
  requestMessages,
  historyGroup,
  formatMessage,
  exportConversation,
} from "./modules/chat-store.mjs?v=3";
import { CHAT_ASSISTANT, resolveChatArtwork } from "./modules/chat-persona.mjs";

const $ = (id) => document.getElementById(id);
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="./assets/chat-icons.svg#${name}"/></svg>`;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
let storageWarningShown = false;
let toastTimer;
let saveTimer;
let pending = null;
let drawer = null;
let deleteTarget = null;
let configuration = { models: [], defaultModelKey: "", configured: false };
let state;
try {
  state = restoreState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
} catch {
  state = restoreState(null);
}
let current =
  state.conversations.find((chat) => chat.id === state.activeId) ||
  createChat(state.defaults);
if (!state.activeId) current.draft = state.draft;
// Keep these in sync with the phone/tablet drawer queries in chat.css.
const historyMedia = matchMedia("(max-width: 899px)");
const settingsMedia = matchMedia("(max-width: 640px)");

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 3800);
}

function persist() {
  clearTimeout(saveTimer);
  state.activeId = state.conversations.some((chat) => chat.id === current.id)
    ? current.id
    : null;
  state.draft = state.activeId ? "" : current.draft || "";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    if (!storageWarningShown) {
      toast(
        "Browser storage is unavailable or full. Export important chats before leaving.",
      );
      storageWarningShown = true;
    }
  }
}

function persistSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

function saveCurrent() {
  if (!current.messages.length || current.exampleId) return persist();
  if (!state.conversations.some((chat) => chat.id === current.id))
    state.conversations.unshift(current);
  persist();
}

function renderHistory() {
  const query = $("searchChats").value.toLowerCase().trim();
  const chats = [...state.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((chat) =>
      `${chat.title} ${chat.messages.map((message) => message.content).join(" ")}`
        .toLowerCase()
        .includes(query),
    );
  const list = $("historyList");
  list.replaceChildren();
  let previousGroup = "";
  for (const chat of chats) {
    const group = historyGroup(chat.updatedAt);
    if (group !== previousGroup) {
      list.append(element("h3", "history-group-label", group));
      previousGroup = group;
    }
    const row = element(
      "div",
      `history-row${chat.id === current.id ? " active" : ""}`,
    );
    const button = element("button", "history-item");
    button.type = "button";
    button.title = chat.title;
    button.setAttribute("aria-label", `Open ${chat.title}`);
    if (chat.id === current.id) button.setAttribute("aria-current", "true");
    button.innerHTML = icon("chat");
    const text = element("span", "", chat.title);
    const count = chat.messages.length;
    text.append(
      element(
        "small",
        "",
        `${count} message${count === 1 ? "" : "s"} · ${new Date(chat.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
      ),
    );
    button.append(text);
    button.addEventListener("click", () => openChat(chat));
    const remove = element("button", "history-delete");
    remove.type = "button";
    remove.innerHTML = icon("trash");
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.addEventListener("click", () => confirmDelete(chat.id));
    row.append(button, remove);
    list.append(row);
  }
  $("chatCount").textContent = state.conversations.length;
  $("historyEmpty").hidden = state.conversations.length > 0 || Boolean(query);
  let exampleMatches = 0;
  document.querySelectorAll("[data-example]").forEach((button) => {
    const example = EXAMPLES.find((item) => item.id === button.dataset.example);
    const matches =
      `${example.title} ${example.messages.map((message) => message.content).join(" ")}`
        .toLowerCase()
        .includes(query);
    button.hidden = !matches;
    button.classList.toggle("active", current.exampleId === example.id);
    if (current.exampleId === example.id)
      button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    if (matches) exampleMatches++;
  });
  document.querySelector(".example-section").hidden = !exampleMatches;
  $("searchEmpty").hidden = chats.length > 0 || exampleMatches > 0 || !query;
}

function messageNode(message, index) {
  const article = element("article", `message ${message.role}`);
  const avatar = element("div", "message-avatar");
  avatar.setAttribute("aria-hidden", "true");
  if (message.role === "assistant") {
    avatar.classList.add("has-portrait");
    const portrait = element("img", "");
    portrait.src = CHAT_ASSISTANT.avatar;
    portrait.alt = "";
    portrait.width = 30;
    portrait.height = 30;
    avatar.append(portrait);
  } else avatar.textContent = "Y";
  const main = element("div", "message-main");
  const meta = element("div", "message-meta");
  meta.append(
    element(
      "strong",
      "",
      message.role === "user" ? "You" : CHAT_ASSISTANT.name,
    ),
  );
  if (message.createdAt) {
    const time = element(
      "time",
      "",
      new Date(message.createdAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    time.dateTime = new Date(message.createdAt).toISOString();
    meta.append(time);
  }
  if (message.role === "assistant" && message.model) {
    const actualModel = element("span", "message-model", message.model);
    actualModel.title = `Actual response model: ${message.model}`;
    meta.append(actualModel);
  }
  const body = element("div", "message-body");
  if (message.role === "assistant")
    body.innerHTML = formatMessage(message.content);
  else body.textContent = message.content;
  main.append(meta, body);
  if (message.role === "assistant") {
    const actions = element("div", "message-actions");
    const copy = element("button", "");
    copy.type = "button";
    copy.innerHTML = `${icon("copy")}Copy`;
    copy.setAttribute("aria-label", "Copy assistant response");
    copy.addEventListener("click", () => copyResponse(message.content));
    actions.append(copy);
    if (index === current.messages.length - 1 && !current.exampleId) {
      const regenerate = element("button", "");
      regenerate.type = "button";
      regenerate.innerHTML = `${icon("refresh")}Regenerate`;
      regenerate.disabled = Boolean(pending);
      regenerate.addEventListener("click", () => requestReply(true));
      actions.append(regenerate);
    }
    main.append(actions);
  }
  article.append(avatar, main);
  return article;
}

function renderConversation({ scroll = true } = {}) {
  const hasMessages = current.messages.length > 0;
  $("welcomeScreen").hidden = hasMessages;
  $("messages").hidden = !hasMessages;
  $("conversationTitle").textContent = hasMessages
    ? current.title
    : "A little insight. A new perspective.";
  document.title = hasMessages
    ? `${current.title} · ${CHAT_ASSISTANT.name}`
    : `${CHAT_ASSISTANT.name} · Chat Mode · Aurum Quant AI`;
  const container = $("messages");
  container.setAttribute("aria-busy", "true");
  container.replaceChildren();
  if (current.exampleId)
    container.append(
      element(
        "p",
        "example-notice",
        "Example conversation · Continue below to make it yours.",
      ),
    );
  current.messages.forEach((message, index) =>
    container.append(messageNode(message, index)),
  );
  if (pending?.chatId === current.id) {
    const typing = element("div", "message assistant");
    typing.innerHTML = `<div class="message-avatar has-portrait" aria-hidden="true"><img src="${CHAT_ASSISTANT.avatar}" width="30" height="30" alt="" /></div><div class="message-main"><div class="message-meta"><strong>${CHAT_ASSISTANT.name}</strong></div><div class="typing-indicator" aria-hidden="true"><span></span><span></span><span></span><div class="typing-label">Thinking it through…</div></div><span class="sr-only">${CHAT_ASSISTANT.name} is preparing a response.</span></div>`;
    container.append(typing);
  }
  container.setAttribute("aria-busy", "false");
  $("chatError").hidden = !current.error;
  $("chatErrorText").textContent = current.error || "";
  $("retryButton").disabled = Boolean(pending);
  $("renameChatButton").disabled = !hasMessages || Boolean(current.exampleId);
  $("exportChatButton").disabled = !hasMessages;
  $("deleteChatButton").disabled = !state.conversations.some(
    (chat) => chat.id === current.id,
  );
  updateComposer();
  if (scroll)
    requestAnimationFrame(() => {
      $("messageScroll").scrollTop = $("messageScroll").scrollHeight;
    });
}

function renderSettings() {
  const options = current.settings;
  // Preserve a removed model's identity so a saved chat never silently changes models.
  $("chatModel")
    .querySelectorAll("[data-unavailable]")
    .forEach((option) => option.remove());
  if (
    options.modelKey &&
    ![...$("chatModel").options].some(
      (option) => option.value === options.modelKey,
    )
  ) {
    const option = new Option(
      "Previously selected model (unavailable)",
      options.modelKey,
    );
    option.dataset.unavailable = "true";
    $("chatModel").append(option);
  }
  $("chatModel").value = options.modelKey;
  document.querySelectorAll("[name=responseStyle]").forEach((input) => {
    input.checked = input.value === options.style;
  });
  $("creativity").value = options.temperature;
  $("creativity").style.setProperty(
    "--range-progress",
    `${options.temperature * 100}%`,
  );
  $("creativityValue").value = options.temperature.toFixed(1);
  $("rememberContext").checked = options.context;
  $("enterToSend").checked = options.enterToSend;
  $("sendHint").textContent = options.enterToSend
    ? "Enter to send"
    : "Ctrl / ⌘ + Enter to send";
  const selected = configuration.models.find(
    (model) =>
      model.key === (options.modelKey || configuration.defaultModelKey),
  );
  $("selectedModelCaption").textContent =
    selected?.label || (options.modelKey ? "Selected model" : "Default model");
}

function updateSettings(patch) {
  current.settings = normalizeSettings({ ...current.settings, ...patch });
  state.defaults = { ...current.settings };
  renderSettings();
  persist();
}

function updateComposer() {
  const waiting = Boolean(pending);
  $("sendButton").disabled = !waiting && !$("messageInput").value.trim();
  $("sendButton").classList.toggle("is-stopping", waiting);
  $("sendButton").innerHTML = icon(waiting ? "stop" : "arrow-up");
  $("sendButton").setAttribute(
    "aria-label",
    waiting ? "Stop response" : "Send message",
  );
  $("sendButton").title = waiting ? "Stop response" : "Send message";
  $("messageInput").readOnly = waiting;
  $("messageInput").placeholder = waiting
    ? `${CHAT_ASSISTANT.name} is thinking it through…`
    : `What's on your mind? Ask ${CHAT_ASSISTANT.name} anything…`;
  $("characterCount").hidden = $("messageInput").value.length < 7200;
  $("characterCount").textContent =
    `${$("messageInput").value.length.toLocaleString()} / 8,000`;
  resizeInput();
}

function resizeInput() {
  const input = $("messageInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(150, Math.max(45, input.scrollHeight))}px`;
}

function openChat(chat) {
  stopResponse(true);
  current.draft = $("messageInput").value;
  persist();
  current = chat;
  $("messageInput").value = current.draft || "";
  // A tab may have closed while the last response was still in flight.
  if (
    !current.exampleId &&
    current.messages.at(-1)?.role === "user" &&
    !current.error
  )
    current.error =
      "This message is waiting for a response. Try again to continue.";
  renderConversation();
  renderSettings();
  renderHistory();
  closeDrawer(false);
  persist();
  $("messageInput").focus({ preventScroll: true });
}

function newConversation() {
  $("searchChats").value = "";
  openChat(createChat(state.defaults));
}

function openExample(id) {
  const example = EXAMPLES.find((item) => item.id === id);
  if (!example) return;
  const chat = createChat(state.defaults);
  chat.title = example.title;
  chat.exampleId = example.id;
  chat.messages = example.messages.map((message) => ({
    ...message,
    id: newId(),
    createdAt: null,
  }));
  openChat(chat);
}

function submitMessage(event) {
  event?.preventDefault();
  if (pending) return stopResponse();
  const content = $("messageInput").value.trim();
  if (!content) return;
  if (content.length > 8000)
    return toast("Please keep your message under 8,000 characters.");
  if (current.messages.length >= MAX_MESSAGES - 1)
    return toast("This conversation is full. Start a new chat to keep going.");
  if (
    !state.conversations.some((chat) => chat.id === current.id) &&
    state.conversations.length >= MAX_CHATS
  )
    return toast(
      "You have 50 saved chats. Export and delete an older chat to make room.",
    );
  if (!current.messages.length) current.title = titleFromMessage(content);
  delete current.exampleId;
  current.messages.push({
    id: newId(),
    role: "user",
    content,
    createdAt: Date.now(),
  });
  current.updatedAt = Date.now();
  current.draft = "";
  current.error = "";
  $("messageInput").value = "";
  saveCurrent();
  renderHistory();
  requestReply();
}

async function requestReply(regenerate = false) {
  if (pending) return;
  const chat = current;
  const previous =
    regenerate && chat.messages.at(-1)?.role === "assistant"
      ? chat.messages.slice(0, -1)
      : chat.messages;
  if (previous.at(-1)?.role !== "user") return;
  const operation = {
    chatId: chat.id,
    controller: new AbortController(),
    timedOut: false,
  };
  pending = operation;
  chat.error = "";
  renderConversation();
  const timeout = setTimeout(() => {
    operation.timedOut = true;
    operation.controller.abort();
  }, 90000);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        modelKey: chat.settings.modelKey,
        settings: {
          style: chat.settings.style,
          temperature: chat.settings.temperature,
        },
        messages: requestMessages(previous, chat.settings.context),
      }),
      signal: operation.controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof payload.message === "string"
          ? payload.message.slice(0, 500)
          : "Chat is temporarily unavailable. Please try again.",
      );
    if (typeof payload.content !== "string" || !payload.content.trim())
      throw new Error("The AI returned an empty response. Please try again.");
    if (pending !== operation) return;
    if (payload.modelFallbackUsed)
      toast(
        `The selected model was unavailable. ${payload.model} answered instead.`,
      );
    const message = {
      id: newId(),
      role: "assistant",
      content: payload.content.slice(0, 32000),
      model: typeof payload.model === "string" ? payload.model : "",
      createdAt: Date.now(),
    };
    if (regenerate && chat.messages.at(-1)?.role === "assistant")
      chat.messages.splice(-1, 1, message);
    else chat.messages.push(message);
    chat.updatedAt = Date.now();
  } catch (error) {
    if (pending !== operation) return;
    chat.error = operation.timedOut
      ? "The AI response took too long. Your message is saved; try again."
      : error instanceof TypeError
        ? "Couldn't connect to the chat service. Your message is saved; please try again."
        : error.message || "Couldn't complete this response. Please try again.";
  } finally {
    clearTimeout(timeout);
    if (pending === operation) {
      pending = null;
      saveCurrent();
      renderConversation();
      renderHistory();
    }
  }
}

function stopResponse(silent = false) {
  if (!pending) return;
  const operation = pending;
  pending = null;
  operation.controller.abort();
  const chat = state.conversations.find((item) => item.id === operation.chatId);
  if (chat) chat.error = "Response stopped. Try again when you're ready.";
  saveCurrent();
  renderConversation();
  if (!silent) toast("Response stopped.");
}

async function copyResponse(content) {
  try {
    if (navigator.clipboard?.writeText)
      await navigator.clipboard.writeText(content);
    else {
      const textarea = element("textarea", "sr-only");
      textarea.value = content;
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Copy unavailable");
    }
    toast("Response copied.");
  } catch {
    toast(
      "Couldn't access the clipboard. You can select and copy the response.",
    );
  }
}

function exportChat() {
  if (!current.messages.length) return;
  const url = URL.createObjectURL(
    new Blob([exportConversation(current)], {
      type: "text/markdown;charset=utf-8",
    }),
  );
  const link = element("a", "");
  link.href = url;
  link.download = `aurum-${
    current.title
      .replace(/[^a-z0-9-]+/gi, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 55) || "conversation"
  }.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("conversationMenu").open = false;
  toast("Conversation exported.");
}

function confirmDelete(id) {
  const chat = state.conversations.find((item) => item.id === id);
  if (!chat) return;
  deleteTarget = id;
  $("conversationMenu").open = false;
  $("deleteDescription").textContent =
    `“${chat.title}” will be removed from this browser. This cannot be undone.`;
  $("deleteDialog").returnValue = "cancel";
  $("deleteDialog").showModal();
}

function deleteConfirmedChat() {
  if ($("deleteDialog").returnValue !== "delete" || !deleteTarget) return;
  const id = deleteTarget;
  deleteTarget = null;
  if (pending?.chatId === id) stopResponse(true);
  state.conversations = state.conversations.filter((chat) => chat.id !== id);
  if (current.id === id) {
    current =
      state.conversations
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ||
      createChat(state.defaults);
    $("messageInput").value = current.draft || "";
    renderConversation();
    renderSettings();
  }
  persist();
  renderHistory();
  toast("Conversation deleted.");
}

async function loadConfiguration() {
  try {
    const response = await fetch("/api/chat", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.message || "AI configuration is unavailable.");
    if (!Array.isArray(data.models)) throw new Error("Invalid configuration");
    configuration = {
      models: data.models.filter(
        (model) =>
          model &&
          typeof model.key === "string" &&
          typeof model.label === "string",
      ),
      defaultModelKey: data.defaultModelKey || "",
      configured: data.configured === true,
    };
    $("chatModel").replaceChildren(new Option("Default model", ""));
    configuration.models.forEach((model) =>
      $("chatModel").append(new Option(model.label, model.key)),
    );
    // Reconcile all history entries, not just the chat open during page load.
    // Removed keys may no longer appear in the server's unavailableModels list.
    const previousKey = current.settings.modelKey;
    for (const options of [
      state.defaults,
      current.settings,
      ...state.conversations.map((chat) => chat.settings),
    ]) {
      options.modelKey = reconcileModelKey(options.modelKey, configuration);
    }
    persist();
    if (previousKey && previousKey !== current.settings.modelKey) {
      toast(
        "Your saved model selection was updated to an available model. Your messages are unchanged.",
      );
    }
    setProviderStatus(
      configuration.configured ? "configured" : "setup",
      configuration.configured
        ? "Uses your configured NVIDIA models"
        : "Add an API key in Terminal Settings",
    );
    renderSettings();
  } catch (error) {
    setProviderStatus(
      "unavailable",
      "AI configuration unavailable · your chats stay saved",
    );
    $("providerStatus").title = error.message;
  }
}

function setProviderStatus(status, text) {
  $("providerStatus").dataset.state = status;
  $("providerStatus").replaceChildren(
    element("span", ""),
    document.createTextNode(text),
  );
}

function showImage(value) {
  const artwork = resolveChatArtwork(value);
  const image = $("customImage");
  image.dataset.artwork = artwork.isCustom ? "custom" : "default";
  image.alt = artwork.alt;
  image.hidden = false;
  if (image.getAttribute("src") !== artwork.src) image.src = artwork.src;
  $("imagePlaceholder").hidden = true;
  $("imageActions").hidden = false;
  $("removeImageButton").hidden = !artwork.isCustom;
  $("imagePreview").classList.add("has-image");
  $("imagePreview").classList.toggle("is-default", !artwork.isCustom);
  $("imageCornerLabel").textContent = artwork.isCustom
    ? "YOUR SPACE"
    : `MEET ${CHAT_ASSISTANT.name.toUpperCase()}`;
  $("imageCaption").textContent = artwork.isCustom
    ? "Your image. Your inspiration. Your space."
    : `${CHAT_ASSISTANT.name} · Your AI assistant`;
}

async function uploadImage(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    return toast("Choose a PNG, JPEG, or WebP image.");
  if (file.size > 5 * 1024 * 1024)
    return toast("Choose an image smaller than 5 MB.");
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const data = canvas.toDataURL("image/webp", 0.82);
    showImage(data);
    try {
      localStorage.setItem(IMAGE_KEY, data);
      toast("Your space, personalized. Image saved in this browser.");
    } catch {
      toast(
        "Image added for this visit. Browser storage is full or unavailable.",
      );
    }
  } catch {
    toast("We couldn't open that image. Try another PNG, JPEG, or WebP.");
  }
}

function syncDrawerAccessibility() {
  const panels = [
    [$("historyPanel"), historyMedia.matches],
    [$("chatSettingsPanel"), settingsMedia.matches],
  ];
  for (const [panel, mobile] of panels) {
    const isOpen = drawer?.panel === panel;
    panel.inert = (mobile && !isOpen) || Boolean(drawer && !isOpen);
    if (mobile && !isOpen) panel.setAttribute("aria-hidden", "true");
    else panel.removeAttribute("aria-hidden");
  }
  $("conversationMain").inert = Boolean(drawer);
  document.querySelector(".workspace-header").inert = Boolean(drawer);
  $("historyToggle").setAttribute(
    "aria-expanded",
    String(drawer?.panel === $("historyPanel")),
  );
  $("chatSettingsToggle").setAttribute(
    "aria-expanded",
    String(drawer?.panel === $("chatSettingsPanel")),
  );
}

function openDrawer(panel, trigger) {
  if (drawer?.panel === panel) return closeDrawer();
  if (drawer) closeDrawer(false);
  drawer = { panel, trigger };
  panel.classList.add("is-open");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  $("sidebarBackdrop").hidden = false;
  syncDrawerAccessibility();
  panel.querySelector("[data-close-drawer]").focus();
}

function closeDrawer(restoreFocus = true) {
  if (!drawer) return;
  const { panel, trigger } = drawer;
  drawer = null;
  panel.classList.remove("is-open");
  panel.removeAttribute("role");
  panel.removeAttribute("aria-modal");
  $("sidebarBackdrop").hidden = true;
  syncDrawerAccessibility();
  if (restoreFocus) trigger?.focus({ preventScroll: true });
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    if (drawer && !document.querySelector("dialog[open]")) closeDrawer();
    $("conversationMenu").open = false;
  }
  if (drawer && event.key === "Tab") {
    const focusable = [
      ...drawer.panel.querySelectorAll(
        'button:not(:disabled),a[href],input,select,textarea,[tabindex="0"]',
      ),
    ].filter(
      (node) =>
        !node.hidden && node.getClientRects().length && node.tabIndex >= 0,
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === drawer.panel)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "k" &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    if (historyMedia.matches) openDrawer($("historyPanel"), $("historyToggle"));
    $("searchChats").focus();
  }
  // Alt+N avoids overriding the browser's native new-window shortcut.
  if (
    event.altKey &&
    event.key.toLowerCase() === "n" &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    newConversation();
  }
}

$("composerForm").addEventListener("submit", submitMessage);
$("messageInput").addEventListener("input", () => {
  current.draft = $("messageInput").value;
  updateComposer();
  persistSoon();
});
$("messageInput").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.isComposing &&
    !event.shiftKey &&
    (current.settings.enterToSend || event.ctrlKey || event.metaKey)
  ) {
    event.preventDefault();
    if (!pending) submitMessage();
  }
});
$("newChatButton").addEventListener("click", newConversation);
$("searchChats").addEventListener("input", renderHistory);
document
  .querySelectorAll("[data-example]")
  .forEach((button) =>
    button.addEventListener("click", () => openExample(button.dataset.example)),
  );
document.querySelectorAll("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;
    current.draft = button.dataset.prompt;
    updateComposer();
    persistSoon();
    $("messageInput").focus();
  }),
);
$("retryButton").addEventListener("click", () =>
  requestReply(current.messages.at(-1)?.role === "assistant"),
);
$("chatModel").addEventListener("change", (event) =>
  updateSettings({ modelKey: event.target.value }),
);
document
  .querySelectorAll("[name=responseStyle]")
  .forEach((input) =>
    input.addEventListener("change", (event) =>
      updateSettings({ style: event.target.value }),
    ),
  );
$("creativity").addEventListener("input", (event) =>
  updateSettings({ temperature: Number(event.target.value) }),
);
$("rememberContext").addEventListener("change", (event) =>
  updateSettings({ context: event.target.checked }),
);
$("enterToSend").addEventListener("change", (event) =>
  updateSettings({ enterToSend: event.target.checked }),
);
$("resetSettingsButton").addEventListener("click", () => {
  updateSettings(DEFAULT_SETTINGS);
  toast("Chat settings reset to defaults.");
});
$("renameChatButton").addEventListener("click", () => {
  $("conversationMenu").open = false;
  $("renameInput").value = current.title;
  $("renameDialog").showModal();
  $("renameInput").select();
});
$("renameForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("renameInput").value.trim();
  if (!title) return $("renameInput").focus();
  current.title = title.slice(0, 80);
  persist();
  renderHistory();
  renderConversation({ scroll: false });
  $("renameDialog").close();
  toast("Conversation renamed.");
});
$("cancelRenameButton").addEventListener("click", () =>
  $("renameDialog").close(),
);
$("deleteChatButton").addEventListener("click", () =>
  confirmDelete(current.id),
);
$("deleteDialog").addEventListener("close", deleteConfirmedChat);
$("exportChatButton").addEventListener("click", exportChat);
[$("uploadImageButton"), $("changeImageButton")].forEach((button) =>
  button.addEventListener("click", () => $("imageInput").click()),
);
$("imageInput").addEventListener("change", uploadImage);
$("removeImageButton").addEventListener("click", () => {
  showImage("");
  try {
    localStorage.removeItem(IMAGE_KEY);
    toast(`${CHAT_ASSISTANT.name}’s portrait restored.`);
  } catch {
    toast(
      `${CHAT_ASSISTANT.name}’s portrait restored for this visit; browser storage is unavailable.`,
    );
  }
});
$("customImage").addEventListener("error", () => {
  if ($("customImage").dataset.artwork === "custom") {
    showImage("");
    toast(
      `Your saved image couldn't load. Showing ${CHAT_ASSISTANT.name}’s portrait instead.`,
    );
    return;
  }
  // Do not repeatedly request an unavailable default image.
  $("customImage").hidden = true;
  $("customImage").removeAttribute("src");
  $("imagePlaceholder").hidden = false;
  $("imageActions").hidden = true;
  $("imagePreview").classList.remove("has-image");
});
$("historyToggle").addEventListener("click", () =>
  openDrawer($("historyPanel"), $("historyToggle")),
);
$("chatSettingsToggle").addEventListener("click", () =>
  openDrawer($("chatSettingsPanel"), $("chatSettingsToggle")),
);
document
  .querySelectorAll("[data-close-drawer]")
  .forEach((button) => button.addEventListener("click", () => closeDrawer()));
$("sidebarBackdrop").addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", handleKeydown);
document.addEventListener("click", (event) => {
  if (!$("conversationMenu").contains(event.target))
    $("conversationMenu").open = false;
});
[historyMedia, settingsMedia].forEach((media) =>
  media.addEventListener("change", () => {
    if (
      drawer &&
      ((drawer.panel === $("historyPanel") && !historyMedia.matches) ||
        (drawer.panel === $("chatSettingsPanel") && !settingsMedia.matches))
    )
      closeDrawer(false);
    syncDrawerAccessibility();
  }),
);
window.addEventListener("pagehide", persist);

try {
  showImage(localStorage.getItem(IMAGE_KEY));
} catch {
  showImage("");
}
// The initial HTML image may have failed before the module attached its listener.
if ($("customImage").complete && !$("customImage").naturalWidth) {
  $("customImage").dispatchEvent(new Event("error"));
}
$("messageInput").value = current.draft || "";
$("searchShortcut").textContent = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘ K"
  : "Ctrl K";
$("newChatButton").querySelector("kbd").textContent = "Alt N";
if (current.messages.at(-1)?.role === "user" && !current.error)
  current.error =
    "This message is waiting for a response. Try again to continue.";
renderHistory();
renderSettings();
renderConversation();
syncDrawerAccessibility();
loadConfiguration();
