import type { BinanceClient } from "../binance/client.js";
import type { Kline, RuntimeSettings } from "../types.js";

export interface VolatilityResult {
  volatilityPercent: number | null;
  method: "atr" | "range" | "fallback";
}

export interface LeverageSafetyResult {
  ok: boolean;
  leverage: number;
  reasons: string[];
}

function clampLeverage(value: number, settings: RuntimeSettings): number {
  const min = Math.max(1, Math.floor(settings.minLeverage));
  const max = Math.max(min, Math.floor(settings.maxLeverage));
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export async function calculateVolatility(
  symbol: string,
  timeframe: string,
  lookback: number,
  binance: BinanceClient
): Promise<VolatilityResult> {
  const limit = Math.max(lookback + 1, 3);
  const candles = await binance.getKlines(symbol, timeframe, limit);
  const atr = calculateAtrVolatility(candles);
  if (atr !== null) return { volatilityPercent: atr, method: "atr" };
  const range = calculateRangeVolatility(candles);
  if (range !== null) return { volatilityPercent: range, method: "range" };
  return { volatilityPercent: null, method: "fallback" };
}

export function calculateAtrVolatility(candles: Kline[]): number | null {
  if (candles.length < 2) return null;
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    ranges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      )
    );
  }
  const currentPrice = candles.at(-1)?.close ?? 0;
  if (currentPrice <= 0 || ranges.length === 0) return null;
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  return (atr / currentPrice) * 100;
}

export function calculateRangeVolatility(candles: Kline[]): number | null {
  if (candles.length === 0) return null;
  const ranges = candles
    .filter((candle) => candle.close > 0)
    .map((candle) => ((candle.high - candle.low) / candle.close) * 100);
  if (ranges.length === 0) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function getRecommendedLeverage(
  symbol: string,
  volatility: number | null,
  settings: RuntimeSettings
): number {
  void symbol;
  if (settings.leverageMode === "fixed") {
    return clampLeverage(settings.fixedLeverage, settings);
  }
  if (volatility === null) return clampLeverage(settings.minLeverage, settings);

  const min = Math.max(1, Math.floor(settings.minLeverage));
  const max = Math.max(min, Math.floor(settings.maxLeverage));
  if (volatility < settings.lowVolatilityThreshold) return max;
  if (volatility < settings.mediumVolatilityThreshold) {
    return clampLeverage(Math.round((min + max) / 2), settings);
  }
  if (volatility < settings.highVolatilityThreshold) {
    return clampLeverage(min + 1, settings);
  }
  return min;
}

export function validateLeverageSafety(
  symbol: string,
  leverage: number,
  settings: RuntimeSettings
): LeverageSafetyResult {
  const reasons: string[] = [];
  const clean = Math.floor(leverage);
  if (!Number.isFinite(clean) || clean <= 0) {
    reasons.push(`${symbol} có leverage không hợp lệ`);
  }
  if (clean > settings.maxLeverage) {
    reasons.push(`${symbol} leverage ${clean}x vượt giới hạn ${settings.maxLeverage}x`);
  }
  if (clean < settings.minLeverage) {
    reasons.push(`${symbol} leverage ${clean}x thấp hơn mức tối thiểu ${settings.minLeverage}x`);
  }
  return {
    ok: reasons.length === 0,
    leverage: clampLeverage(clean, settings),
    reasons
  };
}

export function shouldSkipTradeByVolatility(
  symbol: string,
  volatility: number | null,
  settings: RuntimeSettings
): boolean {
  void symbol;
  if (!settings.skipTradeOnExtremeVolatility) return false;
  if (volatility === null) return false;
  return volatility >= settings.extremeVolatilityThreshold;
}
