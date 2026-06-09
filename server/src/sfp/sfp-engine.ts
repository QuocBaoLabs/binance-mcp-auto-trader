import { BinanceClient } from "../binance/client.js";
import type { KlineClosedEvent } from "../binance/ws-manager.js";
import { BinanceWSManager } from "../binance/ws-manager.js";
import { createSignalChart } from "../chart/signal-chart.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { sendTelegramSignal } from "../notifications/telegram.js";
import { OrderExecutor } from "../orders/order-executor.js";
import { AuditLogService } from "../services/audit-log.js";
import { SettingsService } from "../services/settings.js";
import {
  detectCandlestickPattern,
  type CandlestickPatternResult
} from "../strategy/candlestick-patterns.js";
import { ema, swingFailurePattern, type SFPResult } from "../strategy/indicators.js";
import type { AppEvent, Kline, SFPDecisionRule, SFPSignalRecord } from "../types.js";
import { normalizeUsdFuturesSymbol } from "../symbols.js";

const FALLBACK_SCAN_INTERVAL_MS = 30_000;
const MIN_DUPLICATE_SIGNAL_WINDOW_MS = 10 * 60_000;
const DEFAULT_SCAN_LOOKBACK_CANDLES = 5;
const SLOT_REOPEN_SCAN_LOOKBACK_CANDLES = 1;
const MAX_ISOLATED_SL_LOSS_OF_MARGIN_PCT = 35;
const MAX_CROSSED_SL_LOSS_OF_MARGIN_PCT = 25;
const MAX_CANDLESTICK_ISOLATED_SL_LOSS_OF_MARGIN_PCT = 25;
const MAX_CANDLESTICK_CROSSED_SL_LOSS_OF_MARGIN_PCT = 15;
const CANDLESTICK_LIQUIDATION_BUFFER_SHARE = 0.65;
const CANDLESTICK_MIN_TP_PERCENT = 0.05;
const EXECUTION_MARGIN_BUFFER_MULTIPLIER = 1.08;
const EXECUTION_MARGIN_BUFFER_LABEL = "8%";
const SFP_MIN_SCORE_TO_TRADE = 72;
const SFP_MIN_RISK_REWARD = 1.3;
const SFP_MIN_SWEEP_ATR = 0.15;
const SFP_MIN_WICK_SHARE = 0.35;
const SFP_MAX_ENTRY_CHASE_ATR = 1.2;
const SFP_MIN_STOP_DISTANCE_PCT = 0.05;
const SFP_DEFAULT_TARGET_RR = 2;
const SFP_MAX_STOP_ATR = 2.8;
// Tổng weights: 12+14+13+11+9+10+7+8+8+8+7+9+9+12+8+15 = 151
const SFP_MAX_RULE_SCORE = 151;
const SFP_MAX_STOP_PCT_BY_TIMEFRAME: Record<string, number> = {
  "1m": 1.2,
  "3m": 1.8,
  "5m": 2.5,
  "15m": 4,
  "30m": 5,
  "1h": 7,
  "4h": 12,
  "12h": 16,
  "1d": 20,
  "3d": 28,
  "1w": 35
};

interface SFPScanOptions {
  refreshRest?: boolean;
  reason?: string;
  maxLookbackCandles?: number;
  ignoreIgnoredDuplicates?: boolean;
}

