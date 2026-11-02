// Debate-only scheduling. Chat transport, credentials and final-answer validation
// stay in their existing modules. Never treats a catalog listing as a completion.
import { requestCompletion, NvidiaError } from "./nvidia-runtime.mjs";
import {
  buildDebateSystemPrompt,
  buildDebateUserPrompt,
} from "./analysis-prompts.mjs";

// Both returned genuine short completions in the 24 October live audit. They
// must still be in the current server catalog and are subject to normal errors.
export const FAST_DEBATE_MODELS = Object.freeze([
  "openai/gpt-oss-20b",
  "nvidia/nemotron-3.5-bolt-e4b",
]);
const ROLES = ["bullish", "bearish", "redteam", "both"];
const caches = new WeakMap();
function cacheFor(fetchImpl) {
  if (!caches.has(fetchImpl)) caches.set(fetchImpl, new Map());
  return caches.get(fetchImpl);
}
function cacheKey(runtime, model) {
  return `${runtime.credentialId}:${model.id}`;
}
function recent(runtime, model, fetchImpl) {
  const item = cacheFor(fetchImpl).get(cacheKey(runtime, model));
  return item?.until > Date.now() ? item : null;
}
function remember(runtime, model, fetchImpl, value) {
  const cache = cacheFor(fetchImpl);
  if (cache.size >= 256) cache.delete(cache.keys().next().value);
  const ttl = value.success
    ? 300000
    : value.code === "model_unavailable"
      ? 600000
      : 30000;
  cache.set(cacheKey(runtime, model), { ...value, until: Date.now() + ttl });
}

// Explicit opt-outs win over duplicates and browser metadata. Only IDs/roles
// affect planning; provider endpoints/keys always come from runtime.models.
export function debatePreferences(settings = {}, body = {}) {
  const enabled = new Map();
  const disabled = new Set();
  for (const entry of [
    ...(Array.isArray(settings.debateModels) ? settings.debateModels : []),
    ...(Array.isArray(body.debateModels) ? body.debateModels : []),
  ]) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      entry.id.length > 180
    )
      continue;
    const id = entry.id.trim();
    if (entry.isDebateParticipant === false) disabled.add(id);
    else
      enabled.set(id, {
        id,
        bias: ROLES.includes(entry.bias) ? entry.bias : "both",
      });
  }
  for (const id of disabled) enabled.delete(id);
  return { enabled, disabled };
}

export function planDebate(
  runtime,
  selected,
  settings,
  body,
  mode,
  fetchImpl = globalThis.fetch,
) {
  const { enabled, disabled } = debatePreferences(settings, body);
  if (!mode.maxModels || !enabled.size) return [];
  const usable = runtime.models.filter((model) => !disabled.has(model.id));
  const preference = (model) => {
    const status = recent(runtime, model, fetchImpl);
    if (status && !status.success) return 10000;
    if (status?.success)
      return status.durationMs <= 1500
        ? -1000 + status.durationMs / 10
        : 50 + status.durationMs / 1000;
    const index = FAST_DEBATE_MODELS.indexOf(model.id);
    return index < 0 ? 100 : index;
  };
  const configured = usable
    .filter((model) => enabled.has(model.id))
    .sort((a, b) => preference(a) - preference(b));
  const quick = usable
    .filter(
      (model) =>
        FAST_DEBATE_MODELS.includes(model.id) ||
        (recent(runtime, model, fetchImpl)?.success &&
          recent(runtime, model, fetchImpl).durationMs <= 1500),
    )
    .sort((a, b) => preference(a) - preference(b));
  // Fast explicitly uses a small low-latency council, not an arbitrary first N
  // from a large imported catalog. Deep/full try configured participants too.
  const customCouncil =
    body.debateMode === "deep" || body.debateMode === "full";
  const pool = customCouncil ? configured : quick.length ? quick : configured;
  const backups = [
    ...quick,
    ...usable.filter((model) => model.id === selected.model.id),
  ];
  const primaryPool = pool.length ? pool : backups;
  if (!primaryPool.length) return [];
  return Array.from({ length: mode.maxModels }, (_, index) => {
    const primary = primaryPool[index % primaryPool.length];
    const preferredRole = enabled.get(primary.id)?.bias;
    const bias =
      customCouncil && preferredRole && preferredRole !== "both"
        ? preferredRole
        : ROLES[index % ROLES.length];
    const alternatives = [
      ...new Map(
        backups
          .filter(
            (model) =>
              model.id !== primary.id &&
              recent(runtime, model, fetchImpl)?.success !== false,
          )
          .map((model) => [model.id, model]),
      ).values(),
    ];
    const backup = alternatives[index % alternatives.length];
    return { id: `role-${index + 1}`, bias, primary, backup };
  });
}

