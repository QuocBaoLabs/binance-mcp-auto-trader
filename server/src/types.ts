export type TradeSide = "BUY" | "SELL";
export type SignalDecision = "LONG" | "SHORT" | "WAIT";
export type StrategyMode = "score" | "rules" | "hybrid" | "wyckoff" | "smc";
export type ScannerStrategy = "sfp" | "candlestick" | "wyckoff" | "smc";
export type TrendDirection = "UP" | "DOWN";
export type LeverageMode = "fixed" | "auto";
export type FuturesMarginType = "CROSSED" | "ISOLATED";
export type OrderKind =
  | "LIMIT"
  | "MARKET"
  | "STOP"
  | "STOP_MARKET"
  | "TAKE_PROFIT"
  | "TRAILING_STOP_MARKET"
  | "TAKE_PROFIT_MARKET";

export interface RuntimeSettings {
  readOnly: boolean;
  autoTradeEnabled: boolean;
  dryRun: boolean;
  binanceTestnet: boolean;
  allowMarketOrder: boolean;
  allowedSymbols: string[];
  maxOrderUsdt: number;
  maxDailyLossUsdt: number;
  maxOpenPositions: number;
  maxLeverage: number;
  tpPercent: number;
  slPercent: number;
  minConfidence: number;
  strategyIntervalSeconds: number;
  klineInterval: string;
  strategyMode: StrategyMode;
  touchTolerancePercent: number;
  ruleSupertrendEma10Long: boolean;
  ruleSupertrendEma10Short: boolean;
  ruleRequireTrendDirection: boolean;
  ruleRequireEma10Touch: boolean;
  ruleRequireSupertrendTouch: boolean;
  ruleBollingerReversion: boolean;
  wyckoffRsiLength: number;
  wyckoffTrendSensitivity: number;
  wyckoffPivotLength: number;
  wyckoffUseVolumeFilter: boolean;
  wyckoffVolumeMaLength: number;
  wyckoffBreakoutBufferPct: number;
  wyckoffRetestTolerancePct: number;
  wyckoffMaxRiskDistancePct: number;
  wyckoffMinConfidence: number;
  wyckoffSlBufferPct: number;
  supertrendPeriod: number;
  supertrendMultiplier: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  sarStep: number;
  sarMax: number;
  leverageMode: LeverageMode;
  fixedLeverage: number;
  minLeverage: number;
  volatilityTimeframe: string;
  volatilityLookback: number;
  lowVolatilityThreshold: number;
  mediumVolatilityThreshold: number;
  highVolatilityThreshold: number;
  extremeVolatilityThreshold: number;
  skipTradeOnExtremeVolatility: boolean;
  sfpEnabled: boolean;
  sfpStrategies: ScannerStrategy[];
  sfpLen: number;
  ruleSfpSignal: boolean;
  sfpWatchSymbols: string[];
  sfpTimeframes: string[];
  smcAutoTimeframes: boolean;
  smcPreferredRR: number;
  smcRelaxedRRTP: boolean;
  smcTakeProfitRoiPercent: number;
  smcMinScore: number;
  smcMaxBarsAfterSweepForMSS: number;
  smcFvgMinSizePct: number;
  smcAvoidMiddleOfRange: boolean;
  smcFvgMaxBarsAfterMss: number;
  sfpLeverage: number;
  sfpMarginUsdt: number;
  sfpTpPercent: number;
  sfpCandlestickTpPercent: number;
  sfpMarginType: FuturesMarginType;
  sfpAutoExecute: boolean;
  sfpWaitCandles: number;
  sfpOneTradeAtATime: boolean;
  sfpUseTrailingStop: boolean;
  sfpTrailingCallbackRate: number; // % kéo lại (0.1–5), default 1.5
  sfpTrailingActivationPct: number; // % lãi cần đạt trước khi trailing kích hoạt, default 0.5
}

