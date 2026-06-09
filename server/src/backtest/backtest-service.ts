import { BinanceClient } from "../binance/client.js";
import { SettingsService } from "../services/settings.js";
import { normalizeUsdFuturesSymbol } from "../symbols.js";
import type { Kline, RuntimeSettings } from "../types.js";
import { ICTSMCStrategyEngine } from "../strategy/ict-smc/engine.js";
import { defaultICTConfig } from "../strategy/ict-smc/config.js";
import type { ICTStrategyConfig, Timeframe, TradeSignal as ICTTradeSignal } from "../strategy/ict-smc/types.js";
import {
  analyzeWyckoff,
  generateWyckoffTradeSignal,
  type Candle as WyckoffCandle,
  type WyckoffTradeSignal
} from "../strategy/wyckoff.js";

type BacktestStrategy = "smc" | "wyckoff";
type BacktestSide = "LONG" | "SHORT";
type BacktestOutcome = "tp" | "sl" | "timeout" | "expired" | "open";

interface BacktestInput {
  strategy: BacktestStrategy;
  symbol: string;
  timeframe: string;
  candles?: number;
  minConfidence?: number;
  maxHoldCandles?: number;
  maxWaitCandles?: number;
}

interface CandidateTrade {
  side: BacktestSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  reason: string;
  setupType: string;
}

interface BacktestTrade {
  index: number;
  symbol: string;
  strategy: BacktestStrategy;
  timeframe: string;
  side: BacktestSide;
  setupType: string;
  confidence: number;
  signalTime: string;
  entryTime?: string;
  exitTime?: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice?: number;
  outcome: BacktestOutcome;
  pnlR: number;
  barsHeld: number;
  reason: string;
}

interface BacktestResult {
  symbol: string;
  strategy: BacktestStrategy;
  timeframe: string;
  requestedCandles: number;
  candles: number;
  testedCandles: number;
  minConfidence: number;
  maxHoldCandles: number;
  maxWaitCandles: number;
  elapsedMs: number;
  cacheHit: boolean;
  summary: {
    rawSignals: number;
    qualifiedSignals: number;
    filledTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    timeouts: number;
    expired: number;
    open: number;
    slOnlySignals: number;
    winRate: number;
    netR: number;
    avgR: number;
    bestR: number;
    worstR: number;
  };
  diagnostics: Record<string, number>;
  trades: BacktestTrade[];
}

interface BacktestRunOutput {
  rawSignals: number;
  qualifiedSignals: number;
  slOnlySignals: number;
  diagnostics: Record<string, number>;
  trades: BacktestTrade[];
}

const ICT_TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240
};

const DEFAULT_LOOKBACK = 300;
const BACKTEST_CACHE_MAX = 50;
const BACKTEST_CACHE_TTL_MS = 10 * 60_000;

interface BacktestCacheEntry {
  storedAt: number;
  result: BacktestResult;
}

export class BacktestService {
  private readonly cache = new Map<string, BacktestCacheEntry>();

  constructor(
    private readonly binance: BinanceClient,
    private readonly settingsService: SettingsService
  ) {}

