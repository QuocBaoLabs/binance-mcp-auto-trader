import { detectAMDSetup } from "./amd.js";
import { defaultICTConfig } from "./config.js";
import { detectCRTSetup } from "./crt.js";
import { detectFVG, detectInversionFVG } from "./fvg.js";
import { atr, average, ema } from "./indicators.js";
import { detectLiquidityPools, nearestLiquidity } from "./liquidity.js";
import { detectOTEZone } from "./ote.js";
import { buildTradeSignal, stopDistanceOk } from "./risk.js";
import { detectMSSAfterSweep } from "./structure.js";
import { detectSweep } from "./sweep.js";
import { detectSwings } from "./swings.js";
import type {
  Bias,
  Candle,
  Direction,
  FairValueGap,
  ICTAnalyzeInput,
  ICTAnalyzeResult,
  ICTStrategyConfig,
  LiquidityPool,
  MarketStructureShift,
  SwingPoint,
  TradeSignal
} from "./types.js";

const MIN_CANDLES = 30;

export class ICTSMCStrategyEngine {
  constructor(private readonly config: ICTStrategyConfig = defaultICTConfig) {}

  analyze(input: ICTAnalyzeInput): ICTAnalyzeResult {
    const debug: string[] = [];
    const invalid = validateInput(input, this.config);
    if (invalid.length > 0) {
      return { signal: null, bias: "neutral", debug: invalid };
    }

    const bias = determineBias(input.htfCandles, this.config);
    debug.push(`HTF bias ${bias}`);

    if (this.config.filters.oneTradePerSymbol && input.openPositions?.some((position) => position.symbol === input.symbol)) {
      debug.push("No trade: open position already exists for symbol");
      return { signal: null, bias, debug };
    }
    if ((input.accountState?.dailyLossPct ?? 0) >= this.config.risk.maxDailyLossPct) {
      debug.push("No trade: max daily loss reached");
      return { signal: null, bias, debug };
    }
    if ((input.accountState?.consecutiveLosses ?? 0) >= this.config.risk.maxConsecutiveLosses) {
      debug.push("No trade: max consecutive losses reached");
      return { signal: null, bias, debug };
    }

    const htfSwings = detectSwings(input.htfCandles, this.config.structure.swingLength);
    const mtfSwings = detectSwings(input.mtfCandles, this.config.structure.swingLength);
    const ltfSwings = detectSwings(input.ltfCandles, this.config.structure.internalSwingLength);
    const htfLiquidity = detectLiquidityPools(input.htfCandles, htfSwings, this.config.timeframes.htf, this.config);
    const mtfLiquidity = detectLiquidityPools(input.mtfCandles, mtfSwings, this.config.timeframes.mtf, this.config);
    const ltfLiquidity = detectLiquidityPools(input.ltfCandles, ltfSwings, this.config.timeframes.ltf, this.config);
    const allLiquidity = [...htfLiquidity, ...mtfLiquidity, ...ltfLiquidity];

    const sweeps = detectSweep(input.mtfCandles, mtfLiquidity, this.config)
      .filter((sweep) => sweep.valid)
      .filter((sweep) => biasAllowsDirection(bias, sweep.direction));
    if (sweeps.length === 0) {
      debug.push("No trade: no valid MTF liquidity sweep in HTF bias direction");
      return { signal: null, bias, debug };
    }
    debug.push(`Sweep candidates ${sweeps.length}`);

    const ltfAtr = atr(input.ltfCandles, this.config.displacement.atrLength);
    if (!ltfAtr || ltfAtr <= 0) {
      debug.push("No trade: missing LTF ATR");
      return { signal: null, bias, debug };
    }

    const amd = detectAMDSetup(input.mtfCandles, this.config);
    const crt = detectCRTSetup(input.htfCandles, input.ltfCandles, bias, this.config);
    const fvgBase = detectFVG(input.ltfCandles, this.config.timeframes.ltf, this.config);
    const fvgs = this.config.fvg.useInversionFVG
      ? [...fvgBase, ...detectInversionFVG(input.ltfCandles, fvgBase)]
      : fvgBase;

    const candidates: TradeSignal[] = [];
    for (const sweep of sweeps.slice().reverse()) {
      const localDebug: string[] = [`Sweep ${sweep.direction} ${sweep.liquidity.source} @ ${sweep.liquidity.price}`];
      const mss = detectMSSAfterSweep(input.ltfCandles, sweep, ltfSwings, this.config);
      if (!mss?.valid) {
        debug.push(`${localDebug[0]} -> MSS missing within max bars`);
        continue;
      }
      localDebug.push(`LTF ${mss.direction} MSS broke ${mss.brokenSwing.type} ${mss.breakPrice}`);

      const fvg = selectFvgAfterMss(fvgs, mss, this.config);
      if (!fvg) {
        debug.push(`${localDebug.join("; ")} -> FVG missing/filled/small`);
        continue;
      }
      localDebug.push(`${fvg.inverted ? "Inversion " : ""}${fvg.direction} FVG ${fvg.lower}-${fvg.upper}`);

      const entry = entryFromFvg(fvg, input.ltfCandles.at(-1)?.close ?? fvg.mid, this.config);
      const stopLoss = sweep.direction === "long"
        ? sweep.sweepPrice - ltfAtr * this.config.risk.slBufferAtr
        : sweep.sweepPrice + ltfAtr * this.config.risk.slBufferAtr;
      if (!stopDistanceOk(entry, stopLoss, ltfAtr, this.config)) {
        debug.push(`${localDebug.join("; ")} -> SL too far versus ATR`);
        continue;
      }

      const direction = sweep.direction;
      const sweepSwing: SwingPoint = {
        index: sweep.candleIndex,
        time: sweep.candleTime,
        price: sweep.sweepPrice,
        type: direction === "long" ? "low" : "high",
        strength: this.config.structure.internalSwingLength
      };
      const oteZone = detectOTEZone(direction, sweepSwing, mss.brokenSwing, this.config, entry);
      if (oteZone.inZone) localDebug.push("FVG entry inside OTE zone");
      const targetSide = direction === "long" ? "buySide" : "sellSide";
      const liquidityTargets = nearestLiquidity(allLiquidity, targetSide, entry);
      const nearestTargetSwing = nearestSwingTarget([...htfSwings, ...mtfSwings, ...ltfSwings], direction, entry);
      const htfExtreme = direction === "long"
        ? Math.max(...input.htfCandles.slice(-80).map((candle) => candle.high))
        : Math.min(...input.htfCandles.slice(-80).map((candle) => candle.low));
      const riskDistance = direction === "long" ? entry - stopLoss : stopLoss - entry;
      const tp2 = liquidityTargets[1]?.price;
      const rrToTp2 = tp2 !== undefined && riskDistance > 0
        ? (direction === "long" ? tp2 - entry : entry - tp2) / riskDistance
        : 0;

      const scoreInput = scoreSetup({
        bias,
        direction,
        sweepValid: sweep.valid,
        mss,
        fvg,
        entry,
        oteInZone: oteZone.inZone,
        amdSupport: Boolean(amd?.valid && amdDirection(amd.type) === direction),
        crtSupport: Boolean(crt?.valid && crt.direction === direction),
        rrPreferred: this.config.risk.relaxRRAndTP || rrToTp2 >= this.config.risk.preferredRR,
        relaxedRRTP: this.config.risk.relaxRRAndTP,
        liquidityTargets
      });
      const reason = [...localDebug, ...scoreInput.reason];
      const trade = buildTradeSignal({
        symbol: input.symbol,
        direction,
        entry,
        stopLoss,
        nearestSwing: nearestTargetSwing,
        liquidityTargets,
        htfExtreme,
        score: scoreInput.score,
        reason,
        setupType: fvg.inverted ? "INVERSION_FVG" : "SWEEP_MSS_FVG"
      }, this.config);

      if (!trade) {
        debug.push(`${localDebug.join("; ")} -> TP liquidity/RR invalid`);
        continue;
      }
      if (!this.config.risk.relaxRRAndTP && trade.rr.tp2 < this.config.risk.preferredRR) {
        debug.push(`${localDebug.join("; ")} -> RR TP2 ${trade.rr.tp2.toFixed(2)}R below preferred`);
        continue;
      }
      if (trade.score < this.config.filters.minScoreToTrade) {
        debug.push(`${localDebug.join("; ")} -> score ${trade.score} below ${this.config.filters.minScoreToTrade}`);
        continue;
      }
      if (this.config.filters.avoidMiddleOfRange && isMiddleOfRange(input.mtfCandles, entry)) {
        debug.push(`${localDebug.join("; ")} -> entry in middle of MTF range`);
        continue;
      }
      if (this.config.filters.avoidLowVolume && isLowVolume(input.ltfCandles)) {
        debug.push(`${localDebug.join("; ")} -> low LTF volume`);
        continue;
      }
      candidates.push(trade);
    }

    if (candidates.length === 0) {
      return { signal: null, bias, debug };
    }

    const best = candidates.sort((left, right) =>
      right.score - left.score || right.rr.tp2 - left.rr.tp2
    )[0];
    debug.push(`Trade selected ${best.direction} score=${best.score} rr2=${best.rr.tp2.toFixed(2)}R`);
    return { signal: best, bias, debug };
  }
}

