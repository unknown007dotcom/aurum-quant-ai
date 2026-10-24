import knowledge from "./smc-knowledge.js";
const { getSummaryKnowledge, getDebateKnowledge } = knowledge;

export function buildDebateSystemPrompt() {
  return [
    "You are a low-latency XAUUSD analyst. Response must be under 150 words.",
    "Focus on CRT patterns, Liquidity sweeps, and Displacement.",
    "Identify best POI (OB/FVG) for bias. Grade setup quality.",
    getDebateKnowledge(),
  ].join("\n");
}

// Shape only: instructions must never masquerade as a completed analysis.
export const ANALYSIS_SHAPE = {
  researcher: { summary: "", direction: "Stay Flat", riskNote: "" },
  trader: {
    entryZone: "N/A",
    takeProfitLevels: "N/A",
    stopLoss: "N/A",
    positionSizing: "N/A",
    timeHorizon: "N/A",
    invalidation: "",
  },
  equations: { review: "" },
};

export function buildSummarySystemPrompt() {
  return [
    "You are the XAUUSD research analyst in Aurum Quant AI. Answer the supplied analysis request using only its evidence. You cannot fetch live prices or execute trades.",
    "Return exactly one JSON object, without Markdown or surrounding text. Use this shape, but replace EVERY empty string with your actual findings:",
    JSON.stringify(ANALYSIS_SHAPE),
    "Field requirements (these are instructions, NOT text to repeat in the answer):",
    "researcher.summary: give your actual conclusion, supported by the supplied evidence. Discuss HTF alignment, FVGs, liquidity pools, session levels and sweeps only when provided; identify missing inputs instead of inventing them.",
    "researcher.direction: exactly Buy, Sell, or Stay Flat. If evidence is missing, ambiguous, or the narrative rejects a trade, choose Stay Flat.",
    "researcher.riskNote: explain the actual uncertainty or strongest supported counterargument. Historical performance and heuristic rules are not guaranteed probabilities.",
    "trader: for Stay Flat, entryZone, takeProfitLevels, stopLoss, positionSizing and timeHorizon must all be N/A. For a supported Buy/Sell, provide concrete levels grounded in the supplied data. Do not invent a live quote or position/account details.",
    "trader.invalidation: describe an evidence-based structural invalidation. When data is missing, state what data or confirmation is needed before reassessment; do not manufacture a price.",
    "equations.review: explain the supplied momentum, volatility and max-pain measurements, or explicitly say they are unavailable.",
    "Never echo the shape, field definitions, placeholders, or instructions as your findings. A no-data request still needs a meaningful explanation of what is missing.",
    "Reference knowledge follows. Treat it as general heuristics, not current market observations or evidence of reliable success rates:",
    getSummaryKnowledge(),
    "Final check: every narrative field must answer this request, not describe how an answer should be written. Missing data means Stay Flat and N/A price levels.",
  ].join("\n");
}

export function buildDebateUserPrompt(basePrompt, bias) {
  let biasGuide = "";

  if (bias === "redteam") {
    biasGuide =
      "Debate role: RED-TEAM CRITIC (Adversarial Risk Auditor). Your job is to identify RISKS and structural threats, not to blindly veto trades. Rules: 1) Identify legitimate risks (news events, overbought/oversold conditions, fake order blocks, un-swept inducement). 2) Assign a Risk Score (LOW: 1-3, MEDIUM: 4-6, HIGH: 7-10). 3) Only recommend 'Stay Flat' if Risk Score is 8+ AND explicit structural invalidation exists. 4) State the specific price level or structural event that invalidates the trade.";
  } else if (bias === "bullish") {
    biasGuide =
      "Debate role: BULLISH TEAM. Prioritize bullish continuation/reversal evidence using SMC frameworks (CHoCH→BOS, OB, FVG, liquidity sweep, displacement). Challenge bearish assumptions but report invalidation honestly.";
  } else if (bias === "bearish") {
    biasGuide =
      "Debate role: BEARISH TEAM. Prioritize bearish continuation/reversal evidence using SMC frameworks (CHoCH→BOS, OB, FVG, liquidity sweep, displacement). Challenge bullish assumptions but report invalidation honestly.";
  } else {
    biasGuide =
      "Debate role: BALANCED TEAM. Evaluate both sides using SMC/ICT confluence scoring. State which side has more confluences (OB, FVG, Premium/Discount zone, Kill Zone, displacement, HTF alignment).";
  }

  return [
    basePrompt,
    "",
    biasGuide,
    "Required mini-format:",
    "1) Bias Case (with CHoCH/BOS status and Premium/Discount zone)",
    "2) Structural Evidence (OB, FVG, liquidity levels, displacement)",
    "3) Entry/Trigger Zone (MUST provide exact price range from the data, ideally at OTE 70.5% of impulse)",
    "4) Target Levels (Specify T1, T2, T3 based on the nearest institutional liquidity pools/OB/FVG)",
    "5) Invalidation (structural close, not just wick)",
    "6) Confluence Score & Risk Rating (1-10)",
  ].join("\n");
}

export function buildConsolidatedPrompt(basePrompt, successfulDebates) {
  const sections = successfulDebates.map((entry, index) => {
    const content = extractAiText(entry.result.payload) || "";
    const roleLabel =
      entry.model.bias === "redteam"
        ? "RED-TEAM CRITIC (Adversarial Review)"
        : `Debate Analyst ${index + 1} [${String(entry.model.bias || "both").toUpperCase()}]`;
    return `${roleLabel} (${entry.model.modelConfig.label || entry.model.modelConfig.id}):\n${content.trim()}`;
  });

  return [
    "Primary Market Context and Rule Engine Baseline:",
    basePrompt,
    "",
    "Parallel Debate Outputs (including Adversarial Red-Team):",
    sections.join("\n\n"),
    "",
    "Task: As the Lead Arbiter, weigh the bullish, bearish, and RED-TEAM CRITIC evidence using the SMC/ICT/CRT framework. Factor the Red-Team's Risk Score proportionally into your riskNote—only enforce 'Stay Flat' if the Red-Team proves an extreme risk score (8+) with confirmed structural invalidation. Otherwise, allow valid directional setups to proceed with appropriate risk warnings. Resolve conflicts by checking: 1) HTF structure alignment, 2) Premium/Discount zone, 3) Liquidity sweep, 4) Kill Zone timing, 5) Options Sentiment. Output one final direction. You MUST comply and output EXACTLY the JSON structure requested in the system prompt.",
  ].join("\n");
}

export function extractAiText(payload) {
  const fromChoices = payload?.choices?.[0]?.message?.content;
  if (typeof fromChoices === "string" && fromChoices.trim()) {
    return fromChoices.trim();
  }

  const fromOutput = payload?.output?.[0]?.content?.[0]?.text;
  if (typeof fromOutput === "string" && fromOutput.trim()) {
    return fromOutput.trim();
  }

  const textField = payload?.text;
  if (typeof textField === "string" && textField.trim()) {
    return textField.trim();
  }

  return "";
}