  async run(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = Date.now();
    const settings = this.settingsService.get();
    const strategy = input.strategy === "wyckoff" ? "wyckoff" : "smc";
    const symbol = normalizeUsdFuturesSymbol(input.symbol || "BTCUSDT");
    const timeframe = this.normalizeTimeframe(input.timeframe || settings.klineInterval);
    const requestedCandles = clampInt(input.candles ?? 1000, 120, 1500);
    const minConfidence = clampNumber(
      input.minConfidence ?? (strategy === "wyckoff" ? settings.wyckoffMinConfidence : settings.minConfidence),
      0,
      100
    );
    const maxHoldCandles = clampInt(input.maxHoldCandles ?? 120, 5, 500);
    const maxWaitCandles = clampInt(input.maxWaitCandles ?? 20, 1, 100);
    const klines = (await this.binance.getKlines(symbol, timeframe, requestedCandles)).slice(0, -1);
    const lastClosedTime = klines.at(-1)?.closeTime ?? 0;
    const cacheKey = JSON.stringify({
      strategy,
      symbol,
      timeframe,
      requestedCandles,
      minConfidence,
      maxHoldCandles,
      maxWaitCandles,
      lastClosedTime,
      smc: strategy === "smc" ? {
        preferredRR: settings.smcPreferredRR,
        minScore: settings.smcMinScore,
        maxBarsAfterSweepForMSS: settings.smcMaxBarsAfterSweepForMSS,
        fvgMinSizePct: settings.smcFvgMinSizePct,
        avoidMiddleOfRange: settings.smcAvoidMiddleOfRange,
        fvgMaxBarsAfterMss: settings.smcFvgMaxBarsAfterMss
      } : undefined,
      wyckoff: strategy === "wyckoff" ? {
        rsiLength: settings.wyckoffRsiLength,
        trendSensitivity: settings.wyckoffTrendSensitivity,
        pivotLength: settings.wyckoffPivotLength,
        useVolumeFilter: settings.wyckoffUseVolumeFilter,
        volumeMaLength: settings.wyckoffVolumeMaLength,
        breakoutBufferPct: settings.wyckoffBreakoutBufferPct,
        retestTolerancePct: settings.wyckoffRetestTolerancePct,
        maxRiskDistancePct: settings.wyckoffMaxRiskDistancePct,
        minConfidence: settings.wyckoffMinConfidence,
        slBufferPct: settings.wyckoffSlBufferPct
      } : undefined
    });
    const cached = this.getCached(cacheKey);
    if (cached) {
      return {
        ...cloneResult(cached),
        elapsedMs: Date.now() - startedAt,
        cacheHit: true
      };
    }

    const output = strategy === "wyckoff"
      ? this.runWyckoff({ symbol, timeframe, klines, settings, minConfidence, maxHoldCandles, maxWaitCandles })
      : this.runSmc({ symbol, timeframe: timeframe as Timeframe, klines, settings, minConfidence, maxHoldCandles, maxWaitCandles });

    const summary = summarizeTrades(output.trades);
    summary.rawSignals = output.rawSignals;
    summary.qualifiedSignals = output.qualifiedSignals;
    summary.slOnlySignals = output.slOnlySignals;
    const result: BacktestResult = {
      symbol,
      strategy,
      timeframe,
      requestedCandles,
      candles: klines.length,
      testedCandles: Math.max(0, klines.length - DEFAULT_LOOKBACK),
      minConfidence,
      maxHoldCandles,
      maxWaitCandles,
      elapsedMs: Date.now() - startedAt,
      cacheHit: false,
      summary,
      diagnostics: output.diagnostics,
      trades: output.trades
    };
    this.setCached(cacheKey, result);
    return result;
  }

