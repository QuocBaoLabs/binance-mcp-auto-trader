import { logger } from "../logger.js";
import type { Kline, SignalDecision } from "../types.js";
import {
  LuxAlgoSmcEngine,
  type Alerts,
  type Candle as SmcCandle,
  type SmcEvent,
  type SmcOutput,
  type SmcSettings
} from "./luxalgo-smc-engine.js";

export const SMC_WARMUP_CANDLES = 300;

const DEFAULT_SMC_SETTINGS: SmcSettings = {
  showInternals: true,
  showStructure: true,
  showInternalOrderBlocks: true,
  showSwingOrderBlocks: true,
  showEqualHighsLows: true,
  showFairValueGaps: false,
  internalFilterConfluence: false,
  orderBlockFilter: "Atr",
  orderBlockMitigation: "High/Low",
  atrLength: 200
};

const ALERT_NAMES = [
  "internalBullishBOS",
  "internalBullishCHoCH",
  "internalBearishBOS",
  "internalBearishCHoCH",
  "swingBullishBOS",
  "swingBullishCHoCH",
  "swingBearishBOS",
  "swingBearishCHoCH",
  "internalBullishOrderBlock",
  "internalBearishOrderBlock",
  "swingBullishOrderBlock",
  "swingBearishOrderBlock",
  "equalHighs",
  "equalLows",
  "bullishFairValueGap",
  "bearishFairValueGap"
] as const satisfies readonly (keyof Alerts)[];

interface SmcInstanceState {
  engine: LuxAlgoSmcEngine;
  lastOpenTime: number | null;
  lastOutput: SmcOutput | null;
  lastClosedCandle: Kline | null;
}

interface SignalComponent {
  alert: keyof Alerts;
  signal: SignalDecision;
  confidence: number;
  label: string;
}

export interface SmcBotSignal {
  symbol: string;
  timeframe: string;
  signal: SignalDecision;
  confidence: number;
  reason: string;
  output: SmcOutput | null;
  activeAlerts: (keyof Alerts)[];
  events: SmcEvent[];
  latestClosedCandle: Kline | null;
}

export class LuxAlgoSmcAdapter {
  private readonly instances = new Map<string, SmcInstanceState>();

  constructor(
    private readonly settings: SmcSettings = DEFAULT_SMC_SETTINGS,
    private readonly minConfidence = 70
  ) {}

  analyzeClosedKlines(
    symbol: string,
    timeframe: string,
    klines: Kline[],
    nowMs = Date.now()
  ): SmcBotSignal {
    const state = this.instanceFor(symbol, timeframe);
    const closedKlines = closedOnly(klines, nowMs);

    for (const kline of closedKlines) {
      if (state.lastOpenTime !== null && kline.openTime <= state.lastOpenTime) continue;

      const output = state.engine.update(toSmcCandle(kline));
      state.lastOpenTime = kline.openTime;
      state.lastOutput = output;
      state.lastClosedCandle = kline;
      this.logDebug(symbol, timeframe, kline, output);
    }

    return this.mapToBotSignal(symbol, timeframe, state.lastOutput, state.lastClosedCandle);
  }

  reset(symbol?: string, timeframe?: string): void {
    if (symbol && timeframe) {
      this.instances.delete(this.key(symbol, timeframe));
      return;
    }
    this.instances.clear();
  }

  private instanceFor(symbol: string, timeframe: string): SmcInstanceState {
    const key = this.key(symbol, timeframe);
    const existing = this.instances.get(key);
    if (existing) return existing;

    const created: SmcInstanceState = {
      engine: new LuxAlgoSmcEngine(this.settings),
      lastOpenTime: null,
      lastOutput: null,
      lastClosedCandle: null
    };
    this.instances.set(key, created);
    return created;
  }

  private key(symbol: string, timeframe: string): string {
    return `${symbol.trim().toUpperCase()}:${timeframe}`;
  }

  private mapToBotSignal(
    symbol: string,
    timeframe: string,
    output: SmcOutput | null,
    latestClosedCandle: Kline | null
  ): SmcBotSignal {
    if (!output) {
      return {
        symbol,
        timeframe,
        signal: "WAIT",
        confidence: 0,
        reason: "SMC chua co nen dong de phan tich",
        output: null,
        activeAlerts: [],
        events: [],
        latestClosedCandle: null
      };
    }

    const activeAlerts = activeAlertNames(output.alerts);
    const components = signalComponents(output.alerts);
    const best = components
      .filter((component) => component.signal !== "WAIT")
      .sort((left, right) => right.confidence - left.confidence)[0];

    if (!best) {
      return {
        symbol,
        timeframe,
        signal: "WAIT",
        confidence: Math.max(...components.map((component) => component.confidence), 0),
        reason: [
          "SMC chua co alert vao lenh tren nen dong moi",
          `internalTrend=${trendLabel(output.internalTrend)}`,
          `swingTrend=${trendLabel(output.swingTrend)}`,
          activeAlerts.length > 0 ? `alerts=${activeAlerts.join(",")}` : "alerts=none"
        ].join("; "),
        output,
        activeAlerts,
        events: output.events,
        latestClosedCandle
      };
    }

    const trendBonus =
      (best.signal === "LONG" && (output.internalTrend === 1 || output.swingTrend === 1)) ||
      (best.signal === "SHORT" && (output.internalTrend === -1 || output.swingTrend === -1))
        ? 4
        : 0;
    const confidence = Math.min(100, best.confidence + trendBonus);
    const signal: SignalDecision = confidence >= this.minConfidence ? best.signal : "WAIT";
    const eventText = summarizeEvents(output.events);

    return {
      symbol,
      timeframe,
      signal,
      confidence,
      reason: [
        `SMC ${best.label}`,
        `mappedAlert=${best.alert}`,
        `activeAlerts=${activeAlerts.join(",")}`,
        `internalTrend=${trendLabel(output.internalTrend)}`,
        `swingTrend=${trendLabel(output.swingTrend)}`,
        eventText
      ].filter(Boolean).join("; "),
      output,
      activeAlerts,
      events: output.events,
      latestClosedCandle
    };
  }

