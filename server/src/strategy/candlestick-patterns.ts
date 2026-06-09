import type { Kline } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Kết quả nhận diện mẫu nến — giữ tương thích ngược với sfp-engine.ts */
export interface CandlestickPatternResult {
  direction: "BULLISH" | "BEARISH";
  patternName: string;
  high: number;
  low: number;
  anchorPrice: number;
  confidence: number; // 0–100
  message: string;
}

export interface CandlePatternConfig {
  minBodyToRangeRatio: number;    // thân tối thiểu so với range
  strongBodyToRangeRatio: number; // ngưỡng thân mạnh
  smallBodyToRangeRatio: number;  // ngưỡng thân nhỏ / do dự
  engulfingBodyRatio: number;     // thân nhấn chìm phải >= thân trước * ratio
  haramiBodyRatio: number;        // thân harami phải < thân trước * ratio
  wickToBodyMaxRatio: number;     // râu tối đa so với thân (Three Soldiers/Crows)
  tweezerTolerancePct: number;    // sai số đỉnh/đáy nhíp (0.001 = 0.1%)
  requireTrendContext: boolean;   // bật để yêu cầu ngữ cảnh xu hướng
}

const DEFAULT_CONFIG: CandlePatternConfig = {
  minBodyToRangeRatio: 0.35,
  strongBodyToRangeRatio: 0.5,
  smallBodyToRangeRatio: 0.3,
  engulfingBodyRatio: 1.0,
  haramiBodyRatio: 0.6,
  wickToBodyMaxRatio: 0.5,
  tweezerTolerancePct: 0.001,
  requireTrendContext: false,
};

type Candle = Kline;

// ---------------------------------------------------------------------------
// Helper cơ bản
// ---------------------------------------------------------------------------

function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function candleRange(c: Candle): number {
  return c.high - c.low;
}

function upperWick(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}

function lowerWick(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}

function midBody(c: Candle): number {
  return (c.open + c.close) / 2;
}

function isBullishCandle(c: Candle): boolean {
  return c.close > c.open;
}

function isBearishCandle(c: Candle): boolean {
  return c.close < c.open;
}

function isSmallBody(c: Candle, cfg: CandlePatternConfig): boolean {
  const r = candleRange(c);
  if (r <= 0) return true;
  return body(c) <= r * cfg.smallBodyToRangeRatio;
}

function isStrongBull(c: Candle, cfg: CandlePatternConfig): boolean {
  const r = candleRange(c);
  return r > 0 && c.close > c.open && body(c) >= r * cfg.strongBodyToRangeRatio;
}

function isStrongBear(c: Candle, cfg: CandlePatternConfig): boolean {
  const r = candleRange(c);
  return r > 0 && c.close < c.open && body(c) >= r * cfg.strongBodyToRangeRatio;
}

function isValidBody(c: Candle, cfg: CandlePatternConfig): boolean {
  const r = candleRange(c);
  return r > 0 && body(c) >= r * cfg.minBodyToRangeRatio;
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function isFiniteCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.open) && Number.isFinite(c.close) &&
    Number.isFinite(c.high) && Number.isFinite(c.low) &&
    c.high >= c.low && c.open >= 0
  );
}

// ---------------------------------------------------------------------------
// Xu hướng ngắn hạn
// ---------------------------------------------------------------------------

/**
 * Phát hiện xu hướng trong `lookback` nến vừa đóng.
 * Dùng để tăng/giảm confidence của mẫu nến.
 */
export function detectShortTermTrend(
  candles: Candle[],
  lookback = 5
): "uptrend" | "downtrend" | "sideway" {
  if (candles.length < lookback + 1) return "sideway";
  const current = candles[candles.length - 1].close;
  const reference = candles[candles.length - 1 - lookback].close;
  if (reference <= 0 || !Number.isFinite(reference) || !Number.isFinite(current)) {
    return "sideway";
  }
  const pct = ((current - reference) / reference) * 100;
  if (pct > 0.5) return "uptrend";
  if (pct < -0.5) return "downtrend";
  return "sideway";
}