export function determineBias(candles: Candle[], config: ICTStrategyConfig = defaultICTConfig): Bias {
  if (candles.length < MIN_CANDLES) return "neutral";
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1);
  if (!latest) return "neutral";
  const swings = detectSwings(candles, config.structure.swingLength);
  const highs = swings.filter((swing) => swing.type === "high");
  const lows = swings.filter((swing) => swing.type === "low");
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const fvg = detectFVG(candles, config.timeframes.htf, config);
  const latestHigh = highs.at(-1);
  const prevHigh = highs.at(-2);
  const latestLow = lows.at(-1);
  const prevLow = lows.at(-2);
  let bullish = 0;
  let bearish = 0;

  if (latestHigh && prevHigh && latestLow && prevLow) {
    if (latestHigh.price > prevHigh.price && latestLow.price > prevLow.price) bullish += 1;
    if (latestHigh.price < prevHigh.price && latestLow.price < prevLow.price) bearish += 1;
    if (latest.low > latestLow.price) bullish += 1;
    if (latest.high < latestHigh.price) bearish += 1;
  }
  if ((ema50 !== null && latest.close > ema50) || (ema200 !== null && latest.close > ema200)) bullish += 1;
  if ((ema50 !== null && latest.close < ema50) || (ema200 !== null && latest.close < ema200)) bearish += 1;
  if (fvg.some((gap) => gap.direction === "long" && latest.close >= gap.lower && latest.close <= gap.upper)) bullish += 1;
  if (fvg.some((gap) => gap.direction === "short" && latest.close >= gap.lower && latest.close <= gap.upper)) bearish += 1;

  if (bullish >= 2 && bullish > bearish) return "bullish";
  if (bearish >= 2 && bearish > bullish) return "bearish";
  return "neutral";
}