export interface StaticConfig {
  apiKey: string;
  apiSecret: string;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  enableLiveTrading: boolean;
  maxRiskPercent: number;
  liveBaseUrl: string;
  testnetBaseUrl: string;
  sqlitePath: string;
  signalChartDir: string;
  publicBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  port: number;
  sseHeartbeatSeconds: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export interface MarketSignal {
  symbol: string;
  interval: string;
  signal: SignalDecision;
  confidence: number;
  reason: string;
  price: number;
  emaFast: number | null;
  emaSlow: number | null;
  ema10: number | null;
  ema36: number | null;
  rsi: number | null;
  volumeChange: number | null;
  fundingRate: number | null;
  openInterest: number | null;
  longShortRatio: number | null;
  supertrend: number | null;
  supertrendDirection: TrendDirection | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  sar: number | null;
  sarDirection: TrendDirection | null;
  createdAt: string;
}

export interface BinanceOrderRequest {
  symbol: string;
  side: TradeSide;
  type: OrderKind;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  callbackRate?: string;    // TRAILING_STOP_MARKET: % kéo giá kích hoạt (0.1–5)
  activationPrice?: string; // TRAILING_STOP_MARKET: giá kích hoạt trailing (optional)
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  priceProtect?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX" | "GTD";
  reduceOnly?: boolean;
  closePosition?: boolean;
  newClientOrderId?: string;
}

export interface ProtectedTradeRequest {
  symbol: string;
  side: TradeSide;
  entryType?: "LIMIT" | "MARKET";
  quantity: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  leverage: number;
  marginType?: FuturesMarginType;
  postOnly?: boolean;
  source: "strategy" | "mcp" | "dashboard" | "tradingview";
  confidence?: number;
  reason?: string;
  // Trailing stop — khi bật, thay thế fixed TP bằng trailing stop market
  useTrailingStop?: boolean;
  trailingCallbackRate?: number;    // % kéo lại từ đỉnh/đáy để kích hoạt (0.1–5)
  trailingActivationPrice?: number; // giá kích hoạt trailing (undefined = kích hoạt ngay)
  skipRewardRiskCheck?: boolean;
  // Callbacks for LIMIT orders that don't fill immediately
  onEntryFilled?: () => void;  // LIMIT filled, TP/SL placed
  onEntryExpired?: () => void; // LIMIT cancelled after 60s timeout
}

export type SFPSignalStatus = "pending" | "limit_placed" | "simulated" | "executed" | "rejected" | "ignored" | "tp_hit" | "sl_hit";
export type SFPDecisionAction = "TRADE" | "SKIP";
export type SFPDecisionStatus = "pass" | "warn" | "fail";

export interface SFPDecisionRule {
  id: string;
  label: string;
  status: SFPDecisionStatus;
  detail: string;
  weight: number;
}

export interface SFPSignalRecord {
  id?: number;
  strategy?: ScannerStrategy;
  patternName?: string;
  symbol: string;
  timeframe: string;
  direction: "BULLISH" | "BEARISH";
  confirmed: boolean;
  swingPrice: number;
  oppositeLevel: number;
  sfpCandleHigh: number;
  sfpCandleLow: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  leverage: number;
  marginUsdt: number;
  status: SFPSignalStatus;
  message: string;
  decision?: SFPDecisionAction;
  decisionScore?: number;
  decisionSummary?: string;
  decisionDetails?: SFPDecisionRule[];
  hasSfp?: boolean;
  chartPath?: string;
  chartUrl?: string;
  executeAfter?: string;
  createdAt: string;
  closedAt?: string;
  closePrice?: number;
  realizedPnlUsdt?: number;
  realizedPnlPct?: number;
}

export type AITrainingDocumentKind = "text" | "image" | "prompt" | "candlestick" | "strategy" | "other";

export interface AITrainingDocument {
  id?: number;
  name: string;
  kind: AITrainingDocumentKind;
  mimeType: string;
  content: string;
  sizeBytes: number;
  tags: string[];
  createdAt: string;
}

export interface AITrainingRun {
  id?: number;
  prompt: string;
  documentIds: number[];
  model: string;
  status: "ok" | "error";
  output: string;
  parsedJson?: unknown;
  error?: string;
  createdAt: string;
}

export interface RiskCheckResult {
  ok: boolean;
  reasons: string[];
}

export interface AppEvent {
  type:
    | "config.updated"
    | "log.created"
    | "signal.created"
    | "order.created"
    | "risk.blocked"
    | "strategy.tick"
    | "sfp.signal"
    | "sfp.closed"
    | "ai.training"
    | "emergency.stop"
    | "position.update"
    | "liquidation.warning";
  data: unknown;
  createdAt: string;
}
