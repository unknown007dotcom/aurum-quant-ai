import {
  discoverModels,
  selectModel,
  requestCompletion,
  completeWithFallback,
  NvidiaError,
} from "./nvidia-runtime.mjs";
import {
  buildSummarySystemPrompt,
  buildDebateSystemPrompt,
  buildDebateUserPrompt,
  buildConsolidatedPrompt,
} from "./analysis-prompts.mjs";

export const ANALYSIS_MODES = Object.freeze({
  fast: {
    maxModels: 4,
    concurrency: 4,
    debateMs: 15000,
    summaryMs: 35000,
    totalMs: 65000,
    tokens: 1600,
  },
  deep: {
    maxModels: 12,
    concurrency: 6,
    debateMs: 20000,
    summaryMs: 40000,
    totalMs: 110000,
    tokens: 2200,
  },
  full: {
    maxModels: 35,
    concurrency: 6,
    debateMs: 22000,
    summaryMs: 45000,
    totalMs: 170000,
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

function structuredAnswer(text) {
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
  data.equations ||= {
    review:
      "Use the supplied market equations; no additional live data was fetched.",
  };
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
  const runtime = await discoverModels(settings, env, fetchImpl);
  const selected = selectModel(
    runtime,
    body.selectedModelKey || "",
    body.model || "",
  );
  // Browser model entries may select catalog IDs, never credentials or endpoints.
  const requestedDebates = new Set(
    (Array.isArray(body.debateModels) ? body.debateModels : [])
      .filter((model) => model && model.isDebateParticipant !== false)
      .map((model) => model.id),
  );
  const debatePool = runtime.models
    .filter(
      (model) =>
        model.id !== selected.model.id &&
        (model.debate || requestedDebates.has(model.id)),
    )
    .slice(0, mode.maxModels);
  const roles = ["bullish", "bearish", "redteam", "both"];
  const records = new Array(debatePool.length);
  let next = 0;
  async function runner() {
    while (next < debatePool.length) {
      const index = next++;
      const model = debatePool[index];
      const bias = roles[index % roles.length];
      const remaining = deadline - Date.now() - mode.summaryMs;
      if (remaining < 1000) {
        records[index] = {
          model: { modelConfig: model, bias },
          result: {
            ok: false,
            skipped: true,
            statusCode: 504,
            message: "Skipped to preserve the final-summary time budget.",
            durationMs: 0,
          },
        };
        continue;
      }
      const attemptStarted = Date.now();
      try {
        const result = await requestCompletion(
          model,
          [
            { role: "system", content: buildDebateSystemPrompt() },
            {
              role: "user",
              content: buildDebateUserPrompt(input.prompt, bias),
            },
          ],
          {
            temperature: input.temperature,
            maxTokens: 500,
            timeoutMs: Math.min(mode.debateMs, remaining),
          },
          fetchImpl,
        );
        records[index] = {
          model: { modelConfig: model, bias },
          result: { ...result, ok: true, statusCode: 200 },
        };
      } catch (error) {
        records[index] = {
          model: { modelConfig: model, bias },
          result: {
            ok: false,
            statusCode: error.upstreamStatus || error.status || 502,
            message:
              error instanceof NvidiaError
                ? error.message
                : "Model request failed.",
            durationMs: Date.now() - attemptStarted,
          },
        };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(mode.concurrency, debatePool.length) },
      runner,
    ),
  );
  const successful = records.filter((record) => record?.result.ok);
  const finalPrompt = successful.length
    ? buildConsolidatedPrompt(input.prompt, successful)
    : input.prompt;
  const result = await completeWithFallback(
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
    },
    fetchImpl,
  );
  const content = structuredAnswer(result.content);
  const debateMetrics = records.map(({ model, result: entry }) => ({
    modelLabel: model.modelConfig.label,
    modelId: model.modelConfig.id,
    role: model.bias,
    success: entry.ok,
    skipped: Boolean(entry.skipped),
    statusCode: entry.statusCode,
    durationMs: entry.durationMs,
    sanitizedError: entry.ok ? null : entry.message,
  }));
  const debateConsensus = { buy: 0, sell: 0, wait: 0 };
  for (const { result: entry } of successful) {
    const tail = entry.content.slice(-300).toLowerCase();
    if (/stay flat|no trade|insufficient/.test(tail)) debateConsensus.wait++;
    else if (/\bbuy\b|\bbullish\b/.test(tail)) debateConsensus.buy++;
    else if (/\bsell\b|\bbearish\b/.test(tail)) debateConsensus.sell++;
    else debateConsensus.wait++;
  }
  return {
    model: result.model,
    choices: [{ message: { role: "assistant", content } }],
    aiUsed: true,
    fallbackUsed: false,
    modelFallbackUsed: result.modelFallbackUsed,
    ...(result.modelFallbackUsed
      ? {
          modelFallbackReason:
            "The selected model was unavailable; an active model produced this analysis.",
        }
      : {}),
    debateUsed: successful.length > 0,
    debateAttempted: records.filter((record) => !record.result.skipped).length,
    debateSuccessful: successful.length,
    debateWorking: successful.length,
    debateSkipped: records.filter((record) => record.result.skipped).length,
    debateConsensus,
    debateMetrics,
    debateFailures: debateMetrics.filter((item) => !item.success),
    debateResponses: successful.map(({ model, result: entry }) => ({
      modelLabel: model.modelConfig.label,
      modelId: model.modelConfig.id,
      bias: model.bias,
      output: entry.content,
    })),
    durationMs: Date.now() - started,
  };
}
