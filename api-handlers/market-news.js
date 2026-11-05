const newsService = import("../lib/market-news.mjs");

// Public read-only headlines. This route never loads protected AI/broker settings.
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed." });
  }
  if (Object.keys(req.query || {}).length) {
    return res
      .status(400)
      .json({
        message: "This feed does not accept search queries or source URLs.",
      });
  }
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
  try {
    const { getMarketNews } = await newsService;
    return res.status(200).json(await getMarketNews());
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(503)
      .json({
        type: "market_news",
        readOnly: true,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        items: [],
        sources: [],
      });
  }
};
