import {
  discoverModels,
  selectModel,
  completeWithFallback,
  NvidiaError,
} from "./nvidia-runtime.mjs";
import {
  buildSummarySystemPrompt,
  buildConsolidatedPrompt,
} from "./analysis-prompts.mjs";

import { runDebate, publicDebate } from "./debate-service.mjs";
import {
  evaluateTerminalSkills,
  terminalSkillsPrompt,
} from "../modules/terminal-analysis-skills.mjs";

export const ANALYSIS_MODES = Object.freeze({
  off: {
    maxModels: 0,
    concurrency: 0,
    debateMs: 0,
    debateBudgetMs: 0,
    summaryMs: 35000,
    totalMs: 65000,
    tokens: 1600,
  },
  fast: {
    maxModels: 3,
    concurrency: 3,
    debateMs: 4000,
    debateBudgetMs: 8000,
    summaryMs: 35000,
    totalMs: 65000,
    tokens: 1600,
  },
  deep: {
    maxModels: 4,
    concurrency: 3,
    debateMs: 6000,
    debateBudgetMs: 14000,
    summaryMs: 40000,
    totalMs: 85000,
    tokens: 2200,
  },
  full: {
    maxModels: 6,
    concurrency: 3,
    debateMs: 8000,
    debateBudgetMs: 20000,
    summaryMs: 45000,
    totalMs: 105000,
    tokens: 3000,
  },
});

export function validateAnalysisRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.prompt !== "string" ||
    !body.prompt.trim()
  )
    throw new NvidiaError("Missing AI prompt.", 400, "invalid_request");
  if (body.prompt.length > 96000)
    throw new NvidiaError(
      "The analysis prompt is too large. Reduce the supplied context.",
      413,
      "invalid_request",
    );
  for (const field of ["selectedModelKey", "model"])
    if (
      body[field] !== undefined &&
      (typeof body[field] !== "string" || body[field].length > 180)
    )
      throw new NvidiaError("Invalid model selection.", 400, "invalid_request");
  return {
    prompt: body.prompt.trim(),
    mode: Object.hasOwn(ANALYSIS_MODES, body.debateMode)
      ? body.debateMode
      : "fast",
    temperature:
      typeof body.temperature === "number" && Number.isFinite(body.temperature)
        ? Math.min(1, Math.max(0, body.temperature))
        : 0.2,
  };
}

export function structuredAnswer(text) {
  let data;
  try {
    data = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new NvidiaError(
      "The AI returned an incomplete or invalid analysis. Please retry; no AI trade plan was accepted.",
      502,
      "invalid_analysis",
    );
  }
  if (
    !data ||
    typeof data !== "object" ||
    !data.researcher ||
    typeof data.researcher.summary !== "string" ||
    !data.researcher.summary.trim() ||
    !data.trader ||
    typeof data.trader !== "object" ||
    Array.isArray(data.trader)
  )
    throw new NvidiaError(
      "The AI response is missing required analysis fields. Please retry.",
      502,
      "invalid_analysis",
    );
  const narrative = [
    data.researcher.summary,
    data.researcher.riskNote,
    data.trader.invalidation,
    data.equations?.review,
  ];
  // Production previously accepted a verbatim copy of the prompt's example
  // values. Nonempty JSON alone is not evidence that the request was answered.
  const placeholder =
    /explain the institutional narrative|you must explicitly reference|summarize the red[- ]team critic|specific trigger or structural failure point|discuss equation 1|exact price range or|specific price or|recommended position size|expected hold time|replace (?:every|all) empty string|actual findings here|your (?:analysis|summary|answer) here/i;
  if (
    narrative.some((value) => typeof value !== "string" || !value.trim()) ||
    [...narrative, ...Object.values(data.trader)].some(
      (value) => typeof value === "string" && placeholder.test(value),
    )
  )
    throw new NvidiaError(
      "The AI returned a template or incomplete findings instead of an analysis.",
      502,
      "invalid_analysis",
    );
  const direction = String(data.researcher.direction || "")
    .trim()
    .toLowerCase();
  const neutral =
    /\bstay flat\b|\bno trade\b|\bdo not trade\b|\bno valid setup\b|\bno clear setup\b|\binsufficient data\b|\bmissing (?:market )?data\b/i.test(
      data.researcher.summary,
    );
  data.researcher.direction = neutral
    ? "Stay Flat"
    : direction === "buy"
      ? "Buy"
      : direction === "sell"
        ? "Sell"
        : "Stay Flat";
  if (data.researcher.direction === "Stay Flat")
    for (const field of [
      "entryZone",
      "takeProfitLevels",
      "stopLoss",
      "positionSizing",
      "timeHorizon",
    ])
      data.trader[field] = "N/A";
  else if (
    [
      "entryZone",
      "takeProfitLevels",
      "stopLoss",
      "positionSizing",
      "timeHorizon",
    ].some(
      (field) =>
        typeof data.trader[field] !== "string" ||
        !data.trader[field].trim() ||
        data.trader[field] === "N/A",
    ) ||
    ["entryZone", "takeProfitLevels", "stopLoss"].some(
      (field) => !/\d/.test(data.trader[field]),
    )
  )
    throw new NvidiaError(
      "The AI omitted required trade-plan levels. No AI trade plan was accepted.",
      502,
      "invalid_analysis",
    );
  return JSON.stringify(data);
}

