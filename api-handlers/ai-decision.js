const { getAdminSettings } = require("../lib/firebase-admin");
const {
  safeLoadLearningContext,
  appendLearningContext,
} = require("../lib/analysis-learning.cjs");
const service = import("../lib/analysis-service.mjs");
const provider = import("../lib/nvidia-runtime.mjs");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ message: "Method not allowed." });
  }
  const { completeAnalysis, validateAnalysisRequest } = await service;
  const { NvidiaError } = await provider;
  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new NvidiaError(
          "Send a valid JSON request.",
          400,
          "invalid_request",
        );
      }
    }
    validateAnalysisRequest(body);
    const settings = (await getAdminSettings()) || {};
    let timer;
    const context = await Promise.race([
      safeLoadLearningContext().catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 1500);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    const prompt = context
      ? appendLearningContext(body.prompt, context)
      : body.prompt;
    const result = await completeAnalysis(
      { ...body, prompt },
      settings,
      process.env,
    );
    return res.status(200).json(result);
  } catch (error) {
    const safe = error instanceof NvidiaError;
    return res.status(safe ? error.status : 500).json({
      message: safe
        ? error.message
        : "AI analysis is temporarily unavailable. Please try again.",
      code: safe ? error.code : "internal_error",
      aiUsed: false,
      fallbackUsed: false,
      ...(safe && error.debate ? error.debate : {}),
    });
  }
};
