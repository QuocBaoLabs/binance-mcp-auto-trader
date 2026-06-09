import type { Candle, SwingPoint } from "./types.js";

export function detectSwings(candles: Candle[], length: number): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (length <= 0 || candles.length < length * 2 + 1) return swings;

  for (let i = length; i < candles.length - length; i++) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= length; offset++) {
      if (candle.high <= candles[i - offset].high || candle.high <= candles[i + offset].high) {
        isHigh = false;
      }
      if (candle.low >= candles[i - offset].low || candle.low >= candles[i + offset].low) {
        isLow = false;
      }
    }
    if (isHigh) {
      swings.push({ index: i, time: candle.closeTime, price: candle.high, type: "high", strength: length });
    }
    if (isLow) {
      swings.push({ index: i, time: candle.closeTime, price: candle.low, type: "low", strength: length });
    }
  }
  return swings;
}

export function lastSwing(swings: SwingPoint[], type: "high" | "low", beforeIndex?: number): SwingPoint | null {
  const filtered = swings.filter((swing) => swing.type === type && (beforeIndex === undefined || swing.index < beforeIndex));
  return filtered.at(-1) ?? null;
}