// ---------------------------------------------------------------------------
// Scoring nội bộ
// ---------------------------------------------------------------------------

function computeVolumeBoost(candles: Candle[]): number {
  const latest = candles[candles.length - 1]?.volume;
  if (!latest || !Number.isFinite(latest) || latest <= 0) return 0;
  const slice = candles.slice(-21, -1);
  if (slice.length === 0) return 0;
  const avg = slice.reduce((s, c) => s + c.volume, 0) / slice.length;
  if (avg <= 0) return 0;
  const ratio = latest / avg;
  if (ratio > 1.5) return 5;
  if (ratio > 1.2) return 2;
  return 0;
}

function computeTrendBoost(
  trend: "uptrend" | "downtrend" | "sideway",
  direction: "BULLISH" | "BEARISH"
): number {
  // Mẫu đảo chiều tăng mạnh hơn sau downtrend, và ngược lại
  if (direction === "BULLISH" && trend === "downtrend") return 5;
  if (direction === "BEARISH" && trend === "uptrend") return 5;
  if (trend === "sideway") return -3; // sideway → giảm độ tin cậy
  return 0;
}

function makeResult(
  direction: "BULLISH" | "BEARISH",
  patternName: string,
  usedCandles: Candle[],
  baseConfidence: number,
  message: string,
  boost: number
): CandlestickPatternResult {
  const high = Math.max(...usedCandles.map(c => c.high));
  const low = Math.min(...usedCandles.map(c => c.low));
  return {
    direction,
    patternName,
    high,
    low,
    anchorPrice: direction === "BULLISH" ? low : high,
    confidence: Math.max(0, Math.min(100, baseConfidence + boost)),
    message,
  };
}

// ---------------------------------------------------------------------------
// Mẫu nến TĂNG (multi-candle)
// ---------------------------------------------------------------------------

/** 2 nến: nến tăng nuốt trọn thân nến giảm trước */
export function bullishEngulfing(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 && candleRange(c2) > 0 &&
    isBearishCandle(c1) && isBullishCandle(c2) &&
    c2.open < c1.close &&
    c2.close > c1.open &&
    body(c2) >= body(c1) * cfg.engulfingBodyRatio &&
    isValidBody(c2, cfg)
  );
}

/** 2 nến: thân tăng nhỏ nằm trong thân giảm lớn */
export function bullishHarami(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isBearishCandle(c1) &&
    (isBullishCandle(c2) || isSmallBody(c2, cfg)) &&
    c2.open > c1.close &&
    c2.close < c1.open &&
    body(c2) < body(c1) * cfg.haramiBodyRatio
  );
}

/** 2 nến: nến tăng mở thấp hơn đáy nến giảm rồi đóng trên nửa thân nến giảm */
export function piercingPattern(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isStrongBear(c1, cfg) &&
    isBullishCandle(c2) &&
    c2.open < c1.close &&
    c2.close > midBody(c1) &&
    c2.close < c1.open
  );
}

/** 3 nến: nến giảm mạnh → do dự nhỏ → nến tăng mạnh đóng qua nửa thân nến đầu */
export function morningStar(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 && candleRange(c3) > 0 &&
    isStrongBear(c1, cfg) &&
    isSmallBody(c2, cfg) &&
    isStrongBull(c3, cfg) &&
    c3.close > midBody(c1)
  );
}

