import { atr } from "./indicators.js";
import type { Candle, ICTStrategyConfig, MarketStructureShift, SweepEvent, SwingPoint } from "./types.js";

export function detectMSSAfterSweep(
  ltfCandles: Candle[],
  sweep: SweepEvent,
  internalSwings: SwingPoint[],
  config: ICTStrategyConfig
): MarketStructureShift | null {
  const startIndex = ltfCandles.findIndex((candle) => candle.closeTime >= sweep.candleTime);
  if (startIndex < 0) return null;
  const maxIndex = Math.min(ltfCandles.length - 1, startIndex + config.sweep.maxBarsAfterSweepForMSS);
  const atrValue = atr(ltfCandles.slice(0, maxIndex + 1), config.displacement.atrLength) ?? 0;

  for (let i = startIndex; i <= maxIndex; i++) {
    const candle = ltfCandles[i];
    const brokenSwing = findBrokenSwing(internalSwings, sweep.direction, i);
    if (!brokenSwing) continue;
    const breakOk = sweep.direction === "long"
      ? (config.structure.requireCloseBreak ? candle.close > brokenSwing.price : candle.high > brokenSwing.price)
      : (config.structure.requireCloseBreak ? candle.close < brokenSwing.price : candle.low < brokenSwing.price);
    if (!breakOk) continue;
    const displacement = isDisplacement(candle, atrValue, config);
    return {
      direction: sweep.direction,
      candleIndex: i,
      candleTime: candle.closeTime,
      brokenSwing,
      breakPrice: brokenSwing.price,
      closePrice: candle.close,
      displacement,
      valid: true
    };
  }

  return null;
}

export function isDisplacement(candle: Candle, atrValue: number, config: ICTStrategyConfig): boolean {
  if (atrValue <= 0) return false;
  const range = Math.max(candle.high - candle.low, 1e-12);
  const body = Math.abs(candle.close - candle.open);
  return range >= atrValue * config.displacement.minAtrMultiplier && body / range >= 0.5;
}

function findBrokenSwing(
  swings: SwingPoint[],
  direction: "long" | "short",
  beforeIndex: number
): SwingPoint | null {
  const type = direction === "long" ? "high" : "low";
  const candidates = swings.filter((swing) => swing.type === type && swing.index < beforeIndex);
  return candidates.at(-1) ?? null;
}

