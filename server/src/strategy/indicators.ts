import type { Kline, TrendDirection } from "../types.js";

export interface SFPResult {
  direction: "BULLISH" | "BEARISH";
  confirmed: boolean;
  swingPrice: number;
  oppositeLevel: number;
  sfpCandleHigh: number;
  sfpCandleLow: number;
  sfpCandleOpen: number;
  sfpCandleClose: number;
  sfpCandleVolume: number;
  sfpCandleTime: number;
}

function makeSFPResult(
  direction: SFPResult["direction"],
  confirmed: boolean,
  swingPrice: number,
  oppositeLevel: number,
  candle: Kline
): SFPResult {
  return {
    direction,
    confirmed,
    swingPrice,
    oppositeLevel,
    sfpCandleHigh: candle.high,
    sfpCandleLow: candle.low,
    sfpCandleOpen: candle.open,
    sfpCandleClose: candle.close,
    sfpCandleVolume: candle.volume,
    sfpCandleTime: candle.openTime
  };
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    result = value * multiplier + result * (1 - multiplier);
  }
  return result;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function volumeChangePercent(values: number[], lookback = 20): number | null {
  if (values.length < lookback + 1) return null;
  const latest = values.at(-1) ?? 0;
  const previous = values.slice(-lookback - 1, -1);
  const average =
    previous.reduce((sum, value) => sum + value, 0) / Math.max(previous.length, 1);
  if (average === 0) return null;
  return ((latest - average) / average) * 100;
}

export function bollingerBands(
  values: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number; middle: number; lower: number } | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const middle = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance =
    slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  return {
    upper: middle + deviation * stdDevMultiplier,
    middle,
    lower: middle - deviation * stdDevMultiplier
  };
}

export function supertrend(
  klines: Kline[],
  period = 10,
  multiplier = 3
): { value: number; direction: TrendDirection } | null {
  if (klines.length < period + 2) return null;
  const trueRanges = klines.map((kline, index) => {
    if (index === 0) return kline.high - kline.low;
    const previousClose = klines[index - 1].close;
    return Math.max(
      kline.high - kline.low,
      Math.abs(kline.high - previousClose),
      Math.abs(kline.low - previousClose)
    );
  });

  let atr =
    trueRanges.slice(1, period + 1).reduce((sum, value) => sum + value, 0) /
    period;
  let finalUpper = 0;
  let finalLower = 0;
  let trendValue = 0;
  let direction: TrendDirection = "UP";

  for (let index = period + 1; index < klines.length; index += 1) {
    const kline = klines[index];
    const previousKline = klines[index - 1];
    atr = (atr * (period - 1) + trueRanges[index]) / period;
    const midpoint = (kline.high + kline.low) / 2;
    const basicUpper = midpoint + multiplier * atr;
    const basicLower = midpoint - multiplier * atr;

    if (index === period + 1) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      direction = kline.close >= previousKline.close ? "UP" : "DOWN";
      trendValue = direction === "UP" ? finalLower : finalUpper;
      continue;
    }

    finalUpper =
      basicUpper < finalUpper || previousKline.close > finalUpper
        ? basicUpper
        : finalUpper;
    finalLower =
      basicLower > finalLower || previousKline.close < finalLower
        ? basicLower
        : finalLower;

    if (trendValue === finalUpper) {
      if (kline.close <= finalUpper) {
        trendValue = finalUpper;
        direction = "DOWN";
      } else {
        trendValue = finalLower;
        direction = "UP";
      }
    } else if (kline.close >= finalLower) {
      trendValue = finalLower;
      direction = "UP";
    } else {
      trendValue = finalUpper;
      direction = "DOWN";
    }
  }

  return { value: trendValue, direction };
}