export function debateVerdict(text) {
  // Do not infer a vote from the word "bullish" inside a risk discussion.
  const matches = [
    ...String(text).matchAll(
      /\b(?:verdict|vote)\s*\*{0,2}\s*:\s*\*{0,2}\s*(BUY|SELL|WAIT|STAY FLAT)\b/gi,
    ),
  ];
  const values = new Set(
    matches.map((match) => match[1].toUpperCase().replace("STAY FLAT", "WAIT")),
  );
  if (values.size !== 1) return null;
  const value = [...values][0];
  return value === "BUY"
    ? "buy"
    : value === "SELL"
      ? "sell"
      : value === "WAIT" || value === "STAY FLAT"
        ? "wait"
        : null;
}

export async function runDebate(
  { runtime, selected, settings, body, prompt, mode, deadline },
  fetchImpl = globalThis.fetch,
) {
  const started = Date.now();
  const phaseDeadline = Math.min(
    deadline - mode.summaryMs,
    started + mode.debateBudgetMs,
  );
  const tasks = planDebate(runtime, selected, settings, body, mode, fetchImpl);
  const records = new Array(tasks.length);
  const metrics = [];
  let next = 0;
  let providerBlocked = false;
  const metric = (task, model, values) => ({
    participantId: task.id,
    role: task.bias,
    modelId: model.id,
    modelLabel: model.label,
    success: false,
    skipped: false,
    durationMs: 0,
    ...values,
  });
  async function run(task) {
    const roleStarted = Date.now();
    let lastError;
    let attempted = false;
    for (const model of [task.primary, task.backup].filter(Boolean)) {
      const remaining = phaseDeadline - Date.now();
      if (providerBlocked || remaining < 100) break;
      const cached = recent(runtime, model, fetchImpl);
      if (cached && !cached.success) {
        metrics.push(
          metric(task, model, {
            skipped: true,
            statusCode: cached.statusCode,
            code: "cooldown",
            sanitizedError:
              "Recently failed; temporarily skipped to keep the response fast.",
          }),
        );
        continue;
      }
      const attemptStarted = Date.now();
      attempted = true;
      try {
        const result = await requestCompletion(
          model,
          [
            { role: "system", content: buildDebateSystemPrompt() },
            { role: "user", content: buildDebateUserPrompt(prompt, task.bias) },
          ],
          {
            temperature: body.temperature ?? 0.2,
            maxTokens: 800,
            timeoutMs: Math.min(mode.debateMs, remaining),
          },
          fetchImpl,
        );
        // A one-word connectivity response isn't a market perspective.
        if (
          result.content.trim().split(/\s+/).length < 5 ||
          /you are one participant in|your review perspective:|give the case and its counter-risk|end with verdict: buy/i.test(
            result.content,
          )
        )
          throw new NvidiaError(
            "The debate participant returned no substantive review.",
            502,
            "empty_debate",
          );
        remember(runtime, model, fetchImpl, {
          success: true,
          durationMs: result.durationMs,
        });
        metrics.push(
          metric(task, model, {
            success: true,
            statusCode: 200,
            durationMs: Date.now() - attemptStarted,
            sanitizedError: null,
          }),
        );
        return {
          participantId: task.id,
          requestedModelId: task.primary.id,
          model: { modelConfig: model, bias: task.bias },
          result: {
            ...result,
            ok: true,
            statusCode: 200,
            durationMs: Date.now() - roleStarted,
            modelFallbackUsed: model.id !== task.primary.id,
            vote: debateVerdict(result.content),
          },
        };
      } catch (error) {
        lastError = error;
        const safe = error instanceof NvidiaError;
        const statusCode = safe ? error.upstreamStatus || error.status : 502;
        const code = safe ? error.code : "provider_error";
        const sanitizedError = safe
          ? error.message
          : "Debate participant failed.";
        metrics.push(
          metric(task, model, {
            statusCode,
            code,
            sanitizedError,
            durationMs: Date.now() - attemptStarted,
          }),
        );
        remember(runtime, model, fetchImpl, {
          success: false,
          statusCode,
          code,
        });
        if (["invalid_key", "rate_limited"].includes(code)) {
          providerBlocked = true;
          break;
        }
      }
    }
    const message =
      lastError instanceof NvidiaError
        ? lastError.message
        : providerBlocked
          ? "Skipped after a provider authentication/rate-limit error."
          : "Skipped to preserve the debate and final-answer time budgets.";
    if (!attempted && !metrics.some((entry) => entry.participantId === task.id))
      metrics.push(
        metric(task, task.primary, {
          skipped: true,
          statusCode: 504,
          code: "budget",
          sanitizedError: message,
        }),
      );
    return {
      participantId: task.id,
      requestedModelId: task.primary.id,
      model: { modelConfig: task.primary, bias: task.bias },
      result: {
        ok: false,
        skipped: !attempted,
        statusCode: lastError?.status || 504,
        message,
        durationMs: Date.now() - roleStarted,
      },
    };
  }
  async function runner() {
    while (next < tasks.length) {
      const index = next++;
      records[index] = await run(tasks[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(mode.concurrency, tasks.length) }, runner),
  );
  return { records, metrics, durationMs: Date.now() - started };
}

// This is the only debate data exposed to callers. Never serialize runtime
// model objects: they contain server credentials.
export function publicDebate(debate, mode) {
  const successful = debate.records.filter((record) => record.result.ok);
  const modelCount = new Set(
    successful.map((record) => record.model.modelConfig.id),
  ).size;
  const consensus = { buy: 0, sell: 0, wait: 0, unclassified: 0 };
  for (const record of successful)
    consensus[record.result.vote || "unclassified"]++;
  return {
    debateMode: mode,
    debateUsed: successful.length > 0,
    debatePlanned: debate.records.length,
    debateAttempted: debate.records.filter((record) => !record.result.skipped)
      .length,
    debateSuccessful: successful.length,
    debateWorking: successful.length,
    debateSkipped: debate.records.filter((record) => record.result.skipped)
      .length,
    debateRequests: debate.metrics.filter((entry) => !entry.skipped).length,
    debateDistinctModels: modelCount,
    debateConsensus: consensus,
    debateMetrics: debate.metrics,
    debateFailures: debate.metrics.filter((entry) => !entry.success),
    debateNotice:
      mode === "off"
        ? "Debate is off for this run; only the final AI analysis was requested."
        : !debate.records.length
          ? "No eligible debate participants are enabled in the current model catalog."
          : !successful.length
            ? "No debate participant completed in time. Final AI analysis can still proceed."
            : successful.length > modelCount
              ? `${successful.length} review perspectives from ${modelCount} distinct model(s). Shared-model roles are not independent model votes.`
              : "Independent review requests completed; each response shows its actual model.",
    debateResponses: successful.map((record) => ({
      participantId: record.participantId,
      modelLabel: record.model.modelConfig.label,
      modelId: record.model.modelConfig.id,
      requestedModelId: record.requestedModelId,
      bias: record.model.bias,
      output: record.result.content,
      vote: record.result.vote,
      durationMs: record.result.durationMs,
      modelFallbackUsed: record.result.modelFallbackUsed,
    })),
  };
}
