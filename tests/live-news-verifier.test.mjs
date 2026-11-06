import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { verifyLiveNews, withPackagedNewsApi } = createRequire(import.meta.url)(
  "../tools/verify-live-news.cjs",
);
const feed = () => ({
  type: "market_news",
  readOnly: true,
  status: "available",
  checkedAt: new Date().toISOString(),
  items: [
    {
      id: "fixture",
      sourceId: "investing-commodities",
      title: "Gold and the dollar: test headline",
      url: "https://www.investing.com/news/commodities-news/test",
      publishedAt: new Date(Date.now() - 10000).toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  ],
  sources: [
    {
      id: "investing-commodities",
      status: "ok",
      checkedAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  ],
});
const event = (name, data) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

test("live news verification uses only read-only news/chat routes with no broker lookup or credential payload", async () => {
  const records = [],
    requests = [];
  const result = await verifyLiveNews({
    origin: "https://app.example",
    emit: (record) => records.push(record),
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      if (url.endsWith("/api/market-news")) return Response.json(feed());
      assert.equal(url, "https://app.example/api/chat");
      const body = JSON.parse(options.body);
      assert.equal(body.settings.marketContext, false);
      assert.equal(body.settings.newsContext, true);
      assert.equal(body.stream, true);
      assert.equal(options.headers.Authorization, undefined);
      const marker = body.messages[0].content.match(/NEWS_[a-f0-9]+/)[0];
      const news = feed();
      news.items[0].citation = "N1";
      const content = `${marker}. The supplied test headline reports news about gold and the dollar [N1]. Its possible market implications are uncertain, and this is not a current price or trading signal.`;
      return new Response(
        event("start", { model: "test", news }) +
          event("delta", { text: content }) +
          event("done", { model: "test", content, news }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.tradesExecuted, false);
  assert.equal(records[1].citedIds[0], "N1");
  assert.equal(requests.length, 2);
});

test("a successful HTTP response containing placeholders, stale items or untrusted URLs is not live-news success", async () => {
  for (const payload of [
    { news: [{ event: "CPI", time: "12:30 GMT" }] },
    { ...feed(), items: [] },
    {
      ...feed(),
      items: [{ ...feed().items[0], publishedAt: "2020-01-01T00:00:00Z" }],
    },
    { ...feed(), items: [{ ...feed().items[0], url: "https://evil.example" }] },
  ]) {
    await assert.rejects(
      verifyLiveNews({
        origin: "https://app.example",
        includeChat: false,
        emit() {},
        fetchImpl: async () => Response.json(payload),
      }),
      /recent, timestamped/,
    );
  }
});

test("AI prose without supplied source evidence/references cannot pass the live news gate", async () => {
  await assert.rejects(
    verifyLiveNews({
      origin: "https://app.example",
      emit() {},
      fetchImpl: async (url) =>
        url.endsWith("/api/market-news")
          ? Response.json(feed())
          : Response.json({
              model: "test",
              content:
                "A generic statement about markets is not evidence of current news.",
            }),
    }),
    /real answer/,
  );
});

test("packaged news verification does not expose settings or trading endpoints", async () => {
  let calls = 0;
  await withPackagedNewsApi(
    async (req, res) => {
      calls++;
      res.json(feed());
    },
    async (origin) => {
      assert.equal((await fetch(origin + "/api/settings")).status, 404);
      assert.equal(
        (await fetch(origin + "/api/bot", { method: "POST" })).status,
        404,
      );
      const result = await verifyLiveNews({
        origin,
        includeChat: false,
        emit() {},
      });
      assert.equal(result.ok, true);
    },
  );
  assert.equal(calls, 1);
});

test("routing verification sends the exact generic questions without market or marker hints", async () => {
  const { verifyNewsRouting, NEWS_ROUTING_QUESTIONS } = createRequire(
    import.meta.url,
  )("../tools/verify-live-news.cjs");
  const sent = [],
    records = [];
  const result = await verifyNewsRouting({
    origin: "https://app.example",
    emit: (record) => records.push(record),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/market-news")) return Response.json(feed());
      assert.equal(url, "https://app.example/api/chat");
      const body = JSON.parse(options.body);
      sent.push(body.messages.at(-1).content);
      if (sent.length <= NEWS_ROUTING_QUESTIONS.length)
        assert.deepEqual(body.messages, [
          { role: "user", content: NEWS_ROUTING_QUESTIONS[sent.length - 1] },
        ]);
      else
        assert.deepEqual(body.messages, [
          { role: "user", content: "What is the latest news?" },
          { role: "assistant", content: "I cannot access live news feeds." },
          { role: "user", content: "Try again" },
        ]);
      assert.equal(body.settings.newsContext, true);
      assert.equal(body.settings.marketContext, false);
      assert.equal(options.headers.Authorization, undefined);
      const news = feed();
      news.items[0].citation = "N1";
      const content =
        "Yes, I can read the curated RSS headlines supplied by Aurum. The provided gold/dollar headline [N1] is a report, not a verified current quote or a guaranteed price move.";
      return new Response(
        event("start", { model: "test", news }) +
          event("delta", { text: content }) +
          event("done", { model: "test", content, news }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [...NEWS_ROUTING_QUESTIONS, "Try again"]);
  assert.ok(
    records
      .filter((record) => record.check === "literal-news-routing")
      .every((record) => record.ok && record.acknowledgesNewsAccess),
  );
});

test("literal access verification rejects missing news evidence and blanket access denials", async () => {
  for (const attachNews of [false, true]) {
    await assert.rejects(
      verifyLiveNews({
        origin: "https://app.example",
        question: "Can you access live news feeds?",
        requireAccessAcknowledgement: true,
        emit() {},
        fetchImpl: async (url) => {
          if (url.endsWith("/api/market-news")) return Response.json(feed());
          const news = feed();
          news.items[0].citation = "N1";
          const content =
            "I cannot access live news feeds. Please check a publisher yourself for a current update; here is a source placeholder [N1] rather than a genuinely accessed news answer.";
          return new Response(
            event("delta", { text: content }) +
              event("done", {
                model: "test",
                content,
                ...(attachNews ? { news } : {}),
              }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      }),
      /real answer/,
    );
  }
});