  private logDebug(symbol: string, timeframe: string, candle: Kline, output: SmcOutput): void {
    const alerts = activeAlertNames(output.alerts);
    logger.debug("SMC candle closed", {
      symbol,
      timeframe,
      time: new Date(candle.openTime).toISOString(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      internalTrend: output.internalTrend,
      swingTrend: output.swingTrend,
      alerts,
      pivotHigh: {
        internal: output.pivots.internalHigh,
        swing: output.pivots.swingHigh,
        equal: output.pivots.equalHigh
      },
      pivotLow: {
        internal: output.pivots.internalLow,
        swing: output.pivots.swingLow,
        equal: output.pivots.equalLow
      }
    });
  }
}

function closedOnly(klines: Kline[], nowMs: number): Kline[] {
  return klines
    .filter((kline) => Number.isFinite(kline.openTime) && Number.isFinite(kline.closeTime))
    .filter((kline) => kline.closeTime <= nowMs)
    .sort((left, right) => left.openTime - right.openTime);
}

function toSmcCandle(kline: Kline): SmcCandle {
  return {
    time: kline.openTime,
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close
  };
}

function activeAlertNames(alerts: Alerts): (keyof Alerts)[] {
  return ALERT_NAMES.filter((name) => alerts[name]);
}

function signalComponents(alerts: Alerts): SignalComponent[] {
  const components: SignalComponent[] = [];

  if (alerts.swingBullishCHoCH) components.push(component("swingBullishCHoCH", "LONG", 92, "swing bullish CHoCH"));
  if (alerts.swingBullishBOS) components.push(component("swingBullishBOS", "LONG", 88, "swing bullish BOS"));
  if (alerts.internalBullishCHoCH) components.push(component("internalBullishCHoCH", "LONG", 82, "internal bullish CHoCH"));
  if (alerts.internalBullishBOS) components.push(component("internalBullishBOS", "LONG", 78, "internal bullish BOS"));

  if (alerts.swingBearishCHoCH) components.push(component("swingBearishCHoCH", "SHORT", 92, "swing bearish CHoCH"));
  if (alerts.swingBearishBOS) components.push(component("swingBearishBOS", "SHORT", 88, "swing bearish BOS"));
  if (alerts.internalBearishCHoCH) components.push(component("internalBearishCHoCH", "SHORT", 82, "internal bearish CHoCH"));
  if (alerts.internalBearishBOS) components.push(component("internalBearishBOS", "SHORT", 78, "internal bearish BOS"));

  if (alerts.internalBearishOrderBlock) components.push(component("internalBearishOrderBlock", "LONG", 82, "internal bearish Order Block breakout"));
  if (alerts.swingBearishOrderBlock) components.push(component("swingBearishOrderBlock", "LONG", 86, "swing bearish Order Block breakout"));
  if (alerts.internalBullishOrderBlock) components.push(component("internalBullishOrderBlock", "SHORT", 82, "internal bullish Order Block breakout"));
  if (alerts.swingBullishOrderBlock) components.push(component("swingBullishOrderBlock", "SHORT", 86, "swing bullish Order Block breakout"));

  if (alerts.equalLows) components.push(component("equalLows", "WAIT", 45, "EQL detected"));
  if (alerts.equalHighs) components.push(component("equalHighs", "WAIT", 45, "EQH detected"));
  if (alerts.bullishFairValueGap) components.push(component("bullishFairValueGap", "LONG", 70, "bullish FVG"));
  if (alerts.bearishFairValueGap) components.push(component("bearishFairValueGap", "SHORT", 70, "bearish FVG"));

  return components;
}

function component(alert: keyof Alerts, signal: SignalDecision, confidence: number, label: string): SignalComponent {
  return { alert, signal, confidence, label };
}

function trendLabel(value: SmcOutput["internalTrend"]): string {
  if (value === 1) return "bullish";
  if (value === -1) return "bearish";
  return "neutral";
}

function summarizeEvents(events: SmcEvent[]): string {
  if (events.length === 0) return "events=none";
  const text = events.map((event) => {
    if (event.kind === "structure") return `${event.scope}:${event.direction}:${event.tag}@${event.level}`;
    if (event.kind === "orderBlockMitigated") return `${event.scope}:OB_BREAK:${event.bias === 1 ? "bullish" : "bearish"}@${event.barLow}-${event.barHigh}`;
    if (event.kind === "orderBlockCreated") return `${event.scope}:OB_NEW:${event.bias === 1 ? "bullish" : "bearish"}@${event.barLow}-${event.barHigh}`;
    if (event.kind === "equalHighLow") return `${event.type}@${event.level}`;
    if (event.kind === "fairValueGap") return `FVG:${event.direction}@${event.bottom}-${event.top}`;
    return `${event.label}@${event.level}`;
  });
  return `events=${text.join("|")}`;
}
