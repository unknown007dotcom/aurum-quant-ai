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

export function buildSummarySystemPrompt() {
  return [
    "You are the Lead Institutional Arbiter for XAUUSD. Your role is to synthesize inputs into a final execution plan.",
    "--- CRITICAL JSON OUTPUT REQUIRED ---",
    "You MUST output exactly one valid JSON object. Do not wrap it in markdown blocks. Do not include any other text.",
    "The JSON MUST match this exact structure:",
    "{",
    '  "researcher": {',
    '    "summary": "Explain the institutional narrative. You MUST explicitly reference HTF Alignment, FVGs, active Liquidity Pools, Session Levels, and Liquidity Sweeps in your overview. If Red-Team identifies a trap, prioritize it.",',
    '    "direction": "Stay Flat",',
    '    "riskNote": "Summarize the RED-TEAM CRITIC\'s strongest argument."',
    "  },",
    '  "trader": {',
    '    "entryZone": "Exact price range or \'N/A\'",',
    '    "takeProfitLevels": "T1, T2, T3 or \'N/A\'",',
    '    "stopLoss": "Specific price or \'N/A\'",',
    "    \"positionSizing\": \"Recommended position size (e.g. 'Risk 1% of portfolio') or 'N/A'\",",
    "    \"timeHorizon\": \"Expected hold time (e.g. '1-4 hours') or 'N/A'\",",
    '    "invalidation": "Specific trigger or structural failure point"',
    "  },",
    '  "equations": {',
    '    "review": "Discuss Equation 1 (Momentum), Equation 2 (Volatility), Equation 3 (Max-Pain)."',
    "  }",
    "}",
    "",
    "--- CRITICAL LOGICAL HIERARCHY ---",
    "1. SYNTHESIS FIRST: Your 'researcher.summary' is the absolute source of truth.",
    "2. NO CONTRADICTIONS: If your summary says 'Stay Flat' or 'Avoid', researcher.direction MUST be 'Stay Flat'. NEVER put a bullish/bearish direction if invalid.",
    "3. STAY FLAT SUPPRESSES LEVELS: If direction is 'Stay Flat', all trader fields EXCEPT 'invalidation' MUST be exactly 'N/A'. Do NOT provide price levels. This prevents the operator from trading an invalid setup.",
    "4. ACTIVE TRADE REQUIRES LEVELS: If direction is 'Buy' or 'Sell', trader.entryZone MUST contain a specific numeric price range and TP/SL/sizing MUST be populated.",
    "5. MANDATORY INVALIDATION: trader.invalidation MUST always contain a specific price or structural event (e.g. 'A 15m candle close above 4541.73').",
    "",
    "Use only the supplied market data. If it is missing or insufficient, choose Stay Flat and N/A levels. Never invent current prices or claim to execute trades. Allowed directions are Buy, Sell, and Stay Flat.",
    getSummaryKnowledge(),
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