  private getCached(key: string): BacktestResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.storedAt > BACKTEST_CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return cached.result;
  }

  private setCached(key: string, result: BacktestResult): void {
    this.cache.set(key, { storedAt: Date.now(), result: cloneResult(result) });
    while (this.cache.size > BACKTEST_CACHE_MAX) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }

  private runSmc(input: {
    symbol: string;
    timeframe: Timeframe;
    klines: Kline[];
    settings: RuntimeSettings;
    minConfidence: number;
    maxHoldCandles: number;
    maxWaitCandles: number;
  }): BacktestRunOutput {
    if (!this.toIctTimeframe(input.timeframe)) {
      throw new Error(`SMC chỉ hỗ trợ timeframe: ${Object.keys(ICT_TIMEFRAME_MINUTES).join(", ")}`);
    }
    const config = this.resolveIctConfig([input.timeframe], false, input.timeframe, input.settings);
    const engine = new ICTSMCStrategyEngine(config);
    const trades: BacktestTrade[] = [];
    let rawSignals = 0;
    let qualifiedSignals = 0;
    let slOnlySignals = 0;
    const diagnostics: Record<string, number> = {};

    for (let index = DEFAULT_LOOKBACK - 1; index < input.klines.length - 2; index += 1) {
      const window = input.klines.slice(Math.max(0, index - DEFAULT_LOOKBACK + 1), index + 1);
      const analysis = engine.analyze({
        symbol: input.symbol,
        htfCandles: window,
        mtfCandles: window,
        ltfCandles: window
      });
      const signal = analysis.signal;
      if (!signal) {
        if (hasTpRrBlock(analysis.debug)) slOnlySignals += 1;
        addSmcDiagnostics(diagnostics, analysis.debug);
        continue;
      }
      rawSignals += 1;

      const confidence = Math.min(100, signal.score * 10);
      const latestClose = window.at(-1)?.close ?? 0;
      const targetAlreadyPassed = signal.direction === "long"
        ? latestClose >= signal.takeProfits.tp2
        : latestClose <= signal.takeProfits.tp2;
      if (targetAlreadyPassed) {
        increment(diagnostics, "TP đã đi qua trước khi khớp entry");
        continue;
      }

      const candidate: CandidateTrade = {
        side: signal.direction === "long" ? "LONG" : "SHORT",
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfits.tp2,
        confidence,
        reason: signal.reason.join("; "),
        setupType: signal.setupType
      };
      if (confidence < input.minConfidence) {
        increment(diagnostics, "Không đạt min confidence");
        continue;
      }
      qualifiedSignals += 1;

      const result = simulateTrade({
        candidate,
        klines: input.klines,
        signalIndex: index,
        symbol: input.symbol,
        timeframe: input.timeframe,
        strategy: "smc",
        maxHoldCandles: input.maxHoldCandles,
        maxWaitCandles: input.maxWaitCandles
      });
      trades.push({ ...result, index: trades.length + 1 });
      index = Math.max(index, result.barsHeld > 0 ? findTradeEndIndex(input.klines, result, index) : index + input.maxWaitCandles);
    }

    return { rawSignals, qualifiedSignals, slOnlySignals, diagnostics, trades };
  }

  private runWyckoff(input: {
    symbol: string;
    timeframe: string;
    klines: Kline[];
    settings: RuntimeSettings;
    minConfidence: number;
    maxHoldCandles: number;
    maxWaitCandles: number;
  }): BacktestRunOutput {
    const trades: BacktestTrade[] = [];
    let rawSignals = 0;
    let qualifiedSignals = 0;
    let slOnlySignals = 0;
    const diagnostics: Record<string, number> = {};
    const lookback = 180;
    const wyckoffSettings = {
      rsiLength: input.settings.wyckoffRsiLength,
      trendSensitivity: input.settings.wyckoffTrendSensitivity,
      pivotLength: input.settings.wyckoffPivotLength,
      useVolumeFilter: input.settings.wyckoffUseVolumeFilter,
      volumeMaLength: input.settings.wyckoffVolumeMaLength,
      breakoutBufferPct: input.settings.wyckoffBreakoutBufferPct,
      retestTolerancePct: input.settings.wyckoffRetestTolerancePct,
      maxRiskDistancePct: input.settings.wyckoffMaxRiskDistancePct,
      minConfidence: input.settings.wyckoffMinConfidence,
      slBufferPct: input.settings.wyckoffSlBufferPct,
      leverage: input.settings.sfpLeverage,
      marginType: input.settings.sfpMarginType
    };

    for (let index = lookback - 1; index < input.klines.length - 2; index += 1) {
      const rows = input.klines.slice(Math.max(0, index - lookback + 1), index + 1);
      const candles: WyckoffCandle[] = rows.map((kline) => ({
        time: kline.openTime,
        open: kline.open,
        high: kline.high,
        low: kline.low,
        close: kline.close,
        volume: kline.volume
      }));
      const analysis = analyzeWyckoff(candles, wyckoffSettings);
      const signal = generateWyckoffTradeSignal(candles, analysis, wyckoffSettings, rows.at(-1)?.close);
      const candidate = wyckoffCandidate(signal);
      if (candidate) rawSignals += 1;
      if (!candidate) {
        increment(diagnostics, signal.reason.at(-1) ?? "Không có setup Wyckoff");
        continue;
      }
      if (candidate.confidence < input.minConfidence) {
        increment(diagnostics, "Không đạt min confidence");
        continue;
      }
      qualifiedSignals += 1;

      const result = simulateTrade({
        candidate,
        klines: input.klines,
        signalIndex: index,
        symbol: input.symbol,
        timeframe: input.timeframe,
        strategy: "wyckoff",
        maxHoldCandles: input.maxHoldCandles,
        maxWaitCandles: input.maxWaitCandles
      });
      trades.push({ ...result, index: trades.length + 1 });
      index = Math.max(index, result.barsHeld > 0 ? findTradeEndIndex(input.klines, result, index) : index + input.maxWaitCandles);
    }

    return { rawSignals, qualifiedSignals, slOnlySignals, diagnostics, trades };
  }

  private resolveIctConfig(
    timeframes: string[],
    autoTimeframes: boolean,
    targetTimeframe: string,
    settings: RuntimeSettings
  ): ICTStrategyConfig {
    const preferredRR = settings.smcPreferredRR ?? defaultICTConfig.risk.preferredRR;
    const relaxedRRTP = settings.smcRelaxedRRTP ?? false;
    const fixedTakeProfitRoiPct = settings.smcTakeProfitRoiPercent ?? 30;
    return {
      ...defaultICTConfig,
      timeframes: this.resolveIctTimeframes(timeframes, autoTimeframes, targetTimeframe),
      sweep: {
        ...defaultICTConfig.sweep,
        maxBarsAfterSweepForMSS: settings.smcMaxBarsAfterSweepForMSS ?? defaultICTConfig.sweep.maxBarsAfterSweepForMSS
      },
      fvg: {
        ...defaultICTConfig.fvg,
        minSizePct: settings.smcFvgMinSizePct ?? defaultICTConfig.fvg.minSizePct,
        maxBarsAfterMss: settings.smcFvgMaxBarsAfterMss ?? defaultICTConfig.fvg.maxBarsAfterMss
      },
      risk: {
        ...defaultICTConfig.risk,
        minRR: Math.min(preferredRR, defaultICTConfig.risk.minRR),
        preferredRR,
        relaxRRAndTP: relaxedRRTP,
        fixedTakeProfitRoiPct,
        leverageForRoi: settings.sfpLeverage ?? 1
      },
      filters: {
        ...defaultICTConfig.filters,
        avoidMiddleOfRange: settings.smcAvoidMiddleOfRange ?? defaultICTConfig.filters.avoidMiddleOfRange,
        minScoreToTrade: settings.smcMinScore ?? defaultICTConfig.filters.minScoreToTrade
      }
    };
  }

  private resolveIctTimeframes(
    timeframes: string[],
    autoTimeframes: boolean,
    targetTimeframe: string
  ): ICTStrategyConfig["timeframes"] {
    if (autoTimeframes) return { htf: "1h", mtf: "15m", ltf: "1m" };
    const target = this.toIctTimeframe(targetTimeframe);
    if (target) return { htf: target, mtf: target, ltf: target };
    const only = timeframes.map((tf) => this.toIctTimeframe(tf)).find((tf): tf is Timeframe => tf !== null)
      ?? defaultICTConfig.timeframes.mtf;
    return { htf: only, mtf: only, ltf: only };
  }

  private toIctTimeframe(value: string): Timeframe | null {
    return Object.prototype.hasOwnProperty.call(ICT_TIMEFRAME_MINUTES, value)
      ? value as Timeframe
      : null;
  }

  private normalizeTimeframe(value: string): string {
    const clean = value.trim();
    return clean || "1m";
  }
}

