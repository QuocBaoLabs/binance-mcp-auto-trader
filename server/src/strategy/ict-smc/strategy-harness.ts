import { readFile } from "node:fs/promises";
import { ICTSMCStrategyEngine } from "./engine.js";
import type { Candle, ICTAnalyzeInput } from "./types.js";

interface HarnessFile {
  symbol: string;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  ltfCandles: Candle[];
}

const filePath = process.argv[2];
if (!filePath) {
  console.log("Usage: npx tsx server/src/strategy/ict-smc/strategy-harness.ts candles.json");
  process.exit(0);
}

const payload = JSON.parse(await readFile(filePath, "utf8")) as HarnessFile;
const engine = new ICTSMCStrategyEngine();
let trades = 0;
let rrSum = 0;

for (let i = 30; i <= payload.ltfCandles.length; i++) {
  const now = payload.ltfCandles[i - 1].closeTime;
  const input: ICTAnalyzeInput = {
    symbol: payload.symbol,
    htfCandles: payload.htfCandles.filter((candle) => candle.closeTime <= now),
    mtfCandles: payload.mtfCandles.filter((candle) => candle.closeTime <= now),
    ltfCandles: payload.ltfCandles.slice(0, i)
  };
  const result = engine.analyze(input);
  if (!result.signal) continue;
  trades += 1;
  rrSum += result.signal.rr.tp2;
  console.log(JSON.stringify({
    time: now,
    signal: result.signal,
    debug: result.debug
  }, null, 2));
}

console.log(JSON.stringify({
  trades,
  averageRr: trades > 0 ? rrSum / trades : 0
}, null, 2));

