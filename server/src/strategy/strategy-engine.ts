import { BinanceClient } from "../binance/client.js";
import { BinanceWSManager } from "../binance/ws-manager.js";
import { createSignalChart } from "../chart/signal-chart.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { OrderExecutor } from "../orders/order-executor.js";
import { AuditLogService } from "../services/audit-log.js";
import { SettingsService } from "../services/settings.js";
import type {
  Kline,
  MarketSignal,
  RuntimeSettings,
  SignalDecision,
  TrendDirection
} from "../types.js";
import {
  bollingerBands,
  ema,
  parabolicSar,
  rsi,
  supertrend,
  swingFailurePattern,
  volumeChangePercent,
  type SFPResult
} from "./indicators.js";
import {
  detectCandlestickPattern,
  type CandlestickPatternResult
} from "./candlestick-patterns.js";
import {
  analyzeWyckoff,
  generateWyckoffTradeSignal,
  type Candle,
  type WyckoffTradeSignal
} from "./wyckoff.js";
import { defaultICTConfig } from "./ict-smc/config.js";
import { ICTSMCStrategyEngine } from "./ict-smc/engine.js";
import type { ICTStrategyConfig, Timeframe, TradeSignal as ICTTradeSignal } from "./ict-smc/types.js";

const LONG_SHORT_PERIODS = new Set([
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d"
]);

const ICT_LOOKBACK_CANDLES = 300;
const ICT_MIN_CACHED_CLOSED_CANDLES = ICT_LOOKBACK_CANDLES - 1;
const SMC_REJECT_RETRY_COOLDOWN_MS = 10 * 60_000;
const ICT_TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240
};
const ICT_AUTO_TIMEFRAMES: ICTStrategyConfig["timeframes"] = {
  htf: "1h",
  mtf: "15m",
  ltf: "1m"
};
const AUTO_MARGIN_BUFFER_MULTIPLIER = 1.08;
const AUTO_MARGIN_BUFFER_LABEL = "8%";

interface SignalScoreInput {
  klines: Kline[];
  emaFast: number | null;
  emaSlow: number | null;
  ema10: number | null;
  ema36: number | null;
  rsiValue: number | null;
  volumeChange: number | null;
  fundingRate: number | null;
  longShortRatio: number | null;
  supertrendValue: number | null;
  supertrendDirection: TrendDirection | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  sarValue: number | null;
  sarDirection: TrendDirection | null;
  sfp: SFPResult | null;
  candlePattern: CandlestickPatternResult | null;
}

function ratioPeriod(interval: string): string {
  return LONG_SHORT_PERIODS.has(interval) ? interval : "5m";
}

