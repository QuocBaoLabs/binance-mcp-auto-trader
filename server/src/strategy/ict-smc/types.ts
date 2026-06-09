export type Direction = "long" | "short";
export type Bias = "bullish" | "bearish" | "neutral";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "1h" | "4h";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: "high" | "low";
  strength: number;
}

export interface LiquidityPool {
  id: string;
  type: "buySide" | "sellSide";
  price: number;
  source: "swing" | "equalHighLow" | "previousDay" | "range" | "crt";
  timeframe: Timeframe;
  strength: number;
  createdAt: number;
  swept: boolean;
}

export interface SweepEvent {
  direction: Direction;
  liquidity: LiquidityPool;
  candleIndex: number;
  candleTime: number;
  sweepPrice: number;
  closeBackInside: boolean;
  wickBodyRatio: number;
  valid: boolean;
}

export interface MarketStructureShift {
  direction: Direction;
  candleIndex: number;
  candleTime: number;
  brokenSwing: SwingPoint;
  breakPrice: number;
  closePrice: number;
  displacement: boolean;
  valid: boolean;
}

export interface FairValueGap {
  id: string;
  direction: Direction;
  startIndex: number;
  endIndex: number;
  upper: number;
  lower: number;
  mid: number;
  sizePct: number;
  timeframe: Timeframe;
  filledPct: number;
  valid: boolean;
  inverted: boolean;
}

export interface OTEZone {
  direction: Direction;
  swingStart: SwingPoint;
  swingEnd: SwingPoint;
  fib618: number;
  fib786: number;
  inZone: boolean;
}

export interface TradeSignal {
  symbol: string;
  direction: Direction;
  entryType: "limit" | "market";
  entry: number;
  stopLoss: number;
  takeProfits: {
    tp1: number;
    tp2: number;
    tp3?: number;
  };
  rr: {
    tp1: number;
    tp2: number;
    tp3?: number;
  };
  score: number;
  reason: string[];
  invalidReason?: string[];
  setupType: "SWEEP_MSS_FVG" | "AMD" | "CRT" | "INVERSION_FVG" | "CISD";
  createdAt: number;
}

export interface ICTStrategyConfig {
  timeframes: {
    htf: Timeframe;
    mtf: Timeframe;
    ltf: Timeframe;
  };
  structure: {
    swingLength: number;
    internalSwingLength: number;
    requireCloseBreak: boolean;
  };
  liquidity: {
    detectSwingLiquidity: boolean;
    detectEqualHighLow: boolean;
    equalTolerancePct: number;
    usePreviousDayHighLow: boolean;
    useRangeHighLow: boolean;
  };
  sweep: {
    requireCloseBackInside: boolean;
    minWickBodyRatio: number;
    maxBarsAfterSweepForMSS: number;
  };
  displacement: {
    atrLength: number;
    minAtrMultiplier: number;
  };
  fvg: {
    enabled: boolean;
    minSizePct: number;
    entryMode: "edge" | "midline" | "confirmation";
    maxFillBeforeEntryPct: number;
    useInversionFVG: boolean;
    maxBarsAfterMss: number;
  };
  ote: {
    enabled: boolean;
    fibMin: number;
    fibMax: number;
    scoreBonus: number;
  };
  amd: {
    enabled: boolean;
    rangeLookback: number;
    maxRangeAtrMultiplier: number;
    requireFakeoutCloseBackInside: boolean;
  };
  crt: {
    enabled: boolean;
    sourceTimeframe: Timeframe;
  };
  risk: {
    riskPerTradePct: number;
    maxDailyLossPct: number;
    maxConsecutiveLosses: number;
    minRR: number;
    preferredRR: number;
    relaxRRAndTP: boolean;
    fixedTakeProfitRoiPct: number;
    leverageForRoi: number;
    slBufferAtr: number;
    maxSlAtrMultiplier: number;
  };
  tradeManagement: {
    moveSLToBreakevenAtR: number;
    lockProfitAtR: number;
    lockProfitPct: number;
    useTrailingStop: boolean;
    trailingMode: "ltfSwingAtr" | "atr";
  };
  filters: {
    avoidMiddleOfRange: boolean;
    avoidLowVolume: boolean;
    avoidHighSpread: boolean;
    oneTradePerSymbol: boolean;
    minScoreToTrade: number;
  };
}

export interface ICTAnalyzeInput {
  symbol: string;
  htfCandles: Candle[];
  mtfCandles: Candle[];
  ltfCandles: Candle[];
  accountState?: {
    dailyLossPct?: number;
    consecutiveLosses?: number;
  };
  openPositions?: Array<{ symbol: string }>;
}

export interface ICTAnalyzeResult {
  signal: TradeSignal | null;
  bias: Bias;
  debug: string[];
}