/** 3 nến: ba nến tăng liên tiếp, mỗi nến mở trong thân nến trước, râu trên ngắn */
export function threeWhiteSoldiers(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  const b1 = body(c1), b2 = body(c2), b3 = body(c3);
  return (
    b1 > 0 && b2 > 0 && b3 > 0 &&
    isBullishCandle(c1) && isBullishCandle(c2) && isBullishCandle(c3) &&
    c2.close > c1.close && c3.close > c2.close &&
    c2.open >= c1.open && c2.open <= c1.close &&   // c2 mở trong thân c1
    c3.open >= c2.open && c3.open <= c2.close &&   // c3 mở trong thân c2
    upperWick(c1) <= b1 * cfg.wickToBodyMaxRatio &&
    upperWick(c2) <= b2 * cfg.wickToBodyMaxRatio &&
    upperWick(c3) <= b3 * cfg.wickToBodyMaxRatio
  );
}

/** 3 nến: bullish harami → nến thứ ba xác nhận đóng trên đỉnh nến đầu */
export function threeInsideUp(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isBearishCandle(c1) &&
    (isBullishCandle(c2) || isSmallBody(c2, cfg)) &&
    c2.open > c1.close && c2.close < c1.open &&   // c2 trong thân c1
    isBullishCandle(c3) &&
    c3.close > c1.open
  );
}

/** 3 nến: bullish engulfing trên c1+c2 → c3 xác nhận đóng cao hơn */
export function threeOutsideUp(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    isBearishCandle(c1) &&
    bullishEngulfing(c1, c2, cfg) &&
    isBullishCandle(c3) &&
    c3.close > c2.close
  );
}

/** 2 nến: hai đáy gần bằng nhau, nến sau đóng tăng */
export function tweezerBottom(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  const tolerance = Math.max(Math.abs(c2.close) * cfg.tweezerTolerancePct, 1e-12);
  return (
    candleRange(c1) > 0 && candleRange(c2) > 0 &&
    isBearishCandle(c1) && isBullishCandle(c2) &&
    near(c1.low, c2.low, tolerance)
  );
}

// ---------------------------------------------------------------------------
// Mẫu nến GIẢM (multi-candle)
// ---------------------------------------------------------------------------

/** 2 nến: nến giảm nuốt trọn thân nến tăng trước */
export function bearishEngulfing(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 && candleRange(c2) > 0 &&
    isBullishCandle(c1) && isBearishCandle(c2) &&
    c2.open > c1.close &&
    c2.close < c1.open &&
    body(c2) >= body(c1) * cfg.engulfingBodyRatio &&
    isValidBody(c2, cfg)
  );
}

/** 2 nến: thân giảm nhỏ nằm trong thân tăng lớn */
export function bearishHarami(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isBullishCandle(c1) &&
    (isBearishCandle(c2) || isSmallBody(c2, cfg)) &&
    c2.open < c1.close &&
    c2.close > c1.open &&
    body(c2) < body(c1) * cfg.haramiBodyRatio
  );
}

/** 2 nến: nến giảm mở trên đỉnh nến tăng rồi đóng dưới nửa thân nến tăng */
export function darkCloudCover(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isStrongBull(c1, cfg) &&
    isBearishCandle(c2) &&
    c2.open > c1.close &&
    c2.close < midBody(c1) &&
    c2.close > c1.open
  );
}

/** 3 nến: nến tăng mạnh → do dự nhỏ → nến giảm mạnh đóng qua nửa thân nến đầu */
export function eveningStar(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 && candleRange(c3) > 0 &&
    isStrongBull(c1, cfg) &&
    isSmallBody(c2, cfg) &&
    isStrongBear(c3, cfg) &&
    c3.close < midBody(c1)
  );
}

/** 3 nến: ba nến giảm liên tiếp, mỗi nến mở trong thân nến trước, râu dưới ngắn */
export function threeBlackCrows(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  const b1 = body(c1), b2 = body(c2), b3 = body(c3);
  return (
    b1 > 0 && b2 > 0 && b3 > 0 &&
    isBearishCandle(c1) && isBearishCandle(c2) && isBearishCandle(c3) &&
    c2.close < c1.close && c3.close < c2.close &&
    c2.open <= c1.open && c2.open >= c1.close &&   // c2 mở trong thân c1
    c3.open <= c2.open && c3.open >= c2.close &&   // c3 mở trong thân c2
    lowerWick(c1) <= b1 * cfg.wickToBodyMaxRatio &&
    lowerWick(c2) <= b2 * cfg.wickToBodyMaxRatio &&
    lowerWick(c3) <= b3 * cfg.wickToBodyMaxRatio
  );
}

