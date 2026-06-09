export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WyckoffSettings {
  rsiLength: number;
  trendSensitivity: number;
  pivotLength: number;
  useVolumeFilter?: boolean;
  volumeMaLength?: number;
  breakoutBufferPct?: number;
  retestTolerancePct?: number;
  maxRiskDistancePct?: number;
  minConfidence?: number;
  slBufferPct?: number;
  // Leverage-aware risk gates — must match the executor's margin settings
  leverage?: number;
  marginType?: "CROSSED" | "ISOLATED";
}

export type WyckoffBoxType = "Accumulation" | "Distribution" | "Unknown";
export type WyckoffSignalType =
  | "SC"
  | "AR_ACC"
  | "ST_ACC"
  | "BC"
  | "AR_DIST"
  | "ST_DIST"
  | "PIVOT_LOW"
  | "PIVOT_HIGH"
  | "SPRING"     // wick dưới box.low → đóng lại trên → LONG trigger
  | "UPTHRUST";  // wick trên box.high → đóng lại dưới → SHORT trigger

export interface WyckoffBox {
  type: WyckoffBoxType;
  startIndex: number;
  endIndex: number;
  high: number;
  low: number;
}

export interface WyckoffSignal {
  type: WyckoffSignalType;
  signalIndex: number;
  confirmedIndex: number;
  price: number;
  rsi: number;
}

// Order Block — vùng nến tổ chức (SMC/ICT)
export interface OBZone {
  kind: "bullish" | "bearish";
  candleIndex: number;   // vị trí nến OB
  high: number;          // đỉnh nến OB (bao gồm bóng)
  low: number;           // đáy nến OB (bao gồm bóng)
  bodyHigh: number;      // thân trên (open hoặc close, lấy cái cao hơn)
  bodyLow: number;       // thân dưới
  mitigated: boolean;    // giá đã đi vào OB zone chưa (dùng một phần rồi)
}

export interface WyckoffAnalysisResult {
  rsi: number[];
  boxes: WyckoffBox[];
  signals: WyckoffSignal[];
  orderBlocks: OBZone[];
  lastBox?: WyckoffBox;
  lastSignal?: WyckoffSignal;
  lastTrend?: WyckoffBoxType;
}

export interface WyckoffTradeSignal {
  side: "LONG" | "SHORT" | "NONE";
  reason: string[];
  entryType?: "BREAKOUT" | "RETEST";
  entryPrice?: number;
  stopLoss?: number;
  takeProfit1?: number;
  takeProfit2?: number;
  invalidationPrice?: number;
  confidence: number;
}

const DEFAULT_WYCKOFF_SETTINGS: Required<WyckoffSettings> = {
  rsiLength: 14,
  trendSensitivity: 20,
  pivotLength: 5,
  useVolumeFilter: false,
  volumeMaLength: 20,
  breakoutBufferPct: 0.1,
  retestTolerancePct: 0.2,
  maxRiskDistancePct: 3,
  minConfidence: 65,
  slBufferPct: 0.5,
  leverage: 1,
  marginType: "CROSSED"
};

interface PivotEvent {
  kind: "low" | "high";
  signalIndex: number;
  confirmedIndex: number;
  price: number;
  rsi: number;
}

function withDefaults(settings: Partial<WyckoffSettings> = {}): Required<WyckoffSettings> {
  return { ...DEFAULT_WYCKOFF_SETTINGS, ...settings };
}

// Returns true when the candle at `idx` shows climax characteristics:
// volume spike (≥1.2× MA) OR candle range spike (≥1.4× MA).
// TradingView's Wyckoff requires climax volume/range for SC and BC events.
// Falls back to true when there is too little context data.
function isClimaxCandle(candles: readonly Candle[], idx: number, maLen: number): boolean {
  const len = Math.max(5, Math.min(maLen, 20));
  const start = Math.max(0, idx - len);
  const ctx = candles.slice(start, idx);
  if (ctx.length < 3) return true; // insufficient history → don't filter
  const avgVol   = ctx.reduce((s, c) => s + c.volume,          0) / ctx.length;
  const avgRange = ctx.reduce((s, c) => s + (c.high - c.low),  0) / ctx.length;
  const c = candles[idx];
  if (!c) return false;
  const volSpike   = avgVol   > 0 && c.volume         >= avgVol   * 1.15;
  const rangeSpike = avgRange > 0 && (c.high - c.low) >= avgRange * 1.2;
  return volSpike || rangeSpike;
}

export function wilderRsi(values: number[], period = 14): number[] {
  const output = Array(values.length).fill(Number.NaN) as number[];
  if (values.length <= period || period < 1) return output;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = averageLoss === 0
    ? 100
    : 100 - 100 / (1 + averageGain / averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = averageLoss === 0
      ? 100
      : 100 - 100 / (1 + averageGain / averageLoss);
  }

  return output;
}

