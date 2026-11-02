const analysisService = import("../lib/analysis-service.mjs");
const { getAdminSettings, getFirestore } = require("../lib/firebase-admin");

const DEFAULT_BASE = "https://aurum-quant-edge.aurum-quant-ai.workers.dev";

module.exports = async function handler(req, res) {
  const cronAuth = process.env.CRON_SECRET || "";
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const isCronCall = req.headers["x-vercel-cron"] === "1";
  if (cronAuth && !isCronCall && provided !== cronAuth) {
    res.status(401).json({ message: "Unauthorized." });
    return;
  }

  try {
    const settings = (await getAdminSettings()) || {};
    const { completeAnalysis } = await analysisService;

    const timeframe = "15min";
    const baseUrl = process.env.AUTO_ANALYZE_BASE_URL || DEFAULT_BASE;
    const marketResp = await fetch(`${baseUrl}/market-mtf?entryTf=${encodeURIComponent(timeframe)}&outputsize=240&symbol=XAU_USD`);
    const marketData = await marketResp.json().catch(() => ({}));
    const entryValues = marketData.data?.find?.(entry => entry.id === "entry")?.values || marketData.values;
    if (!marketResp.ok || !Array.isArray(entryValues) || entryValues.length < 50) {
      throw new Error(marketData?.message || `Market data failed (${marketResp.status}).`);
    }

    const candles = entryValues.map((row) => ({
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      datetime: row.datetime,
    })).sort((a, b) => new Date(a.datetime) - new Date(b.datetime)).slice(-240);
    const closes = candles.map((c) => c.close);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const last = candles[candles.length - 1];
    const trend = last.close > sma20 && sma20 > sma50 ? "bullish" : last.close < sma20 && sma20 < sma50 ? "bearish" : "neutral";
    const high60 = Math.max(...candles.slice(-60).map((c) => c.high));
    const low60 = Math.min(...candles.slice(-60).map((c) => c.low));

    const prompt = [
      "Symbol: XAU/USD",
      `Timeframe: ${timeframe}`,
      `Price: ${last.close}`,
      `Trend: ${trend}`,
      `SMA20: ${sma20}`,
      `SMA50: ${sma50}`,
      `Range60: ${low60}-${high60}`,
      "Return only concise trade summary with headings: Summary, Direction, Entry Zone, Invalidation, Risk Note.",
    ].join("\n");

    const aiData = await completeAnalysis({
      selectedModelKey: settings.defaultModelKey || "",
      temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.2,
      debateMode: "fast", prompt,
    }, settings, process.env);

    const aiText = extractAiText(aiData);
    const entry = {
      id: `auto-${Date.now()}`,
      title: formatTimestamp(new Date()),
      timestampIso: new Date().toISOString(),
      deviceId: "system:auto-analyze",
      deviceLabel: "Automated scheduler",
      timeframe,
      price: String(last.close),
      summary: [
        `Market Regime: ${trend}`,
        `Signal Confidence: auto`,
        `Risk Profile: auto`,
        "Session State: auto",
      ],
      executionOverview: [
        "Primary bias from automated run.",
        `SMA20=${sma20} SMA50=${sma50}`,
        `Range60=${low60}-${high60}`,
      ],
      aiOverlay: aiText,
      source: "auto",
      createdAt: Date.now(),
    };

    const db = getFirestore();
    await db.collection("analysis_history").add(entry);

    // Trigger autonomous post-mortem learning pass after saving a new automated signal.
    const cronSecret = process.env.CRON_SECRET || "";
    fetch(`${baseUrl}/auto-learn`, {
      method: "POST",
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
    }).catch(() => {});

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, saved: true, model: aiData.model });
  } catch (error) {
    res.status(502).json({ message: error?.message || "Auto analysis failed." });
  }
};

function normalizeNvidiaKeyPool(listValue, legacyValue) {
  const list = Array.isArray(listValue) ? listValue : [];
  const combined = [...list, legacyValue].map((item) => String(item || "").trim()).filter(Boolean);
  const unique = [];
  for (const key of combined) {
    if (!key.toLowerCase().startsWith("nvapi-")) continue;
    if (!unique.includes(key)) unique.push(key);
  }
  return unique;
}

function pickRandomNvidiaKey(pool) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "";
  }
  const idx = Math.floor(Math.random() * pool.length);
  return String(pool[idx] || "").trim();
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return Number.NaN;
  const window = values.slice(-period);
  return Number((window.reduce((a, b) => a + Number(b || 0), 0) / period).toFixed(5));
}

function extractAiText(payload) {
  return String(payload?.choices?.[0]?.message?.content || payload?.output?.[0]?.content?.[0]?.text || payload?.text || "").trim();
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}