function closeEnough(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

function sameSetup(left: SFPSignalRecord, right: Pick<SFPSignalRecord, "symbol" | "direction" | "swingPrice">): boolean {
  const symbol = normalizeUsdFuturesSymbol(left.symbol);
  const otherSymbol = normalizeUsdFuturesSymbol(right.symbol);
  const tolerance = Math.max(Math.abs(right.swingPrice) * 0.002, 1e-12);
  return symbol === otherSymbol &&
    left.direction === right.direction &&
    closeEnough(left.swingPrice, right.swingPrice, tolerance);
}

function strategyEnabled(settings: ReturnType<SettingsService["get"]>, strategy: "sfp" | "candlestick" | "wyckoff" | "smc"): boolean {
  const strategies = settings.sfpStrategies ?? ["sfp"];
  return strategies.includes(strategy);
}

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function atr(klines: Kline[], period = 14): number | null {
  if (klines.length < period + 1) return null;
  const ranges = klines.slice(-period - 1).map((kline, index, rows) => {
    if (index === 0) return kline.high - kline.low;
    const previousClose = rows[index - 1].close;
    return Math.max(
      kline.high - kline.low,
      Math.abs(kline.high - previousClose),
      Math.abs(kline.low - previousClose)
    );
  });
  const values = ranges.slice(1);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxStopPctForTimeframe(interval: string): number {
  return SFP_MAX_STOP_PCT_BY_TIMEFRAME[interval] ?? 7;
}

function rule(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  weight: number,
  warn = false
): SFPDecisionRule {
  return { id, label, status: ok ? "pass" : warn ? "warn" : "fail", detail, weight: ok ? weight : warn ? Math.round(weight * 0.4) : 0 };
}

export class SFPEngine {
  readonly subscribed = new Set<string>(); // "SYMBOL:interval"
  private listenerAttached = false;
  private autoFillListenerAttached = false;
  private fallbackScanTimer?: NodeJS.Timeout;
  private fallbackScanRunning = false;
  private autoQueueRunning = false;
  private readonly autoFillListener = (event: AppEvent) => {
    if (event.type !== "sfp.closed") return;
    void this.fillOpenSlots("sfp.closed");
  };

  constructor(
    private readonly settingsService: SettingsService,
    private readonly binance: BinanceClient,
    private readonly ws: BinanceWSManager,
    private readonly db: AppDatabase,
    private readonly executor: OrderExecutor,
    private readonly audit: AuditLogService
  ) {}

  private async resolveExecutionMarginUsdt(
    signal: SFPSignalRecord,
    leverage: number,
    activeExposureCount: number,
    maxConcurrent: number
  ): Promise<number> {
    const settings = this.settingsService.get();
    if (settings.dryRun) return signal.marginUsdt;
    try {
      const balanceRows = await this.binance.getBalance() as Array<Record<string, unknown>>;
      const usdt = Array.isArray(balanceRows)
        ? balanceRows.find(row => String(row.asset ?? "") === "USDT")
        : undefined;
      const available = Number(usdt?.availableBalance ?? 0);
      if (!Number.isFinite(available) || available <= 0) return signal.marginUsdt;
      const remainingSlots = Math.max(1, maxConcurrent - activeExposureCount);
      const safePerSlot = Math.floor((available / EXECUTION_MARGIN_BUFFER_MULTIPLIER / remainingSlots) * 100) / 100;
      const minViableMargin = Math.ceil((5 / Math.max(1, leverage)) * 100) / 100;
      if (safePerSlot <= 0) return signal.marginUsdt;
      let effective = Math.min(signal.marginUsdt, safePerSlot);
      if (effective < minViableMargin && safePerSlot >= minViableMargin) {
        effective = minViableMargin;
      }
      effective = Math.max(0.01, Math.floor(effective * 100) / 100);
      if (Math.abs(effective - signal.marginUsdt) >= 0.005 && signal.id !== undefined) {
        this.db.updateSFPSignalMargin(signal.id, effective);
        this.audit.info("SFP tu can doi ky quy moi lenh theo so du kha dung", {
          symbol: signal.symbol,
          id: signal.id,
          requestedMarginUsdt: signal.marginUsdt,
          effectiveMarginUsdt: effective,
          availableUsdt: available,
          remainingSlots,
          buffer: EXECUTION_MARGIN_BUFFER_LABEL
        });
      }
      return effective;
    } catch (error) {
      this.audit.warn("SFP khong the tu can doi ky quy, dung gia tri signal", {
        symbol: signal.symbol,
        id: signal.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return signal.marginUsdt;
    }
  }

  async start(): Promise<void> {
    const settings = this.settingsService.get();
    if (!settings.sfpEnabled) {
      this.audit.info("SFP Engine bi tat (sfpEnabled=false), bo qua khoi dong");
      return;
    }
    await this.syncSubscriptions();
  }

  stop(): void {
    for (const key of this.subscribed) {
      const [symbol, interval] = key.split(":");
      this.ws.unsubscribeKlines(symbol, interval);
    }
    this.subscribed.clear();
    this.ws.removeAllListeners("kline:closed");
    if (this.autoFillListenerAttached) {
      appEvents.off("event", this.autoFillListener);
      this.autoFillListenerAttached = false;
    }
    if (this.fallbackScanTimer) {
      clearInterval(this.fallbackScanTimer);
      this.fallbackScanTimer = undefined;
    }
    this.fallbackScanRunning = false;
    this.listenerAttached = false;
    this.audit.info("SFP Engine da dung");
  }

  // Re-sync subscriptions when settings change (new symbols/timeframes added)
  async syncSubscriptions(): Promise<void> {
    const settings = this.settingsService.get();
    if (!settings.sfpEnabled) { this.stop(); return; }
    if (this.binance.rateLimitStatus().banned) {
      this.audit.warn("SFP sync tam dung vi Binance dang bi rate-limit");
      return;
    }

    // Attach the kline:closed listener exactly once
    if (!this.listenerAttached) {
      this.ws.on("kline:closed", (ev: KlineClosedEvent) => {
        const key = `${ev.symbol}:${ev.interval}`;
        if (!this.subscribed.has(key)) return;
        void this.onCandleClosed(ev.symbol, ev.interval, ev.klines);
      });
      this.listenerAttached = true;
      this.audit.info("SFP Engine da khoi dong (WebSocket mode)");
    }
    if (!this.autoFillListenerAttached) {
      appEvents.on("event", this.autoFillListener);
      this.autoFillListenerAttached = true;
    }
    this.startFallbackScan();

    const wanted = new Set<string>();
    for (const rawSymbol of settings.sfpWatchSymbols) {
      const symbol = normalizeUsdFuturesSymbol(rawSymbol);
      for (const interval of settings.sfpTimeframes) {
        wanted.add(`${symbol}:${interval}`);
      }
    }

    // Unsubscribe removed
    for (const key of this.subscribed) {
      if (!wanted.has(key)) {
        const [symbol, interval] = key.split(":");
        this.ws.unsubscribeKlines(symbol, interval);
        this.subscribed.delete(key);
      }
    }

    // Subscribe new — seed REST klines in batches of 3 to avoid rate limit
    const newKeys = [...wanted].filter(k => !this.subscribed.has(k));
    const BATCH = 3;
    let seededSignals = 0;
    for (let i = 0; i < newKeys.length; i += BATCH) {
      const batch = newKeys.slice(i, i + BATCH);
      await Promise.all(batch.map(async key => {
        const [symbol, interval] = key.split(":");
        try {
          const seedKlines = await this.binance.getKlines(symbol, interval, 100);
          this.ws.subscribeKlines(symbol, interval, seedKlines);
          this.subscribed.add(key);
          const closedKlines = seedKlines.length > 1 ? seedKlines.slice(0, -1) : seedKlines;
          const seeded = await this.analyzeAllKlines(symbol, interval, closedKlines);
          seededSignals += seeded.length;
        } catch (e) {
          this.audit.warn("SFP: khong lay duoc kline seed", {
            symbol, interval,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }));
      // Small pause between batches to respect Binance rate limits
      if (i + BATCH < newKeys.length) await new Promise(r => setTimeout(r, 300));
    }
    if (seededSignals > 0) {
      this.audit.info("SFP seed scan created signals", { count: seededSignals });
      if (settings.sfpAutoExecute) await this.processAutoQueue();
    }
    this.db.pruneTransientTradeData();
  }

  async scanNow(options: SFPScanOptions = {}): Promise<{ results: SFPSignalRecord[]; scanned: number; skipped: number }> {
    const settings = this.settingsService.get();
    const results: SFPSignalRecord[] = [];
    let scanned = 0;
    let skipped = 0;
    if (this.binance.rateLimitStatus().banned) {
      this.audit.warn("SFP scanNow tam dung vi Binance dang bi rate-limit", {
        reason: options.reason ?? "manual"
      });
      return { results, scanned, skipped: settings.sfpWatchSymbols.length * settings.sfpTimeframes.length };
    }

    for (const rawSymbol of settings.sfpWatchSymbols) {
      const symbol = normalizeUsdFuturesSymbol(rawSymbol);
      for (const interval of settings.sfpTimeframes) {
        let klines = this.ws.getKlines(symbol, interval);
        if (options.refreshRest || klines.length < 10) {
          try {
            klines = await this.binance.getKlines(symbol, interval, 100);
            if (!this.subscribed.has(`${symbol}:${interval}`)) {
              this.ws.subscribeKlines(symbol, interval, klines);
              this.subscribed.add(`${symbol}:${interval}`);
            }
          } catch (e) {
            this.audit.warn("SFP scanNow: khong lay duoc klines", {
              symbol, interval, error: e instanceof Error ? e.message : String(e)
            });
            skipped++;
            continue;
          }
        }
        scanned++;
        // Loai bo nen dang hinh thanh (live candle) — chi phan tich nen da dong
        const closedKlines = klines.length > 1 ? klines.slice(0, -1) : klines;
        // Quet nen cuoi + mot so nen truoc do de bat SFP vua xay ra trong vai phut gan day.
        // Khi vua dong vi the, chi quet nen dong moi nhat de tranh vao lai setup cu.
        const maxLookbackCandles = Math.max(1, options.maxLookbackCandles ?? DEFAULT_SCAN_LOOKBACK_CANDLES);
        let sigs: SFPSignalRecord[] = [];
        for (let lookback = 0; lookback < maxLookbackCandles && sigs.length === 0; lookback++) {
          const slice = closedKlines.slice(0, closedKlines.length - lookback);
          if (slice.length < 10) break;
          sigs = await this.analyzeAllKlines(symbol, interval, slice, {
            ignoreIgnoredDuplicates: options.ignoreIgnoredDuplicates
          });
        }
        results.push(...sigs);
      }
    }

    if (settings.sfpAutoExecute) await this.processAutoQueue();
    if (results.length > 0 || options.reason) {
      this.audit.info("SFP scanNow hoan tat", {
        reason: options.reason ?? "manual",
        scanned,
        skipped,
        found: results.length
      });
    }
    this.db.pruneTransientTradeData();
    return { results, scanned, skipped };
  }

  private async onCandleClosed(symbol: string, interval: string, klines: Kline[]): Promise<void> {
    const settings = this.settingsService.get();
    if (!settings.sfpEnabled) return;

    try {
      await this.analyzeAllKlines(symbol, interval, klines);
    } catch (e) {
      this.audit.warn("SFP onCandleClosed loi", {
        symbol, interval, error: e instanceof Error ? e.message : String(e)
      });
    }

    if (settings.sfpAutoExecute) await this.processAutoQueue();
    this.db.pruneTransientTradeData();
  }

  private async fillOpenSlots(reason: string): Promise<void> {
    const settings = this.settingsService.get();
    if (!settings.sfpEnabled || !settings.sfpAutoExecute) return;
    const ignored = this.db.ignorePendingSFPSignals("Bo qua setup cho cu vi vi the vua dong; bot se quet lai tin hieu moi.");
    this.audit.info("SFP auto: kiem tra lap day slot", { reason, ignoredPending: ignored });
    await this.scanNow({
      refreshRest: true,
      reason,
      maxLookbackCandles: SLOT_REOPEN_SCAN_LOOKBACK_CANDLES,
      ignoreIgnoredDuplicates: true
    });
  }

  private startFallbackScan(): void {
    if (this.fallbackScanTimer) return;
    this.fallbackScanTimer = setInterval(() => {
      void this.runFallbackScan();
    }, FALLBACK_SCAN_INTERVAL_MS);
  }

  private async runFallbackScan(): Promise<void> {
    const settings = this.settingsService.get();
    // Run in both manual and auto mode — ensures signals are detected even if WS misses a candle
    if (!settings.sfpEnabled) return;
    if (this.fallbackScanRunning) return;

    this.fallbackScanRunning = true;
    try {
      // refreshRest: false — use WebSocket buffer; only falls back to REST if buffer < 10 candles.
      // Avoids hammering klines REST every 30s for all symbols × timeframes.
      await this.scanNow({ refreshRest: false, reason: "fallback_timer" });
    } catch (e) {
      this.audit.warn("SFP fallback scan loi", {
        error: e instanceof Error ? e.message : String(e)
      });
    } finally {
      this.fallbackScanRunning = false;
    }
  }

  private async getActiveExposure(): Promise<{ count: number; symbols: Set<string> }> {
    const symbols = new Set<string>();

    // Filled positions (weight 5)
    const positions = await this.binance.getPosition() as Array<{
      symbol?: string;
      positionAmt?: string;
    }>;
    for (const position of positions) {
      if (Math.abs(Number(position.positionAmt ?? 0)) <= 0) continue;
      if (position.symbol) symbols.add(normalizeUsdFuturesSymbol(position.symbol));
    }

    // Also count pending LIMIT orders already sent to Binance (execute_after cleared).
    // These are not yet in positionAmt but still occupy a slot.
    for (const sig of this.db.listPendingLimitSignals()) {
      if (sig.symbol) symbols.add(normalizeUsdFuturesSymbol(sig.symbol));
    }

    return { count: symbols.size, symbols };
  }

  private async enrichSignalWithChartAndNotify(
    signal: SFPSignalRecord,
    klines: Kline[]
  ): Promise<SFPSignalRecord> {
    let enriched = signal;
    try {
      const chart = await createSignalChart(signal, klines);
      this.db.updateSFPSignalChart(signal.id!, chart.chartPath, chart.chartUrl);
      enriched = { ...signal, chartPath: chart.chartPath, chartUrl: chart.chartUrl };
    } catch (error) {
      this.audit.warn("Khong tao duoc chart cho signal", {
        id: signal.id,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await sendTelegramSignal(enriched);
    } catch (error) {
      this.audit.warn("Khong gui duoc Telegram signal", {
        id: enriched.id,
        symbol: enriched.symbol,
        timeframe: enriched.timeframe,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return enriched;
  }

  private evaluateSetup(params: {
    sfp: SFPResult;
    klines: Kline[];
    interval: string;
    entry: number;
    slPrice: number;
    tpPrice: number;
    takeProfitPercent: number | null;
    tpMode: "fixed_percent" | "risk_reward";
    leverage: number;
    marginType: "CROSSED" | "ISOLATED";
    candlePattern?: CandlestickPatternResult | null;
  }): { decision: "TRADE" | "SKIP"; score: number; summary: string; details: SFPDecisionRule[] } {
    const { sfp, klines, interval, entry, slPrice, tpPrice, takeProfitPercent, tpMode, leverage, marginType, candlePattern = null } = params;
    const details: SFPDecisionRule[] = [];
    const sfpRange = Math.max(sfp.sfpCandleHigh - sfp.sfpCandleLow, 0);
    const bullish = sfp.direction === "BULLISH";
    const rejectionWick = bullish
      ? Math.min(sfp.sfpCandleOpen, sfp.sfpCandleClose) - sfp.sfpCandleLow
      : sfp.sfpCandleHigh - Math.max(sfp.sfpCandleOpen, sfp.sfpCandleClose);
    const wickShare = sfpRange > 0 ? Math.max(0, rejectionWick) / sfpRange : 0;
    const closeLocation = sfpRange > 0 ? (sfp.sfpCandleClose - sfp.sfpCandleLow) / sfpRange : 0.5;
    const closeOk = bullish ? closeLocation >= 0.5 : closeLocation <= 0.5;
    const currentAtr = atr(klines, 14);
    const sweepDepth = bullish
      ? Math.max(0, sfp.swingPrice - sfp.sfpCandleLow)
      : Math.max(0, sfp.sfpCandleHigh - sfp.swingPrice);
    const sweepAtr = currentAtr && currentAtr > 0 ? sweepDepth / currentAtr : 0;
    const recentWindow = klines.slice(-80);
    const rangeHigh = Math.max(...recentWindow.map(kline => kline.high));
    const rangeLow = Math.min(...recentWindow.map(kline => kline.low));
    const rangeSize = Math.max(rangeHigh - rangeLow, 0);
    const rangePosition = rangeSize > 0
      ? (bullish ? (sfp.sfpCandleLow - rangeLow) / rangeSize : (rangeHigh - sfp.sfpCandleHigh) / rangeSize)
      : 0.5;
    const locationOk = rangePosition <= 0.35;
    const closes = klines.map(kline => kline.close);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const trendOk = ema20 !== null && ema50 !== null
      ? (bullish ? ema20 >= ema50 || entry <= ema20 : ema20 <= ema50 || entry >= ema20)
      : true;
    const avgVolume = average(klines.slice(-21, -1).map(kline => kline.volume));
    const volumeRatio = avgVolume > 0 ? sfp.sfpCandleVolume / avgVolume : 1;
    const volumeOk = volumeRatio >= 0.8;
    const slDistance = Math.abs(entry - slPrice);
    const tpDistance = Math.abs(tpPrice - entry);
    const rr = slDistance > 0 ? tpDistance / slDistance : 0;
    const slDistancePct = entry > 0 ? slDistance / entry * 100 : 0;
    const slDistanceAtr = currentAtr && currentAtr > 0 ? slDistance / currentAtr : 0;
    const maxStopPct = maxStopPctForTimeframe(interval);
    const maxLossPct = slDistancePct * leverage;
    const maxAllowedLossPct = marginType === "ISOLATED"
      ? MAX_ISOLATED_SL_LOSS_OF_MARGIN_PCT
      : MAX_CROSSED_SL_LOSS_OF_MARGIN_PCT;
    const chaseAtr = currentAtr && currentAtr > 0 ? Math.abs(entry - sfp.sfpCandleClose) / currentAtr : 0;
    const entrySideOk = bullish ? slPrice < entry && tpPrice > entry : slPrice > entry && tpPrice < entry;

    details.push(rule(
      "sfp-core",
      "SFP hop le",
      true,
      bullish
        ? `Gia quet xuong duoi swing ${sfp.swingPrice} roi dong lai phia tren.`
        : `Gia quet len tren swing ${sfp.swingPrice} roi dong lai phia duoi.`,
      12
    ));
    details.push(rule(
      "confirmation",
      "Xac nhan dao chieu",
      sfp.confirmed,
      sfp.confirmed
        ? `Gia da dong vuot confirmation level ${sfp.oppositeLevel}.`
        : `Moi co sweep, chua dong vuot confirmation level ${sfp.oppositeLevel}.`,
      14,
      !sfp.confirmed
    ));
    details.push(rule(
      "location",
      "Vi tri thanh khoan",
      locationOk,
      locationOk
        ? `SFP nam o ${pct(rangePosition * 100)} mep vung gia 80 nen gan nhat.`
        : `SFP nam qua sau trong range (${pct(rangePosition * 100)}), de la nhieu giua vung.`,
      13
    ));
    details.push(rule(
      "wick",
      "Rau tu choi du manh",
      wickShare >= SFP_MIN_WICK_SHARE,
      `Rau tu choi chiem ${pct(wickShare * 100)} bien do nen, yeu cau toi thieu ${pct(SFP_MIN_WICK_SHARE * 100)}.`,
      11
    ));
    details.push(rule(
      "close-quality",
      "Close quay lai ro rang",
      closeOk,
      bullish
        ? `Close nam o ${pct(closeLocation * 100)} nen, can nua tren cho long.`
        : `Close nam o ${pct(closeLocation * 100)} nen, can nua duoi cho short.`,
      9
    ));
    details.push(rule(
      "sweep-depth",
      "Do sau sweep",
      sweepAtr >= SFP_MIN_SWEEP_ATR,
      currentAtr
        ? `Sweep sau ${sweepAtr.toFixed(2)} ATR, yeu cau toi thieu ${SFP_MIN_SWEEP_ATR.toFixed(2)} ATR.`
        : "Chua du du lieu ATR, bot giam diem chat luong.",
      10,
      currentAtr === null
    ));
    details.push(rule(
      "volume",
      "Volume xac nhan",
      volumeOk,
      `Volume nen SFP bang ${volumeRatio.toFixed(2)} lan volume trung binh 20 nen.`,
      7,
      !volumeOk && volumeRatio >= 0.6
    ));
    details.push(rule(
      "bias",
      "Bias EMA 20/50",
      trendOk,
      ema20 !== null && ema50 !== null
        ? `EMA20=${ema20.toFixed(4)}, EMA50=${ema50.toFixed(4)}; bias khong chong qua manh voi huong ${bullish ? "long" : "short"}.`
        : "Chua du du lieu EMA, tam khong chan setup.",
      8,
      ema20 === null || ema50 === null
    ));
    details.push(rule(
      "entry-chase",
      "Khong duoi gia qua xa",
      chaseAtr <= SFP_MAX_ENTRY_CHASE_ATR,
      currentAtr
        ? `Entry hien tai cach close nen SFP ${chaseAtr.toFixed(2)} ATR.`
        : "Chua du du lieu ATR de do duoi gia.",
      8,
      currentAtr === null
    ));
    details.push(rule(
      "risk-shape",
      "Hinh dang SL/TP dung",
      entrySideOk && tpDistance > 0,
      entrySideOk
        ? `Entry ${entry}, SL ${slPrice}, TP ${tpPrice} dung phia cho ${bullish ? "long" : "short"}; TP dung ${tpMode === "risk_reward" ? `${SFP_DEFAULT_TARGET_RR.toFixed(1)}R` : `${takeProfitPercent}% theo entry`}.`
        : `Sai phia bao ve: ${bullish ? "long can SL < entry va TP > entry" : "short can SL > entry va TP < entry"}; hien entry ${entry}, SL ${slPrice}, TP ${tpPrice}.`,
      8
    ));
    details.push(rule(
      "stop-distance",
      "Khoang cach SL toi thieu",
      slDistancePct >= SFP_MIN_STOP_DISTANCE_PCT,
      `SL cach entry ${pct(slDistancePct)}, yeu cau toi thieu ${pct(SFP_MIN_STOP_DISTANCE_PCT)} de tranh vua dat da kich hoat.`,
      7
    ));
    details.push(rule(
      "stop-timeframe-cap",
      "SL toi da theo khung",
      slDistancePct <= maxStopPct,
      `SL cach entry ${pct(slDistancePct)}; gioi han cho khung ${interval} la ${pct(maxStopPct)}.`,
      9
    ));
    details.push(rule(
      "stop-atr-cap",
      "SL toi da theo ATR",
      currentAtr !== null && slDistanceAtr <= SFP_MAX_STOP_ATR,
      currentAtr
        ? `SL rong ${slDistanceAtr.toFixed(2)} ATR; gioi han toi da ${SFP_MAX_STOP_ATR.toFixed(2)} ATR.`
        : "Chua du du lieu ATR nen khong cho trade o rule SL ATR.",
      9
    ));
    details.push(rule(
      "risk-reward",
      "Risk/Reward toi thieu",
      rr >= SFP_MIN_RISK_REWARD,
      `RR hien tai ${rr.toFixed(2)}R, yeu cau toi thieu ${SFP_MIN_RISK_REWARD.toFixed(2)}R.`,
      12
    ));
    details.push(rule(
      "liquidation-buffer",
      "Rui ro SL theo margin",
      maxLossPct <= maxAllowedLossPct,
      `Neu cham SL lo khoang ${pct(maxLossPct)} margin; gioi han ${pct(maxAllowedLossPct)} cho ${marginType}.`,
      8
    ));

    // Mẫu nến xác nhận hội tụ với SFP (weight 15 — bonus điểm, không fatal khi thiếu)
    const candleDir = candlePattern?.direction ?? null;
    const candleMatchesTrade = candleDir === (bullish ? "BULLISH" : "BEARISH");
    const candleConflicts = candleDir !== null && !candleMatchesTrade;
    details.push(rule(
      "candle-confirm",
      "Xac nhan mau nen",
      candleMatchesTrade,
      candlePattern
        ? candleMatchesTrade
          ? `[Hoi tu] ${candlePattern.patternName} (${candlePattern.confidence}/100) cung huong SFP — tin hieu hoi tu manh.`
          : `[Xung dot] ${candlePattern.patternName} (${candlePattern.confidence}/100) trai chieu SFP — can than.`
        : "Khong co mau nen xac nhan — tin hieu SFP don thuan.",
      15,
      !candlePattern  // warn=true khi không có pattern (không fail, chỉ thiếu điểm bonus)
    ));

    const rawScore = details.reduce((sum, item) => sum + item.weight, 0);
    const score = Math.round(Math.min(SFP_MAX_RULE_SCORE, rawScore) / SFP_MAX_RULE_SCORE * 100);
    const failed = details.filter(item => item.status === "fail");
    const fatalIds = new Set(["risk-shape", "stop-distance", "stop-timeframe-cap", "stop-atr-cap", "risk-reward", "liquidation-buffer", "entry-chase"]);
    const fatalFail = failed.some(item => fatalIds.has(item.id));
    // Mẫu nến xung đột chiếm 1 trong 2 suất quality fail — signal yếu bị lọc
    const qualityFails = failed.filter(item => !fatalIds.has(item.id)).length;
    const decision = score >= SFP_MIN_SCORE_TO_TRADE && !fatalFail && qualityFails <= 2 ? "TRADE" : "SKIP";
    const strongestFails = failed.slice(0, 3).map(item => item.label.toLowerCase());
    const confluenceTag = candleMatchesTrade && candlePattern
      ? ` [Hoi tu: ${candlePattern.patternName}]` : candleConflicts && candlePattern
      ? ` [Xung dot: ${candlePattern.patternName}]` : "";
    const summary = decision === "TRADE"
      ? `Du dieu kien ${bullish ? "LONG" : "SHORT"}${confluenceTag}: score ${score}/100, RR ${rr.toFixed(2)}R, SL risk ${pct(maxLossPct)} margin.`
      : `Khong vao lenh: score ${score}/100${strongestFails.length ? `, truot ${strongestFails.join(", ")}` : ""}${confluenceTag}.`;

    return { decision, score, summary, details };
  }

  private async analyzeKlines(
    symbol: string,
    interval: string,
    klines: Kline[],
    options: { ignoreIgnoredDuplicates?: boolean } = {},
    candleHint: CandlestickPatternResult | null = null
  ): Promise<SFPSignalRecord | null> {
    const settings = this.settingsService.get();
    if (!strategyEnabled(settings, "sfp")) return null;
    const sfp = swingFailurePattern(klines, settings.sfpLen);
    if (!sfp) return null;

    const tfMs: Record<string, number> = {
      "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
      "1h": 3_600_000, "4h": 14_400_000, "12h": 43_200_000, "1d": 86_400_000,
      "3d": 259_200_000, "1w": 604_800_000
    };
    const candleMs = tfMs[interval] ?? 300_000;
    const duplicateWindowMs = Math.max(candleMs * 6, MIN_DUPLICATE_SIGNAL_WINDOW_MS);
    const duplicateSince = new Date(Date.now() - duplicateWindowMs).toISOString();
    const recent = this.db.recentSFPSignals(symbol, duplicateSince);
    const duplicate = recent.find((signal) => {
      if (options.ignoreIgnoredDuplicates && signal.status === "ignored") return false;
      return sameSetup(signal, { symbol, direction: sfp.direction, swingPrice: sfp.swingPrice });
    });
    if (duplicate) {
      return null;
    }

    // Fetch live market price for accurate entry
    let entry: number;
    try {
      const ticker = await this.binance.getPrice(symbol) as { price: string };
      entry = parseFloat(ticker.price);
      if (!Number.isFinite(entry) || entry <= 0) throw new Error("gia khong hop le");
    } catch {
      // Fallback to last closed kline close if ticker fails
      entry = klines[klines.length - 1].close;
    }

    // SL: exact SFP wick extreme
    const slPrice = sfp.direction === "BULLISH" ? sfp.sfpCandleLow : sfp.sfpCandleHigh;
    const slDistance = Math.abs(entry - slPrice);
    const fixedTakeProfitPercent = settings.sfpTpPercent > 0
      ? settings.sfpTpPercent
      : null;
    const tpMode = fixedTakeProfitPercent === null ? "risk_reward" : "fixed_percent";

    const tpDistance = fixedTakeProfitPercent === null
      ? slDistance * SFP_DEFAULT_TARGET_RR
      : entry * (fixedTakeProfitPercent / 100);
    const tpPrice = sfp.direction === "BULLISH"
      ? entry + tpDistance
      : entry - tpDistance;

    // Chỉ truyền candleHint khi cùng hướng với SFP hoặc ngược chiều (đều cần xét)
    const plan = this.evaluateSetup({
      sfp,
      klines,
      interval,
      entry,
      slPrice,
      tpPrice,
      takeProfitPercent: fixedTakeProfitPercent,
      tpMode,
      leverage: settings.sfpLeverage,
      marginType: settings.sfpMarginType,
      candlePattern: candleHint
    });

    // Auto mode: SKIP signals are rejected immediately; TRADE signals become pending with executeAfter
    // Manual mode: ALL signals become pending so user can decide themselves
    const isAutoMode = settings.sfpAutoExecute;
    const executeAfter = isAutoMode && plan.decision === "TRADE"
      ? new Date(
          Date.now() +
            (settings.sfpWaitCandles > 0
              ? (tfMs[interval] ?? 300_000) * settings.sfpWaitCandles
              : 0)
        ).toISOString()
      : undefined;

    const isConfluence = candleHint !== null && candleHint.direction === sfp.direction;
    const signal: SFPSignalRecord = {
      strategy: "sfp",
      // Khi hội tụ, ghi nhận tên cả hai mẫu để hiển thị trên dashboard
      patternName: isConfluence ? `SFP + ${candleHint!.patternName}` : undefined,
      symbol,
      timeframe: interval,
      direction: sfp.direction,
      confirmed: sfp.confirmed,
      swingPrice: sfp.swingPrice,
      oppositeLevel: sfp.oppositeLevel,
      sfpCandleHigh: sfp.sfpCandleHigh,
      sfpCandleLow: sfp.sfpCandleLow,
      entryPrice: entry,
      slPrice, tpPrice,
      leverage: settings.sfpLeverage,
      marginUsdt: settings.sfpMarginUsdt,
      status: isAutoMode && plan.decision === "SKIP" ? "rejected" : "pending",
      message: plan.summary,
      decision: plan.decision,
      decisionScore: plan.score,
      decisionSummary: plan.summary,
      decisionDetails: plan.details,
      hasSfp: true,
      executeAfter,
      createdAt: new Date().toISOString()
    };

    const saved = await this.enrichSignalWithChartAndNotify(this.db.insertSFPSignal(signal), klines);
    appEvents.publish("sfp.signal", saved);
    const confluenceLabel = isConfluence ? ` [hoi tu: ${candleHint!.patternName}]` : "";
    this.audit.info(`SFP ${sfp.direction}${confluenceLabel} ${plan.decision === "TRADE" ? "du dieu kien" : isAutoMode ? "bo qua (auto)" : "cho nguoi dung quyet dinh"}`, {
      symbol, interval, entry, sl: slPrice, tp: tpPrice,
      swingPrice: sfp.swingPrice, score: plan.score, reason: plan.summary,
      confluence: isConfluence ? candleHint!.patternName : null,
      executeAfter: executeAfter ?? (plan.decision === "TRADE" ? "manual" : "none")
    });

    return saved;
  }

  private async analyzeCandlestickKlines(
    symbol: string,
    interval: string,
    klines: Kline[],
    options: { ignoreIgnoredDuplicates?: boolean } = {},
    sfpHint: SFPResult | null = null
  ): Promise<SFPSignalRecord | null> {
    const settings = this.settingsService.get();
    if (!strategyEnabled(settings, "candlestick")) return null;
    const pattern = detectCandlestickPattern(klines);
    if (!pattern) return null;

    const tfMs: Record<string, number> = {
      "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
      "1h": 3_600_000, "4h": 14_400_000, "12h": 43_200_000, "1d": 86_400_000,
      "3d": 259_200_000, "1w": 604_800_000
    };
    // Tính confluence sớm để dùng trong duplicate check
    const sfpMatchesPattern = sfpHint !== null && sfpHint.direction === pattern.direction;
    const sfpConflicts = sfpHint !== null && !sfpMatchesPattern;
    const confluencePatternName = sfpMatchesPattern
      ? `${pattern.patternName} + SFP`
      : pattern.patternName;

    const candleMs = tfMs[interval] ?? 300_000;
    const duplicateSince = new Date(Date.now() - Math.max(candleMs * 6, MIN_DUPLICATE_SIGNAL_WINDOW_MS)).toISOString();
    const recent = this.db.recentSFPSignals(symbol, duplicateSince);
    const duplicate = recent.find((signal) => {
      if (options.ignoreIgnoredDuplicates && signal.status === "ignored") return false;
      // So sánh theo tên thực tế được lưu (có thể là "Pattern + SFP")
      return signal.strategy === "candlestick" &&
        (signal.patternName === confluencePatternName || signal.patternName === pattern.patternName) &&
        sameSetup(signal, { symbol, direction: pattern.direction, swingPrice: pattern.anchorPrice });
    });
    if (duplicate) return null;

    let entry: number;
    try {
      const ticker = await this.binance.getPrice(symbol) as { price: string };
      entry = parseFloat(ticker.price);
      if (!Number.isFinite(entry) || entry <= 0) throw new Error("gia khong hop le");
    } catch {
      entry = klines[klines.length - 1].close;
    }

    const riskBuffer = Math.max(entry * 0.0005, Math.abs(pattern.high - pattern.low) * 0.05);
    const bullish = pattern.direction === "BULLISH";
    const slPrice = bullish ? pattern.low - riskBuffer : pattern.high + riskBuffer;
    const slDistance = Math.abs(entry - slPrice);
    if (slDistance <= 0) return null;
    const takeProfitPercent = settings.sfpCandlestickTpPercent;
    const tpDistance = entry * (takeProfitPercent / 100);
    const tpPrice = bullish ? entry + tpDistance : entry - tpDistance;
    const entrySideOk = bullish ? slPrice < entry && tpPrice > entry : slPrice > entry && tpPrice < entry;
    if (!entrySideOk || tpPrice <= 0) return null;

    const slDistancePct = entry > 0 ? slDistance / entry * 100 : 0;
    const maxLossPct = slDistancePct * settings.sfpLeverage;
    const maxAllowedLossPct = settings.sfpMarginType === "ISOLATED"
      ? MAX_CANDLESTICK_ISOLATED_SL_LOSS_OF_MARGIN_PCT
      : MAX_CANDLESTICK_CROSSED_SL_LOSS_OF_MARGIN_PCT;
    const maxStopPct = maxStopPctForTimeframe(interval);
    const estimatedLiqDistancePct = settings.sfpLeverage > 0 ? 100 / settings.sfpLeverage : 100;
    const maxSafeStopPct = Math.max(SFP_MIN_STOP_DISTANCE_PCT, estimatedLiqDistancePct * CANDLESTICK_LIQUIDATION_BUFFER_SHARE);
    const liquidationDistanceOk = slDistancePct <= maxSafeStopPct;
    const tpPercentOk = takeProfitPercent >= CANDLESTICK_MIN_TP_PERCENT;

    // sfpMatchesPattern / sfpConflicts đã tính ở trên (trước duplicate check)
    const confidenceThreshold = sfpMatchesPattern ? 65 : sfpConflicts ? 88 : 78;

    const decision = pattern.confidence >= confidenceThreshold &&
      tpPercentOk &&
      slDistancePct >= SFP_MIN_STOP_DISTANCE_PCT &&
      slDistancePct <= maxStopPct &&
      liquidationDistanceOk &&
      maxLossPct <= maxAllowedLossPct
      ? "TRADE"
      : "SKIP";

    const sfpConfluenceDetail = sfpMatchesPattern
      ? `SFP ${sfpHint!.direction} cung chieu xac nhan mau nen — nguong confidence ha xuong ${confidenceThreshold}.`
      : sfpConflicts
      ? `SFP ${sfpHint!.direction} TRAI CHIEU mau nen — nguong confidence tang len ${confidenceThreshold}.`
      : "Khong co SFP kem theo, mau nen hoat dong don lap.";
    const details: SFPDecisionRule[] = [
      rule("candle-pattern", pattern.patternName, true, pattern.message, 35),
      rule("sfp-confluence", "Hoi tu SFP", sfpMatchesPattern, sfpConfluenceDetail, 15, !sfpHint),
      rule("risk-shape", "SL/TP theo mau nen", entrySideOk && tpPercentOk, `Entry ${entry}, SL ${slPrice}, TP ${tpPrice}; TP mau nen = ${takeProfitPercent}% theo entry, ROI TP uoc tinh ${pct(takeProfitPercent * settings.sfpLeverage)} voi ${settings.sfpLeverage}x.`, 20),
      rule("stop-distance", "Khoang cach SL toi thieu", slDistancePct >= SFP_MIN_STOP_DISTANCE_PCT, `SL cach entry ${pct(slDistancePct)}, yeu cau toi thieu ${pct(SFP_MIN_STOP_DISTANCE_PCT)}.`, 12),
      rule("stop-timeframe-cap", "SL toi da theo khung", slDistancePct <= maxStopPct, `SL cach entry ${pct(slDistancePct)}; gioi han ${interval} la ${pct(maxStopPct)}.`, 15),
      rule("liquidation-distance", "Dem truoc liquidation", liquidationDistanceOk, `Uoc tinh vung liquidation cach ${pct(estimatedLiqDistancePct)} voi ${settings.sfpLeverage}x; SL phai nam trong ${pct(maxSafeStopPct)} de cat truoc khi gan chay.`, 18),
      rule("liquidation-buffer", "Rui ro SL theo margin", maxLossPct <= maxAllowedLossPct, `Neu cham SL lo khoang ${pct(maxLossPct)} margin; gioi han ${pct(maxAllowedLossPct)} cho ${settings.sfpMarginType}.`, 18)
    ];
    const score = Math.max(0, Math.min(100, Math.round(pattern.confidence - Math.max(0, maxLossPct - maxAllowedLossPct))));
    const sfpTag = sfpMatchesPattern ? " [+SFP]" : sfpConflicts ? " [-SFP]" : "";
    const summary = decision === "TRADE"
      ? `Mau nen ${pattern.patternName}${sfpTag} ${bullish ? "LONG" : "SHORT"}: score ${score}/100, TP ${takeProfitPercent}% (~${pct(takeProfitPercent * settings.sfpLeverage)} ROI), SL theo ${bullish ? "day" : "dinh"} cum nen.`
      : `Khong vao mau nen ${pattern.patternName}${sfpTag}: score ${score}/100, SL/rui ro chua dat.`;
    const executeAfter = settings.sfpAutoExecute && decision === "TRADE"
      ? new Date(
          Date.now() +
            (settings.sfpWaitCandles > 0
              ? (tfMs[interval] ?? 300_000) * settings.sfpWaitCandles
              : 0)
        ).toISOString()
      : undefined;

    // confluencePatternName đã tính ở trên (trước duplicate check)
    const signal: SFPSignalRecord = {
      strategy: "candlestick",
      patternName: confluencePatternName,
      symbol,
      timeframe: interval,
      direction: pattern.direction,
      confirmed: sfpMatchesPattern ? pattern.confidence >= 70 : pattern.confidence >= 84,
      swingPrice: pattern.anchorPrice,
      oppositeLevel: bullish ? pattern.high : pattern.low,
      sfpCandleHigh: pattern.high,
      sfpCandleLow: pattern.low,
      entryPrice: entry,
      slPrice,
      tpPrice,
      leverage: settings.sfpLeverage,
      marginUsdt: settings.sfpMarginUsdt,
      status: settings.sfpAutoExecute && decision === "SKIP" ? "rejected" : "pending",
      message: summary,
      decision,
      decisionScore: score,
      decisionSummary: summary,
      decisionDetails: details,
      hasSfp: sfpMatchesPattern,
      executeAfter,
      createdAt: new Date().toISOString()
    };

    const saved = await this.enrichSignalWithChartAndNotify(this.db.insertSFPSignal(signal), klines);
    appEvents.publish("sfp.signal", saved);
    this.audit.info(`Mau nen ${confluencePatternName} ${decision === "TRADE" ? "du dieu kien" : settings.sfpAutoExecute ? "bo qua (auto)" : "cho nguoi dung quyet dinh"}`, {
      symbol, interval, direction: pattern.direction, entry, sl: slPrice, tp: tpPrice,
      score, reason: summary, sfpConfluence: sfpMatchesPattern,
      executeAfter: executeAfter ?? (decision === "TRADE" ? "manual" : "none")
    });
    return saved;
  }

  private async analyzeAllKlines(
    symbol: string,
    interval: string,
    klines: Kline[],
    options: { ignoreIgnoredDuplicates?: boolean } = {}
  ): Promise<SFPSignalRecord[]> {
    const settings = this.settingsService.get();
    const results: SFPSignalRecord[] = [];

    // Pre-detect cả hai chiến lược trước khi ghi DB để kiểm tra hội tụ
    const candleHint = strategyEnabled(settings, "candlestick")
      ? detectCandlestickPattern(klines)
      : null;
    const sfpQuick = strategyEnabled(settings, "sfp")
      ? swingFailurePattern(klines, settings.sfpLen)
      : null;

    // ── SFP: nhận candleHint để evaluateSetup tính bonus confluence ──────────
    const sfpRecord = await this.analyzeKlines(symbol, interval, klines, options, candleHint);
    if (sfpRecord) results.push(sfpRecord);

    // ── Confluence suppression ──────────────────────────────────────────────
    // Nếu SFP và candlestick cùng chiều VÀ SFP đã tạo record thành công →
    // record SFP đó đã mang đủ thông tin hội tụ; không tạo thêm record
    // candlestick riêng để tránh 2 lệnh cho cùng 1 setup.
    const sfpDir = sfpRecord?.direction ?? null;
    const candleDir = candleHint?.direction ?? null;
    // Only suppress candlestick when SFP was actually accepted (pending/executed/limit_placed).
    // A rejected SFP must not block a valid co-directional candlestick opportunity.
    const sfpAccepted = sfpRecord !== null && sfpRecord.status !== "rejected";
    const confluenceHandled = sfpAccepted && sfpDir === candleDir && candleDir !== null;

    if (!confluenceHandled) {
      // ── Candlestick: nhận sfpQuick để điều chỉnh threshold ───────────────
      const candleRecord = await this.analyzeCandlestickKlines(
        symbol, interval, klines, options, sfpQuick
      );
      if (candleRecord) results.push(candleRecord);
    }

    return results;
  }

  private async processAutoQueue(): Promise<void> {
    if (this.autoQueueRunning) return;
    this.autoQueueRunning = true;
    try {
    const settings = this.settingsService.get();
    if (!settings.dryRun && !settings.autoTradeEnabled) {
      this.audit.warn("SFP auto: live mode bi chan vi autoTradeEnabled=false");
      return;
    }
    const ready = this.db.listPendingAutoExecute(new Date().toISOString());
    if (ready.length === 0) return;
    const activeSymbols = new Set(
      settings.sfpWatchSymbols.map((symbol) => normalizeUsdFuturesSymbol(symbol))
    );
    const activeTimeframes = new Set(settings.sfpTimeframes);
    // Wyckoff signals use allowedSymbols + klineInterval, not sfpWatchSymbols/sfpTimeframes.
    const wyckoffSymbols = new Set(settings.allowedSymbols.map(normalizeUsdFuturesSymbol));
    const activeReady = ready.filter((signal) => {
      const signalStrategy = signal.strategy ?? "sfp";
      if (!strategyEnabled(settings, signalStrategy)) return false;
      if (signal.strategy === "wyckoff") {
        return wyckoffSymbols.has(normalizeUsdFuturesSymbol(signal.symbol));
      }
      if (signal.strategy === "smc" && signal.patternName?.startsWith("ICT SMC") && settings.smcAutoTimeframes) {
        return activeSymbols.has(normalizeUsdFuturesSymbol(signal.symbol));
      }
      return (
        activeSymbols.has(normalizeUsdFuturesSymbol(signal.symbol)) &&
        activeTimeframes.has(signal.timeframe)
      );
    });

    for (const signal of ready) {
      if (activeReady.includes(signal)) continue;
      this.db.updateSFPSignalStatus(
        signal.id!,
        "rejected",
        "Bo qua vi coin/khung thoi gian khong con trong danh sach quet"
      );
    }
    if (activeReady.length === 0) return;

    const maxConcurrent = settings.sfpOneTradeAtATime
      ? 1
      : Math.max(1, settings.maxOpenPositions);
    let exposure: { count: number; symbols: Set<string> };
    try {
      exposure = await this.getActiveExposure();
    } catch (e) {
      this.audit.warn("SFP auto: khong kiem tra duoc vi the/lenh cho", {
        error: e instanceof Error ? e.message : String(e)
      });
      return;
    }

    const uniqueReady: SFPSignalRecord[] = [];
    for (const signal of activeReady) {
      const duplicate = uniqueReady.some((selected) => sameSetup(selected, signal));
      if (duplicate) {
        this.db.ignoreSFPSignal(
          signal.id!,
          "Bo qua vi trung setup SFP gan day"
        );
        continue;
      }
      uniqueReady.push(signal);
    }

    const executable = uniqueReady.filter((signal) => {
      const duplicate = exposure.symbols.has(normalizeUsdFuturesSymbol(signal.symbol));
      if (duplicate) {
        this.db.ignoreSFPSignal(
          signal.id!,
          `Da co vi the mo tren ${signal.symbol}, bo qua de tim setup khac`
        );
      }
      return !duplicate;
    });

    const slots = Math.max(0, maxConcurrent - exposure.count);
    if (slots <= 0 || executable.length === 0) {
      if (slots <= 0) {
        for (const signal of executable) {
          this.db.ignoreSFPSignal(
            signal.id!,
            `Bo qua vi da du ${maxConcurrent} slot; bot se quet setup moi khi vi the dong`
          );
        }
      }
      this.audit.info("SFP auto: khong co slot/setup hop le", {
        openCount: exposure.count,
        maxConcurrent,
        pending: activeReady.length,
        executable: executable.length
      });
      return;
    }

    let filledSlots = 0;
    for (const signal of executable) {
      if (filledSlots >= slots) {
        this.db.ignoreSFPSignal(
          signal.id!,
          `Bo qua vi slot vua duoc lap; bot se quet setup moi sau khi vi the dong`
        );
        continue;
      }
      const result = await this.executeSignal(signal);
      if (result.status === "executed" || result.status === "simulated" || result.status === "limit_placed") filledSlots += 1;
    }
    } finally {
      this.db.pruneTransientTradeData();
      this.autoQueueRunning = false;
    }
  }

  async executeSignal(signal: SFPSignalRecord): Promise<SFPSignalRecord> {
    const settings = this.settingsService.get();

    if (signal.id !== undefined) {
      const current = this.db.getSFPSignal(signal.id);
      if (!current) return signal;
      if (current.status !== "pending") return current;
      signal = current;
    }

    if (signal.strategy === "smc" && !signal.patternName?.startsWith("ICT SMC")) {
      const msg = "SMC trade method cu da duoc tat. Hay doi phuong phap SMC moi.";
      this.db.updateSFPSignalStatus(signal.id!, "rejected", msg);
      return { ...signal, status: "rejected", message: msg };
    }

    // Bail early if Binance is currently rate-limited — keep signal pending so user can retry
    const rl = this.binance.rateLimitStatus();
    if (rl.banned) {
      const msg = `Binance IP bi cam, con ${rl.waitSeconds}s. Thu lai sau khi het cam.`;
      this.audit.warn("SFP execute hoan lai do rate limit", { symbol: signal.symbol, id: signal.id, waitSeconds: rl.waitSeconds });
      return { ...signal, status: "pending", message: msg };
    }

    // Manual mode can execute pending signals, but candlestick signals keep a hard risk gate.
    const maxConcurrent = settings.sfpOneTradeAtATime
      ? 1
      : Math.max(1, settings.maxOpenPositions);
    let activeExposureCount = 0;
    try {
      const exposure = await this.getActiveExposure();
      activeExposureCount = exposure.count;
      const symbol = normalizeUsdFuturesSymbol(signal.symbol);
      if (exposure.symbols.has(symbol)) {
        const msg = `Da co vi the/lenh cho tren ${signal.symbol}, khong mo trung symbol`;
        this.db.updateSFPSignalStatus(signal.id!, "rejected", msg);
        return { ...signal, status: "rejected", message: msg };
      }
      if (exposure.count >= maxConcurrent) {
        const msg = `Dang co ${exposure.count} vi the/lenh cho - gioi han ${maxConcurrent} lenh cung luc`;
        this.db.updateSFPSignalStatus(signal.id!, "rejected", msg);
        return { ...signal, status: "rejected", message: msg };
      }
    } catch { /* neu khong kiem tra duoc, RiskManager se kiem tra lai truoc khi dat lenh */ }

    const side = signal.direction === "BULLISH" ? "BUY" : "SELL";
    const maxLev = await this.binance.getMaxLeverage(signal.symbol);
    const leverage = Math.min(signal.leverage, maxLev);
    if (leverage < signal.leverage) {
      this.audit.warn("SFP: leverage bi gioi han boi Binance", { symbol: signal.symbol, requested: signal.leverage, capped: leverage, maxLev });
    }
    const signalId = signal.id!;
    const candlestickRiskError = this.validateCandlestickExecutionRisk(signal, leverage, settings);
    if (candlestickRiskError) {
      this.db.updateSFPSignalStatus(signalId, "rejected", candlestickRiskError);
      return { ...signal, status: "rejected", message: candlestickRiskError };
    }
    const effectiveMarginUsdt = await this.resolveExecutionMarginUsdt(
      signal,
      leverage,
      activeExposureCount,
      maxConcurrent
    );
    if (Math.abs(effectiveMarginUsdt - signal.marginUsdt) >= 0.005) {
      signal = { ...signal, marginUsdt: effectiveMarginUsdt };
    }
    const quantity = (effectiveMarginUsdt * leverage) / signal.entryPrice;
    try {
      // Tính giá kích hoạt trailing: lãi ít nhất sfpTrailingActivationPct% mới bắt đầu trail
      const isRelaxedSmc = signal.strategy === "smc" && settings.smcRelaxedRRTP;
      const activationPct = settings.sfpTrailingActivationPct ?? 0.5;
      const trailingActivationPrice = isRelaxedSmc
        ? signal.tpPrice
        : settings.sfpUseTrailingStop && activationPct > 0
        ? (signal.direction === "BULLISH"
            ? signal.entryPrice * (1 + activationPct / 100)
            : signal.entryPrice * (1 - activationPct / 100))
        : undefined;

      const exitModeNote = isRelaxedSmc
        ? `SMC relaxed: trailing/doi SL tai ROI ${settings.smcTakeProfitRoiPercent}%`
        : settings.sfpUseTrailingStop
        ? `trailing ${settings.sfpTrailingCallbackRate}% (kích hoạt tại ${activationPct}% lãi)`
        : `fixed TP ${signal.tpPrice}`;
      this.audit.info(`SFP exit mode: ${exitModeNote}`, { symbol: signal.symbol, id: signalId });
      const entryType = settings.allowMarketOrder ? "MARKET" : "LIMIT";

      const tradeResult = await this.executor.executeProtectedTrade({
        symbol: signal.symbol, side,
        entryType, quantity,
        entryPrice: signal.entryPrice,
        stopLossPrice: signal.slPrice,
        takeProfitPrice: signal.tpPrice,  // vẫn dùng để risk check và display
        leverage,
        marginType: settings.sfpMarginType,
        postOnly: entryType === "LIMIT",
        source: "dashboard",
        confidence: signal.decisionScore ?? (signal.confirmed ? 85 : 75),
        reason: signal.decisionSummary ?? `SFP ${signal.direction} ${signal.confirmed ? "da xac nhan" : "phat hien"} ${signal.timeframe}`,
        // Trailing stop thay thế fixed TP khi được bật
        useTrailingStop: settings.sfpUseTrailingStop || isRelaxedSmc,
        trailingCallbackRate: settings.sfpTrailingCallbackRate,
        trailingActivationPrice,
        skipRewardRiskCheck: isRelaxedSmc,
        // LIMIT orders don't fill instantly — stay "pending" until position opens or times out
        onEntryFilled: () => {
          this.db.updateSFPSignalStatus(signalId, "executed", "LIMIT order khop, vi the mo, TP/SL da gui len Binance.");
          appEvents.publish("sfp.signal", { id: signalId, status: "executed" });
          this.audit.info("SFP LIMIT order khop thanh cong", { symbol: signal.symbol, id: signalId });
        },
        onEntryExpired: () => {
          this.db.updateSFPSignalStatus(signalId, "rejected", "LIMIT order dat len Binance nhung khong khop trong 60 giay, da huy tu dong.");
          appEvents.publish("sfp.signal", { id: signalId, status: "rejected" });
          this.audit.warn("SFP LIMIT order het han, da huy", { symbol: signal.symbol, id: signalId });
        }
      }) as Record<string, unknown>;

      if (settings.dryRun) {
        const msg = "Mo phong: khong gui lenh that len Binance.";
        this.db.updateSFPSignalStatus(signalId, "simulated", msg);
        this.audit.info("SFP mo phong thanh cong", { symbol: signal.symbol, id: signalId });
        return { ...signal, status: "simulated", message: msg };
      }

      // Check if LIMIT entry is waiting for fill (TP/SL scheduled for later)
      const stopLossResult = tradeResult.stopLoss as Record<string, unknown> | undefined;
      const isPendingFill = stopLossResult?.status === "PENDING_POSITION";
      if (isPendingFill) {
        const msg = "LIMIT order dat len Binance, dang cho khop. TP/SL se gui khi vi the mo.";
        this.db.markLimitPlaced(signalId, msg); // status→limit_placed; not re-queued; counted in exposure
        this.audit.info("SFP LIMIT order dat len Binance, cho khop", { symbol: signal.symbol, id: signalId });
        return { ...signal, status: "limit_placed", message: msg, executeAfter: undefined };
      }

      // LIMIT filled immediately or MARKET order — position confirmed open
      const msg = "Da vao lenh SFP, vi the mo, TP/SL da gui.";
      this.db.updateSFPSignalStatus(signalId, "executed", msg);
      this.audit.info("SFP execute thanh cong", { symbol: signal.symbol, id: signalId });
      return { ...signal, status: "executed", message: msg };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.db.updateSFPSignalStatus(signalId, "rejected", msg);
      this.audit.error("SFP execute that bai", { symbol: signal.symbol, id: signalId, error: msg });
      return { ...signal, status: "rejected", message: msg };
    }
  }

  private validateCandlestickExecutionRisk(
    signal: SFPSignalRecord,
    leverage: number,
    settings: ReturnType<SettingsService["get"]>
  ): string | null {
    if (signal.strategy !== "candlestick") return null;
    const entry = signal.entryPrice;
    if (entry <= 0 || signal.slPrice <= 0 || signal.tpPrice <= 0) {
      return "Chan vao lenh mau nen: entry/SL/TP khong hop le.";
    }

    const bullish = signal.direction === "BULLISH";
    const entrySideOk = bullish
      ? signal.slPrice < entry && signal.tpPrice > entry
      : signal.slPrice > entry && signal.tpPrice < entry;
    if (!entrySideOk) return "Chan vao lenh mau nen: SL/TP khong nam dung phia entry.";

    const slDistancePct = Math.abs(entry - signal.slPrice) / entry * 100;
    const tpDistancePct = Math.abs(signal.tpPrice - entry) / entry * 100;
    const desiredTpPct = settings.sfpCandlestickTpPercent;
    if (Math.abs(tpDistancePct - desiredTpPct) > 0.03) {
      return `Chan vao lenh mau nen cu: TP signal ${pct(tpDistancePct)} khong khop TP hien tai ${pct(desiredTpPct)}. Hay quet lai setup moi.`;
    }

    const maxLossPct = slDistancePct * leverage;
    const maxAllowedLossPct = settings.sfpMarginType === "ISOLATED"
      ? MAX_CANDLESTICK_ISOLATED_SL_LOSS_OF_MARGIN_PCT
      : MAX_CANDLESTICK_CROSSED_SL_LOSS_OF_MARGIN_PCT;
    if (maxLossPct > maxAllowedLossPct) {
      return `Chan vao lenh mau nen: SL co the mat ${pct(maxLossPct)} margin voi ${leverage}x, vuot gioi han ${pct(maxAllowedLossPct)}.`;
    }

    const estimatedLiqDistancePct = leverage > 0 ? 100 / leverage : 100;
    const maxSafeStopPct = Math.max(SFP_MIN_STOP_DISTANCE_PCT, estimatedLiqDistancePct * CANDLESTICK_LIQUIDATION_BUFFER_SHARE);
    if (slDistancePct > maxSafeStopPct) {
      return `Chan vao lenh mau nen: SL cach ${pct(slDistancePct)}, qua gan vung liquidation uoc tinh ${pct(estimatedLiqDistancePct)} voi ${leverage}x.`;
    }
    return null;
  }
}