function wyckoffCandidate(signal: WyckoffTradeSignal): CandidateTrade | null {
  if (signal.side !== "LONG" && signal.side !== "SHORT") return null;
  if (!signal.entryPrice || !signal.stopLoss || !signal.takeProfit2) return null;
  return {
    side: signal.side,
    entry: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit2,
    confidence: signal.confidence,
    reason: signal.reason.join("; "),
    setupType: signal.entryType ?? "WYCKOFF"
  };
}

function simulateTrade(input: {
  candidate: CandidateTrade;
  klines: Kline[];
  signalIndex: number;
  symbol: string;
  timeframe: string;
  strategy: BacktestStrategy;
  maxHoldCandles: number;
  maxWaitCandles: number;
}): BacktestTrade {
  const { candidate, klines, signalIndex } = input;
  const signalTime = new Date(klines[signalIndex]?.closeTime ?? Date.now()).toISOString();
  let entryIndex = -1;
  const waitEnd = Math.min(klines.length - 1, signalIndex + input.maxWaitCandles);
  for (let i = signalIndex + 1; i <= waitEnd; i += 1) {
    if (touchesEntry(klines[i], candidate)) {
      entryIndex = i;
      break;
    }
  }

  if (entryIndex < 0) {
    return {
      index: 0,
      symbol: input.symbol,
      strategy: input.strategy,
      timeframe: input.timeframe,
      side: candidate.side,
      setupType: candidate.setupType,
      confidence: candidate.confidence,
      signalTime,
      entry: candidate.entry,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      outcome: "expired",
      pnlR: 0,
      barsHeld: input.maxWaitCandles,
      reason: candidate.reason
    };
  }

  const holdEnd = Math.min(klines.length - 1, entryIndex + input.maxHoldCandles);
  for (let i = entryIndex; i <= holdEnd; i += 1) {
    const candle = klines[i];
    const slHit = touchesStop(candle, candidate);
    const tpHit = touchesTakeProfit(candle, candidate);
    if (slHit || tpHit) {
      const conservativeSl = slHit && tpHit;
      const outcome: BacktestOutcome = conservativeSl || slHit ? "sl" : "tp";
      const exitPrice = outcome === "tp" ? candidate.takeProfit : candidate.stopLoss;
      return {
        index: 0,
        symbol: input.symbol,
        strategy: input.strategy,
        timeframe: input.timeframe,
        side: candidate.side,
        setupType: candidate.setupType,
        confidence: candidate.confidence,
        signalTime,
        entryTime: new Date(klines[entryIndex].closeTime).toISOString(),
        exitTime: new Date(candle.closeTime).toISOString(),
        entry: candidate.entry,
        stopLoss: candidate.stopLoss,
        takeProfit: candidate.takeProfit,
        exitPrice,
        outcome,
        pnlR: pnlR(candidate, exitPrice),
        barsHeld: i - entryIndex + 1,
        reason: candidate.reason
      };
    }
  }

  const last = klines[holdEnd];
  const outcome: BacktestOutcome = holdEnd >= klines.length - 1 ? "open" : "timeout";
  return {
    index: 0,
    symbol: input.symbol,
    strategy: input.strategy,
    timeframe: input.timeframe,
    side: candidate.side,
    setupType: candidate.setupType,
    confidence: candidate.confidence,
    signalTime,
    entryTime: new Date(klines[entryIndex].closeTime).toISOString(),
    exitTime: new Date(last.closeTime).toISOString(),
    entry: candidate.entry,
    stopLoss: candidate.stopLoss,
    takeProfit: candidate.takeProfit,
    exitPrice: outcome === "timeout" ? last.close : undefined,
    outcome,
    pnlR: outcome === "timeout" ? pnlR(candidate, last.close) : 0,
    barsHeld: holdEnd - entryIndex + 1,
    reason: candidate.reason
  };
}

