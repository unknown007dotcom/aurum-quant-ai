import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { completeAnalysis } from "../../lib/analysis-service.mjs";
import { credentials } from "../../lib/nvidia-runtime.mjs";
import {
  buildTerminalSkillInput,
  evaluateTerminalSkills,
  terminalSkillsPrompt,
} from "../../modules/terminal-analysis-skills.mjs";
const require = createRequire(import.meta.url);
const {
  SESSION,
  FIVE,
  FIFTEEN,
  sha256,
  normalizeDataset,
  snapshotAt,
  validateSessionCoverage,
  createStrategyReplay,
} = require("./point-in-time.cjs");
const { COSTS, classifyPlan, simulate } = require("./paper-execution.cjs");
const { writeArtifacts } = require("./report.cjs");
const { getAdminSettings } = require("../../lib/firebase-admin.js");
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MARKET_URL =
  "https://aurum-quant-edge.aurum-quant-ai.workers.dev/market-mtf?symbol=XAU_USD&entryTf=15min&outputsize=2500";
const MAX_COMPLETIONS = 272;
const MAX_RUN_MS = 35 * 60 * 1000;
const MODEL_SETTINGS = {
  debateMode: "fast",
  temperature: 0.2,
  terminalSkills: true,
  manualRiskBudgetUsd: null,
};