/** 3 nến: bearish harami → nến thứ ba xác nhận đóng dưới đáy nến đầu */
export function threeInsideDown(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    candleRange(c1) > 0 &&
    isBullishCandle(c1) &&
    (isBearishCandle(c2) || isSmallBody(c2, cfg)) &&
    c2.open < c1.close && c2.close > c1.open &&   // c2 trong thân c1
    isBearishCandle(c3) &&
    c3.close < c1.open
  );
}

/** 3 nến: bearish engulfing trên c1+c2 → c3 xác nhận đóng thấp hơn */
export function threeOutsideDown(c1: Candle, c2: Candle, c3: Candle, cfg: CandlePatternConfig): boolean {
  return (
    isBullishCandle(c1) &&
    bearishEngulfing(c1, c2, cfg) &&
    isBearishCandle(c3) &&
    c3.close < c2.close
  );
}

/** 2 nến: hai đỉnh gần bằng nhau, nến sau đóng giảm */
export function tweezerTop(c1: Candle, c2: Candle, cfg: CandlePatternConfig): boolean {
  const tolerance = Math.max(Math.abs(c2.close) * cfg.tweezerTolerancePct, 1e-12);
  return (
    candleRange(c1) > 0 && candleRange(c2) > 0 &&
    isBullishCandle(c1) && isBearishCandle(c2) &&
    near(c1.high, c2.high, tolerance)
  );
}

// ---------------------------------------------------------------------------
// Hàm phát hiện chính
// ---------------------------------------------------------------------------

/**
 * Quét 3 nến đã đóng gần nhất để tìm mẫu đảo chiều đa nến.
 * Ưu tiên mẫu 3 nến trước 2 nến. Trả về kết quả tốt nhất hoặc null.
 *
 * Chỉ dùng với nến đã đóng hoàn toàn (kline.x === true khi dùng WebSocket).
 */
