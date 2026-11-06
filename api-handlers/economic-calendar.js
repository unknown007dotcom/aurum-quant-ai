const calendarService = import("../lib/economic-calendar.mjs");

// Public read-only upcoming events (economic calendar). This route never loads
// protected AI/broker settings and never accepts client URLs or queries.
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
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300");
  try {
    const { getUpcomingEvents } = await calendarService;
    return res.status(200).json(await getUpcomingEvents());
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(503)
      .json({
        type: "economic_calendar",
        readOnly: true,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        events: [],
        sources: [],
      });
  }
};
