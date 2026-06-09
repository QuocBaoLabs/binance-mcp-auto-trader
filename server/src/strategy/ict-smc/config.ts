import type { ICTStrategyConfig } from "./types.js";

export const defaultICTConfig: ICTStrategyConfig = {
  timeframes: {
    htf: "1h",
    mtf: "15m",
    ltf: "1m"
  },
  structure: {
    swingLength: 3,
    internalSwingLength: 2,
    requireCloseBreak: true
  },
  liquidity: {
    detectSwingLiquidity: true,
    detectEqualHighLow: true,
    equalTolerancePct: 0.05,
    usePreviousDayHighLow: true,
    useRangeHighLow: true
  },
  sweep: {
    requireCloseBackInside: true,
    minWickBodyRatio: 1.2,
    maxBarsAfterSweepForMSS: 10
  },
  displacement: {
    atrLength: 14,
    minAtrMultiplier: 0.8
  },
  fvg: {
    enabled: true,
    minSizePct: 0.05,
    entryMode: "midline",
    maxFillBeforeEntryPct: 80,
    useInversionFVG: true,
    maxBarsAfterMss: 3
  },
  ote: {
    enabled: true,
    fibMin: 0.618,
    fibMax: 0.786,
    scoreBonus: 2
  },
  amd: {
    enabled: true,
    rangeLookback: 30,
    maxRangeAtrMultiplier: 4,
    requireFakeoutCloseBackInside: true
  },
  crt: {
    enabled: true,
    sourceTimeframe: "1h"
  },
  risk: {
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxConsecutiveLosses: 3,
    minRR: 1.5,
    preferredRR: 2.0,
    relaxRRAndTP: false,
    fixedTakeProfitRoiPct: 30,
    leverageForRoi: 1,
    slBufferAtr: 0.15,
    maxSlAtrMultiplier: 2.5
  },
  tradeManagement: {
    moveSLToBreakevenAtR: 1.0,
    lockProfitAtR: 2.0,
    lockProfitPct: 40,
    useTrailingStop: true,
    trailingMode: "ltfSwingAtr"
  },
  filters: {
    avoidMiddleOfRange: true,
    avoidLowVolume: true,
    avoidHighSpread: true,
    oneTradePerSymbol: true,
    minScoreToTrade: 7
  }
};