// Detect Order Blocks (SMC/ICT):
//   Bullish OB = last bearish candle before a strong upward displacement
//   Bearish OB = last bullish candle before a strong downward displacement
// Displacement = next candle(s) close breaks the OB candle's high/low with volume.
function detectOrderBlocks(candles: readonly Candle[], volMaLen: number): OBZone[] {
  const DISPLACEMENT_WINDOW = 5; // look ahead up to 5 candles
  const result: OBZone[] = [];
  const len = candles.length;

  for (let i = 0; i < len - 1; i++) {
    const c = candles[i];
    if (!c) continue;
    const isBearish = c.close < c.open;
    const isBullish = c.close > c.open;
    if (!isBearish && !isBullish) continue;

    // Volume context for displacement confirmation
    const volStart = Math.max(0, i - volMaLen);
    const volCtx = candles.slice(volStart, i);
    const avgVol = volCtx.length > 0
      ? volCtx.reduce((s, x) => s + x.volume, 0) / volCtx.length
      : 0;

    let displaced = false;
    let displIdx = i + 1;

    // Check next DISPLACEMENT_WINDOW candles for displacement
    for (let j = i + 1; j <= Math.min(i + DISPLACEMENT_WINDOW, len - 1); j++) {
      const next = candles[j];
      if (!next) break;
      const hasVol = avgVol > 0 ? next.volume >= avgVol * 1.1 : true;

      if (isBearish && next.close > c.high && hasVol) {
        // Bullish displacement — this bearish candle is a Bullish OB
        displaced = true; displIdx = j; break;
      }
      if (isBullish && next.close < c.low && hasVol) {
        // Bearish displacement — this bullish candle is a Bearish OB
        displaced = true; displIdx = j; break;
      }
    }
    if (!displaced) continue;

    const kind: OBZone["kind"] = isBearish ? "bullish" : "bearish";
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow  = Math.min(c.open, c.close);

    // Check if OB has been mitigated (price entered the body zone after displacement)
    let mitigated = false;
    for (let k = displIdx + 1; k < len; k++) {
      const ck = candles[k];
      if (!ck) break;
      if (kind === "bullish" && ck.low <= bodyHigh && ck.high >= bodyLow) {
        mitigated = true; break;
      }
      if (kind === "bearish" && ck.high >= bodyLow && ck.low <= bodyHigh) {
        mitigated = true; break;
      }
    }

    result.push({ kind, candleIndex: i, high: c.high, low: c.low, bodyHigh, bodyLow, mitigated });
  }

  // Keep only the 3 most recent unmitigated OBs per direction to reduce noise
  const bullishOBs = result.filter(o => o.kind === "bullish" && !o.mitigated).slice(-3);
  const bearishOBs = result.filter(o => o.kind === "bearish" && !o.mitigated).slice(-3);
  // Plus all mitigated ones (for chart display only, grayed out)
  const mitigated  = result.filter(o => o.mitigated).slice(-2);
  return [...mitigated, ...bullishOBs, ...bearishOBs];
}

