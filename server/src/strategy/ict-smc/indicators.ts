import type { Candle } from "./types.js";

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1 || period <= 0) return null;
  const ranges: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const candle = candles[i];
    const prev = candles[i - 1];
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prev.close),
      Math.abs(candle.low - prev.close)
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rangePct(upper: number, lower: number): number {
  const mid = (upper + lower) / 2;
  return mid > 0 ? Math.abs(upper - lower) / mid * 100 : 0;
}

