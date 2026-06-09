import { atr } from "./indicators.js";
import type { Candle, ICTStrategyConfig } from "./types.js";

export interface AMDSetup {
  type: "bullishAMD" | "bearishAMD";
  rangeHigh: number;
  rangeLow: number;
  manipulationCandleIndex: number;
  valid: boolean;
}

export function detectAMDSetup(candles: Candle[], config: ICTStrategyConfig): AMDSetup | null {
  if (!config.amd.enabled || candles.length < config.amd.rangeLookback + 2) return null;
  const last = candles.at(-1);
  if (!last) return null;
  const range = candles.slice(-(config.amd.rangeLookback + 1), -1);
  const rangeHigh = Math.max(...range.map((candle) => candle.high));
  const rangeLow = Math.min(...range.map((candle) => candle.low));
  const atrValue = atr(candles, config.displacement.atrLength);
  if (!atrValue || rangeHigh - rangeLow > atrValue * config.amd.maxRangeAtrMultiplier) return null;

  if (last.low < rangeLow && (!config.amd.requireFakeoutCloseBackInside || last.close > rangeLow)) {
    return { type: "bullishAMD", rangeHigh, rangeLow, manipulationCandleIndex: candles.length - 1, valid: true };
  }
  if (last.high > rangeHigh && (!config.amd.requireFakeoutCloseBackInside || last.close < rangeHigh)) {
    return { type: "bearishAMD", rangeHigh, rangeLow, manipulationCandleIndex: candles.length - 1, valid: true };
  }
  return null;
}