export function analyzeWyckoff(
  candles: readonly Candle[],
  rawSettings: Partial<WyckoffSettings> = {}
): WyckoffAnalysisResult {
  const settings = withDefaults(rawSettings);
  const rsiHigh = 50 + settings.trendSensitivity;
  const rsiLow = 50 - settings.trendSensitivity;
  const closes = candles.map((candle) => candle.close);
  const rsiValues = wilderRsi(closes, settings.rsiLength);
  const boxes: WyckoffBox[] = [];
  const signals: WyckoffSignal[] = [];
  const pivots: PivotEvent[] = [];

  // --- Box detection: RSI mid-range = sideways/trading range ---
  let sidewayStart: number | null = null;
  let sidewayHigh = Number.NEGATIVE_INFINITY;
  let sidewayLow = Number.POSITIVE_INFINITY;

  for (let index = 1; index < candles.length; index += 1) {
    const currentRsi = rsiValues[index];
    const previousRsi = rsiValues[index - 1];
    if (!Number.isFinite(currentRsi) || !Number.isFinite(previousRsi)) continue;

    const currentInside = currentRsi >= rsiLow && currentRsi <= rsiHigh;
    const previousInside = previousRsi >= rsiLow && previousRsi <= rsiHigh;
    const side = currentInside || previousInside;
    const bull = currentRsi > rsiHigh && previousRsi > rsiHigh;
    const bear = currentRsi < rsiLow && previousRsi < rsiLow;

    if (side) {
      if (sidewayStart === null) {
        sidewayStart = index - (previousInside ? 1 : 0);
        sidewayHigh = candles[sidewayStart]?.high ?? candles[index].high;
        sidewayLow = candles[sidewayStart]?.low ?? candles[index].low;
      }
      sidewayHigh = Math.max(sidewayHigh, candles[index].high);
      sidewayLow = Math.min(sidewayLow, candles[index].low);
      continue;
    }

    if (sidewayStart !== null) {
      const boxWidth = index - sidewayStart;
      // Require at least pivotLength candles — too narrow a box has no meaningful pivots
      if (boxWidth >= settings.pivotLength) {
        const type: WyckoffBoxType = bull ? "Accumulation" : bear ? "Distribution" : "Unknown";
        boxes.push({
          type,
          startIndex: sidewayStart,
          endIndex: index - 1,
          high: sidewayHigh,
          low: sidewayLow
        });
      }
      sidewayStart = null;
      sidewayHigh = Number.NEGATIVE_INFINITY;
      sidewayLow = Number.POSITIVE_INFINITY;
    }
  }

  // Close any open sideways zone at the last candle
  if (sidewayStart !== null && candles.length > 0) {
    const boxWidth = candles.length - 1 - sidewayStart;
    if (boxWidth >= settings.pivotLength) {
      boxes.push({
        type: "Unknown",
        startIndex: sidewayStart,
        endIndex: candles.length - 1,
        high: sidewayHigh,
        low: sidewayLow
      });
    }
  }

  // --- Global pivot detection (PIVOT_LOW / PIVOT_HIGH) ---
  const len = Math.max(1, Math.floor(settings.pivotLength));
  for (let currentIndex = len * 2; currentIndex < candles.length; currentIndex += 1) {
    const center = currentIndex - len;
    const window = candles.slice(center - len, center + len + 1);
    const centerCandle = candles[center];
    const centerRsi = rsiValues[center];
    if (!centerCandle || !Number.isFinite(centerRsi)) continue;

    const isPivotLow = window.every((candle, offset) =>
      offset === len ? true : centerCandle.low < candle.low
    );
    const isPivotHigh = window.every((candle, offset) =>
      offset === len ? true : centerCandle.high > candle.high
    );

    if (isPivotLow) {
      pivots.push({
        kind: "low",
        signalIndex: center,
        confirmedIndex: currentIndex,
        price: centerCandle.low,
        rsi: centerRsi
      });
      signals.push({
        type: "PIVOT_LOW",
        signalIndex: center,
        confirmedIndex: currentIndex,
        price: centerCandle.low,
        rsi: centerRsi
      });
    }
    if (isPivotHigh) {
      pivots.push({
        kind: "high",
        signalIndex: center,
        confirmedIndex: currentIndex,
        price: centerCandle.high,
        rsi: centerRsi
      });
      signals.push({
        type: "PIVOT_HIGH",
        signalIndex: center,
        confirmedIndex: currentIndex,
        price: centerCandle.high,
        rsi: centerRsi
      });
    }
  }

  // --- Per-box Wyckoff event detection ---
  // State machine: prior trend gates which climax type is valid;
  // the FIRST qualifying climax locks the box direction so Accumulation
  // and Distribution events can never mix inside the same box.
  for (const box of boxes) {
    let sc: WyckoffSignal | null = null;
    let arAcc: WyckoffSignal | null = null;
    let bc: WyckoffSignal | null = null;
    let arDist: WyckoffSignal | null = null;
    let boxMode: "acc" | "dist" | null = null; // locked after first climax fires

    // Prior trend: 15 candles before box start
    const lookback = Math.min(15, box.startIndex);
    const priorA = lookback >= 2 ? candles[Math.max(0, box.startIndex - lookback)] : null;
    const priorB = box.startIndex > 0 ? candles[box.startIndex - 1] : null;
    let priorTrend: "up" | "down" | "flat" = "flat";
    if (priorA && priorB) {
      const pct = ((priorB.close - priorA.close) / priorA.close) * 100;
      if (pct <= -0.8) priorTrend = "down";
      else if (pct >= 0.8) priorTrend = "up";
    }
    const canBeAcc  = priorTrend !== "up";   // downtrend or flat → SC possible
    const canBeDist = priorTrend !== "down"; // uptrend or flat   → BC possible

    const boxPivots = pivots.filter(
      (p) => p.signalIndex >= box.startIndex && p.signalIndex <= box.endIndex
    );

    for (const pivot of boxPivots) {
      const currentRsi  = rsiValues[pivot.confirmedIndex];
      const previousRsi = rsiValues[pivot.confirmedIndex - 1];
      const spring =
        Number.isFinite(currentRsi) && Number.isFinite(previousRsi)
          ? currentRsi > rsiLow && previousRsi < rsiLow : false;
      const utad =
        Number.isFinite(currentRsi) && Number.isFinite(previousRsi)
          ? currentRsi < rsiHigh && previousRsi > rsiHigh : false;
      const climax = isClimaxCandle(candles, pivot.signalIndex, settings.volumeMaLength);

      // Phase 1 — direction not yet locked: search for first qualifying climax
      if (boxMode === null) {
        if (canBeAcc && pivot.kind === "low" && !spring && climax) {
          boxMode = "acc";
          sc = pushWyckoffSignal(signals, "SC", pivot);
        } else if (canBeDist && pivot.kind === "high" && !utad && climax) {
          boxMode = "dist";
          bc = pushWyckoffSignal(signals, "BC", pivot);
        }
        continue; // keep scanning until direction is locked
      }

      // Phase 2 — direction locked: emit follow-on events only for that direction
      if (boxMode === "acc") {
        if (pivot.kind === "high" && sc && pivot.signalIndex > sc.signalIndex && arAcc === null) {
          arAcc = pushWyckoffSignal(signals, "AR_ACC", pivot);
          continue;
        }
        if (
          pivot.kind === "low" && sc && arAcc &&
          pivot.signalIndex > arAcc.signalIndex &&
          pivot.signalIndex !== sc.signalIndex
        ) {
          const nearSc      = pivot.price >= sc.price * 0.97;
          const nearBoxLow  = isNearRecentBoxLow(boxes, pivot.signalIndex, pivot.price);
          if (nearSc || nearBoxLow) pushWyckoffSignal(signals, "ST_ACC", pivot);
        }
      } else {
        if (pivot.kind === "low" && bc && pivot.signalIndex > bc.signalIndex && arDist === null) {
          arDist = pushWyckoffSignal(signals, "AR_DIST", pivot);
          continue;
        }
        if (
          pivot.kind === "high" && bc && arDist &&
          pivot.signalIndex > arDist.signalIndex &&
          pivot.signalIndex !== bc.signalIndex
        ) {
          pushWyckoffSignal(signals, "ST_DIST", pivot);
        }
      }
    }
  }

  signals.sort((left, right) =>
    left.confirmedIndex - right.confirmedIndex || left.signalIndex - right.signalIndex
  );

  // Reclassify Unknown boxes: events detected inside take priority, then prior-price trend.
  // This enables short-timeframe Wyckoff where RSI rarely hits extremes.
  for (const box of boxes) {
    if (box.type !== "Unknown") continue;
    const inBox = signals.filter(
      (s) => s.signalIndex >= box.startIndex && s.signalIndex <= box.endIndex
    );
    const hasAcc = inBox.some((s) => s.type === "SC" || s.type === "AR_ACC" || s.type === "ST_ACC");
    const hasDist = inBox.some((s) => s.type === "BC" || s.type === "AR_DIST" || s.type === "ST_DIST");
    if (hasAcc && !hasDist) {
      box.type = "Accumulation";
    } else if (hasDist && !hasAcc) {
      box.type = "Distribution";
    } else if (!hasAcc && !hasDist) {
      // Fall back to prior-price trend: downtrend before box → Accumulation, uptrend → Distribution
      const lookback = Math.min(20, box.startIndex);
      if (lookback >= 2) {
        const priorStart = candles[Math.max(0, box.startIndex - lookback)];
        const priorEnd = candles[box.startIndex - 1];
        if (priorStart && priorEnd) {
          const pctChange = ((priorEnd.close - priorStart.close) / priorStart.close) * 100;
          if (pctChange <= -1.5) box.type = "Accumulation";
          else if (pctChange >= 1.5) box.type = "Distribution";
        }
      }
    }
  }

  // --- Spring / Upthrust detection (price-based, per box) ---
  // Spring:   wick < box.low  AND close >= box.low  → bẫy shorts → LONG signal
  // Upthrust: wick > box.high AND close <= box.high → bẫy longs  → SHORT signal
  for (const box of boxes) {
    const accCtx  = box.type === "Accumulation" || box.type === "Unknown";
    const distCtx = box.type === "Distribution"  || box.type === "Unknown";
    const end = Math.min(box.endIndex, candles.length - 2); // exclude current forming candle
    for (let i = box.startIndex; i <= end; i++) {
      const c = candles[i];
      if (!c) continue;
      // Spring: wick pierces below support, closes back inside box
      if (accCtx && c.low < box.low && c.close >= box.low) {
        if (isClimaxCandle(candles, i, settings.volumeMaLength)) {
          signals.push({
            type: "SPRING",
            signalIndex: i,
            confirmedIndex: i,
            price: c.low,        // price = actual spring low (SL anchor)
            rsi: rsiValues[i] ?? Number.NaN
          });
          // Spring implies Accumulation — reclassify Unknown
          if (box.type === "Unknown") box.type = "Accumulation";
        }
      }
      // Upthrust: wick pierces above resistance, closes back inside box
      if (distCtx && c.high > box.high && c.close <= box.high) {
        if (isClimaxCandle(candles, i, settings.volumeMaLength)) {
          signals.push({
            type: "UPTHRUST",
            signalIndex: i,
            confirmedIndex: i,
            price: c.high,       // price = actual upthrust high (SL anchor)
            rsi: rsiValues[i] ?? Number.NaN
          });
          if (box.type === "Unknown") box.type = "Distribution";
        }
      }
    }
  }

  // Re-sort after adding Spring/Upthrust signals
  signals.sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.signalIndex - b.signalIndex);

  // --- Order Block detection ---
  const orderBlocks = detectOrderBlocks(candles, settings.volumeMaLength);

  const lastBox = boxes.at(-1);
  const lastSignal = signals.at(-1);
  return {
    rsi: rsiValues,
    boxes,
    signals,
    orderBlocks,
    lastBox,
    lastSignal,
    lastTrend: lastBox?.type ?? "Unknown"
  };
}