export function swingFailurePattern(klines: Kline[], len = 5): SFPResult | null {
  const n = klines.length;
  if (n < len * 2 + 3) return null;

  // Most recent confirmed pivot high: high[i] > all left[len] AND high[i] > high[i+1]
  let swingHBix = -1;
  let swingHPrc = 0;
  for (let i = n - 2; i >= len; i--) {
    const ph = klines[i].high;
    let ok = klines[i + 1].high < ph;
    for (let j = 1; j <= len && ok; j++) if (klines[i - j].high >= ph) ok = false;
    if (ok) { swingHBix = i; swingHPrc = ph; break; }
  }

  // Most recent confirmed pivot low
  let swingLBix = -1;
  let swingLPrc = 0;
  for (let i = n - 2; i >= len; i--) {
    const pl = klines[i].low;
    let ok = klines[i + 1].low > pl;
    for (let j = 1; j <= len && ok; j++) if (klines[i - j].low <= pl) ok = false;
    if (ok) { swingLBix = i; swingLPrc = pl; break; }
  }

  const last = klines[n - 1];

  // Bearish SFP: wick above swing high, close back below — open position irrelevant
  if (swingHBix >= 0 && n - 1 - swingHBix <= 500 &&
      last.high > swingHPrc && last.close < swingHPrc) {
    let opposL = swingHPrc;
    for (let i = swingHBix + 1; i < n - 1; i++) if (klines[i].low < opposL) opposL = klines[i].low;
    return makeSFPResult("BEARISH", last.close < opposL, swingHPrc, opposL, last);
  }

  // Bullish SFP: wick below swing low, close back above — open position irrelevant
  if (swingLBix >= 0 && n - 1 - swingLBix <= 500 &&
      last.low < swingLPrc && last.close > swingLPrc) {
    let opposH = swingLPrc;
    for (let i = swingLBix + 1; i < n - 1; i++) if (klines[i].high > opposH) opposH = klines[i].high;
    return makeSFPResult("BULLISH", last.close > opposH, swingLPrc, opposH, last);
  }

  // Confirmation: current candle closes past the opposite level of a recent SFP
  for (let sfpBar = n - 2; sfpBar >= Math.max(1, n - 11); sfpBar--) {
    const sfpC = klines[sfpBar];
    if (swingHBix >= 0 && swingHBix < sfpBar && sfpBar - swingHBix <= 500 &&
        sfpC.high > swingHPrc && sfpC.close < swingHPrc) {
      let opposL = swingHPrc;
      for (let i = swingHBix + 1; i < sfpBar; i++) if (klines[i].low < opposL) opposL = klines[i].low;
      if (last.close < opposL) {
        return makeSFPResult("BEARISH", true, swingHPrc, opposL, sfpC);
      }
    }
    if (swingLBix >= 0 && swingLBix < sfpBar && sfpBar - swingLBix <= 500 &&
        sfpC.low < swingLPrc && sfpC.close > swingLPrc) {
      let opposH = swingLPrc;
      for (let i = swingLBix + 1; i < sfpBar; i++) if (klines[i].high > opposH) opposH = klines[i].high;
      if (last.close > opposH) {
        return makeSFPResult("BULLISH", true, swingLPrc, opposH, sfpC);
      }
    }
  }

  return null;
}

export function parabolicSar(
  klines: Kline[],
  step = 0.02,
  maxStep = 0.2
): { value: number; direction: TrendDirection } | null {
  if (klines.length < 3) return null;
  let direction: TrendDirection =
    klines[1].close >= klines[0].close ? "UP" : "DOWN";
  let sar = direction === "UP" ? klines[0].low : klines[0].high;
  let extremePoint = direction === "UP" ? klines[1].high : klines[1].low;
  let acceleration = step;

  for (let index = 2; index < klines.length; index += 1) {
    const current = klines[index];
    const previous = klines[index - 1];
    const beforePrevious = klines[index - 2];
    sar = sar + acceleration * (extremePoint - sar);

    if (direction === "UP") {
      sar = Math.min(sar, previous.low, beforePrevious.low);
      if (current.low < sar) {
        direction = "DOWN";
        sar = extremePoint;
        extremePoint = current.low;
        acceleration = step;
      } else if (current.high > extremePoint) {
        extremePoint = current.high;
        acceleration = Math.min(maxStep, acceleration + step);
      }
    } else {
      sar = Math.max(sar, previous.high, beforePrevious.high);
      if (current.high > sar) {
        direction = "UP";
        sar = extremePoint;
        extremePoint = current.high;
        acceleration = step;
      } else if (current.low < extremePoint) {
        extremePoint = current.low;
        acceleration = Math.min(maxStep, acceleration + step);
      }
    }
  }

  return { value: sar, direction };
}
