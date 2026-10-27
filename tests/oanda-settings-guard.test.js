const { applyOandaCredentialGuard, oandaTokenHint } = require("../lib/oanda-settings-guard");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ [FAIL] ${name}: ${e.message}`);
    failed++;
  }
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// The core safety property the owner asked for: an empty field must not
// be able to delete the saved token.
test("empty token is dropped so a merge cannot wipe the saved token", () => {
  const out = applyOandaCredentialGuard({ oandaApiToken: "", botUnits: 5 });
  assertEqual("oandaApiToken" in out, false);
  assertEqual(out.botUnits, 5);
});

test("whitespace-only token and account id are dropped", () => {
  const out = applyOandaCredentialGuard({ oandaApiToken: "   ", oandaAccountId: " " });
  assertEqual("oandaApiToken" in out, false);
  assertEqual("oandaAccountId" in out, false);
});

test("payload without OANDA keys passes through untouched", () => {
  const out = applyOandaCredentialGuard({ botMode: "auto" });
  assertEqual(out.botMode, "auto");
  assertEqual("oandaApiToken" in out, false);
});

test("a real new token is saved, trimmed", () => {
  const out = applyOandaCredentialGuard({ oandaApiToken: "  abc-123  ", oandaAccountId: " 001-002 " });
  assertEqual(out.oandaApiToken, "abc-123");
  assertEqual(out.oandaAccountId, "001-002");
});

test("explicit clear flag empties the token and is not persisted", () => {
  const out = applyOandaCredentialGuard({ clearOandaApiToken: true });
  assertEqual(out.oandaApiToken, "");
  assertEqual("clearOandaApiToken" in out, false);
});

test("clearOandaCredentials empties both and drops the flag", () => {
  const out = applyOandaCredentialGuard({ clearOandaCredentials: true });
  assertEqual(out.oandaApiToken, "");
  assertEqual(out.oandaAccountId, "");
  assertEqual("clearOandaCredentials" in out, false);
});

test("input body object is not mutated", () => {
  const body = { oandaApiToken: "" };
  applyOandaCredentialGuard(body);
  assertEqual(body.oandaApiToken, "");
  assertEqual("oandaApiToken" in body, true);
});

test("oandaTokenHint only ever exposes the last 4 characters", () => {
  assertEqual(oandaTokenHint("fake-secret-wxyz"), "••••wxyz");
  assertEqual(oandaTokenHint(""), "");
  assertEqual(oandaTokenHint("ab"), "••••");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