export function generateWyckoffTradeSignal(
  candles: readonly Candle[],
  analysis: WyckoffAnalysisResult,
  rawSettings: Partial<WyckoffSettings> = {},
  entryPriceOverride?: number
): WyckoffTradeSignal {
  const settings = withDefaults(rawSettings);
  const reasons: string[] = [];
  const last = candles.at(-1);
  const lastBox = analysis.lastBox;
  if (!last || !lastBox) {
    return none(["Thiếu candle hoặc chưa có Wyckoff box."], 0);
  }

  const currentRsi = analysis.rsi.at(-1);
  if (!Number.isFinite(currentRsi)) {
    return none(["Chưa đủ dữ liệu RSI để đánh giá Wyckoff."], 0);
  }
  const currentRsiValue = currentRsi as number;

  // Use live price when provided (avoids look-ahead bias from last.close)
  const entryPrice =
    entryPriceOverride !== undefined && Number.isFinite(entryPriceOverride) && entryPriceOverride > 0
      ? entryPriceOverride
      : last.close;

  const volumeOk = isVolumeConfirmed(candles, settings);
  const recentSignals = analysis.signals.filter((signal) =>
    signal.confirmedIndex >= lastBox.startIndex && signal.confirmedIndex <= candles.length - 1
  );
  const breakoutBuffer = settings.breakoutBufferPct;
  const retestTolerance = settings.retestTolerancePct;

  const longSetup = lastBox.type === "Accumulation";
  const shortSetup = lastBox.type === "Distribution";
  const hasSc = recentSignals.some((s) => s.type === "SC");
  const hasArAcc = recentSignals.some((s) => s.type === "AR_ACC");
  const hasStAcc = recentSignals.some((s) => s.type === "ST_ACC");
  const hasBc = recentSignals.some((s) => s.type === "BC");
  const hasArDist = recentSignals.some((s) => s.type === "AR_DIST");
  const hasStDist = recentSignals.some((s) => s.type === "ST_DIST");

  const longBreakout = entryPrice > lastBox.high * (1 + breakoutBuffer / 100);
  const shortBreakdown = entryPrice < lastBox.low * (1 - breakoutBuffer / 100);
  const longRetest =
    hadBreakout(candles, lastBox, "LONG", breakoutBuffer) &&
    last.low <= lastBox.high * (1 + retestTolerance / 100) &&
    entryPrice > lastBox.high;
  const shortRetest =
    hadBreakout(candles, lastBox, "SHORT", breakoutBuffer) &&
    last.high >= lastBox.low * (1 - retestTolerance / 100) &&
    entryPrice < lastBox.low;

  if (longSetup) {
    const wyckoffOk = hasSc || hasArAcc || hasStAcc;
    const entryType = longBreakout ? "BREAKOUT" : longRetest ? "RETEST" : undefined;

    // Hard gates: Wyckoff structure + clear trigger are both mandatory
    if (!wyckoffOk) {
      reasons.push("Accumulation box nhưng thiếu SC/AR_ACC/ST_ACC đã xác nhận trong box này.");
      return none(reasons, 10);
    }
    if (!entryType) {
      reasons.push("Giá chưa breakout hoặc retest lên trên box.high — không có trigger vào lệnh.");
      return none(reasons, 20);
    }

    // Confidence scoring: hard gates passed, now measure quality
    let confidence = 20;

    if (hasSc) { confidence += 15; reasons.push("SC xác nhận (capitulation)"); }
    if (hasArAcc) { confidence += 8; reasons.push("AR_ACC có mặt (rally đầu)"); }
    if (hasStAcc) { confidence += 20; reasons.push("ST_ACC xác nhận (cấu trúc hoàn chỉnh SC→AR→ST)"); }

    if (entryType === "RETEST") {
      confidence += 25;
      reasons.push(`Entry RETEST box.high ${lastBox.high.toFixed(6)} — xác nhận hỗ trợ cũ thành kháng cự mới`);
    } else {
      confidence += 18;
      reasons.push(`Entry BREAKOUT trên box.high ${lastBox.high.toFixed(6)}`);
    }

    if (currentRsiValue > 50) {
      confidence += 10;
      reasons.push(`RSI ${currentRsiValue.toFixed(1)} > 50 xác nhận đà tăng`);
    } else {
      reasons.push(`RSI ${currentRsiValue.toFixed(1)} chưa > 50 (trừ điểm xác nhận)`);
    }

    if (settings.useVolumeFilter) {
      if (volumeOk) { confidence += 10; reasons.push("Volume xác nhận breakout"); }
      else reasons.push("Volume chưa xác nhận theo bộ lọc");
    }

    // ── SL: structural (swing low) > OB below > box.high ──────────────────
    const baseSLFallbackLong = entryType === "BREAKOUT"
      ? lastBox.high * (1 - settings.slBufferPct / 100)
      : longStopLoss(lastBox, recentSignals, settings.slBufferPct);

    const { sl: structSLLong, label: slLabelLong } = structuralSLLong(
      analysis.signals, entryPrice, settings.slBufferPct, baseSLFallbackLong
    );
    reasons.push(`SL tại ${slLabelLong} ${structSLLong.toFixed(6)} — giá về dưới đây = setup sai.`);

    // ── TP: nearest OB above entry > Wyckoff measured move ─────────────────
    const wyckoffTPLong = lastBox.high + (lastBox.high - lastBox.low);
    const { tp: obTPLong, label: tpLabelLong } = obBasedTPLong(
      analysis.orderBlocks, entryPrice, wyckoffTPLong
    );
    if (tpLabelLong !== "measured move") {
      reasons.push(`TP tại ${tpLabelLong} — nearest OB (magnet).`);
    }

    return buildTrade({
      side: "LONG",
      entryType,
      entryPrice,
      stopLoss: structSLLong,
      takeProfitOverride: obTPLong,
      confidence,
      reasons,
      settings
    });
  }

  if (shortSetup) {
    const wyckoffOk = hasBc || hasArDist || hasStDist;
    const entryType = shortBreakdown ? "BREAKOUT" : shortRetest ? "RETEST" : undefined;

    if (!wyckoffOk) {
      reasons.push("Distribution box nhưng thiếu BC/AR_DIST/ST_DIST đã xác nhận trong box này.");
      return none(reasons, 10);
    }
    if (!entryType) {
      reasons.push("Giá chưa breakdown hoặc retest xuống dưới box.low — không có trigger vào lệnh.");
      return none(reasons, 20);
    }

    let confidence = 20;

    if (hasBc) { confidence += 15; reasons.push("BC xác nhận (buying climax)"); }
    if (hasArDist) { confidence += 8; reasons.push("AR_DIST có mặt (pullback đầu)"); }
    if (hasStDist) { confidence += 20; reasons.push("ST_DIST xác nhận (cấu trúc hoàn chỉnh BC→AR→ST)"); }

    if (entryType === "RETEST") {
      confidence += 25;
      reasons.push(`Entry RETEST box.low ${lastBox.low.toFixed(6)} — xác nhận hỗ trợ cũ thành kháng cự mới`);
    } else {
      confidence += 18;
      reasons.push(`Entry BREAKOUT dưới box.low ${lastBox.low.toFixed(6)}`);
    }

    if (currentRsiValue < 50) {
      confidence += 10;
      reasons.push(`RSI ${currentRsiValue.toFixed(1)} < 50 xác nhận đà giảm`);
    } else {
      reasons.push(`RSI ${currentRsiValue.toFixed(1)} chưa < 50 (trừ điểm xác nhận)`);
    }

    if (settings.useVolumeFilter) {
      if (volumeOk) { confidence += 10; reasons.push("Volume xác nhận breakdown"); }
      else reasons.push("Volume chưa xác nhận theo bộ lọc");
    }

    // ── SL: structural (swing high) > OB above > box.low ──────────────────
    const baseSLFallbackShort = entryType === "BREAKOUT"
      ? lastBox.low * (1 + settings.slBufferPct / 100)
      : shortStopLoss(lastBox, recentSignals, settings.slBufferPct);

    const { sl: structSLShort, label: slLabelShort } = structuralSLShort(
      analysis.signals, entryPrice, settings.slBufferPct, baseSLFallbackShort
    );
    reasons.push(`SL tại ${slLabelShort} ${structSLShort.toFixed(6)} — giá về trên đây = setup sai.`);

    // ── TP: nearest OB below entry > Wyckoff measured move ─────────────────
    const wyckoffTPShort = lastBox.low - (lastBox.high - lastBox.low);
    const { tp: obTPShort, label: tpLabelShort } = obBasedTPShort(
      analysis.orderBlocks, entryPrice, wyckoffTPShort
    );
    if (tpLabelShort !== "measured move") {
      reasons.push(`TP tại ${tpLabelShort} — nearest OB (magnet).`);
    }

    return buildTrade({
      side: "SHORT",
      entryType,
      entryPrice,
      stopLoss: structSLShort,
      takeProfitOverride: obTPShort,
      confidence,
      reasons,
      settings
    });
  }

  // --- Order Block entry: price retesting OB zone aligned with Wyckoff bias ---
  // Bullish OB + Accumulation context → LONG with SL below OB.low (very tight)
  // Bearish OB + Distribution context → SHORT with SL above OB.high
  const OB_LOOKBACK = 30; // OB still relevant within last 30 candles
  const activeOBs = analysis.orderBlocks
    .filter(ob => !ob.mitigated && (candles.length - 1 - ob.candleIndex) <= OB_LOOKBACK);

  for (const ob of activeOBs.slice().reverse()) { // most recent first
    const inZone = ob.kind === "bullish"
      ? entryPrice <= ob.bodyHigh * 1.001 && entryPrice >= ob.bodyLow * 0.999
      : entryPrice >= ob.bodyLow  * 0.999 && entryPrice <= ob.bodyHigh * 1.001;
    if (!inZone) continue;

    const isLongOB  = ob.kind === "bullish" && (longSetup  || lastBox.type !== "Distribution");
    const isShortOB = ob.kind === "bearish" && (shortSetup || lastBox.type !== "Accumulation");
    if (!isLongOB && !isShortOB) continue;

    const side: "LONG" | "SHORT" = isLongOB ? "LONG" : "SHORT";
    const slOB = isLongOB
      ? ob.low  * (1 - settings.slBufferPct / 100)   // below OB low
      : ob.high * (1 + settings.slBufferPct / 100);   // above OB high
    const tpOB = isLongOB ? lastBox.high : lastBox.low;

    let confidence = 40;
    if (isLongOB  && (hasSc || hasArAcc || hasStAcc)) { confidence += 20; }
    if (isShortOB && (hasBc || hasArDist || hasStDist)) { confidence += 20; }
    if (currentRsiValue > 30 && currentRsiValue < 70) confidence += 8;
    if (volumeOk) confidence += 10;

    const obReasons = [
      ...reasons,
      `${ob.kind === "bullish" ? "Bullish" : "Bearish"} OB tại ${ob.bodyLow.toFixed(6)}–${ob.bodyHigh.toFixed(6)} — giá đang trong vùng OB.`,
      `SL ${slOB.toFixed(6)} (dưới/trên nến OB — rất tight) | TP ${tpOB.toFixed(6)}`,
      `Wyckoff ${side} bias xác nhận OB entry.`
    ];

    return buildTrade({ side, entryType: "RETEST", entryPrice, stopLoss: slOB, confidence, reasons: obReasons, settings });
  }

  // --- Spring entry (LONG): price pierced below box.low then snapped back ---
  // Works on Accumulation OR Unknown boxes. Provides tight SL = spring low.
  const SPRING_LOOKBACK = 8; // only act on spring within last 8 candles
  const lastSpring = recentSignals
    .filter((s) => s.type === "SPRING")
    .at(-1);

  if (lastSpring && !shortSetup) {
    const age = (candles.length - 1) - lastSpring.signalIndex;
    const stillInBox = entryPrice <= lastBox.high && entryPrice >= lastBox.low * 0.995;
    if (age <= SPRING_LOOKBACK && stillInBox) {
      let confidence = 30;
      const springLow = lastSpring.price;
      const sl = springLow * (1 - settings.slBufferPct / 100);
      const slDist = Math.abs(entryPrice - sl);
      if (slDist <= 0) return none([...reasons, "Spring SL không hợp lệ."], 0);

      reasons.push(`SPRING: nến #${lastSpring.signalIndex} đâm xuống ${springLow.toFixed(6)} dưới box.low ${lastBox.low.toFixed(6)} rồi đóng ngược lại — bẫy shorts.`);
      if (hasSc || hasArAcc || hasStAcc) { confidence += 15; reasons.push("Cấu trúc SC/AR/ST hỗ trợ thêm."); }
      if (age <= 3) { confidence += 12; reasons.push(`Spring tươi (${age} nến trước).`); }
      if (currentRsiValue > 30 && currentRsiValue < 60) { confidence += 8; reasons.push(`RSI ${currentRsiValue.toFixed(1)} hợp lý.`); }
      if (volumeOk) { confidence += 10; reasons.push("Volume xác nhận spring."); }
      reasons.push(`Entry LIMIT tại box.low ${lastBox.low.toFixed(6)} — chờ giá retest vùng hỗ trợ.`);
      reasons.push(`SL ${sl.toFixed(6)} (dưới đáy spring — rất gần) | TP = box.high ${lastBox.high.toFixed(6)}`);

      return buildTrade({
        side: "LONG",
        entryType: "RETEST",          // LIMIT order, same execution path as RETEST
        entryPrice: lastBox.low,      // limit at box.low for optimal entry
        stopLoss: sl,
        confidence,
        reasons,
        settings
      });
    }
  }

  // --- Upthrust entry (SHORT): price pierced above box.high then snapped back ---
  const lastUpthrust = recentSignals
    .filter((s) => s.type === "UPTHRUST")
    .at(-1);

  if (lastUpthrust && !longSetup) {
    const age = (candles.length - 1) - lastUpthrust.signalIndex;
    const stillInBox = entryPrice >= lastBox.low && entryPrice <= lastBox.high * 1.005;
    if (age <= SPRING_LOOKBACK && stillInBox) {
      let confidence = 30;
      const upthrustHigh = lastUpthrust.price;
      const sl = upthrustHigh * (1 + settings.slBufferPct / 100);
      const slDist = Math.abs(sl - entryPrice);
      if (slDist <= 0) return none([...reasons, "Upthrust SL không hợp lệ."], 0);

      reasons.push(`UPTHRUST: nến #${lastUpthrust.signalIndex} đâm lên ${upthrustHigh.toFixed(6)} trên box.high ${lastBox.high.toFixed(6)} rồi đóng xuống lại — bẫy longs.`);
      if (hasBc || hasArDist || hasStDist) { confidence += 15; reasons.push("Cấu trúc BC/AR/ST hỗ trợ thêm."); }
      if (age <= 3) { confidence += 12; reasons.push(`Upthrust tươi (${age} nến trước).`); }
      if (currentRsiValue < 70 && currentRsiValue > 40) { confidence += 8; reasons.push(`RSI ${currentRsiValue.toFixed(1)} hợp lý.`); }
      if (volumeOk) { confidence += 10; reasons.push("Volume xác nhận upthrust."); }
      reasons.push(`Entry LIMIT tại box.high ${lastBox.high.toFixed(6)} — chờ giá retest vùng kháng cự.`);
      reasons.push(`SL ${sl.toFixed(6)} (trên đỉnh upthrust — rất gần) | TP = box.low ${lastBox.low.toFixed(6)}`);

      return buildTrade({
        side: "SHORT",
        entryType: "RETEST",
        entryPrice: lastBox.high,
        stopLoss: sl,
        confidence,
        reasons,
        settings
      });
    }
  }

  return none([`Box gần nhất là ${lastBox.type}, chưa đủ hướng Accumulation/Distribution.`], 0);
}