function summarizeTrades(trades: BacktestTrade[]): BacktestResult["summary"] {
  const filled = trades.filter((trade) => trade.outcome !== "expired");
  const closed = filled.filter((trade) => trade.outcome !== "open");
  const wins = trades.filter((trade) => trade.outcome === "tp").length;
  const losses = trades.filter((trade) => trade.outcome === "sl").length;
  const timeouts = trades.filter((trade) => trade.outcome === "timeout").length;
  const expired = trades.filter((trade) => trade.outcome === "expired").length;
  const open = trades.filter((trade) => trade.outcome === "open").length;
  const netR = closed.reduce((sum, trade) => sum + trade.pnlR, 0);
  const rValues = closed.map((trade) => trade.pnlR);
  return {
    rawSignals: trades.length,
    qualifiedSignals: trades.length,
    filledTrades: filled.length,
    closedTrades: closed.length,
    wins,
    losses,
    timeouts,
    expired,
    open,
    slOnlySignals: 0,
    winRate: wins + losses > 0 ? wins / (wins + losses) * 100 : 0,
    netR,
    avgR: closed.length > 0 ? netR / closed.length : 0,
    bestR: rValues.length ? Math.max(...rValues) : 0,
    worstR: rValues.length ? Math.min(...rValues) : 0
  };
}