function validateInput(input: ICTAnalyzeInput, config: ICTStrategyConfig): string[] {
  const errors: string[] = [];
  if (input.htfCandles.length < MIN_CANDLES) errors.push("No trade: not enough HTF candles");
  if (input.mtfCandles.length < MIN_CANDLES) errors.push("No trade: not enough MTF candles");
  if (input.ltfCandles.length < MIN_CANDLES) errors.push("No trade: not enough LTF candles");
  if (!config.fvg.enabled) errors.push("No trade: FVG disabled");
  return errors;
}

function biasAllowsDirection(bias: Bias, direction: Direction): boolean {
  if (bias === "neutral") return true;
  return (bias === "bullish" && direction === "long") || (bias === "bearish" && direction === "short");
}

function selectFvgAfterMss(
  fvgs: FairValueGap[],
  mss: MarketStructureShift,
  config: ICTStrategyConfig
): FairValueGap | null {
  const candidates = fvgs.filter((fvg) =>
    fvg.direction === mss.direction &&
    fvg.valid &&
    fvg.endIndex >= mss.candleIndex &&
    fvg.endIndex <= mss.candleIndex + config.fvg.maxBarsAfterMss &&
    fvg.filledPct <= config.fvg.maxFillBeforeEntryPct
  );
  return candidates.sort((left, right) => right.sizePct - left.sizePct)[0] ?? null;
}

