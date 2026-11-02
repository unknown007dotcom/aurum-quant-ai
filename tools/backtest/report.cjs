const fs = require("node:fs/promises");
const path = require("node:path");
const esc = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const cell = (text) =>
  String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
const fmt = (value, digits = 2) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "N/A";
function csvCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  let text = String(value ?? "");
  if (/^[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function csv(rows, columns) {
  return (
    "\uFEFF" +
    columns.join(",") +
    "\n" +
    rows
      .map((row) => columns.map((column) => csvCell(row[column])).join(","))
      .join("\n") +
    "\n"
  );
}
function ny(iso) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
function chart(curve) {
  const points = [{ netPnl: 0 }, ...curve];
  let min = Math.min(0, ...points.map((row) => row.netPnl)),
    max = Math.max(0, ...points.map((row) => row.netPnl));
  if (Math.abs(max - min) < 0.000001) {
    min = -0.5;
    max = 0.5;
  }
  const y = (n) => 205 - ((n - min) / (max - min)) * 170;
  const line = points
    .map(
      (row, i) =>
        `${50 + (i / Math.max(1, points.length - 1)) * 850},${y(row.netPnl)}`,
    )
    .join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 260" role="img" aria-label="Hypothetical profit and loss in USD per ounce, not account returns"><rect width="960" height="260" fill="#fff"/><line x1="50" y1="${y(0)}" x2="900" y2="${y(0)}" stroke="#cbd5e1"/><polyline points="${line}" fill="none" stroke="#b48530" stroke-width="3"/><g fill="#526072" font-family="sans-serif" font-size="13"><text x="50" y="20">$${fmt(max)} / oz</text><text x="50" y="235">$${fmt(min)} / oz</text><text x="400" y="255">23 Oct 2026 · New York session · M5 marks</text></g></svg>`;
}
async function writeArtifacts(output, manifest, decisions, result) {
  const base = result.scenarios.find((row) => row.id === "base");
  const evidence = (filename) =>
    manifest.artifactOrigin
      ? manifest.artifactOrigin + "/" + filename
      : filename;
  const summary = !result.fullDecisionCoverage
    ? `Incomplete AI coverage: ${result.answeredDecisions}/${result.expectedDecisions} checkpoints answered. Do not treat the P/L as a full-session strategy result.`
    : !base.closedTrades
      ? "No paper trades executed under the declared interpretation. Win rate, profit factor and expectancy cannot be estimated; this is not evidence of profitability."
      : `Under the declared base-case fills/costs, ${base.closedTrades} paper trades produced ${fmt(base.netUsdPerOunce)} USD per hypothetical ounce-equivalent. This single-session retrospective sample does not establish a profitable strategy.`;
  const scenarioRows = [...result.scenarios, result.lastTargetSensitivity];
  const coverageLines = Object.entries(result.categories)
    .map(([key, count]) => `- ${key}: **${count}**`)
    .join("\n");
  const metricsTable = [
    "| Scenario | Trades | Wins / losses | Net USD/oz | Sum net R | Max DD USD/oz | Profit factor |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
    ...scenarioRows.map(
      (row) =>
        `| ${row.id} | ${row.closedTrades} | ${row.wins} / ${row.losses} | ${fmt(row.netUsdPerOunce)} | ${fmt(row.sumNetR)} | ${fmt(row.maxDrawdownUsdPerOunce)} | ${fmt(row.profitFactor)} |`,
    ),
  ].join("\n");
  const signalRows = decisions.map((point) => ({
    index: point.index,
    asOfUtc: point.asOf,
    newYorkTime: ny(point.asOf),
    status: point.status,
    aiDirection: point.plan?.researcher?.direction || "",
    effectiveCategory: point.execution.category,
    ruleDirection: point.ruleDirection,
    referencePrice: point.referencePrice,
    entryLow: point.execution.entryLow,
    entryHigh: point.execution.entryHigh,
    stop: point.execution.stop,
    targets: point.execution.targets?.join(" / ") || "",
    reason: point.execution.reason,
    model: point.actualModel || "",
    calls: point.completionCalls,
    durationMs: point.durationMs,
    summary: point.plan?.researcher?.summary || point.error?.message || "",
  }));
  const decisionTable = [
    "| # | New York time | AI | Effective classification |",
    "| ---: | --- | --- | --- |",
    ...signalRows.map(
      (row) =>
        `| ${row.index} | ${row.newYorkTime} | ${cell(row.aiDirection || row.status)} | ${cell(row.effectiveCategory)} |`,
    ),
  ].join("\n");
  const tradeTable = base.trades.length
    ? [
        "| Trade | Decision NY | Direction | Entry UTC / price | Exit UTC / price | Exit | Net USD/oz | Net R |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
        ...base.trades.map(
          (row) =>
            `| ${row.id} | ${ny(row.decisionAt)} | ${row.direction} | ${row.entryTime} / ${fmt(row.entryPrice, 3)} | ${row.exitTime} / ${fmt(row.exitPrice, 3)} | ${row.exitReason}${row.ambiguous ? " (ordering uncertain)" : ""} | ${fmt(row.netUsdPerOunce)} | ${fmt(row.netR)} |`,
        ),
      ].join("\n")
    : "No filled paper trades in the base case.";
  const methods = Object.entries(manifest.assumptions)
    .map(([key, value]) => `- **${key}:** ${value}`)
    .join("\n");
  const markdown = `# Current-AI backtest: XAU/USD\n\n**Retrospective paper-plan replay — not live execution or a statistically validated strategy.**\n\nSession: **${manifest.session.label}**. Decision schedule: 34 M15 checkpoints. Completed: ${result.completedAt}.\n\n## Result\n\n${summary}\n\n### Coverage\n\n- Answered: **${result.answeredDecisions}/${result.expectedDecisions}**; attempted: ${result.attemptedDecisions}.\n- Real model completion requests: **${result.completionCalls}**; catalog reads: ${result.catalogReads}.\n- Mode: Fast debate + final analyst; temperature 0.2. No valid answer was rerolled based on its outcome.\n${coverageLines}\n${result.stoppedReason ? `\nStopped reason: ${result.stoppedReason}\n` : ""}\n## Cost and exit sensitivity\n\n${metricsTable}\n\nBase costs are an **assumed $1.00 bid/ask spread plus $0.10 slippage per fill per ounce**. Historical bid/ask spreads/depth were not available in the cache. The low-cost case assumes $0.50 / $0; stress assumes $2.00 / $0.20. The last-target case uses the base costs but the last supplied target. Changing spread can change which entries fill. These are predeclared sensitivities, not optimization.\n\n- P/L is normalized to **one hypothetical ounce-equivalent**, not your balance or actual OANDA account units.\n- “Price P/L” already incorporates the assumed spread; slippage is deducted separately.\n- Drawdown is M5 close-to-close marked-to-market; account-return percentages and annualized Sharpe are **N/A**.\n- ${base.ambiguousTrades} base-case trades have intrabar ordering uncertainty. Stops are prioritized; no same-entry-bar target is credited for an intrabar entry.\n\n## Base-case paper trade ledger\n\n${tradeTable}\n\n## Every scheduled AI evaluation\n\n${decisionTable}\n\nFull visible AI responses, research inputs/audits and per-call usage are in the companion JSON files${manifest.artifactOrigin ? ` at ${manifest.artifactOrigin}/report.html (Vercel access protection may require your login)` : ""}; no provider hidden-reasoning text or credentials is exported.\n\n## Method and limitations\n\n${methods}\n\nThis replays the current main analysis code, not the separate EMA/risk-offset automated bot. Existing preview-history win rates are not used: the current logger can record the rule-engine bias instead of the final AI decision and can fall back to rule-based levels.\n\n## Reproducibility\n\n- Source revision: \`${manifest.sourceCodeRevision || "working tree; see source hashes"}\`.\n- Main strategy file SHA-256: \`${manifest.sourceHashes["app.js"]}\`.\n- Market input SHA-256: \`${result.dataSha256}\`.\n- Public model configuration SHA-256: \`${manifest.modelConfigSha256}\`.\n- Reported token usage: ${result.tokenUsage.promptTokens} input, ${result.tokenUsage.completionTokens} output (${result.usageRecordsAvailable} responses supplied usage).\n- Files: \`manifest.json\`, \`market-data.json\`, \`decisions.json\`, \`provider-usage.json\`, \`result.json\`, \`signals.csv\`, \`trades.csv\`.\n\nNo orders, bot commands, account changes, production deploys, or live learning/history writes were performed.\n`;
  const svg = chart(base.curve);
  const tableHtml = (head, rows) =>
    `<div class="scroll"><table><thead><tr>${head.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;"><title>XAU/USD · Current-AI session replay</title><style>body{margin:0;background:#f3f5f8;color:#1c293b;font:15px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 22px}h1{font-size:35px;line-height:1.2}h2{margin-top:32px}.eyebrow{color:#896020;font-weight:650;letter-spacing:.08em}.notice{padding:18px 22px;background:#fff7e5;border-left:4px solid #bd903c;border-radius:8px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:24px 0}.card{background:white;padding:18px;border-radius:12px;border:1px solid #e0e5ec}.card strong{font-size:25px;display:block}.muted,small{color:#596678}.scroll{overflow:auto}table{border-collapse:collapse;background:white;width:100%;font-size:13px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e0e5ec;vertical-align:top}th{background:#eaf0f5;white-space:nowrap}a{color:#755416}svg{width:100%;height:auto;border:1px solid #e0e5ec;border-radius:12px}li{margin-bottom:9px}code{overflow-wrap:anywhere}footer{margin-top:35px;font-size:12px}</style></head><body><main><p class="eyebrow">AURUM QUANT AI · RESEARCH ONLY</p><h1>Current-AI session replay</h1><p>${esc(manifest.session.label)} · XAU/USD · M15 decisions / M5 paper fills</p><div class="notice"><strong>Retrospective simulation, not live performance.</strong><br>${esc(summary)}</div><div class="cards"><div class="card"><span>Valid AI responses</span><strong>${result.answeredDecisions} / ${result.expectedDecisions}</strong></div><div class="card"><span>Base-case paper trades</span><strong>${base.closedTrades}</strong></div><div class="card"><span>Net P/L · USD per oz</span><strong>${fmt(base.netUsdPerOunce)}</strong></div><div class="card"><span>Win rate</span><strong>${base.winRatePct === null ? "N/A" : fmt(base.winRatePct, 1) + "%"}</strong><small>Small one-session sample</small></div></div><h2>Hypothetical P/L path</h2>${svg}<p class="muted">Normalized one-ounce positions, no starting account balance or compounding. This is not an account return curve.</p><h2>Cost and exit sensitivity</h2>${tableHtml(
    ["Scenario", "Trades", "W / L", "Net USD/oz", "Net R", "Max DD USD/oz"],
    scenarioRows.map((row) => [
      row.id,
      row.closedTrades,
      `${row.wins} / ${row.losses}`,
      fmt(row.netUsdPerOunce),
      fmt(row.sumNetR),
      fmt(row.maxDrawdownUsdPerOunce),
    ]),
  )}<p class="muted">Base: assumed $1 spread + $0.10 slippage/fill. Low-cost: $0.50 / $0. Stress: $2 / $0.20. Historical execution spreads and depth were not available.</p><h2>Decision timeline</h2>${tableHtml(
    ["#", "NY time", "AI direction", "Effective classification", "Reason"],
    signalRows.map((row) => [
      row.index,
      row.newYorkTime,
      row.aiDirection || row.status,
      row.effectiveCategory,
      row.reason,
    ]),
  )}<h2>Base-case trades</h2>${
    base.trades.length
      ? tableHtml(
          ["ID", "Side", "Entry UTC", "Entry", "Exit", "Reason", "Net USD/oz"],
          base.trades.map((row) => [
            row.id,
            row.direction,
            row.entryTime,
            fmt(row.entryPrice, 3),
            fmt(row.exitPrice, 3),
            row.exitReason + (row.ambiguous ? " · ordering uncertain" : ""),
            fmt(row.netUsdPerOunce),
          ]),
        )
      : "<p>No filled paper trades.</p>"
  }<h2>Method and limits</h2><ul>${Object.entries(manifest.assumptions)
    .map(
      ([key, value]) => `<li><strong>${esc(key)}:</strong> ${esc(value)}</li>`,
    )
    .join(
      "",
    )}</ul><h2>Evidence files</h2><p><a href="report.md">Markdown report</a> · <a href="signals.csv">All signals CSV</a> · <a href="trades.csv">Paper trades CSV</a> · <a href="${esc(evidence("decisions.json"))}">Actual AI replies</a> · <a href="manifest.json">Manifest</a> · <a href="${esc(evidence("market-data.json"))}">Market dataset</a> · <a href="result.json">Full results</a></p><p><small>Strategy SHA-256: <code>${esc(result.strategySha256)}</code><br>Dataset SHA-256: <code>${esc(result.dataSha256)}</code></small></p><footer>No trades or live application changes. One session is insufficient to establish profitability. Generated ${esc(result.completedAt)}.</footer></main></body></html>`;
  await fs.mkdir(output, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(result, null, 2),
    ),
    fs.writeFile(path.join(output, "report.md"), markdown),
    fs.writeFile(path.join(output, "report.html"), html),
    fs.writeFile(path.join(output, "equity.svg"), svg),
    fs.writeFile(
      path.join(output, "signals.csv"),
      csv(signalRows, [
        "index",
        "asOfUtc",
        "newYorkTime",
        "status",
        "aiDirection",
        "effectiveCategory",
        "ruleDirection",
        "referencePrice",
        "entryLow",
        "entryHigh",
        "stop",
        "targets",
        "reason",
        "model",
        "calls",
        "durationMs",
        "summary",
      ]),
    ),
    fs.writeFile(
      path.join(output, "trades.csv"),
      csv(base.trades, [
        "id",
        "decisionIndex",
        "decisionAt",
        "direction",
        "entryTime",
        "entryPrice",
        "stop",
        "target",
        "exitTime",
        "exitPrice",
        "exitReason",
        "grossPricePnl",
        "slippageCost",
        "netUsdPerOunce",
        "netR",
        "ambiguous",
        "entryIntrabar",
        "simulatedOunces",
      ]),
    ),
  ]);
}
module.exports = { writeArtifacts, csvCell, chart };
