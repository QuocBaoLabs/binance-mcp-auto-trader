import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { staticConfig } from "../config.js";
import type { MarketSignal, SFPSignalRecord } from "../types.js";
import { AppDatabase } from "./database.js";

function makeMarketSignal(): MarketSignal {
  return {
    symbol: "BTCUSDT",
    interval: "1m",
    signal: "WAIT",
    confidence: 0,
    reason: "scan only",
    price: 100,
    emaFast: null,
    emaSlow: null,
    ema10: null,
    ema36: null,
    rsi: null,
    volumeChange: 0,
    fundingRate: null,
    openInterest: null,
    longShortRatio: null,
    supertrend: null,
    supertrendDirection: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
    sar: null,
    sarDirection: null,
    createdAt: new Date().toISOString()
  };
}

function makeSfpSignal(status: SFPSignalRecord["status"], chartPath?: string): SFPSignalRecord {
  return {
    strategy: "sfp",
    symbol: "BTCUSDT",
    timeframe: "1m",
    direction: "BULLISH",
    confirmed: true,
    swingPrice: 99,
    oppositeLevel: 101,
    sfpCandleHigh: 101,
    sfpCandleLow: 98,
    entryPrice: 100,
    slPrice: 98,
    tpPrice: 104,
    leverage: 1,
    marginUsdt: 10,
    status,
    message: status,
    decision: status === "pending" ? "TRADE" : "SKIP",
    decisionScore: 80,
    chartPath,
    chartUrl: chartPath ? "/charts/signals/test-prune.svg" : undefined,
    createdAt: new Date().toISOString()
  };
}

test("pruneTransientTradeData keeps rejected reasons and active trade signals", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trader-db-"));
  const db = new AppDatabase(path.join(tempDir, "test.sqlite"));
  fs.mkdirSync(staticConfig.signalChartDir, { recursive: true });
  const chartPath = path.join(staticConfig.signalChartDir, `test-prune-${Date.now()}.svg`);
  fs.writeFileSync(chartPath, "<svg></svg>");

  db.insertSignal(makeMarketSignal());
  db.insertOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    status: "SIMULATED",
    dryRun: true,
    source: "test",
    payload: { dryRun: true }
  });
  db.insertOrder({
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    status: "SUBMITTED",
    dryRun: false,
    source: "test",
    payload: { orderId: 1 }
  });
  db.insertSFPSignal(makeSfpSignal("simulated", chartPath));
  db.insertSFPSignal(makeSfpSignal("rejected"));
  db.insertSFPSignal(makeSfpSignal("ignored"));
  db.insertSFPSignal(makeSfpSignal("executed"));
  db.insertSFPSignal(makeSfpSignal("pending"));

  const result = db.pruneTransientTradeData();

  assert.equal(result.marketSignals, 1);
  assert.equal(result.transientSfpSignals, 1);
  assert.equal(result.dryRunOrders, 1);
  assert.equal(result.chartFiles, 1);
  assert.equal(db.listSignals(10).length, 0);
  assert.equal(db.listOrders(10).length, 1);
  assert.deepEqual(
    db.listSFPSignals(10).map(signal => signal.status).sort(),
    ["executed", "ignored", "pending", "rejected"]
  );
  assert.equal(fs.existsSync(chartPath), false);
});
