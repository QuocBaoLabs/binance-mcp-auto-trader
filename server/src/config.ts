import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeSettings, ScannerStrategy, StaticConfig } from "./types.js";
import { normalizeUsdFuturesSymbols } from "./symbols.js";

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSymbols(value: string | undefined): string[] {
  return normalizeUsdFuturesSymbols((value ?? "BTCUSDT,ETHUSDT").split(","));
}

function parseScannerStrategies(value: string | undefined): ScannerStrategy[] {
  const raw = (value ?? "sfp").split(",").map(s => s.trim().toLowerCase());
  const selected = raw.filter((item): item is ScannerStrategy =>
    item === "sfp" || item === "candlestick" || item === "wyckoff" || item === "smc"
  );
  return selected.length > 0 ? [...new Set(selected)] : ["sfp"];
}

const logLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();

export const staticConfig: StaticConfig = {
  apiKey: process.env.BINANCE_API_KEY ?? "",
  apiSecret: process.env.BINANCE_API_SECRET ?? "",
  aiApiKey: process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  aiBaseUrl: process.env.AI_BASE_URL ?? "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL ?? "gpt-5.5",
  enableLiveTrading: parseBool(process.env.ENABLE_LIVE_TRADING, false),
  maxRiskPercent: parseNumber(process.env.MAX_RISK_PERCENT, 2),
  liveBaseUrl: process.env.BINANCE_LIVE_BASE_URL ?? "https://fapi.binance.com",
  testnetBaseUrl:
    process.env.BINANCE_TESTNET_BASE_URL ?? "https://demo-fapi.binance.com",
  sqlitePath: path.resolve(process.env.SQLITE_PATH ?? "./data/trader.sqlite"),
  signalChartDir: path.resolve(process.env.SIGNAL_CHART_DIR ?? "./data/charts"),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${parseNumber(process.env.PORT, 3001)}`).replace(/\/+$/, ""),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  port: parseNumber(process.env.PORT, 3001),
  sseHeartbeatSeconds: parseNumber(process.env.SSE_HEARTBEAT_SECONDS, 15),
  logLevel: ["debug", "info", "warn", "error"].includes(logLevel)
    ? (logLevel as StaticConfig["logLevel"])
    : "info"
};

export const defaultRuntimeSettings: RuntimeSettings = {
  readOnly: parseBool(process.env.READ_ONLY, true),
  autoTradeEnabled: parseBool(process.env.AUTO_TRADE_ENABLED, false),
  dryRun: parseBool(process.env.DRY_RUN, true),
  binanceTestnet: parseBool(process.env.BINANCE_TESTNET, true),
  allowMarketOrder: parseBool(process.env.ALLOW_MARKET_ORDER, false),
  allowedSymbols: parseSymbols(process.env.ALLOWED_SYMBOLS),
  maxOrderUsdt: parseNumber(process.env.MAX_ORDER_USDT, 25),
  maxDailyLossUsdt: parseNumber(process.env.MAX_DAILY_LOSS_USDT, 50),
  maxOpenPositions: parseNumber(process.env.MAX_OPEN_POSITIONS, 1),
  maxLeverage: parseNumber(process.env.MAX_LEVERAGE, 1),
  tpPercent: parseNumber(process.env.TP_PERCENT, 1.5),
  slPercent: parseNumber(process.env.SL_PERCENT, 0.8),
  minConfidence: parseNumber(process.env.MIN_CONFIDENCE, 70),
  strategyIntervalSeconds: parseNumber(process.env.STRATEGY_INTERVAL_SECONDS, 30),
  klineInterval: process.env.KLINE_INTERVAL ?? "5m",
  strategyMode: ["score", "rules", "hybrid", "wyckoff", "smc"].includes(
    process.env.STRATEGY_MODE ?? ""
  )
    ? (process.env.STRATEGY_MODE as RuntimeSettings["strategyMode"])
    : "rules",
  touchTolerancePercent: parseNumber(process.env.TOUCH_TOLERANCE_PERCENT, 0.15),
  ruleSupertrendEma10Long: parseBool(
    process.env.RULE_SUPERTREND_EMA10_LONG,
    true
  ),
  ruleSupertrendEma10Short: parseBool(
    process.env.RULE_SUPERTREND_EMA10_SHORT,
    true
  ),
  ruleRequireTrendDirection: parseBool(
    process.env.RULE_REQUIRE_TREND_DIRECTION,
    true
  ),
  ruleRequireEma10Touch: parseBool(
    process.env.RULE_REQUIRE_EMA10_TOUCH,
    true
  ),
  ruleRequireSupertrendTouch: parseBool(
    process.env.RULE_REQUIRE_SUPERTREND_TOUCH,
    true
  ),
  ruleBollingerReversion: parseBool(
    process.env.RULE_BOLLINGER_REVERSION,
    false
  ),
  wyckoffRsiLength: parseNumber(process.env.WYCKOFF_RSI_LENGTH, 14),
  wyckoffTrendSensitivity: parseNumber(process.env.WYCKOFF_TREND_SENSITIVITY, 20),
  wyckoffPivotLength: parseNumber(process.env.WYCKOFF_PIVOT_LENGTH, 5),
  wyckoffUseVolumeFilter: parseBool(process.env.WYCKOFF_USE_VOLUME_FILTER, true),
  wyckoffVolumeMaLength: parseNumber(process.env.WYCKOFF_VOLUME_MA_LENGTH, 20),
  wyckoffBreakoutBufferPct: parseNumber(process.env.WYCKOFF_BREAKOUT_BUFFER_PCT, 0.1),
  wyckoffRetestTolerancePct: parseNumber(process.env.WYCKOFF_RETEST_TOLERANCE_PCT, 0.2),
  wyckoffMaxRiskDistancePct: parseNumber(process.env.WYCKOFF_MAX_RISK_DISTANCE_PCT, 3),
  wyckoffMinConfidence: parseNumber(process.env.WYCKOFF_MIN_CONFIDENCE, 65),
  wyckoffSlBufferPct: parseNumber(process.env.WYCKOFF_SL_BUFFER_PCT, 0.5),
  supertrendPeriod: parseNumber(process.env.SUPERTREND_PERIOD, 10),
  supertrendMultiplier: parseNumber(process.env.SUPERTREND_MULTIPLIER, 3),
  bollingerPeriod: parseNumber(process.env.BOLLINGER_PERIOD, 20),
  bollingerStdDev: parseNumber(process.env.BOLLINGER_STD_DEV, 2),
  sarStep: parseNumber(process.env.SAR_STEP, 0.02),
  sarMax: parseNumber(process.env.SAR_MAX, 0.2),
  leverageMode: ["fixed", "auto"].includes(process.env.LEVERAGE_MODE ?? "")
    ? (process.env.LEVERAGE_MODE as RuntimeSettings["leverageMode"])
    : "fixed",
  fixedLeverage: parseNumber(process.env.FIXED_LEVERAGE, 1),
  minLeverage: parseNumber(process.env.MIN_LEVERAGE, 1),
  volatilityTimeframe: process.env.VOLATILITY_TIMEFRAME ?? "1h",
  volatilityLookback: parseNumber(process.env.VOLATILITY_LOOKBACK, 14),
  lowVolatilityThreshold: parseNumber(process.env.LOW_VOLATILITY_THRESHOLD, 0.5),
  mediumVolatilityThreshold: parseNumber(
    process.env.MEDIUM_VOLATILITY_THRESHOLD,
    1.5
  ),
  highVolatilityThreshold: parseNumber(
    process.env.HIGH_VOLATILITY_THRESHOLD,
    3
  ),
  extremeVolatilityThreshold: parseNumber(
    process.env.EXTREME_VOLATILITY_THRESHOLD,
    4
  ),
  skipTradeOnExtremeVolatility: parseBool(
    process.env.SKIP_TRADE_ON_EXTREME_VOLATILITY,
    true
  ),
  sfpEnabled: parseBool(process.env.SFP_ENABLED, true),
  sfpStrategies: parseScannerStrategies(process.env.SFP_STRATEGIES),
  sfpLen: parseNumber(process.env.SFP_LEN, 5),
  ruleSfpSignal: parseBool(process.env.RULE_SFP_SIGNAL, false),
  sfpWatchSymbols: parseSymbols(process.env.SFP_WATCH_SYMBOLS ?? process.env.ALLOWED_SYMBOLS),
  sfpTimeframes: (process.env.SFP_TIMEFRAMES ?? process.env.SFP_TIMEFRAME ?? "5m").split(",").map(s => s.trim()).filter(Boolean),
  smcAutoTimeframes: parseBool(process.env.SMC_AUTO_TIMEFRAMES, true),
  smcPreferredRR: parseNumber(process.env.SMC_PREFERRED_RR, 2),
  smcRelaxedRRTP: parseBool(process.env.SMC_RELAXED_RR_TP, false),
  smcTakeProfitRoiPercent: parseNumber(process.env.SMC_TAKE_PROFIT_ROI_PERCENT, 30),
  smcMinScore: parseNumber(process.env.SMC_MIN_SCORE, 7),
  smcMaxBarsAfterSweepForMSS: parseNumber(process.env.SMC_MAX_BARS_AFTER_SWEEP_FOR_MSS, 10),
  smcFvgMinSizePct: parseNumber(process.env.SMC_FVG_MIN_SIZE_PCT, 0.05),
  smcAvoidMiddleOfRange: parseBool(process.env.SMC_AVOID_MIDDLE_OF_RANGE, true),
  smcFvgMaxBarsAfterMss: parseNumber(process.env.SMC_FVG_MAX_BARS_AFTER_MSS, 3),
  sfpLeverage: parseNumber(process.env.SFP_LEVERAGE, 1),
  sfpMarginUsdt: parseNumber(process.env.SFP_MARGIN_USDT, 10),
  sfpTpPercent: parseNumber(process.env.SFP_TP_PERCENT, 0),
  sfpCandlestickTpPercent: parseNumber(process.env.SFP_CANDLESTICK_TP_PERCENT, 0.5),
  sfpMarginType: ["CROSSED", "ISOLATED"].includes(process.env.SFP_MARGIN_TYPE ?? "")
    ? (process.env.SFP_MARGIN_TYPE as RuntimeSettings["sfpMarginType"])
    : "CROSSED",
  sfpAutoExecute: parseBool(process.env.SFP_AUTO_EXECUTE, false),
  sfpWaitCandles: parseNumber(process.env.SFP_WAIT_CANDLES, 3),
  sfpOneTradeAtATime: parseBool(process.env.SFP_ONE_TRADE_AT_A_TIME, true),
  sfpUseTrailingStop: parseBool(process.env.SFP_USE_TRAILING_STOP, false),
  sfpTrailingCallbackRate: parseNumber(process.env.SFP_TRAILING_CALLBACK_RATE, 1.5),
  sfpTrailingActivationPct: parseNumber(process.env.SFP_TRAILING_ACTIVATION_PCT, 0.5)
};

export function activeBaseUrl(settings: RuntimeSettings): string {
  return settings.binanceTestnet
    ? staticConfig.testnetBaseUrl
    : staticConfig.liveBaseUrl;
}

export function hasCredentials(): boolean {
  return Boolean(staticConfig.apiKey && staticConfig.apiSecret);
}

export function credentialsStatus(): {
  configured: boolean;
  apiKeyPreview: string | null;
} {
  return {
    configured: hasCredentials(),
    apiKeyPreview: previewCredential(staticConfig.apiKey)
  };
}

export function saveBinanceCredentials(apiKey: string, apiSecret: string): void {
  const cleanApiKey = cleanCredential(apiKey);
  const cleanApiSecret = cleanCredential(apiSecret);
  if (cleanApiKey.length < 8 || cleanApiSecret.length < 8) {
    throw new Error("API key/secret quá ngắn hoặc chưa hợp lệ");
  }

  staticConfig.apiKey = cleanApiKey;
  staticConfig.apiSecret = cleanApiSecret;
  process.env.BINANCE_API_KEY = cleanApiKey;
  process.env.BINANCE_API_SECRET = cleanApiSecret;
  upsertEnvFile({
    BINANCE_API_KEY: cleanApiKey,
    BINANCE_API_SECRET: cleanApiSecret
  });
}

export function aiCredentialsStatus(): {
  configured: boolean;
  apiKeyPreview: string | null;
  baseUrl: string;
  model: string;
} {
  return {
    configured: Boolean(staticConfig.aiApiKey),
    apiKeyPreview: previewCredential(staticConfig.aiApiKey),
    baseUrl: staticConfig.aiBaseUrl,
    model: staticConfig.aiModel
  };
}

export function saveAICredentials(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): ReturnType<typeof aiCredentialsStatus> {
  const nextBaseUrl = cleanBaseUrl(input.baseUrl ?? staticConfig.aiBaseUrl);
  const nextModel = String(input.model ?? staticConfig.aiModel).trim();
  if (!nextModel) throw new Error("AI model khong duoc de trong");

  const updates: Record<string, string> = {
    AI_BASE_URL: nextBaseUrl,
    AI_MODEL: nextModel
  };

  const rawKey = input.apiKey?.trim();
  if (rawKey && rawKey !== previewCredential(staticConfig.aiApiKey)) {
    const cleanKey = cleanCredential(rawKey);
    if (cleanKey.length < 8) throw new Error("AI API key qua ngan hoac chua hop le");
    staticConfig.aiApiKey = cleanKey;
    process.env.AI_API_KEY = cleanKey;
    updates.AI_API_KEY = cleanKey;
  }

  staticConfig.aiBaseUrl = nextBaseUrl;
  staticConfig.aiModel = nextModel;
  process.env.AI_BASE_URL = nextBaseUrl;
  process.env.AI_MODEL = nextModel;
  upsertEnvFile(updates);
  return aiCredentialsStatus();
}

function cleanCredential(value: string): string {
  const clean = value.trim();
  if (/[\r\n]/.test(clean)) {
    throw new Error("API key/secret không được chứa dòng mới");
  }
  return clean;
}

function cleanBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error("AI Base URL phai bat dau bang http:// hoac https://");
  }
  if (/[\r\n]/.test(clean)) {
    throw new Error("AI Base URL khong duoc chua dong moi");
  }
  return clean;
}

function previewCredential(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function upsertEnvFile(values: Record<string, string>): void {
  const envPath = path.resolve(process.env.ENV_PATH ?? ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const newline = existing.includes("\r\n") ? "\r\n" : os.EOL;
  const keys = new Set(Object.keys(values));
  const seen = new Set<string>();
  const lines = existing ? existing.split(/\r?\n/) : [];
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !keys.has(key)) return line;
    seen.add(key);
    return `${key}=${quoteEnvValue(values[key])}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) nextLines.push(`${key}=${quoteEnvValue(value)}`);
  }

  fs.writeFileSync(envPath, `${nextLines.join(newline).replace(/\s+$/u, "")}${newline}`, "utf8");
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}
