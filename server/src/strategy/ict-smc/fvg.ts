import { rangePct } from "./indicators.js";
import type { Candle, FairValueGap, ICTStrategyConfig, Timeframe } from "./types.js";

export function detectFVG(
  candles: Candle[],
  timeframe: Timeframe,
  config: ICTStrategyConfig
): FairValueGap[] {
  if (!config.fvg.enabled || candles.length < 3) return [];
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const left = candles[i - 2];
    const current = candles[i];
    if (current.low > left.high) {
      const lower = left.high;
      const upper = current.low;
      const sizePct = rangePct(upper, lower);
      gaps.push(buildGap("long", i - 2, i, upper, lower, sizePct, timeframe, candles, config));
    }
    if (current.high < left.low) {
      const upper = left.low;
      const lower = current.high;
      const sizePct = rangePct(upper, lower);
      gaps.push(buildGap("short", i - 2, i, upper, lower, sizePct, timeframe, candles, config));
    }
  }
  return gaps;
}

export function detectInversionFVG(candles: Candle[], fvgs: FairValueGap[]): FairValueGap[] {
  return fvgs.flatMap((fvg) => {
    const after = candles.slice(fvg.endIndex + 1);
    const inverted = fvg.direction === "long"
      ? after.some((candle) => candle.close < fvg.lower)
      : after.some((candle) => candle.close > fvg.upper);
    return inverted ? [{ ...fvg, direction: fvg.direction === "long" ? "short" : "long", inverted: true }] : [];
  });
}

function buildGap(
  direction: "long" | "short",
  startIndex: number,
  endIndex: number,
  upper: number,
  lower: number,
  sizePct: number,
  timeframe: Timeframe,
  candles: Candle[],
  config: ICTStrategyConfig
): FairValueGap {
  const filledPct = calculateFillPct(candles.slice(endIndex + 1), direction, upper, lower);
  return {
    id: `${timeframe}:${direction}:${candles[endIndex].closeTime}:${lower}:${upper}`,
    direction,
    startIndex,
    endIndex,
    upper,
    lower,
    mid: (upper + lower) / 2,
    sizePct,
    timeframe,
    filledPct,
    valid: sizePct >= config.fvg.minSizePct && filledPct < 100,
    inverted: false
  };
}

function calculateFillPct(candles: Candle[], direction: "long" | "short", upper: number, lower: number): number {
  const size = Math.max(upper - lower, 1e-12);
  let maxFill = 0;
  for (const candle of candles) {
    const fill = direction === "long"
      ? Math.max(0, upper - candle.low)
      : Math.max(0, candle.high - lower);
    maxFill = Math.max(maxFill, Math.min(100, fill / size * 100));
  }
  return maxFill;
}

