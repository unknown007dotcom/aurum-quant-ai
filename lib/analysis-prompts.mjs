import knowledge from "./smc-knowledge.js";
const { getSummaryKnowledge, getDebateKnowledge } = knowledge;

export function buildDebateSystemPrompt() {
  return [
    "You are one participant in an XAUUSD research council, not the final arbiter. Give an independent, concise review in at most 100 words.",
    "Use only the supplied market evidence. If evidence is missing, say what is missing and choose WAIT. Never invent prices, live data, certainty, or executed orders.",
    "The supplied context may request a final JSON report; that instruction is for a different stage. Your response here must be plain text: case, counter-risk, then a final line exactly Verdict: BUY, Verdict: SELL, or Verdict: WAIT.",
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
  const roles = {
    bullish:
      "BULLISH: examine the strongest supported long case, but reject it if confirmation is missing. Do not assume a buy just because of your assigned perspective.",
    bearish:
      "BEARISH: examine the strongest supported short case, but reject it if confirmation is missing. Do not assume a sell just because of your assigned perspective.",
    redteam:
      "RED-TEAM: audit missing evidence, contradictions, traps and invalidation. Explain the strongest concrete risk without inventing events or overriding evidence arbitrarily.",
    both: "BALANCED: compare the supported long and short evidence and identify the decisive confirmation or uncertainty.",
  };
  return [
    "Supplied market context:",
    basePrompt,
    "",
    `Your review perspective: ${roles[bias] || roles.both}`,
    "Give the case and its counter-risk in at most 100 words. Use exact levels only if the supplied evidence supports them; otherwise use N/A. End with Verdict: BUY, Verdict: SELL, or Verdict: WAIT.",
  ].join("\n");
}

export function buildConsolidatedPrompt(basePrompt, successfulDebates) {
  const sections = successfulDebates.map((entry, index) => {
    const content =
      entry.result.content || extractAiText(entry.result.payload) || "";
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
    `These are ${successfulDebates.length} perspectives from ${new Set(successfulDebates.map((entry) => entry.model.modelConfig.id)).size} distinct model(s). Shared-model perspectives are NOT independent model votes; do not inflate confidence from their count.`,
    sections.join("\n\n"),
    "",
    "Task: As the Lead Arbiter, weigh the bullish, bearish, and RED-TEAM CRITIC evidence using the SMC/ICT/CRT framework. Treat participant reviews as arguments, not new facts. Check their claims against the primary evidence. Missing or contradictory evidence supports Stay Flat; never force a directional trade because of the role assignments or a numerical vote count. Resolve conflicts by checking: 1) HTF structure alignment, 2) Premium/Discount zone, 3) Liquidity sweep, 4) Kill Zone timing, 5) Options Sentiment. Output one final direction. You MUST comply and output EXACTLY the JSON structure requested in the system prompt.",
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