function addSmcDiagnostics(bucket: Record<string, number>, debug: string[]): void {
  if (debug.length === 0) {
    increment(bucket, "Không có debug");
    return;
  }
  for (const item of debug) {
    if (item.includes("no valid MTF liquidity sweep")) {
      increment(bucket, "Không có liquidity sweep hợp lệ");
    } else if (item.includes("MSS missing")) {
      increment(bucket, "Có sweep nhưng thiếu MSS");
    } else if (item.includes("FVG missing")) {
      increment(bucket, "Có MSS nhưng thiếu/filled/small FVG");
    } else if (item.includes("SL too far")) {
      increment(bucket, "SL quá xa so với ATR");
    } else if (item.includes("TP liquidity/RR invalid")) {
      increment(bucket, "TP/RR không hợp lệ");
    } else if (item.includes("RR TP2")) {
      increment(bucket, "RR thấp hơn preferred RR");
    } else if (item.includes("entry in middle")) {
      increment(bucket, "Entry nằm giữa range");
    } else if (item.includes("low LTF volume")) {
      increment(bucket, "Volume LTF thấp");
    } else if (item.includes("not enough")) {
      increment(bucket, "Không đủ nến");
    }
  }
}

function hasTpRrBlock(debug: string[]): boolean {
  return debug.some((item) =>
    item.includes("TP liquidity/RR invalid") ||
    item.includes("RR TP2")
  );
}

function increment(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function findTradeEndIndex(klines: Kline[], trade: BacktestTrade, fallback: number): number {
  const targetTime = trade.exitTime ?? trade.entryTime ?? trade.signalTime;
  const targetMs = Date.parse(targetTime);
  const found = klines.findIndex((kline) => kline.closeTime === targetMs);
  return found >= 0 ? found : fallback;
}

function touchesEntry(candle: Kline, trade: CandidateTrade): boolean {
  return candle.low <= trade.entry && candle.high >= trade.entry;
}

function touchesStop(candle: Kline, trade: CandidateTrade): boolean {
  return trade.side === "LONG" ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss;
}

function touchesTakeProfit(candle: Kline, trade: CandidateTrade): boolean {
  return trade.side === "LONG" ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit;
}

function pnlR(trade: CandidateTrade, exitPrice: number): number {
  const risk = trade.side === "LONG" ? trade.entry - trade.stopLoss : trade.stopLoss - trade.entry;
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  const pnl = trade.side === "LONG" ? exitPrice - trade.entry : trade.entry - exitPrice;
  return pnl / risk;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function cloneResult(result: BacktestResult): BacktestResult {
  return JSON.parse(JSON.stringify(result)) as BacktestResult;
}