export function detectCandlestickPattern(
  klines: Kline[],
  configOverride?: Partial<CandlePatternConfig>
): CandlestickPatternResult | null {
  if (klines.length < 3) return null;

  const cfg: CandlePatternConfig = { ...DEFAULT_CONFIG, ...configOverride };

  const c1 = klines[klines.length - 3];
  const c2 = klines[klines.length - 2];
  const c3 = klines[klines.length - 1];

  if (!isFiniteCandle(c1) || !isFiniteCandle(c2) || !isFiniteCandle(c3)) return null;

  const trend = detectShortTermTrend(klines, 5);
  const vBoost = computeVolumeBoost(klines);

  // ── 3-nến TĂNG (ưu tiên cao nhất) ────────────────────────────────────────

  if (morningStar(c1, c2, c3, cfg)) {
    return makeResult("BULLISH", "Morning Star", [c1, c2, c3], 78,
      "Morning Star: nến giảm mạnh → nến do dự nhỏ → nến tăng mạnh đóng qua nửa thân nến đầu.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (threeWhiteSoldiers(c1, c2, c3, cfg)) {
    return makeResult("BULLISH", "Three White Soldiers", [c1, c2, c3], 80,
      "Three White Soldiers: ba nến tăng liên tiếp, mỗi nến mở trong thân nến trước, râu trên ngắn.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (threeOutsideUp(c1, c2, c3, cfg)) {
    return makeResult("BULLISH", "Three Outside Up", [c1, c2, c3], 75,
      "Three Outside Up: bullish engulfing được nến thứ ba xác nhận đóng cao hơn.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (threeInsideUp(c1, c2, c3, cfg)) {
    return makeResult("BULLISH", "Three Inside Up", [c1, c2, c3], 70,
      "Three Inside Up: bullish harami rồi nến thứ ba xác nhận đóng trên đỉnh nến đầu.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  // ── 3-nến GIẢM ────────────────────────────────────────────────────────────

  if (eveningStar(c1, c2, c3, cfg)) {
    return makeResult("BEARISH", "Evening Star", [c1, c2, c3], 78,
      "Evening Star: nến tăng mạnh → nến do dự nhỏ → nến giảm mạnh đóng qua nửa thân nến đầu.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (threeBlackCrows(c1, c2, c3, cfg)) {
    return makeResult("BEARISH", "Three Black Crows", [c1, c2, c3], 80,
      "Three Black Crows: ba nến giảm liên tiếp, mỗi nến mở trong thân nến trước, râu dưới ngắn.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (threeOutsideDown(c1, c2, c3, cfg)) {
    return makeResult("BEARISH", "Three Outside Down", [c1, c2, c3], 75,
      "Three Outside Down: bearish engulfing được nến thứ ba xác nhận đóng thấp hơn.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (threeInsideDown(c1, c2, c3, cfg)) {
    return makeResult("BEARISH", "Three Inside Down", [c1, c2, c3], 70,
      "Three Inside Down: bearish harami rồi nến thứ ba xác nhận đóng dưới đáy nến đầu.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  // ── 2-nến TĂNG (dùng c2, c3) ─────────────────────────────────────────────

  if (bullishEngulfing(c2, c3, cfg)) {
    return makeResult("BULLISH", "Bullish Engulfing", [c2, c3], 68,
      "Bullish Engulfing: nến tăng nuốt trọn thân nến giảm trước — áp lực mua áp đảo.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (piercingPattern(c2, c3, cfg)) {
    return makeResult("BULLISH", "Piercing Pattern", [c2, c3], 65,
      "Piercing Pattern: nến tăng mở thấp hơn và đóng trên nửa thân nến giảm — lực mua phục hồi.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (tweezerBottom(c2, c3, cfg)) {
    return makeResult("BULLISH", "Tweezer Bottom", [c2, c3], 50,
      "Tweezer Bottom: hai đáy gần bằng nhau, nến sau đóng tăng — vùng hỗ trợ giữ vững hai lần.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  if (bullishHarami(c2, c3, cfg)) {
    return makeResult("BULLISH", "Bullish Harami", [c2, c3], 55,
      "Bullish Harami: thân nến tăng nhỏ nằm trong thân nến giảm lớn — đà giảm đang suy yếu.",
      computeTrendBoost(trend, "BULLISH") + vBoost);
  }

  // ── 2-nến GIẢM (dùng c2, c3) ─────────────────────────────────────────────

  if (bearishEngulfing(c2, c3, cfg)) {
    return makeResult("BEARISH", "Bearish Engulfing", [c2, c3], 68,
      "Bearish Engulfing: nến giảm nuốt trọn thân nến tăng trước — áp lực bán áp đảo.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (darkCloudCover(c2, c3, cfg)) {
    return makeResult("BEARISH", "Dark Cloud Cover", [c2, c3], 65,
      "Dark Cloud Cover: nến giảm mở trên cao rồi đóng dưới nửa thân nến tăng — phe bán chiếm ưu thế.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (tweezerTop(c2, c3, cfg)) {
    return makeResult("BEARISH", "Tweezer Top", [c2, c3], 50,
      "Tweezer Top: hai đỉnh gần bằng nhau, nến sau đóng giảm — vùng kháng cự cản giá hai lần.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  if (bearishHarami(c2, c3, cfg)) {
    return makeResult("BEARISH", "Bearish Harami", [c2, c3], 55,
      "Bearish Harami: thân nến giảm nhỏ nằm trong thân nến tăng lớn — đà tăng đang suy yếu.",
      computeTrendBoost(trend, "BEARISH") + vBoost);
  }

  return null;
}
