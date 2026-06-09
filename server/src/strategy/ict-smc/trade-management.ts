import type { Direction, ICTStrategyConfig, SwingPoint } from "./types.js";

export function nextTrailingStop(params: {
  direction: Direction;
  currentStop: number;
  latestSwing: SwingPoint | null;
  atr: number;
  config: ICTStrategyConfig;
}): number {
  const { direction, currentStop, latestSwing, atr, config } = params;
  if (!config.tradeManagement.useTrailingStop || !latestSwing || atr <= 0) return currentStop;
  if (direction === "long" && latestSwing.type === "low") {
    return Math.max(currentStop, latestSwing.price - atr * 0.2);
  }
  if (direction === "short" && latestSwing.type === "high") {
    return Math.min(currentStop, latestSwing.price + atr * 0.2);
  }
  return currentStop;
}

