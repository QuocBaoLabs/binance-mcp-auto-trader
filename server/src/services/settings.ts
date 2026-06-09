import { defaultRuntimeSettings, hasCredentials } from "../config.js";
import type { RuntimeSettings } from "../types.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { normalizeUsdFuturesSymbols } from "../symbols.js";

export class SettingsService {
  constructor(private readonly db: AppDatabase) {
    this.bootstrapDefaults();
  }

  get(): RuntimeSettings {
    const settings = { ...defaultRuntimeSettings };
    for (const key of Object.keys(settings) as (keyof RuntimeSettings)[]) {
      const stored = this.db.getSetting(key);
      if (stored !== undefined) {
        settings[key] = JSON.parse(stored) as never;
      }
    }
    return this.normalize(settings);
  }

  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    const current = this.get();
    const next = this.normalize({ ...current, ...patch });
    for (const key of Object.keys(next) as (keyof RuntimeSettings)[]) {
      if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
        this.db.setSetting(key, next[key]);
      }
    }
    appEvents.publish("config.updated", this.safe(next));
    return next;
  }

  safe(settings = this.get()): RuntimeSettings & {
    credentialsConfigured: boolean;
  } {
    return {
      ...settings,
      credentialsConfigured: hasCredentials()
    };
  }

  private bootstrapDefaults(): void {
    for (const [key, value] of Object.entries(defaultRuntimeSettings) as [
      keyof RuntimeSettings,
      unknown
    ][]) {
      if (this.db.getSetting(key) === undefined) {
        this.db.setSetting(key, value);
      }
    }
  }

  private normalize(settings: RuntimeSettings): RuntimeSettings {
    return {
      ...settings,
      readOnly: Boolean(settings.readOnly),
      autoTradeEnabled: Boolean(settings.autoTradeEnabled),
      dryRun: Boolean(settings.dryRun),
      binanceTestnet: Boolean(settings.binanceTestnet),
      allowMarketOrder: Boolean(settings.allowMarketOrder),
      maxOrderUsdt: Math.max(0, Number(settings.maxOrderUsdt)),
      maxDailyLossUsdt: Math.max(0, Number(settings.maxDailyLossUsdt)),
      maxOpenPositions: Math.max(0, Math.floor(Number(settings.maxOpenPositions))),
      maxLeverage: Math.max(
        1,
        Math.floor(Number(settings.maxLeverage)),
        Math.floor(Number(settings.sfpLeverage))   // SFP leverage luôn được phép
      ),
      tpPercent: Math.max(0, Number(settings.tpPercent)),
      slPercent: Math.max(0, Number(settings.slPercent)),
      minConfidence: Math.min(100, Math.max(0, Number(settings.minConfidence))),
      strategyIntervalSeconds: Math.max(
        5,
        Math.floor(Number(settings.strategyIntervalSeconds))
      ),
      klineInterval: settings.klineInterval || "5m",
      strategyMode: ["score", "rules", "hybrid", "wyckoff", "smc"].includes(settings.strategyMode)
        ? settings.strategyMode
        : "hybrid",
      touchTolerancePercent: Math.min(
        5,
        Math.max(0, Number(settings.touchTolerancePercent))
      ),
      ruleSupertrendEma10Long: Boolean(settings.ruleSupertrendEma10Long),
      ruleSupertrendEma10Short: Boolean(settings.ruleSupertrendEma10Short),
      ruleRequireTrendDirection: Boolean(settings.ruleRequireTrendDirection),
      ruleRequireEma10Touch: Boolean(settings.ruleRequireEma10Touch),
      ruleRequireSupertrendTouch: Boolean(settings.ruleRequireSupertrendTouch),
      ruleBollingerReversion: Boolean(settings.ruleBollingerReversion),
      wyckoffRsiLength: Math.max(2, Math.floor(Number(settings.wyckoffRsiLength))),
      wyckoffTrendSensitivity: Math.min(45, Math.max(1, Number(settings.wyckoffTrendSensitivity))),
      wyckoffPivotLength: Math.max(1, Math.floor(Number(settings.wyckoffPivotLength))),
      wyckoffUseVolumeFilter: Boolean(settings.wyckoffUseVolumeFilter),
      wyckoffVolumeMaLength: Math.max(1, Math.floor(Number(settings.wyckoffVolumeMaLength))),
      wyckoffBreakoutBufferPct: Math.min(10, Math.max(0, Number(settings.wyckoffBreakoutBufferPct))),
      wyckoffRetestTolerancePct: Math.min(10, Math.max(0, Number(settings.wyckoffRetestTolerancePct))),
      wyckoffMaxRiskDistancePct: Math.min(100, Math.max(0.01, Number(settings.wyckoffMaxRiskDistancePct))),
      wyckoffMinConfidence: Math.min(100, Math.max(0, Number(settings.wyckoffMinConfidence))),
      supertrendPeriod: Math.max(2, Math.floor(Number(settings.supertrendPeriod))),
      supertrendMultiplier: Math.max(0.1, Number(settings.supertrendMultiplier)),
      bollingerPeriod: Math.max(2, Math.floor(Number(settings.bollingerPeriod))),
      bollingerStdDev: Math.max(0.1, Number(settings.bollingerStdDev)),
      sarStep: Math.min(1, Math.max(0.001, Number(settings.sarStep))),
      sarMax: Math.min(1, Math.max(0.01, Number(settings.sarMax))),
      leverageMode: ["fixed", "auto"].includes(settings.leverageMode)
        ? settings.leverageMode
        : "fixed",
      fixedLeverage: Math.max(1, Math.floor(Number(settings.fixedLeverage))),
      minLeverage: Math.max(1, Math.floor(Number(settings.minLeverage))),
      volatilityTimeframe: settings.volatilityTimeframe || "1h",
      volatilityLookback: Math.max(
        2,
        Math.floor(Number(settings.volatilityLookback))
      ),
      lowVolatilityThreshold: Math.max(
        0,
        Number(settings.lowVolatilityThreshold)
      ),
      mediumVolatilityThreshold: Math.max(
        0,
        Number(settings.mediumVolatilityThreshold)
      ),
      highVolatilityThreshold: Math.max(
        0,
        Number(settings.highVolatilityThreshold)
      ),
      extremeVolatilityThreshold: Math.max(
        0,
        Number(settings.extremeVolatilityThreshold)
      ),
      skipTradeOnExtremeVolatility: Boolean(
        settings.skipTradeOnExtremeVolatility
      ),
      sfpEnabled: Boolean(settings.sfpEnabled),
      sfpStrategies: Array.isArray(settings.sfpStrategies)
        ? [...new Set(settings.sfpStrategies.filter(s => s === "sfp" || s === "candlestick" || s === "wyckoff" || s === "smc"))]
        : ["sfp"],
      sfpLen: Math.max(2, Math.floor(Number(settings.sfpLen))),
      ruleSfpSignal: Boolean(settings.ruleSfpSignal),
      sfpWatchSymbols: normalizeUsdFuturesSymbols(settings.sfpWatchSymbols),
      // SFP coins are always allowed — merge them in so allowedSymbols check passes
      allowedSymbols: Array.from(new Set([
        ...normalizeUsdFuturesSymbols(settings.allowedSymbols),
        ...normalizeUsdFuturesSymbols(settings.sfpWatchSymbols)
      ])),
      sfpTimeframes: Array.isArray(settings.sfpTimeframes) && settings.sfpTimeframes.length > 0
        ? settings.sfpTimeframes
        : ["5m"],
      smcAutoTimeframes: Boolean(settings.smcAutoTimeframes),
      smcRelaxedRRTP: Boolean(settings.smcRelaxedRRTP),
      smcTakeProfitRoiPercent: Math.min(500, Math.max(1, Number(settings.smcTakeProfitRoiPercent ?? 30))),
      smcFvgMaxBarsAfterMss: Math.max(1, Math.min(20, Math.floor(Number(settings.smcFvgMaxBarsAfterMss ?? 3)))),
      sfpLeverage: Math.max(1, Math.floor(Number(settings.sfpLeverage))),
      sfpMarginUsdt: Math.max(0.01, Number(settings.sfpMarginUsdt)),
      sfpTpPercent: Math.max(0, Number(settings.sfpTpPercent)),
      sfpCandlestickTpPercent: Math.min(20, Math.max(0.05, Number(settings.sfpCandlestickTpPercent))),
      sfpMarginType: ["CROSSED", "ISOLATED"].includes(settings.sfpMarginType)
        ? settings.sfpMarginType
        : "CROSSED",
      sfpAutoExecute: Boolean(settings.sfpAutoExecute),
      sfpWaitCandles: Math.max(0, Math.floor(Number(settings.sfpWaitCandles))),
      sfpOneTradeAtATime: Boolean(settings.sfpOneTradeAtATime),
      sfpUseTrailingStop: Boolean(settings.sfpUseTrailingStop),
      sfpTrailingCallbackRate: Math.min(5, Math.max(0.1, Number(settings.sfpTrailingCallbackRate ?? 1.5))),
      sfpTrailingActivationPct: Math.max(0, Number(settings.sfpTrailingActivationPct ?? 0.5))
    };
  }

  preview(patch: Partial<RuntimeSettings>): RuntimeSettings {
    return this.normalize({ ...this.get(), ...patch });
  }
}
