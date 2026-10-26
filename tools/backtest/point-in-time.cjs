const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const FIVE = 300000,
  FIFTEEN = 900000;
const SESSION = Object.freeze({
  start: "2026-10-23T12:00:00.000Z",
  end: "2026-10-23T20:30:00.000Z",
  timeZone: "America/New_York",
  label: "23 October 2026, 08:00–16:30 New York (EDT)",
  checkpoints: 34,
});
const FRAME_MS = {
  "5min": FIVE,
  "15min": FIFTEEN,
  h1: 3600000,
  "4h": 14400000,
  "1day": 86400000,
  "1week": 604800000,
};
const FRAME_IDS = ["5min", "15min", "h1", "4h", "1day", "1week", "1month"];
const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
function cleanRows(rows, id) {
  assert.ok(Array.isArray(rows), `Missing ${id} candle history`);
  const seen = new Set();
  const cleaned = rows
    .map((row) => {
      assert.ok(
        typeof row.datetime === "string" &&
          /(?:Z|[+-]\d\d:\d\d)$/.test(row.datetime),
        `${id}: timezone must be explicit`,
      );
      const time = Date.parse(row.datetime);
      const [open, high, low, close] = ["open", "high", "low", "close"].map(
        (key) => Number(row[key]),
      );
      assert.ok(
        Number.isFinite(time) &&
          [open, high, low, close].every((n) => Number.isFinite(n) && n > 0),
        `${id}: invalid price/time`,
      );
      assert.ok(
        high >= Math.max(open, close, low) &&
          low <= Math.min(open, close, high),
        `${id}: invalid OHLC geometry`,
      );
      assert.ok(!seen.has(time), `${id}: duplicate timestamp ${row.datetime}`);
      seen.add(time);
      return {
        time,
        datetime: new Date(time).toISOString(),
        open,
        high,
        low,
        close,
        volume:
          row.volume !== null &&
          row.volume !== undefined &&
          Number.isFinite(Number(row.volume))
            ? Number(row.volume)
            : null,
        complete: row.complete,
      };
    })
    .sort((a, b) => a.time - b.time);
  assert.ok(cleaned.length > 1, `${id}: insufficient history`);
  return cleaned;
}
function normalizeDataset(payload) {
  assert.equal(
    payload?.provider,
    "oanda",
    "Require the terminal feed to identify its source as OANDA",
  );
  assert.equal(payload.status, "ok");
  const frames = {};
  for (const id of FRAME_IDS) {
    const frame = payload.data?.find((row) => row.id === id);
    assert.equal(
      String(frame?.symbolUsed)
        .replace(/[\s/_-]/g, "")
        .toUpperCase(),
      "XAUUSD",
      `${id}: wrong instrument`,
    );
    frames[id] = cleanRows(frame.values, id);
  }
  return {
    provider: payload.provider,
    cacheStatus: payload.cache_status || null,
    frames,
    rawSha256: sha256(payload),
  };
}
function rawBar(row, complete) {
  return {
    datetime: row.datetime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    complete,
  };
}
function aggregate(parts, start) {
  assert.ok(
    parts.length,
    "Cannot manufacture a forming candle without past prices",
  );
  return {
    datetime: new Date(start).toISOString(),
    open: parts[0].open,
    high: Math.max(...parts.map((row) => row.high)),
    low: Math.min(...parts.map((row) => row.low)),
    close: parts.at(-1).close,
    volume: parts.every((row) => row.volume !== null)
      ? parts.reduce((sum, row) => sum + row.volume, 0)
      : null,
    complete: false,
  };
}
function frameAt(dataset, id, cutoff) {
  const rows = dataset.frames[id],
    result = [];
  let reconstructed = null;
  const lower = dataset.frames["5min"];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.time >= cutoff) break;
    // Calendar-aligned D/W/M boundary timestamps come from the provider. No
    // future OHLC values are used. A holiday/weekend can conservatively delay
    // treating a higher-timeframe bar as closed; it never closes it early.
    const end = ["1day", "1week", "1month"].includes(id)
      ? (rows[i + 1]?.time ??
        (id === "1month" ? Infinity : row.time + FRAME_MS[id]))
      : row.time + FRAME_MS[id];
    if (end <= cutoff) {
      assert.notEqual(
        row.complete,
        false,
        `${id}: stale/unfinalized historical candle ${row.datetime}`,
      );
      result.push(rawBar(row, true));
    } else if (id !== "5min" && id !== "15min") {
      assert.ok(
        lower[0].time <= row.time,
        `${id}: M5 history does not cover the start of the forming parent bar`,
      );
      const parts = lower.filter(
        (part) => part.time >= row.time && part.time + FIVE <= cutoff,
      );
      if (parts.length) {
        result.push(aggregate(parts, row.time));
        reconstructed = {
          periodStart: row.datetime,
          lastSourceBarClose: new Date(parts.at(-1).time + FIVE).toISOString(),
          sourceBars: parts.length,
        };
      }
    }
  }
  return { values: result.slice(-5000), reconstructed };
}
function snapshotAt(dataset, cutoff) {
  assert.ok(Number.isFinite(cutoff));
  const data = [],
    audit = {};
  for (const id of FRAME_IDS) {
    const frame = frameAt(dataset, id, cutoff);
    data.push({ id, values: frame.values, symbolUsed: "XAU_USD" });
    audit[id] = {
      count: frame.values.length,
      first: frame.values[0]?.datetime || null,
      last: frame.values.at(-1)?.datetime || null,
      formingReconstructed: frame.reconstructed,
    };
  }
  const entry = data.find((frame) => frame.id === "15min");
  assert.ok(
    entry.values.length >= 1000,
    "Insufficient M15 warmup before this decision",
  );
  assert.equal(
    Date.parse(entry.values.at(-1).datetime) + FIFTEEN,
    cutoff,
    "M15 snapshot must end exactly at the decision cutoff",
  );
  data.push(
    { ...entry, id: "entry" },
    { ...data.find((frame) => frame.id === "1day"), id: "benchmark" },
    { id: "alpha_vantage", data: null, symbolUsed: "" },
  );
  return {
    market: { status: "ok", provider: "oanda", data },
    audit,
    cutoff: new Date(cutoff).toISOString(),
  };
}
function validateSessionCoverage(dataset, session = SESSION) {
  const start = Date.parse(session.start),
    end = Date.parse(session.end);
  const times = new Set(dataset.frames["5min"].map((row) => row.time));
  for (let t = start; t < end; t += FIVE)
    assert.ok(
      times.has(t),
      `Missing M5 execution candle ${new Date(t).toISOString()}`,
    );
  for (let t = start; t < end; t += FIFTEEN) snapshotAt(dataset, t);
  return {
    checkpoints: (end - start) / FIFTEEN,
    executionBars: (end - start) / FIVE,
  };
}
function extract(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a + start.length);
  assert.ok(
    a >= 0 && b > a && source.indexOf(start, a + start.length) === -1,
    `Source boundary changed: ${start}`,
  );
  return source.slice(a, b);
}
function createStrategyReplay(root, options = {}) {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const sharedSource = fs.readFileSync(
    path.join(root, "modules/analysis-engine.js"),
    "utf8",
  );
  const code =
    extract(
      app,
      "// --- Analysis Logic ---",
      "// --- Liquidity Notification System ---",
    ) +
    "\n" +
    extract(app, "function buildAiPrompt(", "function extractAiText(");
  if (options.engine !== "vm") {
    return {
      strategySha256: sha256(app),
      extractedLogicSha256: sha256(sharedSource + "\n" + code),
      evaluate(market, asOf) {
        const result = spawnSync(
          process.execPath,
          [path.join(root, "tools/backtest/strategy-native-worker.cjs")],
          {
            input: JSON.stringify({
              market,
              asOf,
              keepDiagnosticLogs: options.keepDiagnosticLogs === true,
            }),
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 8 * 1024 * 1024,
            // Broker/model credentials do not enter the computation subprocess.
            env: { TZ: "Asia/Kolkata", PATH: process.env.PATH || "" },
          },
        );
        if (result.error || result.status !== 0)
          throw new Error(
            `Historical strategy worker failed: ${result.error?.message || result.stderr.slice(0, 500) || result.signal}`,
          );
        return JSON.parse(result.stdout);
      },
    };
  }
  // Keep arrays, dates and math inside one native VM realm. Passing host-realm
  // math functions/arrays through thousands of candle operations is needlessly
  // expensive; the exact strategy/helper source is unchanged here.
  const context = vm.createContext(
    {
      __clock: Date.parse(SESSION.start),
      console: { log() {}, warn() {}, error() {} },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const setup = `
    const NativeDate = Date;
    globalThis.Date = class ReplayDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [globalThis.__clock])); }
      static now() { return globalThis.__clock; }
    };
    const SharedAnalysisEngine = (() => { const module = { exports: {} }; ${sharedSource}; return module.exports.AnalysisEngine; })();
    const state = { selectedTimeframe: "15min", selectedTimezone: "Asia/Kolkata", currentRmi: 100, previousRmi: 100, rmiBias: "neutral" };
    ${code}
    ${options.keepDiagnosticLogs ? "" : "LiquidityEngine._addDiagnosticLog = () => {};"}
    globalThis.__run = data => {
      const analysis = AnalysisEngine.run(data);
      analysis.liquidityPools = LiquidityEngine.computeLiquidityPools(data);
      analysis.liquidityEvents = LiquidityEngine.scanAllLiquidityEvents(analysis.liquidityPools, data);
      analysis.sessionLevels = LiquidityEngine._sessionState;
      return { analysis, prompt: buildAiPrompt(analysis, data) };
    };
  `;
  new vm.Script(setup, {
    filename: "current-terminal-strategy.js",
  }).runInContext(context, { timeout: 5000 });
  const execute = new vm.Script(
    "JSON.stringify(__run(JSON.parse(__inputJSON)))",
  );
  return {
    strategySha256: sha256(app),
    extractedLogicSha256: sha256(sharedSource + "\n" + code),
    evaluate(market, asOf) {
      context.__clock = asOf;
      context.__inputJSON = JSON.stringify(market);
      try {
        return JSON.parse(execute.runInContext(context, { timeout: 30000 }));
      } finally {
        delete context.__inputJSON;
      }
    },
  };
}

module.exports = {
  SESSION,
  FIVE,
  FIFTEEN,
  FRAME_IDS,
  sha256,
  normalizeDataset,
  snapshotAt,
  validateSessionCoverage,
  createStrategyReplay,
};
