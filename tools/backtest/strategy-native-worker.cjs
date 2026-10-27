// Isolated, credential-free execution of trusted, unchanged strategy source.
// Input is sanitized historical market JSON, never executable code.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ROOT = path.resolve(__dirname, "../..");
function extract(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a + start.length);
  assert.ok(
    a >= 0 && b > a && source.indexOf(start, a + start.length) === -1,
    "Strategy source boundaries changed",
  );
  return source.slice(a, b);
}
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  assert.ok(Number.isFinite(input.asOf));
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const code =
    extract(
      app,
      "// --- Analysis Logic ---",
      "// --- Liquidity Notification System ---",
    ) +
    "\n" +
    extract(app, "function buildAiPrompt(", "function extractAiText(");
  assert.ok(
    !/\b(?:fetch|require)\s*\(|\b(?:process|window|document)\s*(?:\.[a-zA-Z_$]|\[)|new\s+(?:XMLHttpRequest|WebSocket|EventSource)/.test(
      code,
    ),
    "Unexpected I/O in extracted strategy; review before replay",
  );
  const { AnalysisEngine: shared } = require(
    path.join(ROOT, "modules/analysis-engine.js"),
  );
  const NativeDate = Date;
  class ClockDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [input.asOf]));
    }
    static now() {
      return input.asOf;
    }
  }
  const state = {
    selectedTimeframe: "15min",
    selectedTimezone: "Asia/Kolkata",
    currentRmi: 100,
    previousRmi: 100,
    rmiBias: "neutral",
  };
  const blocked = () => {
    throw new Error("I/O is disabled in the historical strategy worker");
  };
  const factory = new Function(
    "SharedAnalysisEngine",
    "state",
    "Date",
    "console",
    "fetch",
    "require",
    "process",
    "window",
    "document",
    "globalThis",
    '"use strict";\n' +
      code +
      "\n" +
      (input.keepDiagnosticLogs
        ? ""
        : "LiquidityEngine._addDiagnosticLog = () => {};") +
      "\n return data => { const analysis=AnalysisEngine.run(data); analysis.liquidityPools=LiquidityEngine.computeLiquidityPools(data); analysis.liquidityEvents=LiquidityEngine.scanAllLiquidityEvents(analysis.liquidityPools,data); analysis.sessionLevels=LiquidityEngine._sessionState; return {analysis,prompt:buildAiPrompt(analysis,data)}; };",
  );
  const run = factory(
    shared,
    state,
    ClockDate,
    { log() {}, warn() {}, error() {} },
    blocked,
    blocked,
    undefined,
    undefined,
    undefined,
    Object.freeze({}),
  );
  process.stdout.write(JSON.stringify(run(input.market)));
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 1;
}