function pushWyckoffSignal(
  signals: WyckoffSignal[],
  type: WyckoffSignalType,
  pivot: PivotEvent
): WyckoffSignal {
  const signal: WyckoffSignal = {
    type,
    signalIndex: pivot.signalIndex,
    confirmedIndex: pivot.confirmedIndex,
    price: pivot.price,
    rsi: pivot.rsi
  };
  signals.push(signal);
  return signal;
}

function isNearRecentBoxLow(boxes: WyckoffBox[], signalIndex: number, price: number): boolean {
  const box = [...boxes].reverse().find((candidate) =>
    candidate.startIndex <= signalIndex && candidate.endIndex >= signalIndex
  ) ?? boxes.at(-1);
  if (!box) return false;
  const tolerance = Math.max(box.low * 0.03, 1e-12);
  return Math.abs(price - box.low) <= tolerance || price >= box.low;
}

function isVolumeConfirmed(candles: readonly Candle[], settings: Required<WyckoffSettings>): boolean {
  if (!settings.useVolumeFilter) return true;
  const length = Math.max(1, Math.floor(settings.volumeMaLength));
  if (candles.length < length + 1) return false;
  const latest = candles.at(-1)?.volume ?? 0;
  const sample = candles.slice(-length - 1, -1);
  const average = sample.reduce((sum, candle) => sum + candle.volume, 0) / sample.length;
  return average > 0 && latest > average;
}

