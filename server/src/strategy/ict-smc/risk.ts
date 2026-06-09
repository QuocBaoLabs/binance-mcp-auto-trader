import type { Direction, ICTStrategyConfig, LiquidityPool, SwingPoint, TradeSignal } from "./types.js";

export interface RiskPlanInput {
  symbol: string;
  direction: Direction;
  entry: number;
  stopLoss: number;
  nearestSwing: SwingPoint | null;
  liquidityTargets: LiquidityPool[];
  htfExtreme: number | null;
  score: number;
  reason: string[];
  setupType: TradeSignal["setupType"];
}

export function buildTradeSignal(input: RiskPlanInput, config: ICTStrategyConfig): TradeSignal | null {
  const risk = input.direction === "long"
    ? input.entry - input.stopLoss
    : input.stopLoss - input.entry;
  if (risk <= 0) return null;

  const relaxed = config.risk.relaxRRAndTP;
  const fixedRoiTp = relaxed
    ? fixedRoiTakeProfit(
        input.direction,
        input.entry,
        config.risk.fixedTakeProfitRoiPct,
        config.risk.leverageForRoi
      )
    : null;
  const rawTp1 = input.nearestSwing?.price ?? input.liquidityTargets[0]?.price;
  const rawTp2 = input.liquidityTargets[1]?.price;
  const tp1 = relaxed
    ? validTarget(input.direction, input.entry, rawTp1) ? rawTp1 : fixedRoiTp
    : rawTp1;
  const tp2 = relaxed ? fixedRoiTp : rawTp2;
  const tp3 = input.htfExtreme ?? undefined;
  if (!tp1 || !tp2) return null;

  const rr1 = reward(input.direction, input.entry, tp1) / risk;
  const rr2 = reward(input.direction, input.entry, tp2) / risk;
  const rr3 = tp3 ? reward(input.direction, input.entry, tp3) / risk : undefined;
  if (!relaxed && rr2 < config.risk.minRR) return null;

  return {
    symbol: input.symbol,
    direction: input.direction,
    entryType: "limit",
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfits: { tp1, tp2, ...(tp3 ? { tp3 } : {}) },
    rr: { tp1: rr1, tp2: rr2, ...(rr3 !== undefined ? { tp3: rr3 } : {}) },
    score: input.score,
    reason: input.reason,
    setupType: input.setupType,
    createdAt: Date.now()
  };
}

export function reward(direction: Direction, entry: number, target: number): number {
  return direction === "long" ? target - entry : entry - target;
}

function fixedRoiTakeProfit(
  direction: Direction,
  entry: number,
  roiPct: number,
  leverage: number
): number | null {
  if (entry <= 0) return null;
  const lev = Math.max(1, leverage);
  const priceMovePct = Math.max(0.01, roiPct) / lev / 100;
  return direction === "long"
    ? entry * (1 + priceMovePct)
    : entry * (1 - priceMovePct);
}

function validTarget(
  direction: Direction,
  entry: number,
  target: number | undefined
): target is number {
  return target !== undefined && reward(direction, entry, target) > 0;
}

export function stopDistanceOk(entry: number, stopLoss: number, atrValue: number, config: ICTStrategyConfig): boolean {
  if (atrValue <= 0) return false;
  return Math.abs(entry - stopLoss) <= atrValue * config.risk.maxSlAtrMultiplier;
}
