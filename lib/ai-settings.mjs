import {
  credentials,
  NVIDIA_BASE_URL,
  secureBaseUrl,
} from "./nvidia-runtime.mjs";

// Public catalog entries intentionally contain no keys. Saving those rows must
// not erase the existing server credential or move it to a different host.
export function preserveAiCredentials(current = {}, patch = {}) {
  const next = { ...patch };
  const stored = credentials(current, {});
  const fallback =
    stored.find((entry) => entry.baseUrl === NVIDIA_BASE_URL)?.apiKey || "";
  const previous = [
    ...(current.nvidiaModels || []),
    ...(current.debateModels || []),
  ];
  for (const field of ["nvidiaModels", "debateModels"]) {
    if (!Array.isArray(next[field])) continue;
    next[field] = next[field].map((model) => {
      const baseUrl = secureBaseUrl(model.baseUrl || NVIDIA_BASE_URL);
      const existing = previous.find(
        (item) =>
          (item.id === model.id || item.key === model.key) &&
          secureBaseUrl(item.baseUrl || NVIDIA_BASE_URL) === baseUrl,
      );
      return {
        ...model,
        baseUrl,
        apiKey: String(
          model.apiKey ||
            existing?.apiKey ||
            (baseUrl === NVIDIA_BASE_URL ? fallback : ""),
        ).trim(),
      };
    });
  }
  const touchesAi = [
    "nvidiaModels",
    "debateModels",
    "globalNvidiaApiKey",
    "globalNvidiaApiKeys",
    "defaultModelKey",
  ].some((field) => Object.hasOwn(next, field));
  if (touchesAi) {
    if (!String(next.globalNvidiaApiKey || "").trim())
      next.globalNvidiaApiKey = current.globalNvidiaApiKey || fallback;
    if (
      !Array.isArray(next.globalNvidiaApiKeys) ||
      !next.globalNvidiaApiKeys.filter(Boolean).length
    )
      next.globalNvidiaApiKeys = Array.isArray(current.globalNvidiaApiKeys)
        ? current.globalNvidiaApiKeys
        : [];
  }
  return next;
}
