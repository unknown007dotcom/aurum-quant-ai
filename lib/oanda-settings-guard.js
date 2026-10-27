/**
 * Guard against accidental deletion of the stored OANDA credentials.
 *
 * Settings saves are merges, but the admin UI (and any other caller) can
 * send `oandaApiToken: ""` simply because the password field happened to
 * be empty, had not finished loading, or admin auth failed. Treating that
 * empty string as a real value would silently wipe the saved token — this
 * has to be impossible to do by accident during development.
 *
 * Rules:
 * - A non-empty `oandaApiToken` / `oandaAccountId` is saved (trimmed).
 * - An empty / whitespace-only / missing value NEVER overwrites the stored
 *   one — the key is dropped from the payload so a merge preserves it.
 * - The ONLY way to delete a stored credential is to send an explicit
 *   `clearOandaApiToken: true` and/or `clearOandaAccountId: true`
 *   (or `clearOandaCredentials: true` for both).
 * - The clear flags themselves are never persisted.
 */
function applyOandaCredentialGuard(body) {
  const payload = { ...(body || {}) };

  const clearToken = payload.clearOandaApiToken === true || payload.clearOandaCredentials === true;
  const clearAccountId = payload.clearOandaAccountId === true || payload.clearOandaCredentials === true;
  delete payload.clearOandaApiToken;
  delete payload.clearOandaAccountId;
  delete payload.clearOandaCredentials;

  if (clearToken) {
    payload.oandaApiToken = "";
  } else if ("oandaApiToken" in payload) {
    const token = String(payload.oandaApiToken || "").trim();
    if (token) {
      payload.oandaApiToken = token;
    } else {
      // Empty field must never delete the saved token.
      delete payload.oandaApiToken;
    }
  }

  if (clearAccountId) {
    payload.oandaAccountId = "";
  } else if ("oandaAccountId" in payload) {
    const accountId = String(payload.oandaAccountId || "").trim();
    if (accountId) {
      payload.oandaAccountId = accountId;
    } else {
      delete payload.oandaAccountId;
    }
  }

  return payload;
}

/** Last-4 hint for UI feedback, e.g. "••••wxyz". Never returns the secret. */
function oandaTokenHint(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  return value.length >= 4 ? `••••${value.slice(-4)}` : "••••";
}

module.exports = { applyOandaCredentialGuard, oandaTokenHint };
