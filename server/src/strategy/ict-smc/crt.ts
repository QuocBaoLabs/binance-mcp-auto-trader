import type { Bias, Candle, Direction, ICTStrategyConfig } from "./types.js";

export interface CRTSetup {
  direction: Direction;
  candleIndex: number;
  high: number;
  low: number;
  valid: boolean;
}

export function detectCRTSetup(
  htfCandles: Candle[],
  ltfCandles: Candle[],
  bias: Bias,
  config: ICTStrategyConfig
): CRTSetup | null {
  if (!config.crt.enabled || htfCandles.length < 3 || ltfCandles.length < 3) return null;
  const candidates = htfCandles.slice(-10, -1);
  const lastLtf = ltfCandles.at(-1);
  if (!lastLtf) return null;

  if (bias === "bullish") {
    const bearish = findLastCandle(candidates, (candle) => candle.close < candle.open);
    if (bearish && lastLtf.low < bearish.low && lastLtf.close > bearish.low) {
      return { direction: "long", candleIndex: htfCandles.indexOf(bearish), high: bearish.high, low: bearish.low, valid: true };
    }
  }

  if (bias === "bearish") {
    const bullish = findLastCandle(candidates, (candle) => candle.close > candle.open);
    if (bullish && lastLtf.high > bullish.high && lastLtf.close < bullish.high) {
      return { direction: "short", candleIndex: htfCandles.indexOf(bullish), high: bullish.high, low: bullish.low, valid: true };
    }
  }

  return null;
}

function findLastCandle(candles: Candle[], predicate: (candle: Candle) => boolean): Candle | undefined {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (predicate(candles[i])) return candles[i];
  }
  return undefined;
}