async function main() {
  if (!process.argv.includes("--confirm-ai-usage"))
    throw new Error(
      "This is an opt-in research run with real NVIDIA usage. Pass --confirm-ai-usage to authorize the fixed 34-checkpoint replay. No orders are ever sent.",
    );
  const outputArg = process.argv.indexOf("--output");
  const output = path.resolve(
    outputArg >= 0
      ? process.argv[outputArg + 1]
      : path.join(ROOT, "scratch/backtest/session-2026-10-23"),
  );
  await fs.mkdir(output, { recursive: true });
  // Match the main workspace's default/browser location, not the build server.
  process.env.TZ = "Asia/Kolkata";
  const startedAt = new Date().toISOString(),
    started = Date.now();
  const applicationFiles = [
    "app.js",
    "modules/analysis-engine.js",
    "modules/terminal-analysis-skills.mjs",
    "lib/analysis-service.mjs",
    "lib/analysis-prompts.mjs",
    "lib/debate-service.mjs",
    "lib/nvidia-runtime.mjs",
  ];
  const sourceHashes = {};
  for (const file of applicationFiles)
    sourceHashes[file] = sha256(
      await fs.readFile(path.join(ROOT, file), "utf8"),
    );
  const fetchStarted = Date.now();
  const response = await fetch(MARKET_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(
      `Market data could not be fetched (${response.status}); no AI calls made.`,
    );
  const rawMarket = await response.json();
  const dataset = normalizeDataset(rawMarket);
  validateSessionCoverage(dataset);
  const replay = createStrategyReplay(ROOT);
  const settings = await getAdminSettings();
  if (!credentials(settings, process.env).length)
    throw new Error(
      "No server-side NVIDIA configuration; no AI evaluations attempted.",
    );
  const selectedModelKey =
    typeof settings.defaultModelKey === "string"
      ? settings.defaultModelKey
      : "";
  const modelConfig = {
    selectedModelKey,
    configuredModels: (settings.nvidiaModels || []).map(
      ({ key, id, label }) => ({ key, id, label }),
    ),
    debatePreferences: (settings.debateModels || []).map(
      ({ id, bias, isDebateParticipant }) => ({
        id,
        bias,
        isDebateParticipant,
      }),
    ),
    ...MODEL_SETTINGS,
  };
  const manifest = {
    runType: "retrospective_current_ai_plan_replay",
    startedAt,
    session: SESSION,
    artifactOrigin:
      typeof process.env.VERCEL_URL === "string" &&
      /^[a-z0-9-]+\.vercel\.app$/.test(process.env.VERCEL_URL)
        ? "https://" + process.env.VERCEL_URL
        : null,
    sourceCodeRevision: process.env.AURUM_BACKTEST_REVISION || null,
    sourceHashes,
    extractedLogicSha256: replay.extractedLogicSha256,
    data: {
      url: MARKET_URL,
      provider: dataset.provider,
      cacheStatus: dataset.cacheStatus,
      fetchedAt: new Date().toISOString(),
      fetchDurationMs: Date.now() - fetchStarted,
      sha256: dataset.rawSha256,
      frames: Object.fromEntries(
        Object.entries(dataset.frames).map(([id, rows]) => [
          id,
          {
            count: rows.length,
            first: rows[0].datetime,
            last: rows.at(-1).datetime,
          },
        ]),
      ),
    },
    modelConfig,
    modelConfigSha256: sha256(modelConfig),
    assumptions: {
      instrument: "XAU_USD",
      decisionTimeframe: "M15 completed-entry bars",
      executionResolution: "M5 midpoint OHLC",
      strategy:
        "Current main-page AnalysisEngine, LiquidityEngine, buildAiPrompt, Fast council, final validator and rule/AI conflict guard; not the different automated-bot strategy. Observational diagnostic-log formatting is disabled in the isolated runner; output parity is tested.",
      historyWindow:
        "Available cache prefix up to the live 5000-bar cache cap. The exact historical cache contents are not archived; older rows evicted before collection cannot be reconstructed.",
      higherTimeframes:
        "Completed parent bars only when their period ended by the cutoff. Forming H1/H4/D/W/M OHLC rebuilt from completed past M5 bars; never use later parent-bar high/low/close.",
      clock:
        "Historical as-of clock for strategy/session/quality math, real clock for provider request timeouts.",
      learningMemory:
        "Omitted: no point-in-time versioned global learning-memory snapshots exist; current outcome memory would leak later results.",
      snapshotClock:
        "Main default timezone Asia/Kolkata; evaluation session 08:00–16:30 America/New_York (EDT).",
      size: "One hypothetical ounce-equivalent per position; no account balance, compounding, margin or leverage assumed.",
      entryAndExit:
        "Only explicit price-level plans; additional non-price confirmations are not assumed. Five-minute delay, pending plan valid until the next decision, one position, stop/first-target/session-end exits. No partial exits, trailing stops or prose structural-invalidation management.",
      costs:
        "Historical bid/ask/depth are not present in the terminal cache. Spread and slippage are declared assumptions, not measured broker execution costs. Base: $1 spread plus $0.10 slippage per fill, per ounce.",
      ambiguity:
        "Stop first when both barriers are hit; intrabar entries use an adverse overlap price, receive no same-bar target credit, and stop touches are counted conservatively.",
      limitations:
        "One session is not statistical validation. This re-runs current stochastic AI today, not saved past AI decisions. LLM training-time/hindsight knowledge cannot be ruled out. Reconstructed cache/input differences and execution assumptions limit fidelity.",
      liveChanges:
        "No production deployment, bot command, order, settings write or learning/history write.",
    },
  };
  await fs.writeFile(
    path.join(output, "market-data.json"),
    JSON.stringify(rawMarket),
  );
  await fs.writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    "[BACKTEST-MANIFEST] " +
      JSON.stringify({
        startedAt,
        session: SESSION,
        sourceHashes,
        dataSha256: dataset.rawSha256,
        frames: manifest.data.frames,
        modelConfigSha256: manifest.modelConfigSha256,
        mode: MODEL_SETTINGS,
        maximumCompletionCalls: MAX_COMPLETIONS,
        tradesExecuted: false,
      }),
  );

  const calls = [],
    decisions = [];
  let completions = 0,
    catalogReads = 0,
    stoppedReason = null;
  const aiFetch = async (url, options) => {
    const parsed = new URL(url);
    if (
      parsed.origin !== "https://integrate.api.nvidia.com" ||
      !["/v1/models", "/v1/chat/completions"].includes(parsed.pathname)
    )
      throw new Error("Backtest transport blocked an unexpected endpoint");
    const isCompletion = parsed.pathname.endsWith("/chat/completions");
    if (isCompletion && completions >= MAX_COMPLETIONS)
      throw new Error("Backtest completion budget exhausted");
    if (isCompletion) completions++;
    else catalogReads++;
    const body = options.body ? JSON.parse(options.body) : null;
    const began = Date.now();
    const record = {
      index: calls.length + 1,
      point: decisions.length + 1,
      kind: isCompletion ? "completion" : "catalog",
      model: body?.model || null,
      maxTokens: body?.max_tokens || null,
    };
    calls.push(record);
    try {
      const res = await fetch(url, options);
      record.httpStatus = res.status;
      const json = await res
        .clone()
        .json()
        .catch(() => null);
      record.durationMs = Date.now() - began;
      if (json?.usage)
        record.usage = {
          promptTokens: json.usage.prompt_tokens ?? null,
          completionTokens: json.usage.completion_tokens ?? null,
          totalTokens: json.usage.total_tokens ?? null,
        };
      return res;
    } catch (error) {
      record.durationMs = Date.now() - began;
      record.failure = error.name || "network_error";
      throw error;
    }
  };
  const start = Date.parse(SESSION.start),
    end = Date.parse(SESSION.end);
  const prepared = [];
  for (
    let cutoff = start, index = 1;
    cutoff < end;
    cutoff += FIFTEEN, index++
  ) {
    if (Date.now() - started > 10 * 60 * 1000)
      throw new Error(
        "Historical input preparation exceeded its separate safety budget; no AI calls made.",
      );
    const prepareStarted = Date.now();
    const snap = snapshotAt(dataset, cutoff);
    const { analysis, prompt } = replay.evaluate(snap.market, cutoff);
    if (index === 1 || index % 8 === 0 || index === SESSION.checkpoints)
      console.log(
        "[BACKTEST-PREPARE] " +
          JSON.stringify({
            index,
            asOf: new Date(cutoff).toISOString(),
            durationMs: Date.now() - prepareStarted,
            aiCallsSoFar: completions,
          }),
      );
    const skillInput = buildTerminalSkillInput(analysis, snap.market, {
      instrument: "XAU_USD",
      timeframe: "15min",
      riskBudgetUsd: null,
    });
    const research = evaluateTerminalSkills(skillInput, cutoff);
    const digest = terminalSkillsPrompt(research);
    if (research) research.usedInPrompt = Boolean(digest);
    const historicalPrompt = [
      `HISTORICAL PAPER REPLAY. Decision cutoff: ${new Date(cutoff).toISOString()}. Assess only information supplied as of that cutoff, not today's market. Later candles and outcomes are withheld. No orders can be executed. Global outcome/learning memory is deliberately unavailable for this historical instant.`,
      prompt,
      digest,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (historicalPrompt.length > 96000)
      throw new Error("Historical prompt exceeds the unchanged analysis limit");
    prepared.push({
      index,
      asOf: new Date(cutoff).toISOString(),
      referencePrice: analysis.price,
      ruleDirection: analysis.decision.action,
      inputSha256: sha256(snap.market),
      promptSha256: sha256(historicalPrompt),
      promptChars: historicalPrompt.length,
      frameAudit: snap.audit,
      research,
      historicalPrompt,
    });
  }
  await fs.writeFile(
    path.join(output, "prepared-inputs.json"),
    JSON.stringify(prepared, null, 2),
  );
  console.log(
    "[BACKTEST-PREPARED] " +
      JSON.stringify({
        checkpoints: prepared.length,
        first: prepared[0].asOf,
        last: prepared.at(-1).asOf,
        maxPromptChars: Math.max(...prepared.map((p) => p.promptChars)),
        firstFrameAudit: prepared[0].frameAudit,
        historicalMemoryUsed: false,
        aiCallsSoFar: completions,
      }),
  );
  for (const preparedPoint of prepared) {
    if (Date.now() - started > MAX_RUN_MS || completions >= MAX_COMPLETIONS) {
      stoppedReason = "Safety time/provider budget exhausted";
      break;
    }
    const pointStarted = Date.now();
    const { historicalPrompt, ...inputs } = preparedPoint;
    const point = { ...inputs, status: "pending", execution: null };
    const before = completions;
    try {
      const result = await completeAnalysis(
        {
          selectedModelKey,
          prompt: historicalPrompt,
          debateMode: "fast",
          temperature: 0.2,
        },
        settings,
        process.env,
        aiFetch,
      );
      if (result.aiUsed !== true || result.fallbackUsed === true)
        throw new Error("No real AI answer");
      const plan = JSON.parse(result.choices[0].message.content);
      point.status = "answered";
      point.plan = plan;
      point.execution = classifyPlan(
        plan,
        point.ruleDirection,
        point.referencePrice,
      );
      point.actualModel = result.model;
      point.modelFallbackUsed = Boolean(result.modelFallbackUsed);
      point.responseRepaired = Boolean(result.responseRepaired);
      point.debateSuccessful = result.debateSuccessful;
      point.debateDistinctModels = result.debateDistinctModels;
      point.debateResponses = result.debateResponses;
      point.debateFailures = result.debateFailures;
      point.timings = result.timings;
    } catch (error) {
      point.status = "error";
      point.error = {
        code: error.code || "replay_error",
        message: String(error.message)
          .replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]")
          .slice(0, 300),
      };
      point.execution = { category: "error", reason: point.error.code };
      if (
        [
          "invalid_key",
          "rate_limited",
          "missing_key",
          "invalid_configuration",
        ].includes(error.code)
      )
        stoppedReason = `Provider ${error.code}; stopped to protect normal AI service`;
    }
    point.durationMs = Date.now() - pointStarted;
    point.completionCalls = completions - before;
    decisions.push(point);
    await fs.writeFile(
      path.join(output, "decisions.json"),
      JSON.stringify(decisions, null, 2),
    );
    await fs.writeFile(
      path.join(output, "provider-usage.json"),
      JSON.stringify(calls, null, 2),
    );
    console.log(
      "[BACKTEST-DECISION] " +
        JSON.stringify({
          index: point.index,
          asOf: point.asOf,
          status: point.status,
          model: point.actualModel,
          referencePrice: point.referencePrice,
          ruleDirection: point.ruleDirection,
          execution: point.execution,
          completionCalls: point.completionCalls,
          durationMs: point.durationMs,
          summary: point.plan?.researcher?.summary?.slice(0, 220),
          error: point.error,
        }),
    );
    if (stoppedReason) break;
    await pause(1000); // no parallel AI evaluations or outcome-driven rerolls
  }
  const categories = {};
  for (const point of decisions)
    categories[point.execution.category] =
      (categories[point.execution.category] || 0) + 1;
  const scenarios = COSTS.map((cost) => ({
    id: cost.id,
    ...simulate(decisions, dataset.frames["5min"], cost),
  }));
  const target2 = {
    id: "base_last_target",
    ...simulate(decisions, dataset.frames["5min"], COSTS[1], SESSION, 999),
  };
  const result = {
    runType: manifest.runType,
    completedAt: new Date().toISOString(),
    session: SESSION,
    sourceCodeRevision: manifest.sourceCodeRevision,
    fullDecisionCoverage:
      decisions.length === SESSION.checkpoints &&
      decisions.every((point) => point.status === "answered"),
    expectedDecisions: SESSION.checkpoints,
    attemptedDecisions: decisions.length,
    answeredDecisions: decisions.filter((point) => point.status === "answered")
      .length,
    categories,
    stoppedReason,
    completionCalls: completions,
    catalogReads,
    runtimeMs: Date.now() - started,
    tokenUsage: calls.reduce(
      (sum, call) => ({
        promptTokens: sum.promptTokens + (call.usage?.promptTokens || 0),
        completionTokens:
          sum.completionTokens + (call.usage?.completionTokens || 0),
        totalTokens: sum.totalTokens + (call.usage?.totalTokens || 0),
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ),
    usageRecordsAvailable: calls.filter((call) => call.usage).length,
    scenarios,
    lastTargetSensitivity: target2,
    dataSha256: dataset.rawSha256,
    strategySha256: replay.strategySha256,
    tradesExecuted: false,
    liveSiteChanged: false,
  };
  for (const file of applicationFiles)
    if (
      sourceHashes[file] !==
      sha256(await fs.readFile(path.join(ROOT, file), "utf8"))
    )
      throw new Error("Strategy source changed during the run");
  await writeArtifacts(output, manifest, decisions, result);
  const compact = ({ trades, curve, events, ...rest }) => rest;
  console.log(
    "[BACKTEST-SUMMARY] " +
      JSON.stringify({
        ...result,
        scenarios: scenarios.map(compact),
        lastTargetSensitivity: compact(target2),
      }),
  );
  for (const trade of scenarios.find((row) => row.id === "base").trades)
    console.log("[BACKTEST-TRADE] " + JSON.stringify(trade));
  const bundle = {};
  for (const name of [
    "report.html",
    "report.md",
    "equity.svg",
    "manifest.json",
    "result.json",
    "signals.csv",
    "trades.csv",
  ])
    bundle[name] = await fs.readFile(path.join(output, name), "utf8");
  const compressed = gzipSync(Buffer.from(JSON.stringify(bundle)));
  const encoded = compressed.toString("base64");
  const chunks = Math.ceil(encoded.length / 2400);
  console.log(
    "[BACKTEST-BUNDLE-META] " +
      JSON.stringify({
        chunks,
        sha256: sha256(compressed.toString("base64")),
        files: Object.keys(bundle),
      }),
  );
  for (let i = 0; i < chunks; i++)
    console.log(
      "[BACKTEST-BUNDLE-" +
        String(i + 1).padStart(3, "0") +
        "] " +
        encoded.slice(i * 2400, (i + 1) * 2400),
    );
  console.log(
    "[BACKTEST-COMPLETE] " +
      JSON.stringify({
        fullDecisionCoverage: result.fullDecisionCoverage,
        attempted: decisions.length,
        answered: result.answeredDecisions,
        completionCalls: completions,
        outputFiles: [
          "report.html",
          "report.md",
          "result.json",
          "manifest.json",
          "decisions.json",
          "trades.csv",
          "signals.csv",
          "market-data.json",
          "prepared-inputs.json",
          "provider-usage.json",
        ],
        tradesExecuted: false,
        productionUnchanged: true,
      }),
  );
}
main().catch((error) => {
  console.error(
    "[BACKTEST-FAILED] " +
      String(error.message)
        .replace(/nvapi-[a-z0-9_-]+/gi, "[REDACTED]")
        .slice(0, 1500),
  );
  process.exitCode = 1;
});