export async function completeAnalysis(
  body,
  settings = {},
  env = {},
  fetchImpl = globalThis.fetch,
) {
  const input = validateAnalysisRequest(body);
  const mode = ANALYSIS_MODES[input.mode];
  const started = Date.now();
  const deadline = started + mode.totalMs;
  // Opt-in, terminal-only research context. No extra model/provider requests;
  // optional-data failures cannot stop the existing AI answer pipeline.
  const skillsStarted = Date.now();
  const analysisSkills = evaluateTerminalSkills(body.terminalSkills);
  const candidateSkillPrompt = terminalSkillsPrompt(analysisSkills);
  const skillPrompt =
    input.prompt.length + candidateSkillPrompt.length + 2 <= 96000
      ? candidateSkillPrompt
      : "";
  if (analysisSkills) analysisSkills.usedInPrompt = Boolean(skillPrompt);
  const skillsMs = Date.now() - skillsStarted;
  const analysisPrompt = skillPrompt
    ? `${input.prompt}\n\n${skillPrompt}`
    : input.prompt;
  const runtime = await discoverModels(settings, env, fetchImpl);
  const selected = selectModel(
    runtime,
    body.selectedModelKey || "",
    body.model || "",
  );
  const discoveryMs = Date.now() - started;
  // Debate has its own scheduler and wall-clock budget. Provider failures are
  // recorded per role, not promoted into failures of the final-answer pipeline.
  const debate = await runDebate(
    {
      runtime,
      selected,
      settings,
      body: { ...body, temperature: input.temperature, debateMode: input.mode },
      prompt: analysisPrompt,
      mode,
      deadline,
    },
    fetchImpl,
  );
  const { records } = debate;
  const debateInfo = publicDebate(debate, input.mode);
  const successful = records.filter((record) => record?.result.ok);
  const finalPrompt = successful.length
    ? buildConsolidatedPrompt(analysisPrompt, successful)
    : analysisPrompt;
  const summaryStarted = Date.now();
  let result;
  try {
    result = await completeWithFallback(
      runtime,
      selected,
      [
        { role: "system", content: buildSummarySystemPrompt() },
        { role: "user", content: finalPrompt },
      ],
      {
        temperature: input.temperature,
        maxTokens: mode.tokens,
        timeoutMs: mode.summaryMs,
        deadline,
        jsonOutput: true,
        validateContent: structuredAnswer,
        repairMessage:
          "Your previous answer was invalid or repeated a template. Answer the original request now with one complete JSON object. Write actual findings in researcher.summary, researcher.riskNote, trader.invalidation and equations.review. Do not copy field instructions. If market data is missing, explain what is missing, choose Stay Flat and use N/A for every price field.",
      },
      fetchImpl,
    );
  } catch (error) {
    // Preserve genuine reviews even if final synthesis fails. The HTTP failure
    // remains a failure; no server-generated trade plan is substituted.
    if (error instanceof NvidiaError)
      error.debate = {
        ...debateInfo,
        ...(analysisSkills ? { analysisSkills } : {}),
        debateNotice:
          "Final AI analysis failed. These are participant reviews only, not an accepted trade plan.",
      };
    throw error;
  }
  const content = result.content;
  return {
    model: result.model,
    choices: [{ message: { role: "assistant", content } }],
    aiUsed: true,
    fallbackUsed: false,
    modelFallbackUsed: result.modelFallbackUsed,
    responseRepaired: result.responseRepaired,
    ...(result.modelFallbackUsed
      ? {
          modelFallbackReason:
            "The selected model was unavailable; an active model produced this analysis.",
        }
      : {}),
    ...debateInfo,
    ...(analysisSkills ? { analysisSkills } : {}),
    timings: {
      discoveryMs,
      ...(analysisSkills ? { skillsMs } : {}),
      debateMs: debate.durationMs,
      summaryMs: Date.now() - summaryStarted,
      totalMs: Date.now() - started,
    },
    durationMs: Date.now() - started,
  };
}