function hadBreakout(
  candles: readonly Candle[],
  box: WyckoffBox,
  side: "LONG" | "SHORT",
  bufferPct: number
): boolean {
  const start = Math.min(candles.length - 2, box.endIndex + 1);
  for (let index = start; index < candles.length - 1; index += 1) {
    const close = candles[index]?.close;
    if (close === undefined) continue;
    if (side === "LONG" && close > box.high * (1 + bufferPct / 100)) return true;
    if (side === "SHORT" && close < box.low * (1 - bufferPct / 100)) return true;
  }
  return false;
}

function longStopLoss(box: WyckoffBox, signals: WyckoffSignal[], slBufferPct: number): number {
  const st = [...signals].reverse().find((s) => s.type === "ST_ACC");
  // ST price is higher than box.low → tighter and more precise anchor
  const anchor = st?.price && st.price > box.low ? st.price : box.low;
  return anchor * (1 - slBufferPct / 100);
}

function shortStopLoss(box: WyckoffBox, signals: WyckoffSignal[], slBufferPct: number): number {
  const st = [...signals].reverse().find((s) => s.type === "ST_DIST");
  const anchor = st?.price && st.price < box.high ? st.price : box.high;
  return anchor * (1 + slBufferPct / 100);
}

// Structural SL: nearest swing high above entry (for SHORT)
function structuralSLShort(
  allSignals: WyckoffSignal[], entryPrice: number, slBufferPct: number, fallback: number
): { sl: number; label: string } {
  const nearestHigh = allSignals
    .filter(s => (s.type === "PIVOT_HIGH" || s.type === "BC" || s.type === "AR_ACC") && s.price > entryPrice)
    .sort((a, b) => a.price - b.price)   // nearest above entry first
    .at(0);
  if (nearestHigh && nearestHigh.price < fallback) {
    return { sl: nearestHigh.price * (1 + slBufferPct / 100), label: `Swing high ${nearestHigh.price.toFixed(6)}` };
  }
  return { sl: fallback, label: "box.high" };
}