function latestArrayNumber(data: unknown, key: string): number | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const value = (data.at(-1) as Record<string, unknown> | undefined)?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectNumber(data: unknown, key: string): number | null {
  if (!data || typeof data !== "object") return null;
  const parsed = Number((data as Record<string, unknown>)[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

const HTF_INTERVALS   = ["1h", "4h"] as const;
const HTF_REFRESH_MS  = 5 * 60_000;  // refresh HTF bias every 5 minutes
const HTF_CANDLES     = 60;           // 60 candles per HTF

interface HtfBias {
  bias: "bullish" | "bearish" | "neutral";
  reason: string;
  updatedAt: number;
}

export class StrategyEngine {
  private timer?: NodeJS.Timeout;
  private htfTimer?: NodeJS.Timeout;
  private running = false;
  private emergencyStopped = false;
  private readonly latestSignalCache = new Map<string, MarketSignal>();
  // symbol → { "1h": HtfBias, "4h": HtfBias }
  private readonly htfCache = new Map<string, Record<string, HtfBias>>();
  constructor(
    private readonly settingsService: SettingsService,
    private readonly binance: BinanceClient,
    private readonly ws: BinanceWSManager,
    private readonly db: AppDatabase,
    private readonly audit: AuditLogService,
    private readonly executor?: OrderExecutor
  ) {}

  start(): void {
    if (this.timer) return;
    this.audit.info("Strategy engine đã khởi động");
    void this.tick();
    const intervalMs = this.settingsService.get().strategyIntervalSeconds * 1000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // HTF bias refresh — runs independently every 5 minutes
    void this.refreshHtfBias();
    this.htfTimer = setInterval(() => void this.refreshHtfBias(), HTF_REFRESH_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    if (this.htfTimer) { clearInterval(this.htfTimer); this.htfTimer = undefined; }
    this.timer = undefined;
    this.audit.info("Strategy engine đã dừng");
  }

  emergencyStop(): void {
    this.emergencyStopped = true;
    this.audit.warn("Đã kích hoạt dừng khẩn cấp strategy engine");
    appEvents.publish("emergency.stop", { strategyPaused: true });
  }

  resumeAfterEmergency(): void {
    this.emergencyStopped = false;
    this.audit.info("Đã gỡ trạng thái dừng khẩn cấp strategy engine");
  }

  status(): { running: boolean; emergencyStopped: boolean } {
    return {
      running: Boolean(this.timer),
      emergencyStopped: this.emergencyStopped
    };
  }

  latestSignalsFor(symbols: string[]): Array<MarketSignal | null> {
    return symbols.map((symbol) => this.latestSignalCache.get(symbol) ?? null);
  }

  listLatestSignals(limit = 100): MarketSignal[] {
    return [...this.latestSignalCache.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit);
  }

  private refreshSignalChart(signalId: number | undefined, klines: Kline[], reason: string): void {
    if (signalId === undefined || klines.length === 0) return;
    const updated = this.db.getSFPSignal(signalId);
    if (!updated) return;
    createSignalChart(updated, klines)
      .then((chart) => this.db.updateSFPSignalChart(signalId, chart.chartPath, chart.chartUrl))
      .catch((error) => {
        this.audit.warn("Khong the cap nhat chart sau khi doi trang thai signal", {
          id: signalId,
          symbol: updated.symbol,
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async resolveAutoMarginUsdt(
    symbol: string,
    requestedMarginUsdt: number,
    leverage: number,
    settings: RuntimeSettings
  ): Promise<number> {
    if (settings.dryRun) return requestedMarginUsdt;
    try {
      const [balanceRows, positions] = await Promise.all([
        this.binance.getBalance() as Promise<Array<Record<string, unknown>>>,
        this.binance.getPosition() as Promise<Array<Record<string, unknown>>>
      ]);
      const usdt = Array.isArray(balanceRows)
        ? balanceRows.find(row => String(row.asset ?? "") === "USDT")
        : undefined;
      const available = Number(usdt?.availableBalance ?? 0);
      const activePositions = Array.isArray(positions)
        ? positions.filter(row => Math.abs(Number(row.positionAmt ?? 0)) > 0)
        : [];
      const alreadyOpenSameSymbol = activePositions.some(
        row => String(row.symbol ?? "").toUpperCase() === symbol.toUpperCase()
      );
      if (!Number.isFinite(available) || available <= 0 || alreadyOpenSameSymbol) return requestedMarginUsdt;

      const remainingSlots = Math.max(1, Math.max(1, settings.maxOpenPositions) - activePositions.length);
      const safePerSlot = Math.floor((available / AUTO_MARGIN_BUFFER_MULTIPLIER / remainingSlots) * 100) / 100;
      const minViableMargin = Math.ceil((5 / Math.max(1, leverage)) * 100) / 100;
      if (safePerSlot <= 0) return requestedMarginUsdt;

      let effective = Math.min(requestedMarginUsdt, safePerSlot);
      if (effective < minViableMargin && safePerSlot >= minViableMargin) {
        effective = minViableMargin;
      }
      effective = Math.max(0.01, Math.floor(effective * 100) / 100);
      if (Math.abs(effective - requestedMarginUsdt) >= 0.005) {
        this.audit.info("Tu can doi ky quy moi lenh theo so du kha dung", {
          symbol,
          requestedMarginUsdt,
          effectiveMarginUsdt: effective,
          availableUsdt: available,
          remainingSlots,
          buffer: AUTO_MARGIN_BUFFER_LABEL
        });
      }
      return effective;
    } catch (error) {
      this.audit.warn("Khong the tu can doi ky quy, dung gia tri cau hinh", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
      return requestedMarginUsdt;
    }
  }

  async runOnce(): Promise<MarketSignal[]> {
    return this.tick();
  }

  async previewOnce(options: { symbols?: string[]; intervals?: string[] } = {}): Promise<MarketSignal[]> {
    const baseSettings = this.settingsService.get();
    const symbols = options.symbols?.length
      ? options.symbols
      : baseSettings.strategyMode === "smc"
      ? baseSettings.sfpWatchSymbols
      : baseSettings.allowedSymbols;
    const intervals = baseSettings.strategyMode === "smc"
      ? this.resolveSmcScanIntervals(
          options.intervals?.length ? options.intervals : baseSettings.sfpTimeframes,
          baseSettings.smcAutoTimeframes
        )
      : options.intervals?.length ? options.intervals : [baseSettings.klineInterval];
    const results: MarketSignal[] = [];

    for (const interval of intervals) {
      const settings = {
        ...baseSettings,
        klineInterval: interval,
        sfpTimeframes: baseSettings.strategyMode === "smc" && options.intervals?.length ? options.intervals : baseSettings.sfpTimeframes
      };
      for (const symbol of symbols) {
        const rateLimit = this.binance.rateLimitStatus();
        if (rateLimit.banned) {
          this.audit.warn("Strategy preview tam dung vi Binance dang rate-limit", {
            waitSeconds: rateLimit.waitSeconds
          });
          return results;
        }
        try {
          results.push(
            settings.strategyMode === "wyckoff"
              ? await this.analyzeWyckoffPreviewSymbol(symbol, settings)
              : settings.strategyMode === "smc"
              ? await this.analyzeSmcSymbol(symbol, settings)
              : await this.analyzeSymbol(symbol, settings)
          );
        } catch (error) {
          this.audit.error("Strategy preview loi khi phan tich symbol", {
            symbol,
            interval,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return results;
  }

  private async tick(): Promise<MarketSignal[]> {
    if (this.running) return [];
    this.running = true;
    const settings = this.settingsService.get();
    const results: MarketSignal[] = [];
    const selectedStrategies = new Set(settings.sfpStrategies ?? []);
    const scanJobs: Array<{
      mode: RuntimeSettings["strategyMode"];
      symbols: string[];
      intervals: string[];
    }> = [];
    if (selectedStrategies.has("smc")) {
      scanJobs.push({
        mode: "smc",
        symbols: settings.sfpWatchSymbols,
        intervals: this.resolveSmcScanIntervals(settings.sfpTimeframes, settings.smcAutoTimeframes)
      });
    }
    if (selectedStrategies.has("wyckoff")) {
      scanJobs.push({
        mode: "wyckoff",
        symbols: settings.allowedSymbols,
        intervals: [settings.klineInterval]
      });
    }
    if (scanJobs.length === 0 && !["smc", "wyckoff"].includes(settings.strategyMode)) {
      scanJobs.push({
        mode: settings.strategyMode,
        symbols: settings.allowedSymbols,
        intervals: [settings.klineInterval]
      });
    }
    appEvents.publish("strategy.tick", {
      symbols: [...new Set(scanJobs.flatMap((job) => job.symbols))],
      autoTradeEnabled: settings.autoTradeEnabled,
      readOnly: settings.readOnly
    });

    try {
      if (settings.readOnly) {
        return results;
      }
      for (const job of scanJobs) {
      for (const interval of job.intervals) {
        const intervalSettings = { ...settings, strategyMode: job.mode, klineInterval: interval };
        for (const symbol of job.symbols) {
        const rateLimit = this.binance.rateLimitStatus();
        if (rateLimit.banned) {
          this.audit.warn("Strategy tick tam dung vi Binance dang rate-limit", {
            waitSeconds: rateLimit.waitSeconds
          });
          break;
        }
        try {
          let signal: MarketSignal;
          if (intervalSettings.strategyMode === "wyckoff") {
            signal = await this.analyzeAndExecuteWyckoff(symbol, intervalSettings);
          } else if (intervalSettings.strategyMode === "smc") {
            const liveSettings = { ...this.settingsService.get(), klineInterval: interval };
            if (liveSettings.readOnly || !(liveSettings.sfpStrategies ?? []).includes("smc")) break;
            signal = await this.analyzeSmcSymbol(symbol, liveSettings);
          } else {
            signal = await this.analyzeSymbol(symbol, intervalSettings);
          }
          results.push(signal);
          this.latestSignalCache.set(signal.symbol, signal);
          this.db.insertSignal(signal);
          appEvents.publish("signal.created", signal);
        } catch (error) {
          this.audit.error("Một vòng xử lý symbol của chiến lược bị lỗi", {
            symbol,
            interval,
            error: error instanceof Error ? error.message : String(error)
          });
          if (this.binance.rateLimitStatus().banned) break;
        }
        }
        if (this.binance.rateLimitStatus().banned) break;
      }
      if (this.binance.rateLimitStatus().banned) break;
      }
      return results;
    } finally {
      this.db.pruneTransientTradeData();
      this.running = false;
    }
  }

  private async analyzeSymbol(symbol: string, settings = this.settingsService.get()): Promise<MarketSignal> {
    const [klines, funding, openInterest, longShort] = await Promise.all([
      this.binance.getKlines(symbol, settings.klineInterval, 100),
      this.optional(() => this.binance.getFundingRate(symbol, 1)),
      this.optional(() => this.binance.getOpenInterest(symbol)),
      this.optional(() =>
        this.binance.getLongShortRatio(symbol, ratioPeriod(settings.klineInterval), 30)
      )
    ]);

    const closes = klines.map((kline) => kline.close);
    const volumes = klines.map((kline) => kline.volume);
    const price = closes.at(-1) ?? 0;
    const emaFast = ema(closes, 9);
    const emaSlow = ema(closes, 21);
    const ema10 = ema(closes, 10);
    const ema36 = ema(closes, 36);
    const rsiValue = rsi(closes, 14);
    const volumeChange = volumeChangePercent(volumes);
    const fundingRate = latestArrayNumber(funding, "fundingRate");
    const openInterestValue = objectNumber(openInterest, "openInterest");
    const longShortRatio = latestArrayNumber(longShort, "longShortRatio");
    const supertrendResult = supertrend(
      klines,
      settings.supertrendPeriod,
      settings.supertrendMultiplier
    );
    const bb = bollingerBands(
      closes,
      settings.bollingerPeriod,
      settings.bollingerStdDev
    );
    const sarResult = parabolicSar(klines, settings.sarStep, settings.sarMax);
    const sfpResult = settings.sfpEnabled ? swingFailurePattern(klines, settings.sfpLen) : null;
    // Mẫu nến chỉ tham gia scoring, không tự quyết định vào lệnh
    const candlePattern = detectCandlestickPattern(klines);

    const scoreInput: SignalScoreInput = {
      klines,
      emaFast,
      emaSlow,
      ema10,
      ema36,
      rsiValue,
      volumeChange,
      fundingRate,
      longShortRatio,
      supertrendValue: supertrendResult?.value ?? null,
      supertrendDirection: supertrendResult?.direction ?? null,
      bbUpper: bb?.upper ?? null,
      bbMiddle: bb?.middle ?? null,
      bbLower: bb?.lower ?? null,
      sarValue: sarResult?.value ?? null,
      sarDirection: sarResult?.direction ?? null,
      sfp: sfpResult ?? null,
      candlePattern: candlePattern ?? null
    };
    const decision = this.decideSignal(scoreInput, settings);

    return {
      symbol,
      interval: settings.klineInterval,
      signal: decision.signal,
      confidence: decision.confidence,
      reason: decision.reason,
      price,
      emaFast,
      emaSlow,
      ema10,
      ema36,
      rsi: rsiValue,
      volumeChange,
      fundingRate,
      openInterest: openInterestValue,
      longShortRatio,
      supertrend: supertrendResult?.value ?? null,
      supertrendDirection: supertrendResult?.direction ?? null,
      bbUpper: bb?.upper ?? null,
      bbMiddle: bb?.middle ?? null,
      bbLower: bb?.lower ?? null,
      sar: sarResult?.value ?? null,
      sarDirection: sarResult?.direction ?? null,
      createdAt: new Date().toISOString()
    };
  }

  private async analyzeSmcSymbol(
    symbol: string,
    settings = this.settingsService.get()
  ): Promise<MarketSignal> {
    const nowMs = Date.now();
    const liveSettings = { ...this.settingsService.get(), klineInterval: settings.klineInterval };
    const ictConfig = this.resolveIctConfig(
      liveSettings.sfpTimeframes,
      liveSettings.smcAutoTimeframes,
      liveSettings.klineInterval,
      liveSettings
    );
    const rawKlines = await this.getIctKlines(symbol, ictConfig.timeframes);
    const htfRaw = rawKlines[ictConfig.timeframes.htf];
    const mtfRaw = rawKlines[ictConfig.timeframes.mtf];
    const ltfRaw = rawKlines[ictConfig.timeframes.ltf];
    const htfKlines = this.closedKlines(htfRaw, nowMs);
    const mtfKlines = this.closedKlines(mtfRaw, nowMs);
    const ltfKlines = this.closedKlines(ltfRaw, nowMs);
    const closes = ltfKlines.map((kline) => kline.close);
    const volumes = ltfKlines.map((kline) => kline.volume);
    const latestClosed = ltfKlines.at(-1) ?? mtfKlines.at(-1) ?? htfKlines.at(-1) ?? null;
    const ict = new ICTSMCStrategyEngine(ictConfig).analyze({
      symbol,
      htfCandles: htfKlines,
      mtfCandles: mtfKlines,
      ltfCandles: ltfKlines
    });
    const latestPrice = latestClosed?.close ?? closes.at(-1) ?? 0;
    const targetAlreadyPassed = ict.signal && latestPrice > 0
      ? ict.signal.direction === "long"
        ? latestPrice >= ict.signal.takeProfits.tp2
        : latestPrice <= ict.signal.takeProfits.tp2
      : false;
    const tradeSignal = targetAlreadyPassed ? null : ict.signal;
    let finalTradeSignal = tradeSignal;
    let blockedAfterAnalysisReason: string | null = null;
    if (tradeSignal !== null) {
      const saveResult = await this.saveIctSmcSignal(symbol, tradeSignal, ictConfig, ltfKlines, liveSettings);
      if (!saveResult.saved) {
        finalTradeSignal = null;
        blockedAfterAnalysisReason = saveResult.reason ?? null;
      }
    }

    const signal: SignalDecision = finalTradeSignal
      ? finalTradeSignal.direction === "long" ? "LONG" : "SHORT"
      : "WAIT";
    const confidence = finalTradeSignal ? Math.min(100, finalTradeSignal.score * 10) : 0;
    const reason = finalTradeSignal
      ? [
          `ICT_SMC ${finalTradeSignal.setupType}`,
          `bias=${ict.bias}`,
          `HTF=${ictConfig.timeframes.htf}`,
          `MTF=${ictConfig.timeframes.mtf}`,
          `LTF=${ictConfig.timeframes.ltf}`,
          `entry=${finalTradeSignal.entry}`,
          `SL=${finalTradeSignal.stopLoss}`,
          `TP1=${finalTradeSignal.takeProfits.tp1}`,
          `TP2=${finalTradeSignal.takeProfits.tp2}`,
          `RR2=${finalTradeSignal.rr.tp2.toFixed(2)}R`,
          ...finalTradeSignal.reason
        ].join("; ")
      : [
          `ICT_SMC WAIT`,
          `bias=${ict.bias}`,
          ...(blockedAfterAnalysisReason ? [`No trade: ${blockedAfterAnalysisReason}`] : []),
          ...(targetAlreadyPassed && ict.signal
            ? [
                `No trade: TP already passed before limit entry`,
                `entry=${ict.signal.entry}`,
                `TP2=${ict.signal.takeProfits.tp2}`,
                `lastClose=${latestPrice}`
              ]
            : ict.debug)
        ].join("; ");

    return {
      symbol,
      interval: ictConfig.timeframes.mtf,
      signal,
      confidence,
      reason,
      price: latestPrice,
      emaFast: null,
      emaSlow: null,
      ema10: null,
      ema36: null,
      rsi: rsi(closes, 14),
      volumeChange: volumeChangePercent(volumes),
      fundingRate: null,
      openInterest: null,
      longShortRatio: null,
      supertrend: null,
      supertrendDirection: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
      sar: null,
      sarDirection: null,
      createdAt: new Date().toISOString()
    };
  }

  private async saveIctSmcSignal(
    symbol: string,
    trade: ICTTradeSignal,
    ictConfig: ICTStrategyConfig,
    ltfKlines: Kline[],
    settings: RuntimeSettings
  ): Promise<{ saved: boolean; reason?: string }> {
    const preDirection: "BULLISH" | "BEARISH" = trade.direction === "long" ? "BULLISH" : "BEARISH";
    const preDedupSince = new Date(Date.now() - 3_600_000).toISOString();
    const preRecent = this.db.recentSFPSignals(symbol, preDedupSince);
    const preNowMs = Date.now();
    const preDuplicate = preRecent.some((signal) => {
      const sameSetup =
        signal.strategy === "smc" &&
        signal.patternName?.includes("ICT SMC") &&
        signal.timeframe === ictConfig.timeframes.mtf &&
        signal.direction === preDirection &&
        Math.abs(signal.entryPrice - trade.entry) / trade.entry < 0.005;
      if (!sameSetup) return false;
      if (signal.status === "pending" || signal.status === "limit_placed" || signal.status === "executed") {
        return true;
      }
      if (signal.status === "rejected") {
        const ageMs = preNowMs - Date.parse(signal.createdAt);
        return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SMC_REJECT_RETRY_COOLDOWN_MS;
      }
      return false;
    });
    if (preDuplicate) {
      this.audit.info("ICT SMC signal bi bo qua do trung setup hoac vua reject gan day", {
        symbol,
        timeframe: ictConfig.timeframes.mtf,
        direction: preDirection
      });
      return { saved: false, reason: "Setup trung hoac vua bi reject gan day." };
    }

    const liveSettings = { ...this.settingsService.get(), klineInterval: settings.klineInterval };
    const liveIctConfig = this.resolveIctConfig(
      liveSettings.sfpTimeframes,
      liveSettings.smcAutoTimeframes,
      liveSettings.klineInterval,
      liveSettings
    );
    if (!liveSettings.smcRelaxedRRTP) {
      const cameFromRelaxedConfig = ictConfig.risk.relaxRRAndTP;
      const belowPreferredRR = trade.rr.tp2 < liveIctConfig.risk.preferredRR;
      if (cameFromRelaxedConfig || belowPreferredRR) {
        const reason = cameFromRelaxedConfig
          ? "Bo RR/TP SMC da tat trong luc quet; setup relaxed bi chan, cho quet lai theo logic goc."
          : `RR2 ${trade.rr.tp2.toFixed(2)}R thap hon RR TP2 toi thieu ${liveIctConfig.risk.preferredRR}R.`;
        await this.saveBlockedIctSmcSignal(symbol, trade, liveIctConfig, ltfKlines, liveSettings, reason);
        return { saved: false, reason };
      }
    }
    const direction: "BULLISH" | "BEARISH" = trade.direction === "long" ? "BULLISH" : "BEARISH";
    const dedupSince = new Date(Date.now() - 3_600_000).toISOString();
    const recent = this.db.recentSFPSignals(symbol, dedupSince);
    const nowMs = Date.now();
    const isDuplicate = recent.some((signal) => {
      const sameSetup =
        signal.strategy === "smc" &&
        signal.patternName?.startsWith("ICT SMC") &&
        signal.timeframe === ictConfig.timeframes.mtf &&
        signal.direction === direction &&
        Math.abs(signal.entryPrice - trade.entry) / trade.entry < 0.005;
      if (!sameSetup) return false;
      if (signal.status === "pending" || signal.status === "limit_placed" || signal.status === "executed") {
        return true;
      }
      if (signal.status === "rejected") {
        const ageMs = nowMs - Date.parse(signal.createdAt);
        return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SMC_REJECT_RETRY_COOLDOWN_MS;
      }
      return false;
    });
    if (isDuplicate) {
      this.audit.info("ICT SMC signal bi bo qua do trung setup hoac vua reject gan day", {
        symbol,
        timeframe: ictConfig.timeframes.mtf,
        direction
      });
      return { saved: false, reason: "Setup trùng hoặc vừa bị reject gần đây." };
    }

    const lastCandle = ltfKlines.at(-1);
    if (!lastCandle) return { saved: false, reason: "Khong co nen dong de luu setup." };
    const score = Math.min(100, trade.score * 10);
    const decisionDetails: import("../types.js").SFPDecisionRule[] = [
      {
        id: "ict-core",
        label: "Sweep -> MSS -> FVG",
        status: "pass",
        detail: "Setup co du liquidity sweep, market structure shift va fair value gap theo thu tu.",
        weight: 40
      },
      {
        id: "ict-timeframes",
        label: "Multi-timeframe",
        status: "pass",
        detail: `HTF=${ictConfig.timeframes.htf}, MTF=${ictConfig.timeframes.mtf}, LTF=${ictConfig.timeframes.ltf}. Chi dung nen da dong.`,
        weight: 15
      },
      {
        id: "ict-risk",
        label: "RR va SL",
        status: settings.smcRelaxedRRTP || trade.rr.tp2 >= ictConfig.risk.preferredRR ? "pass" : "warn",
        detail: settings.smcRelaxedRRTP
          ? `Relaxed RR/TP: Entry=${trade.entry}, SL=${trade.stopLoss}, TP trigger ROI ${settings.smcTakeProfitRoiPercent}%=${trade.takeProfits.tp2}, RR tham chieu=${trade.rr.tp2.toFixed(2)}R.`
          : `Entry=${trade.entry}, SL=${trade.stopLoss}, TP1=${trade.takeProfits.tp1}, TP2=${trade.takeProfits.tp2}, RR2=${trade.rr.tp2.toFixed(2)}R.`,
        weight: 25
      },
      {
        id: "ict-score",
        label: "Score",
        status: trade.score >= ictConfig.filters.minScoreToTrade ? "pass" : "warn",
        detail: `Score ${trade.score}/10. ${trade.reason.join("; ")}`,
        weight: 20
      }
    ];
    const isAuto =
      !this.emergencyStopped &&
      settings.autoTradeEnabled &&
      settings.sfpAutoExecute &&
      !settings.readOnly &&
      score >= settings.minConfidence;
    const effectiveMarginUsdt = await this.resolveAutoMarginUsdt(
      symbol,
      settings.sfpMarginUsdt,
      settings.sfpLeverage,
      settings
    );

    const signal: import("../types.js").SFPSignalRecord = {
      strategy: "smc",
      patternName: `ICT SMC ${trade.setupType} ${trade.direction.toUpperCase()}`,
      symbol,
      timeframe: ictConfig.timeframes.mtf,
      direction,
      confirmed: true,
      swingPrice: trade.entry,
      oppositeLevel: trade.stopLoss,
      sfpCandleHigh: lastCandle.high,
      sfpCandleLow: lastCandle.low,
      entryPrice: trade.entry,
      slPrice: trade.stopLoss,
      tpPrice: trade.takeProfits.tp2,
      leverage: settings.sfpLeverage,
      marginUsdt: effectiveMarginUsdt,
      status: "pending",
      decision: "TRADE",
      decisionScore: score,
      decisionSummary: trade.reason.join("; "),
      decisionDetails,
      hasSfp: false,
      message: `ICT SMC ${trade.direction.toUpperCase()} ${trade.setupType}; entry=${trade.entry}; SL=${trade.stopLoss}; TP2=${trade.takeProfits.tp2}; RR2=${trade.rr.tp2.toFixed(2)}R`,
      createdAt: new Date().toISOString()
    };

    const saved = this.db.insertSFPSignal(signal);
    appEvents.publish("sfp.signal", saved);
    this.audit.info("ICT SMC signal luu vao queue", {
      symbol,
      timeframe: ictConfig.timeframes.mtf,
      direction: trade.direction,
      score,
      entry: trade.entry,
      sl: trade.stopLoss,
      tp: trade.takeProfits.tp2,
      marginUsdt: effectiveMarginUsdt,
      rr2: trade.rr.tp2
    });

    if (saved.id !== undefined) {
      createSignalChart(saved, ltfKlines)
        .then((chart) => this.db.updateSFPSignalChart(saved.id!, chart.chartPath, chart.chartUrl))
        .catch((error) => {
          this.audit.warn("Khong the tao chart cho ICT SMC signal", {
            symbol,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }

    if (isAuto) {
      await this.maybeExecuteIctSmcTrade(symbol, trade, settings, saved.id, ltfKlines, effectiveMarginUsdt);
    }
    return { saved: true };
  }

  private async saveBlockedIctSmcSignal(
    symbol: string,
    trade: ICTTradeSignal,
    ictConfig: ICTStrategyConfig,
    ltfKlines: Kline[],
    settings: RuntimeSettings,
    reason: string
  ): Promise<void> {
    const direction: "BULLISH" | "BEARISH" = trade.direction === "long" ? "BULLISH" : "BEARISH";
    const lastCandle = ltfKlines.at(-1);
    if (!lastCandle) return;
    const score = Math.min(100, trade.score * 10);
    const signal: import("../types.js").SFPSignalRecord = {
      strategy: "smc",
      patternName: `[BLOCKED] ICT SMC ${trade.setupType} ${trade.direction.toUpperCase()}`,
      symbol,
      timeframe: ictConfig.timeframes.mtf,
      direction,
      confirmed: true,
      swingPrice: trade.entry,
      oppositeLevel: trade.stopLoss,
      sfpCandleHigh: lastCandle.high,
      sfpCandleLow: lastCandle.low,
      entryPrice: trade.entry,
      slPrice: trade.stopLoss,
      tpPrice: trade.takeProfits.tp2,
      leverage: settings.sfpLeverage,
      marginUsdt: settings.sfpMarginUsdt,
      status: "rejected",
      decision: "SKIP",
      decisionScore: score,
      decisionSummary: reason,
      decisionDetails: [
        {
          id: "ict-risk-live-config",
          label: "RR/TP live config",
          status: "fail",
          detail: reason,
          weight: 100
        }
      ],
      hasSfp: false,
      message: `KHONG VAO LENH: ${reason}`,
      createdAt: new Date().toISOString()
    };
    const saved = this.db.insertSFPSignal(signal);
    appEvents.publish("sfp.signal", saved);
    this.audit.warn("ICT SMC setup bi chan boi cau hinh RR/TP moi nhat", {
      symbol,
      timeframe: ictConfig.timeframes.mtf,
      direction,
      rr2: trade.rr.tp2,
      preferredRR: ictConfig.risk.preferredRR,
      reason
    });
    if (saved.id !== undefined) {
      createSignalChart(saved, ltfKlines)
        .then((chart) => this.db.updateSFPSignalChart(saved.id!, chart.chartPath, chart.chartUrl))
        .catch((error) => {
          this.audit.warn("Khong the tao chart cho ICT SMC blocked signal", {
            symbol,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }
  }

  private async maybeExecuteIctSmcTrade(
    symbol: string,
    trade: ICTTradeSignal,
    settings: RuntimeSettings,
    signalId?: number,
    chartKlines: Kline[] = [],
    marginUsdt = settings.sfpMarginUsdt
  ): Promise<void> {
    if (!this.executor) {
      this.audit.warn("ICT SMC execute bi bo qua: OrderExecutor chua duoc inject", { symbol });
      return;
    }
    try {
      const side = trade.direction === "long" ? "BUY" : "SELL";
      const leverage = settings.sfpLeverage;
      const quantity = (marginUsdt * leverage) / trade.entry;
      const tradeResult = await this.executor.executeProtectedTrade({
        symbol,
        side,
        entryType: settings.allowMarketOrder ? "MARKET" : "LIMIT",
        quantity,
        entryPrice: trade.entry,
        stopLossPrice: trade.stopLoss,
        takeProfitPrice: trade.takeProfits.tp2,
        leverage,
        marginType: settings.sfpMarginType,
        source: "strategy",
        confidence: Math.min(100, trade.score * 10),
        reason: `ICT SMC ${trade.direction.toUpperCase()} ${trade.setupType}; ${trade.reason.join("; ")}`,
        skipRewardRiskCheck: settings.smcRelaxedRRTP,
        useTrailingStop: settings.smcRelaxedRRTP,
        trailingCallbackRate: settings.sfpTrailingCallbackRate,
        trailingActivationPrice: settings.smcRelaxedRRTP ? trade.takeProfits.tp2 : undefined,
        onEntryFilled: signalId === undefined ? undefined : () => {
          this.db.updateSFPSignalStatus(signalId, "executed", "LIMIT order khop, vi the mo, TP/SL da gui len Binance.");
          this.refreshSignalChart(signalId, chartKlines, "limit-filled");
          appEvents.publish("sfp.signal", { id: signalId, status: "executed" });
        },
        onEntryExpired: signalId === undefined ? undefined : () => {
          this.db.updateSFPSignalStatus(signalId, "rejected", "LIMIT order dat len Binance nhung khong khop trong 60 giay, da huy tu dong.");
          this.refreshSignalChart(signalId, chartKlines, "limit-expired");
          appEvents.publish("sfp.signal", { id: signalId, status: "rejected" });
        }
      }) as Record<string, unknown>;
      if (signalId !== undefined) {
        const stopLossResult = tradeResult.stopLoss as Record<string, unknown> | undefined;
        const isPendingFill = stopLossResult?.status === "PENDING_POSITION";
        if (settings.dryRun) {
          this.db.updateSFPSignalStatus(signalId, "simulated", "Mo phong: khong gui lenh that.");
          this.refreshSignalChart(signalId, chartKlines, "dry-run");
        } else if (isPendingFill) {
          this.db.markLimitPlaced(signalId, "LIMIT order dat len Binance, dang cho khop. TP/SL se gui khi vi the mo.");
          this.refreshSignalChart(signalId, chartKlines, "limit-placed");
        } else {
          this.db.updateSFPSignalStatus(signalId, "executed", "ICT SMC trade dat lenh thanh cong.");
          this.refreshSignalChart(signalId, chartKlines, "executed");
        }
      }
      this.audit.info("ICT SMC trade dat lenh thanh cong", {
        symbol,
        direction: trade.direction,
        entry: trade.entry,
        sl: trade.stopLoss,
        tp: trade.takeProfits.tp2
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signalId !== undefined) {
        const stillOpen = await this.hasOpenPosition(symbol);
        this.db.updateSFPSignalStatus(
          signalId,
          stillOpen ? "executed" : "rejected",
          stillOpen
            ? `Lệnh đã vào nhưng bước bảo vệ/cleanup lỗi; Binance vẫn còn vị thế mở. Kiểm tra TP/SL thủ công. Lỗi gốc: ${message}`
            : message
        );
        this.refreshSignalChart(signalId, chartKlines, stillOpen ? "execute-failed-open" : "execute-rejected");
      }
      this.audit.warn("ICT SMC execute that bai", { symbol, error: message });
    }
  }

  // Full Wyckoff analysis with live price + conditional execution.
  // Used by tick() so execution happens inside the strategy loop.
  private async analyzeAndExecuteWyckoff(
    symbol: string,
    settings: RuntimeSettings
  ): Promise<MarketSignal> {
    const [klines, priceRaw] = await Promise.all([
      this.binance.getKlines(symbol, settings.klineInterval, 100),
      this.optional(() => this.binance.getPrice(symbol))
    ]);

    const closes = klines.map((k) => k.close);
    const volumes = klines.map((k) => k.volume);
    const rawPrice = (priceRaw as { price?: string } | null)?.price;
    const livePrice = rawPrice ? parseFloat(rawPrice) : null;
    const price =
      livePrice && Number.isFinite(livePrice) && livePrice > 0
        ? livePrice
        : (closes.at(-1) ?? 0);

    const candles: Candle[] = klines.map((k) => ({
      time: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume
    }));

    const wyckoffSettings = {
      rsiLength: settings.wyckoffRsiLength,
      trendSensitivity: settings.wyckoffTrendSensitivity,
      pivotLength: settings.wyckoffPivotLength,
      useVolumeFilter: settings.wyckoffUseVolumeFilter,
      volumeMaLength: settings.wyckoffVolumeMaLength,
      breakoutBufferPct: settings.wyckoffBreakoutBufferPct,
      retestTolerancePct: settings.wyckoffRetestTolerancePct,
      maxRiskDistancePct: settings.wyckoffMaxRiskDistancePct,
      minConfidence: settings.wyckoffMinConfidence,
      slBufferPct: settings.wyckoffSlBufferPct,
      leverage: settings.sfpLeverage,
      marginType: settings.sfpMarginType
    };

    const analysis = analyzeWyckoff(candles, wyckoffSettings);
    const trade = generateWyckoffTradeSignal(candles, analysis, wyckoffSettings, price);
    const signal = this.mapWyckoffSide(trade);

    const lastBox = analysis.lastBox
      ? `${analysis.lastBox.type} ${analysis.lastBox.low.toFixed(6)}-${analysis.lastBox.high.toFixed(6)}`
      : "none";
    const lastSig = analysis.lastSignal
      ? `${analysis.lastSignal.type}@${analysis.lastSignal.confirmedIndex}`
      : "none";
    const tradeText = this.describeWyckoffTrade(trade);

    const marketSignal: MarketSignal = {
      symbol,
      interval: settings.klineInterval,
      signal,
      confidence: trade.confidence,
      reason: [
        `WYCKOFF_ACC_DIST ${trade.side}`,
        `box=${lastBox}`,
        `lastSignal=${lastSig}`,
        tradeText,
        ...trade.reason
      ].join("; "),
      price,
      emaFast: null,
      emaSlow: null,
      ema10: null,
      ema36: null,
      rsi: rsi(closes, settings.wyckoffRsiLength),
      volumeChange: volumeChangePercent(volumes),
      fundingRate: null,
      openInterest: null,
      longShortRatio: null,
      supertrend: null,
      supertrendDirection: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
      sar: null,
      sarDirection: null,
      createdAt: new Date().toISOString()
    };

    // When a valid trade signal is generated, save it as SFPSignalRecord so the dashboard
    // can display an "Execute" button (manual mode) or auto-queue can pick it up.
    if (
      signal !== "WAIT" &&
      trade.entryPrice !== undefined &&
      trade.stopLoss !== undefined &&
      trade.takeProfit1 !== undefined
    ) {
      await this.saveWyckoffSignal(symbol, trade, analysis, klines, settings);
    } else if (signal === "WAIT" && trade.confidence >= settings.wyckoffMinConfidence) {
      // High-confidence WAIT: save a "blocked" record + chart so user can see WHY
      await this.saveBlockedWyckoffSignal(symbol, trade, analysis, klines, settings);
    }

    return marketSignal;
  }

  private async saveWyckoffSignal(
    symbol: string,
    trade: WyckoffTradeSignal,
    analysis: ReturnType<typeof analyzeWyckoff>,
    klines: Kline[],
    settings: RuntimeSettings
  ): Promise<void> {
    const direction: "BULLISH" | "BEARISH" = trade.side === "LONG" ? "BULLISH" : "BEARISH";

    // Dedup: skip if there is already an active (pending/limit_placed/executed) Wyckoff
    // signal for this symbol from the last hour to avoid re-inserting on every tick.
    const dedupSince = new Date(Date.now() - 3_600_000).toISOString();
    const recent = this.db.recentSFPSignals(symbol, dedupSince);
    const isDuplicate = recent.some(
      (s) =>
        s.strategy === "wyckoff" &&
        s.direction === direction &&
        (s.status === "pending" || s.status === "limit_placed" || s.status === "executed") &&
        Math.abs(s.entryPrice - trade.entryPrice!) / trade.entryPrice! < 0.005
    );
    if (isDuplicate) return;

    const lastCandle = klines.at(-1)!;
    const isAuto =
      !this.emergencyStopped &&
      settings.autoTradeEnabled &&
      settings.sfpAutoExecute &&
      !settings.readOnly &&
      trade.confidence >= settings.wyckoffMinConfidence;
    const effectiveMarginUsdt = await this.resolveAutoMarginUsdt(
      symbol,
      settings.sfpMarginUsdt,
      settings.sfpLeverage,
      settings
    );

    const wyckoffRecord: import("../types.js").SFPSignalRecord = {
      strategy: "wyckoff",
      patternName: `Wyckoff ${trade.entryType ?? "SIGNAL"} ${trade.side}`,
      symbol,
      timeframe: settings.klineInterval,
      direction,
      confirmed: true,
      swingPrice: trade.entryType === "BREAKOUT"
        ? (analysis.lastBox?.high ?? trade.entryPrice!)
        : (analysis.lastBox?.low ?? trade.stopLoss!),
      oppositeLevel: trade.stopLoss!,
      sfpCandleHigh: lastCandle.high,
      sfpCandleLow: lastCandle.low,
      entryPrice: trade.entryPrice!,
      slPrice: trade.stopLoss!,
      tpPrice: trade.takeProfit1!,
      leverage: settings.sfpLeverage,
      marginUsdt: effectiveMarginUsdt,
      status: "pending",
      decision: "TRADE",
      decisionScore: trade.confidence,
      decisionSummary: trade.reason.join("; "),
      decisionDetails: [],
      hasSfp: false,
      message: trade.reason.slice(0, 3).join("; "),
      createdAt: new Date().toISOString()
    };

    const saved = this.db.insertSFPSignal(wyckoffRecord);
    appEvents.publish("sfp.signal", saved);
    this.audit.info("Wyckoff signal luu vao queue cho nut vao lenh", {
      symbol, direction, entry: trade.entryPrice, sl: trade.stopLoss, tp: trade.takeProfit1,
      marginUsdt: effectiveMarginUsdt,
      confidence: trade.confidence, mode: isAuto ? "auto" : "manual"
    });

    // Auto-generate chart for this signal (non-blocking)
    if (saved.id !== undefined) {
      const closedKlines = klines.length > 1 ? klines.slice(0, -1) : klines;
      createSignalChart(saved, closedKlines)
        .then(chart => {
          this.db.updateSFPSignalChart(saved.id!, chart.chartPath, chart.chartUrl);
        })
        .catch(err => {
          this.audit.warn("Khong the tao chart cho Wyckoff signal", {
            symbol, error: err instanceof Error ? err.message : String(err)
          });
        });
    }

    // Auto mode: execute immediately via OrderExecutor; update signal status afterward.
    if (isAuto) {
      const closedKlines = klines.length > 1 ? klines.slice(0, -1) : klines;
      await this.maybeExecuteWyckoffTrade(symbol, trade, settings, saved.id, closedKlines, effectiveMarginUsdt);
    }
  }

  private async maybeExecuteWyckoffTrade(
    symbol: string,
    trade: WyckoffTradeSignal,
    settings: RuntimeSettings,
    signalId?: number,
    chartKlines: Kline[] = [],
    marginUsdt = settings.sfpMarginUsdt
  ): Promise<void> {
    if (!this.executor) {
      this.audit.warn("Wyckoff execute bi bo qua: OrderExecutor chua duoc inject", { symbol });
      return;
    }
    try {
      const side = trade.side === "LONG" ? "BUY" : "SELL" as const;
      // Use sfp leverage/margin settings — consistent with the execute button path
      const leverage = settings.sfpLeverage;
      const entryPrice = trade.entryPrice!;
      const quantity = (marginUsdt * leverage) / entryPrice;
      const tradeResult = await this.executor.executeProtectedTrade({
        symbol,
        side,
        // Always LIMIT — TP/SL remain STOP_MARKET / TAKE_PROFIT_MARKET on Binance side.
        // BREAKOUT: LIMIT at live price fills immediately as maker (no slippage).
        // RETEST: LIMIT at box boundary waits for price to return.
        entryType: settings.allowMarketOrder ? "MARKET" : "LIMIT",
        quantity,
        entryPrice,
        stopLossPrice: trade.stopLoss!,
        takeProfitPrice: trade.takeProfit1!,
        leverage,
        marginType: settings.sfpMarginType,
        source: "strategy",
        confidence: trade.confidence,
        reason: `Wyckoff ${trade.side} ${trade.entryType ?? ""}; ${trade.reason.join("; ")}`,
        onEntryFilled: signalId === undefined ? undefined : () => {
          this.db.updateSFPSignalStatus(signalId, "executed", "LIMIT order khop, vi the mo, TP/SL da gui len Binance.");
          this.refreshSignalChart(signalId, chartKlines, "wyckoff-limit-filled");
          appEvents.publish("sfp.signal", { id: signalId, status: "executed" });
        },
        onEntryExpired: signalId === undefined ? undefined : () => {
          this.db.updateSFPSignalStatus(signalId, "rejected", "LIMIT order dat len Binance nhung khong khop trong 60 giay, da huy tu dong.");
          this.refreshSignalChart(signalId, chartKlines, "wyckoff-limit-expired");
          appEvents.publish("sfp.signal", { id: signalId, status: "rejected" });
        }
      }) as Record<string, unknown>;
      if (signalId !== undefined) {
        const stopLossResult = tradeResult.stopLoss as Record<string, unknown> | undefined;
        const isPendingFill = stopLossResult?.status === "PENDING_POSITION";
        if (settings.dryRun) {
          this.db.updateSFPSignalStatus(signalId, "simulated", "Mo phong: khong gui lenh that.");
          this.refreshSignalChart(signalId, chartKlines, "wyckoff-dry-run");
        } else if (isPendingFill) {
          this.db.markLimitPlaced(signalId, "LIMIT order dat len Binance, dang cho khop. TP/SL se gui khi vi the mo.");
          this.refreshSignalChart(signalId, chartKlines, "wyckoff-limit-placed");
        } else {
          this.db.updateSFPSignalStatus(signalId, "executed", "Wyckoff trade dat lenh thanh cong.");
          this.refreshSignalChart(signalId, chartKlines, "wyckoff-executed");
        }
      }
      this.audit.info("Wyckoff trade dat lenh thanh cong", {
        symbol, side: trade.side, entryType: trade.entryType,
        entry: entryPrice, sl: trade.stopLoss, tp: trade.takeProfit1, confidence: trade.confidence
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (signalId !== undefined) {
        const stillOpen = await this.hasOpenPosition(symbol);
        this.db.updateSFPSignalStatus(
          signalId,
          stillOpen ? "executed" : "rejected",
          stillOpen
            ? `Lệnh đã vào nhưng bước bảo vệ/cleanup lỗi; Binance vẫn còn vị thế mở. Kiểm tra TP/SL thủ công. Lỗi gốc: ${msg}`
            : msg
        );
        this.refreshSignalChart(signalId, chartKlines, stillOpen ? "wyckoff-execute-failed-open" : "wyckoff-execute-rejected");
      }
      this.audit.warn("Wyckoff execute that bai (risk/rate-limit/duplicate)", { symbol, error: msg });
    }
  }

  private async hasOpenPosition(symbol: string): Promise<boolean> {
    try {
      const positions = await this.binance.getPosition(symbol) as unknown[];
      const rows = Array.isArray(positions) ? positions : [positions];
      return rows.some((row) => Math.abs(Number((row as Record<string, unknown>).positionAmt ?? 0)) > 0);
    } catch (error) {
      this.audit.warn("Khong the doi chieu vi the sau loi execute", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async analyzeWyckoffPreviewSymbol(
    symbol: string,
    settings: RuntimeSettings
  ): Promise<MarketSignal> {
    const klines = await this.binance.getKlines(symbol, settings.klineInterval, 100);
    const closes = klines.map((kline) => kline.close);
    const volumes = klines.map((kline) => kline.volume);
    const price = closes.at(-1) ?? 0;
    const input: SignalScoreInput = {
      klines,
      emaFast: null,
      emaSlow: null,
      ema10: null,
      ema36: null,
      rsiValue: rsi(closes, settings.wyckoffRsiLength),
      volumeChange: volumeChangePercent(volumes),
      fundingRate: null,
      longShortRatio: null,
      supertrendValue: null,
      supertrendDirection: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
      sarValue: null,
      sarDirection: null,
      sfp: null,
      candlePattern: null
    };
    const decision = this.wyckoffSignal(input, settings);

    return {
      symbol,
      interval: settings.klineInterval,
      signal: decision.signal,
      confidence: decision.confidence,
      reason: decision.reason,
      price,
      emaFast: null,
      emaSlow: null,
      ema10: null,
      ema36: null,
      rsi: input.rsiValue,
      volumeChange: input.volumeChange,
      fundingRate: null,
      openInterest: null,
      longShortRatio: null,
      supertrend: null,
      supertrendDirection: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
      sar: null,
      sarDirection: null,
      createdAt: new Date().toISOString()
    };
  }

  private decideSignal(
    input: SignalScoreInput,
    settings: RuntimeSettings
  ): { signal: SignalDecision; confidence: number; reason: string } {
    if (settings.strategyMode === "wyckoff") return this.wyckoffSignal(input, settings);
    const scoreDecision = this.scoreSignal(input, settings);
    const ruleDecision = this.ruleSignal(input, settings);

    if (settings.strategyMode === "score") return scoreDecision;
    if (settings.strategyMode === "rules") return ruleDecision;
    if (ruleDecision.signal !== "WAIT") return ruleDecision;
    return scoreDecision;
  }

  private wyckoffSignal(
    input: SignalScoreInput,
    settings: RuntimeSettings
  ): { signal: SignalDecision; confidence: number; reason: string } {
    const candles = input.klines.map((kline): Candle => ({
      time: kline.openTime,
      open: kline.open,
      high: kline.high,
      low: kline.low,
      close: kline.close,
      volume: kline.volume
    }));
    const wyckoffSettings = {
      rsiLength: settings.wyckoffRsiLength,
      trendSensitivity: settings.wyckoffTrendSensitivity,
      pivotLength: settings.wyckoffPivotLength,
      useVolumeFilter: settings.wyckoffUseVolumeFilter,
      volumeMaLength: settings.wyckoffVolumeMaLength,
      breakoutBufferPct: settings.wyckoffBreakoutBufferPct,
      retestTolerancePct: settings.wyckoffRetestTolerancePct,
      maxRiskDistancePct: settings.wyckoffMaxRiskDistancePct,
      minConfidence: settings.wyckoffMinConfidence,
      slBufferPct: settings.wyckoffSlBufferPct,
      leverage: settings.sfpLeverage,
      marginType: settings.sfpMarginType
    };
    const analysis = analyzeWyckoff(candles, wyckoffSettings);
    const trade = generateWyckoffTradeSignal(candles, analysis, wyckoffSettings);
    const signal = this.mapWyckoffSide(trade);
    const lastBox = analysis.lastBox
      ? `${analysis.lastBox.type} ${analysis.lastBox.low.toFixed(6)}-${analysis.lastBox.high.toFixed(6)}`
      : "none";
    const lastSignal = analysis.lastSignal
      ? `${analysis.lastSignal.type}@${analysis.lastSignal.confirmedIndex}`
      : "none";
    const tradeText = this.describeWyckoffTrade(trade);
    return {
      signal,
      confidence: trade.confidence,
      reason: [
        `WYCKOFF_ACC_DIST ${trade.side}`,
        `box=${lastBox}`,
        `lastSignal=${lastSignal}`,
        tradeText,
        ...trade.reason
      ].join("; ")
    };
  }

  private mapWyckoffSide(trade: WyckoffTradeSignal): SignalDecision {
    if (trade.side === "LONG") return "LONG";
    if (trade.side === "SHORT") return "SHORT";
    return "WAIT";
  }

  private describeWyckoffTrade(trade: WyckoffTradeSignal): string {
    if (trade.side === "NONE") return "trade=NONE";
    return [
      `entryType=${trade.entryType}`,
      `entry=${trade.entryPrice?.toFixed(6)}`,
      `sl=${trade.stopLoss?.toFixed(6)}`,
      `tp1=${trade.takeProfit1?.toFixed(6)}`,
      `tp2=${trade.takeProfit2?.toFixed(6)}`
    ].join(", ");
  }

  private scoreSignal(
    input: SignalScoreInput,
    settings: RuntimeSettings
  ): { signal: SignalDecision; confidence: number; reason: string } {
    let longScore = 0;
    let shortScore = 0;
    const reasons: string[] = [];

    if (input.emaFast !== null && input.emaSlow !== null) {
      if (input.emaFast > input.emaSlow) {
        longScore += 35;
        reasons.push("xu hướng EMA 9/21 nghiêng về long");
      } else {
        shortScore += 35;
        reasons.push("xu hướng EMA 9/21 nghiêng về short");
      }
    }

    if (input.ema10 !== null && input.ema36 !== null) {
      if (input.ema10 > input.ema36) {
        longScore += 20;
        reasons.push("EMA 10 nằm trên EMA 36");
      } else {
        shortScore += 20;
        reasons.push("EMA 10 nằm dưới EMA 36");
      }
    }

    if (input.rsiValue !== null) {
      if (input.rsiValue < 35) {
        longScore += 20;
        reasons.push("RSI đang quá bán");
      } else if (input.rsiValue > 65) {
        shortScore += 20;
        reasons.push("RSI đang quá mua");
      } else if (input.rsiValue >= 45 && input.rsiValue <= 60) {
        longScore += 8;
        shortScore += 8;
        reasons.push("RSI trung tính");
      }
    }

    if (input.volumeChange !== null && input.volumeChange > 10) {
      if (longScore >= shortScore) longScore += 12;
      else shortScore += 12;
      reasons.push("volume tăng mạnh");
    }

    if (input.fundingRate !== null) {
      if (input.fundingRate < -0.0001) {
        longScore += 10;
        reasons.push("funding âm");
      } else if (input.fundingRate > 0.0001) {
        shortScore += 10;
        reasons.push("funding dương");
      }
    }

    if (input.longShortRatio !== null) {
      if (input.longShortRatio < 0.9) {
        longScore += 5;
        reasons.push("tỷ lệ long/short thấp");
      } else if (input.longShortRatio > 1.1) {
        shortScore += 5;
        reasons.push("tỷ lệ long/short cao");
      }
    }

    if (input.supertrendDirection !== null) {
      if (input.supertrendDirection === "UP") {
        longScore += 18;
        reasons.push("Supertrend đang tăng");
      } else {
        shortScore += 18;
        reasons.push("Supertrend đang giảm");
      }
    }

    if (input.sarDirection !== null) {
      if (input.sarDirection === "UP") {
        longScore += 8;
        reasons.push("Parabolic SAR ủng hộ long");
      } else {
        shortScore += 8;
        reasons.push("Parabolic SAR ủng hộ short");
      }
    }

    const latest = input.klines.at(-1);
    if (latest && settings.ruleBollingerReversion) {
      if (this.touchesLevel(latest, input.bbLower, settings.touchTolerancePercent)) {
        longScore += 12;
        reasons.push("giá chạm BB dưới");
      }
      if (this.touchesLevel(latest, input.bbUpper, settings.touchTolerancePercent)) {
        shortScore += 12;
        reasons.push("giá chạm BB trên");
      }
    }

    if (input.sfp !== null && settings.sfpEnabled) {
      const pts = input.sfp.confirmed ? 30 : 15;
      if (input.sfp.direction === "BULLISH") {
        longScore += pts;
        reasons.push(input.sfp.confirmed ? "SFP tăng đã xác nhận" : "SFP tăng phát hiện");
      } else {
        shortScore += pts;
        reasons.push(input.sfp.confirmed ? "SFP giảm đã xác nhận" : "SFP giảm phát hiện");
      }
    }

    // Mẫu nến đa nến: cộng điểm cùng hướng, trừ điểm ngược hướng
    // Không tự vào lệnh — chỉ là yếu tố xác nhận thêm
    if (input.candlePattern !== null) {
      const patBoost = Math.round(input.candlePattern.confidence * 0.2);
      if (input.candlePattern.direction === "BULLISH") {
        longScore += patBoost;
        shortScore -= 15;
        reasons.push(`mẫu nến tăng: ${input.candlePattern.patternName} (+${patBoost})`);
      } else {
        shortScore += patBoost;
        longScore -= 15;
        reasons.push(`mẫu nến giảm: ${input.candlePattern.patternName} (+${patBoost})`);
      }
    }

    const diff = Math.abs(longScore - shortScore);
    if (diff < 12 || Math.max(longScore, shortScore) < 45) {
      return {
        signal: "WAIT",
        confidence: Math.max(longScore, shortScore),
        reason: `Chưa có lợi thế đủ mạnh. ${reasons.join("; ") || "thiếu dữ liệu"}`
      };
    }

    const signal: SignalDecision = longScore > shortScore ? "LONG" : "SHORT";
    return {
      signal,
      confidence: Math.min(100, Math.max(longScore, shortScore)),
      reason: `${signal} điểm ${
        longScore > shortScore ? longScore : shortScore
      }; ${reasons.join("; ")}`
    };
  }

  private ruleSignal(
    input: SignalScoreInput,
    settings: RuntimeSettings
  ): { signal: SignalDecision; confidence: number; reason: string } {
    const latest = input.klines.at(-1);
    if (!latest) {
      return { signal: "WAIT", confidence: 0, reason: "Thiếu dữ liệu nến" };
    }

    const touchesSupertrend = this.touchesLevel(
      latest,
      input.supertrendValue,
      settings.touchTolerancePercent
    );
    const touchesEma10 = this.touchesLevel(
      latest,
      input.ema10,
      settings.touchTolerancePercent
    );
    const touchesLowerBb = this.touchesLevel(
      latest,
      input.bbLower,
      settings.touchTolerancePercent
    );
    const touchesUpperBb = this.touchesLevel(
      latest,
      input.bbUpper,
      settings.touchTolerancePercent
    );

    const longChecks = [
      {
        enabled: settings.ruleRequireTrendDirection,
        ok:
          input.supertrendDirection === "UP" &&
          input.ema10 !== null &&
          input.ema36 !== null &&
          input.ema10 >= input.ema36,
        label: "xu hướng tăng"
      },
      {
        enabled: settings.ruleRequireEma10Touch,
        ok: touchesEma10,
        label: "giá hồi về EMA 10"
      },
      {
        enabled: settings.ruleRequireSupertrendTouch,
        ok: touchesSupertrend,
        label: "giá gần Supertrend"
      }
    ];
    const shortChecks = [
      {
        enabled: settings.ruleRequireTrendDirection,
        ok:
          input.supertrendDirection === "DOWN" &&
          input.ema10 !== null &&
          input.ema36 !== null &&
          input.ema10 <= input.ema36,
        label: "xu hướng giảm"
      },
      {
        enabled: settings.ruleRequireEma10Touch,
        ok: touchesEma10,
        label: "giá hồi về EMA 10"
      },
      {
        enabled: settings.ruleRequireSupertrendTouch,
        ok: touchesSupertrend,
        label: "giá gần Supertrend"
      }
    ];
    const enabledLongChecks = longChecks.filter((check) => check.enabled);
    const enabledShortChecks = shortChecks.filter((check) => check.enabled);

    if (
      settings.ruleSupertrendEma10Long &&
      enabledLongChecks.length > 0 &&
      enabledLongChecks.every((check) => check.ok)
    ) {
      return {
        signal: "LONG",
        confidence: 82,
        reason: `LONG rule; ${enabledLongChecks
          .map((check) => check.label)
          .join("; ")}; biên chạm ${settings.touchTolerancePercent}%`
      };
    }

    if (
      settings.ruleSupertrendEma10Short &&
      enabledShortChecks.length > 0 &&
      enabledShortChecks.every((check) => check.ok)
    ) {
      return {
        signal: "SHORT",
        confidence: 82,
        reason: `SHORT rule; ${enabledShortChecks
          .map((check) => check.label)
          .join("; ")}; biên chạm ${settings.touchTolerancePercent}%`
      };
    }

    if (settings.ruleBollingerReversion && touchesLowerBb) {
      return {
        signal: "LONG",
        confidence: 72,
        reason: `LONG rule; giá chạm dải dưới Bollinger trong biên ${settings.touchTolerancePercent}%`
      };
    }

    if (settings.ruleBollingerReversion && touchesUpperBb) {
      return {
        signal: "SHORT",
        confidence: 72,
        reason: `SHORT rule; giá chạm dải trên Bollinger trong biên ${settings.touchTolerancePercent}%`
      };
    }

    if (settings.ruleSfpSignal && settings.sfpEnabled && input.sfp !== null) {
      const side: SignalDecision = input.sfp.direction === "BULLISH" ? "LONG" : "SHORT";
      const confidence = input.sfp.confirmed ? 85 : 75;
      return {
        signal: side,
        confidence,
        reason: `${side} SFP ${input.sfp.confirmed ? "đã xác nhận" : "phát hiện"}; swing=${input.sfp.swingPrice.toFixed(4)}; oppos=${input.sfp.oppositeLevel.toFixed(4)}`
      };
    }

    return {
      signal: "WAIT",
      confidence: 0,
      reason: "Chưa khớp điều kiện rule strategy"
    };
  }

  private touchesLevel(
    latest: Kline,
    level: number | null,
    tolerancePercent: number
  ): boolean {
    if (level === null || level <= 0) return false;
    const tolerance = latest.close * (tolerancePercent / 100);
    return level >= latest.low - tolerance && level <= latest.high + tolerance;
  }

  private resolveIctConfig(
    timeframes: string[],
    autoTimeframes: boolean,
    targetTimeframe?: string,
    settings?: RuntimeSettings
  ): ICTStrategyConfig {
    const preferredRR = settings?.smcPreferredRR ?? defaultICTConfig.risk.preferredRR;
    const relaxedRRTP = settings?.smcRelaxedRRTP ?? false;
    const fixedTakeProfitRoiPct = settings?.smcTakeProfitRoiPercent ?? 30;
    return {
      ...defaultICTConfig,
      timeframes: this.resolveIctTimeframes(timeframes, autoTimeframes, targetTimeframe),
      sweep: {
        ...defaultICTConfig.sweep,
        maxBarsAfterSweepForMSS: settings?.smcMaxBarsAfterSweepForMSS ?? defaultICTConfig.sweep.maxBarsAfterSweepForMSS
      },
      fvg: {
        ...defaultICTConfig.fvg,
        minSizePct: settings?.smcFvgMinSizePct ?? defaultICTConfig.fvg.minSizePct,
        maxBarsAfterMss: settings?.smcFvgMaxBarsAfterMss ?? defaultICTConfig.fvg.maxBarsAfterMss
      },
      risk: {
        ...defaultICTConfig.risk,
        minRR: Math.min(preferredRR, defaultICTConfig.risk.minRR),
        preferredRR,
        relaxRRAndTP: relaxedRRTP,
        fixedTakeProfitRoiPct,
        leverageForRoi: settings?.sfpLeverage ?? 1
      },
      filters: {
        ...defaultICTConfig.filters,
        avoidMiddleOfRange: settings?.smcAvoidMiddleOfRange ?? defaultICTConfig.filters.avoidMiddleOfRange,
        minScoreToTrade: settings?.smcMinScore ?? defaultICTConfig.filters.minScoreToTrade
      }
    };
  }

  private resolveIctTimeframes(
    timeframes: string[],
    autoTimeframes: boolean,
    targetTimeframe?: string
  ): ICTStrategyConfig["timeframes"] {
    if (autoTimeframes) return ICT_AUTO_TIMEFRAMES;
    const target = this.toIctTimeframe(targetTimeframe ?? "");
    if (target) {
      return { ltf: target, mtf: target, htf: target };
    }

    const selected = [...new Set(timeframes)]
      .map((timeframe) => this.toIctTimeframe(timeframe))
      .filter((timeframe): timeframe is Timeframe => timeframe !== null)
      .sort((left, right) => ICT_TIMEFRAME_MINUTES[left] - ICT_TIMEFRAME_MINUTES[right]);

    if (selected.length >= 3) {
      return {
        ltf: selected[0],
        mtf: selected[Math.floor(selected.length / 2)],
        htf: selected.at(-1) ?? selected[0]
      };
    }
    if (selected.length === 2) {
      return {
        ltf: selected[0],
        mtf: selected[1],
        htf: selected[1]
      };
    }
    const only = selected[0] ?? defaultICTConfig.timeframes.mtf;
    return { ltf: only, mtf: only, htf: only };
  }

  private resolveSmcScanIntervals(timeframes: string[], autoTimeframes: boolean): Timeframe[] {
    if (autoTimeframes) return [ICT_AUTO_TIMEFRAMES.mtf];
    const selected = [...new Set(timeframes)]
      .map((timeframe) => this.toIctTimeframe(timeframe))
      .filter((timeframe): timeframe is Timeframe => timeframe !== null)
      .sort((left, right) => ICT_TIMEFRAME_MINUTES[left] - ICT_TIMEFRAME_MINUTES[right]);
    return selected.length > 0 ? selected : [defaultICTConfig.timeframes.mtf];
  }

  private async getIctKlines(
    symbol: string,
    timeframes: ICTStrategyConfig["timeframes"]
  ): Promise<Record<Timeframe, Kline[]>> {
    const uniqueTimeframes = [...new Set([timeframes.htf, timeframes.mtf, timeframes.ltf])];
    const entries = await Promise.all(
      uniqueTimeframes.map(async (timeframe) => {
        const cached = this.ws.getKlines(symbol, timeframe);
        const cachedClosed = this.closedKlines(cached, Date.now());
        if (cachedClosed.length >= ICT_MIN_CACHED_CLOSED_CANDLES) {
          return [timeframe, cached.slice(-ICT_LOOKBACK_CANDLES)] as const;
        }

        const klines = await this.binance.getKlines(symbol, timeframe, ICT_LOOKBACK_CANDLES);
        this.ws.subscribeKlines(symbol, timeframe, klines);
        return [timeframe, klines] as const;
      })
    );
    return Object.fromEntries(entries) as Record<Timeframe, Kline[]>;
  }

  private toIctTimeframe(value: string): Timeframe | null {
    return Object.prototype.hasOwnProperty.call(ICT_TIMEFRAME_MINUTES, value)
      ? value as Timeframe
      : null;
  }

  private closedKlines(klines: Kline[], nowMs: number): Kline[] {
    return klines.slice(0, -1).filter((kline) => kline.closeTime <= nowMs);
  }

  private async saveBlockedWyckoffSignal(
    symbol: string,
    trade: WyckoffTradeSignal,
    analysis: ReturnType<typeof analyzeWyckoff>,
    klines: Kline[],
    settings: RuntimeSettings
  ): Promise<void> {
    const lastBox = analysis.lastBox;
    if (!lastBox) return;

    // Dedup: skip if we already saved a blocked signal for this symbol in last 20 min
    const dedupSince = new Date(Date.now() - 20 * 60_000).toISOString();
    const recent = this.db.recentSFPSignals(symbol, dedupSince);
    if (recent.some(s => s.strategy === "wyckoff" && (s.status === "rejected" || s.status === "ignored"))) return;

    const isLong = lastBox.type === "Accumulation";
    const direction: "BULLISH" | "BEARISH" = isLong ? "BULLISH" : "BEARISH";

    // Estimate where entry/SL/TP would be if risk check had passed
    const entryEst = isLong ? lastBox.high : lastBox.low;
    const slEst    = isLong
      ? lastBox.low  * (1 - settings.wyckoffSlBufferPct / 100)
      : lastBox.high * (1 + settings.wyckoffSlBufferPct / 100);
    const tpEst    = isLong
      ? lastBox.high + (lastBox.high - lastBox.low)   // 1× box height above
      : lastBox.low  - (lastBox.high - lastBox.low);   // 1× box height below

    const lastCandle = klines.at(-1)!;
    const blockReason = trade.reason.join("; ");

    const blockedRecord: import("../types.js").SFPSignalRecord = {
      strategy: "wyckoff",
      patternName: `Wyckoff ${isLong ? "LONG" : "SHORT"} [BỊ CHẶN]`,
      symbol,
      timeframe: settings.klineInterval,
      direction,
      confirmed: true,
      swingPrice:    isLong ? lastBox.high : lastBox.low,
      oppositeLevel: isLong ? lastBox.low  : lastBox.high,
      sfpCandleHigh: lastCandle.high,
      sfpCandleLow:  lastCandle.low,
      entryPrice:  entryEst,
      slPrice:     slEst,
      tpPrice:     tpEst,
      leverage:    settings.sfpLeverage,
      marginUsdt:  settings.sfpMarginUsdt,
      status:      "rejected",
      decision:    "SKIP",
      decisionScore:   trade.confidence,
      decisionSummary: blockReason,
      decisionDetails: [],
      hasSfp:  false,
      message: `Conf ${trade.confidence}/100 — không vào được: ${trade.reason.at(-1) ?? "lý do không xác định"}`,
      createdAt: new Date().toISOString()
    };

    const saved = this.db.insertSFPSignal(blockedRecord);
    appEvents.publish("sfp.signal", saved);
    this.audit.info("Wyckoff signal bi chan, luu chart de xem ly do", {
      symbol, direction, confidence: trade.confidence, reason: trade.reason.at(-1)
    });

    // Auto-generate chart with block note
    if (saved.id !== undefined) {
      const closedKlines = klines.length > 1 ? klines.slice(0, -1) : klines;
      createSignalChart(saved, closedKlines)
        .then(chart => this.db.updateSFPSignalChart(saved.id!, chart.chartPath, chart.chartUrl))
        .catch(err => this.audit.warn("Khong the tao chart cho blocked signal", {
          symbol, error: err instanceof Error ? err.message : String(err)
        }));
    }
  }

  // ── HTF Bias ─────────────────────────────────────────────────────────────

  /** Refresh H1 and H4 Wyckoff bias for all allowed symbols. */
  private async refreshHtfBias(): Promise<void> {
    const settings = this.settingsService.get();
    if (settings.readOnly) return;
    for (const symbol of settings.allowedSymbols) {
      if (this.binance.rateLimitStatus().banned) break;
      const biases: Record<string, HtfBias> = this.htfCache.get(symbol) ?? {};
      for (const tf of HTF_INTERVALS) {
        try {
          const klines = await this.binance.getKlines(symbol, tf, HTF_CANDLES);
          const closes  = klines.map((k: Kline) => k.close);
          const volumes = klines.map((k: Kline) => k.volume);
          const candles = klines.map((k: Kline) => ({
            time: k.openTime, open: k.open, high: k.high,
            low: k.low, close: k.close, volume: k.volume
          }));
          biases[tf] = this.computeHtfBias(candles, closes, volumes, symbol, tf);
        } catch { /* skip on error */ }
      }
      this.htfCache.set(symbol, biases);
    }
  }

  private computeHtfBias(
    candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
    closes: number[],
    _volumes: number[],
    symbol: string,
    tf: string
  ): HtfBias {
    try {
      const analysis = analyzeWyckoff(candles, {
        pivotLength: 5,
        trendSensitivity: 20,
        volumeMaLength: 20
      });

      const lastBox    = analysis.lastBox;
      const signals    = analysis.signals;
      const price      = closes.at(-1) ?? 0;

      if (!lastBox) {
        return { bias: "neutral", reason: `${tf}: chưa xác định box`, updatedAt: Date.now() };
      }

      const hasBullish = signals.some(s => s.type === "SC" || s.type === "AR_ACC" || s.type === "ST_ACC" || s.type === "SPRING");
      const hasBearish = signals.some(s => s.type === "BC" || s.type === "AR_DIST" || s.type === "ST_DIST" || s.type === "UPTHRUST");

      // Price position relative to box
      const aboveBox = price > lastBox.high;
      const belowBox = price < lastBox.low;
      const insideBox = !aboveBox && !belowBox;

      let bias: "bullish" | "bearish" | "neutral" = "neutral";
      let reason = "";

      if (aboveBox || lastBox.type === "Accumulation") {
        // Price above box OR inside Accumulation box → bullish bias
        bias   = "bullish";
        reason = `${tf}: ${lastBox.type} box${aboveBox ? ", giá trên box" : ""} → bias TĂNG`;
      } else if (belowBox || lastBox.type === "Distribution") {
        // Price below box OR inside Distribution box → bearish bias
        // Distribution box means institutions are selling regardless of current price
        bias   = "bearish";
        reason = `${tf}: ${lastBox.type} box${belowBox ? ", giá dưới box" : ""} → bias GIẢM`;
      } else {
        // Unknown box → neutral
        reason = `${tf}: Unknown box → neutral`;
      }

      return { bias, reason, updatedAt: Date.now() };
    } catch {
      return { bias: "neutral", reason: `${tf}: lỗi phân tích HTF`, updatedAt: Date.now() };
    }
  }

  /** Get combined HTF bias.
   *  Rule: H4 has final say. If H4 is directional → use it.
   *  If H4 neutral → use H1. If both neutral → neutral (allow).
   *  A clear H4 bearish blocks LONG even if H1 is neutral.
   */
  getHtfBias(symbol: string): { bias: "bullish" | "bearish" | "neutral"; reasons: string[] } {
    const biases = this.htfCache.get(symbol);
    if (!biases) return { bias: "neutral", reasons: ["HTF chưa có dữ liệu — cho phép tạm"] };

    const h4 = biases["4h"];
    const h1 = biases["1h"];
    const reasons = [h1, h4].filter(Boolean).map(b => b.reason);

    // H4 is primary: if H4 is clear → use it
    if (h4 && h4.bias !== "neutral") return { bias: h4.bias, reasons };
    // H4 neutral → fall back to H1
    if (h1 && h1.bias !== "neutral") return { bias: h1.bias, reasons };
    return { bias: "neutral", reasons };
  }

  private async optional<T>(callback: () => Promise<T>): Promise<T | null> {
    if (this.binance.rateLimitStatus().banned) return null;
    try {
      return await callback();
    } catch (error) {
      if (this.binance.rateLimitStatus().banned) return null;
      this.audit.warn("Không đọc được một endpoint dữ liệu thị trường phụ", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}
