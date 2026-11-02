const assert = require("node:assert/strict");
const MARKET_URL =
  "https://aurum-quant-edge.aurum-quant-ai.workers.dev/market-mtf?symbol=XAU_USD&entryTf=15min&outputsize=256";

// Explicit build/verifier probe, not a new request in the application's hot path.
// This endpoint is the terminal's existing read-only market-data source.
async function liveTerminalRequest(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(MARKET_URL, {
    signal: AbortSignal.timeout(25000),
  });
  assert.equal(
    response.status,
    200,
    "The terminal market feed did not respond",
  );
  const market = await response.json();
  const { AnalysisEngine } = require("../modules/analysis-engine.js");
  const { buildTerminalSkillInput } = await import(
    "../modules/terminal-analysis-skills.mjs"
  );
  const entry = Array.isArray(market?.data)
    ? market.data.find((item) => item?.id === "entry")
    : null;
  const candles = AnalysisEngine.normalizeCandles(entry?.values);
  assert.ok(
    candles.length >= 15,
    "Not enough market candles for the packaged research check",
  );
  // This packaged check deliberately supplies no entry/stop/target strategy.
  // The separate browser verifier exercises the actual main-page rule engine.
  const baseline = {
    price: candles.at(-1).close,
    rmi: { value: AnalysisEngine.calculateRMI(candles) },
  };
  const terminalSkills = buildTerminalSkillInput(baseline, market, {
    timeframe: "15min",
    instrument: "XAU_USD",
  });
  assert.ok(
    terminalSkills.candles.length >= 15,
    "Not enough genuine feed candles for an ATR check",
  );
  return {
    debateMode: "fast",
    temperature: 0,
    prompt: [
      "Read-only terminal research verification. Analyze the supplied XAU/USD market snapshot; do not execute any order. Keep the system's JSON response shape.",
      "The attached terminal research context includes a bounded candle window. Use the calculated quality/volatility findings and describe any limitations. No entry/stop/target strategy is supplied in this quality-only probe; do not invent trade levels, account details or a backtest.",
      JSON.stringify({
        timeframe: "15min",
        price: baseline.price,
        trend: baseline.trend,
        rmi: baseline.rmi,
        htfAlignment: baseline.htfAlignment,
        referencePlan: baseline.decision,
      }),
    ].join("\n"),
    terminalSkills,
  };
}

async function assertTerminalSkillsReply(payload) {
  const { structuredAnswer } = await import("../lib/analysis-service.mjs");
  assert.equal(payload.aiUsed, true, payload.message || "No actual AI answer");
  assert.equal(payload.fallbackUsed, false);
  const plan = JSON.parse(
    structuredAnswer(payload.choices?.[0]?.message?.content),
  );
  const report = payload.analysisSkills;
  assert.equal(report?.researchOnly, true);
  assert.equal(report.usedInPrompt, true);
  assert.ok(report.quality.usable >= 15 && report.quality.usable <= 256);
  assert.ok(
    Number.isFinite(report.volatility.atr14) && report.volatility.atr14 >= 0,
  );
  assert.equal(report.validation.status, "not_run");
  assert.equal(
    report.source.revision,
    "981e1d736cdc02bdc1c55c74ec9224e956414706",
  );
  assert.equal(report.skillIds.length, 5);
  return {
    model: payload.model,
    aiUsed: true,
    usedInPrompt: true,
    researchOnly: true,
    reviewedCandles: report.quality.usable,
    lastCandleAt: report.quality.lastCandleAt,
    freshness: report.quality.freshness,
    issues: report.quality.issues,
    atr14: report.volatility.atr14,
    validation: "not_run",
    summary: plan.researcher.summary.slice(0, 500),
    timings: payload.timings,
    sourceRevision: report.source.revision,
    tradesExecuted: false,
  };
}
module.exports = { liveTerminalRequest, assertTerminalSkillsReply };