// Structural SL: nearest swing low below entry (for LONG)
function structuralSLLong(
  allSignals: WyckoffSignal[], entryPrice: number, slBufferPct: number, fallback: number
): { sl: number; label: string } {
  const nearestLow = allSignals
    .filter(s => (s.type === "PIVOT_LOW" || s.type === "SC" || s.type === "AR_DIST") && s.price < entryPrice)
    .sort((a, b) => b.price - a.price)   // nearest below entry first
    .at(0);
  if (nearestLow && nearestLow.price > fallback) {
    return { sl: nearestLow.price * (1 - slBufferPct / 100), label: `Swing low ${nearestLow.price.toFixed(6)}` };
  }
  return { sl: fallback, label: "box.low" };
}

// TP at nearest unmitigated OB in trade direction
function obBasedTPShort(obs: OBZone[], entryPrice: number, fallback: number): { tp: number; label: string } {
  const nearest = obs
    .filter(ob => ob.bodyHigh < entryPrice * 0.999)
    .sort((a, b) => b.bodyHigh - a.bodyHigh)  // nearest below entry first
    .at(0);
  if (nearest) return { tp: nearest.bodyHigh, label: `${nearest.kind === "bearish" ? "Bearish" : "Bullish"} OB ${nearest.bodyHigh.toFixed(6)}` };
  return { tp: fallback, label: "measured move" };
}