function entryFromFvg(fvg: FairValueGap, currentClose: number, config: ICTStrategyConfig): number {
  if (config.fvg.entryMode === "confirmation") return currentClose;
  if (config.fvg.entryMode === "edge") return fvg.direction === "long" ? fvg.upper : fvg.lower;
  return fvg.mid;
}

function nearestSwingTarget(swings: SwingPoint[], direction: Direction, entry: number): SwingPoint | null {
  const type = direction === "long" ? "high" : "low";
  const candidates = swings.filter((swing) =>
    swing.type === type && (direction === "long" ? swing.price > entry : swing.price < entry)
  );
  return candidates.sort((left, right) =>
    direction === "long" ? left.price - right.price : right.price - left.price
  )[0] ?? null;
}

function amdDirection(type: "bullishAMD" | "bearishAMD"): Direction {
  return type === "bullishAMD" ? "long" : "short";
}

function scoreSetup(input: {
  bias: Bias;
  direction: Direction;
  sweepValid: boolean;
  mss: MarketStructureShift;
  fvg: FairValueGap;
  entry: number;
  oteInZone: boolean;
  amdSupport: boolean;
  crtSupport: boolean;
  rrPreferred: boolean;
  relaxedRRTP: boolean;
  liquidityTargets: LiquidityPool[];
}): { score: number; reason: string[] } {
  let score = 0;
  const reason: string[] = [];
  if ((input.bias === "bullish" && input.direction === "long") || (input.bias === "bearish" && input.direction === "short")) {
    score += 2;
    reason.push("HTF bias cung huong +2");
  }
  if (input.sweepValid) {
    score += 2;
    reason.push("Liquidity sweep ro +2");
  }
  if (input.mss.valid) {
    score += 2;
    reason.push("MSS sau sweep +2");
  }
  if (input.fvg.valid) {
    score += 2;
    reason.push("FVG sau MSS +2");
  }
  if (input.oteInZone) {
    score += 2;
    reason.push("FVG midpoint nam trong OTE +2");
  }
  if (input.amdSupport) {
    score += 1;
    reason.push("AMD ho tro +1");
  }
  if (input.crtSupport) {
    score += 1;
    reason.push("CRT ho tro +1");
  }
  if (input.mss.displacement) {
    score += 1;
    reason.push("Displacement manh +1");
  }
  if (input.rrPreferred) {
    score += 1;
    reason.push(input.relaxedRRTP ? "Relaxed RR/TP enabled +1" : "RR >= preferred +1");
  }
  if (input.liquidityTargets.length >= 2) {
    score += 1;
    reason.push("Co liquidity TP2 +1");
  }
  return { score, reason };
}

function isMiddleOfRange(candles: Candle[], entry: number): boolean {
  const range = candles.slice(-Math.min(80, candles.length));
  const high = Math.max(...range.map((candle) => candle.high));
  const low = Math.min(...range.map((candle) => candle.low));
  const width = high - low;
  if (width <= 0) return false;
  const position = (entry - low) / width;
  return position >= 0.4 && position <= 0.6;
}

function isLowVolume(candles: Candle[]): boolean {
  if (candles.length < 21) return false;
  const last = candles.at(-1);
  if (!last) return false;
  const avg = average(candles.slice(-21, -1).map((candle) => candle.volume));
  return avg > 0 && last.volume < avg * 0.5;
}
