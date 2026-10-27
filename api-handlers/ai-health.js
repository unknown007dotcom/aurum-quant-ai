const { getAdminSettings } = require("../lib/firebase-admin");
const provider = import("../lib/nvidia-runtime.mjs");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ message: "Method not allowed." });
  }
  try {
    const { checkNvidiaHealth } = await provider;
    const settings = (await getAdminSettings()) || {};
    return res.status(200).json(await checkNvidiaHealth(settings, process.env));
  } catch {
    return res
      .status(503)
      .json({
        provider: "NVIDIA",
        keyValid: null,
        completionVerified: false,
        status: "unhealthy",
        error: "AI settings could not be loaded.",
        lastCheckedAt: Date.now(),
      });
  }
};