function obBasedTPLong(obs: OBZone[], entryPrice: number, fallback: number): { tp: number; label: string } {
  const nearest = obs
    .filter(ob => ob.bodyLow > entryPrice * 1.001)
    .sort((a, b) => a.bodyLow - b.bodyLow)    // nearest above entry first
    .at(0);
  if (nearest) return { tp: nearest.bodyLow, label: `${nearest.kind === "bullish" ? "Bullish" : "Bearish"} OB ${nearest.bodyLow.toFixed(6)}` };
  return { tp: fallback, label: "measured move" };
}

function buildTrade(params: {
  side: "LONG" | "SHORT";
  entryType: "BREAKOUT" | "RETEST";
  entryPrice: number;
  stopLoss: number;
  confidence: number;
  reasons: string[];
  settings: Required<WyckoffSettings>;
  takeProfitOverride?: number;
}): WyckoffTradeSignal {
  const { side, entryType, entryPrice, stopLoss, confidence, reasons, settings } = params;
  const risk = side === "LONG" ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (!Number.isFinite(stopLoss) || stopLoss <= 0 || risk <= 0) {
    return none([...reasons, "Stop loss không hợp lệ hoặc entry <= SL."], confidence);
  }

  const riskPct = (risk / entryPrice) * 100;
  if (riskPct > settings.maxRiskDistancePct) {
    return none([
      ...reasons,
      `Risk distance ${riskPct.toFixed(2)}% vượt giới hạn ${settings.maxRiskDistancePct}% — box quá rộng so với entry.`
    ], confidence);
  }

  // Leverage-aware gates — mirror RiskManager logic so the signal can actually be executed.
  // Without these, a "91/100 confidence" signal is shown but immediately blocked at execution.
  const leverage = settings.leverage;
  if (leverage > 1) {
    const marginType = settings.marginType;
    const maxMarginLossPct = marginType === "ISOLATED" ? 35 : 25;
    const marginLossPct = riskPct * leverage;

    if (marginLossPct > maxMarginLossPct) {
      return none([
        ...reasons,
        `SL ${riskPct.toFixed(2)}% × ${leverage}x = mất ${marginLossPct.toFixed(1)}% margin nếu chạm SL; giới hạn ${maxMarginLossPct}% cho ${marginType}. Cần đòn bẩy ≤ ${Math.floor(maxMarginLossPct / riskPct)}x hoặc SL ≤ ${(maxMarginLossPct / leverage).toFixed(2)}%.`
      ], confidence);
    }

    // Liquidation proximity: SL must trigger well before the estimated liquidation zone.
    // Estimated liq distance ≈ 100/leverage (no maintenance margin model — conservative).
    const liqDistancePct = 100 / leverage;
    const maxSafeStopPct = liqDistancePct * 0.70; // allow SL up to 70% of liq distance
    if (riskPct > maxSafeStopPct) {
      return none([
        ...reasons,
        `SL ${riskPct.toFixed(2)}% quá gần vùng thanh lý ước tính (${liqDistancePct.toFixed(2)}% với ${leverage}x); ngưỡng an toàn ${maxSafeStopPct.toFixed(2)}%. Giảm đòn bẩy hoặc chờ setup box hẹp hơn.`
      ], confidence);
    }
  }

  const minConfidence = settings.minConfidence;
  if (confidence < minConfidence) {
    return none([
      ...reasons,
      `Confidence ${confidence}/100 chưa đạt ngưỡng tối thiểu ${minConfidence} — cần thêm xác nhận (RSI, ST_ACC hoặc RETEST).`
    ], confidence);
  }

  const tp1 = params.takeProfitOverride !== undefined && Number.isFinite(params.takeProfitOverride) && params.takeProfitOverride > 0
    ? params.takeProfitOverride
    : (side === "LONG" ? entryPrice + risk : entryPrice - risk);
  const tp2 = side === "LONG" ? entryPrice + risk * 2 : entryPrice - risk * 2;

  return {
    side,
    entryType,
    entryPrice,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    invalidationPrice: stopLoss,
    confidence: Math.min(100, Math.max(0, confidence)),
    reason: reasons
  };
}

function none(reason: string[], confidence: number): WyckoffTradeSignal {
  return {
    side: "NONE",
    confidence: Math.min(100, Math.max(0, confidence)),
    reason
  };
}
