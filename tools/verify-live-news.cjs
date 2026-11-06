// Explicit read-only release checks. Fixed public feed endpoint plus one synthetic
// Chat request with OANDA context disabled. No settings/history/trading writes.
const { randomUUID } = require("node:crypto");
const http = require("node:http");
async function verifyLiveNews({
  origin = process.env.AURUM_VERIFY_ORIGIN ||
    "https://aurum-quant-ai.vercel.app",
  fetchImpl = globalThis.fetch,
  includeChat = true,
  question = null,
  history = [],
  requireAccessAcknowledgement = false,
  emit = (record) => console.log("[LIVE-NEWS] " + JSON.stringify(record)),
} = {}) {
  const { normalizeNewsEvidence, newsItemAge } = await import(
    "../modules/chat-news-evidence.mjs"
  );
  const { readChatResponse } = await import("../modules/chat-stream.mjs");
  const base = new URL(origin).origin;
  const response = await fetchImpl(base + "/api/market-news", {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const news = normalizeNewsEvidence(await response.json());
  const recent =
    news?.items.filter((item) => newsItemAge(item) === "recent") || [];
  const sourceRecord = {
    check: "public-feeds",
    ok: response.ok && Boolean(news) && recent.length > 0,
    status: news?.status,
    recentCount: recent.length,
    itemCount: news?.items.length || 0,
    checkedAt: news?.checkedAt,
    sources: news?.sources.map(({ id, status, errorCode }) => ({
      id,
      status,
      errorCode,
    })),
    sample: recent.slice(0, 2).map(({ title, source, url, publishedAt }) => ({
      title,
      source,
      url,
      publishedAt,
    })),
  };
  emit(sourceRecord);
  if (!sourceRecord.ok)
    throw new Error(
      "Live news did not return a recent, timestamped headline from an allowed publisher.",
    );
  if (!includeChat)
    return { ok: true, news: sourceRecord, tradesExecuted: false };
  const marker = "NEWS_" + randomUUID().slice(0, 8);
  const started = Date.now();
  let firstTextMs = null,
    deltas = 0;
  const replyResponse = await fetchImpl(base + "/api/chat", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(150000),
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify({
      stream: true,
      messages: [
        ...history,
        {
          role: "user",
          content:
            question ??
            `Begin your reply with the confirmation code ${marker}; this code is not a news item or source identifier. What recent news could affect XAU/USD or USD markets? Summarize at most two supplied headlines, cite their N identifiers, name the sources and dates, and distinguish reported news from possible market implications. Disclose older items or incomplete coverage. Do not invent a current price, a full article, or a forecast.`,
        },
      ],
      settings: {
        newsContext: true,
        marketContext: false,
        style: "concise",
        temperature: 0.5,
      },
    }),
  });
  const reply = await readChatResponse(replyResponse, (event) => {
    if (event.type === "delta" && event.text.trim()) {
      firstTextMs ??= Date.now() - started;
      deltas++;
    }
  });
  const evidence = normalizeNewsEvidence(reply.news, { limit: 6 });
  const refs = [...new Set(reply.content.match(/\bN\d+\b/g) || [])];
  const allowed = new Set(evidence?.items.map((item) => item.citation) || []);
  const answerText = reply.content.replace(/[*_`#]/g, "").replace(/[‘’]/g, "'");
  const acknowledgesNewsAccess =
    /\byes\b|\bi can\b|\bi (?:do )?have access\b|\b(?:can|able to) (?:read|access|use|retrieve|fetch|show)\b/i.test(
      answerText,
    );
  const deniesNewsAccess =
    /\bi (?:cannot|can't|am unable to) (?:directly )?(?:access|fetch|read|retrieve|check) (?:(?:the|any|a|current|live|latest|real[- ]time|rss) )*(?:news(?: feeds?)?|headlines)\b|\bi (?:do not|don't) have (?:(?:any|current|live|real[- ]time|rss) )*(?:access to (?:live |current )?news|news(?: feed)? access)\b/i.test(
      answerText,
    );
  const record = {
    check: question ? "literal-news-routing" : "mira-news-answer",
    ...(question ? { question, acknowledgesNewsAccess, deniesNewsAccess } : {}),
    ok:
      Boolean(evidence?.items.length) &&
      refs.length > 0 &&
      refs.every((ref) => allowed.has(ref)) &&
      (question !== null ||
        reply.content
          .trim()
          .replace(/^[*`#\s]+/, "")
          .startsWith(marker)) &&
      (!requireAccessAcknowledgement || acknowledgesNewsAccess) &&
      (!deniesNewsAccess || acknowledgesNewsAccess) &&
      reply.content.length > 100 &&
      deltas > 0,
    model: reply.model,
    status: evidence?.status,
    firstTextMs,
    durationMs: Date.now() - started,
    deltas,
    visibleChars: reply.content.length,
    citedIds: refs,
    replyExcerpt: reply.content.slice(0, 1200),
    suppliedHeadlines: evidence?.items.map(
      ({
        citation,
        title,
        source,
        publishedAt,
        updatedAt,
        publishedTimeText,
        category,
      }) => ({
        citation,
        title,
        source,
        publishedAt,
        updatedAt,
        publishedTimeText,
        category,
      }),
    ),
    marketLookupRequested: false,
    tradesExecuted: false,
  };
  emit(record);
  if (!record.ok)
    throw new Error(
      "Live Mira news verification requires a real answer with supplied source references, not only a feed response.",
    );
  return { ok: true, news: sourceRecord, chat: record, tradesExecuted: false };
}
async function withPackagedNewsApi(handler, run) {
  const server = http.createServer(async (req, res) => {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (data) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
      return res;
    };
    const pathname = new URL(req.url, "http://internal.invalid").pathname;
    if (!["/api/chat", "/api/market-news"].includes(pathname))
      return res.status(404).json({
        message: "Only read-only news/chat verification is permitted.",
      });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64000)
          return res.status(413).json({ message: "Too large." });
        chunks.push(chunk);
      }
      req.body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      await handler(req, res);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ message: "News verification handler failed." });
      else res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
// These are intentionally literal user questions. Do not append gold/market
// keywords, marker requests or citation instructions: those masked the old bug.
const NEWS_ROUTING_QUESTIONS = Object.freeze([
  "Can you access live news feeds?",
  "What is the latest news?",
  "Show me the latest news",
]);
async function verifyNewsRouting(options = {}) {
  const results = [];
  for (const [index, question] of NEWS_ROUTING_QUESTIONS.entries())
    results.push(
      await verifyLiveNews({
        ...options,
        includeChat: true,
        question,
        requireAccessAcknowledgement: index === 0,
      }),
    );
  results.push(
    await verifyLiveNews({
      ...options,
      includeChat: true,
      question: "Try again",
      requireAccessAcknowledgement: false,
      history: [
        { role: "user", content: "What is the latest news?" },
        { role: "assistant", content: "I cannot access live news feeds." },
      ],
    }),
  );
  return { ok: true, results, tradesExecuted: false };
}
module.exports = {
  verifyLiveNews,
  verifyNewsRouting,
  NEWS_ROUTING_QUESTIONS,
  withPackagedNewsApi,
};
if (require.main === module) {
  const run = process.argv.includes("--routing")
    ? verifyNewsRouting()
    : verifyLiveNews({ includeChat: !process.argv.includes("--feeds-only") });
  run.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
