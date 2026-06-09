import type { Candle, ICTStrategyConfig, LiquidityPool, SweepEvent } from "./types.js";

export function detectSweep(
  candles: Candle[],
  liquidityPools: LiquidityPool[],
  config: ICTStrategyConfig
): SweepEvent[] {
  const events: SweepEvent[] = [];
  const swept = new Set<string>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    for (const pool of liquidityPools) {
      if (swept.has(pool.id) || candle.openTime <= pool.createdAt) continue;
      const body = Math.max(Math.abs(candle.close - candle.open), 1e-12);
      const bullishWick = Math.min(candle.open, candle.close) - candle.low;
      const bearishWick = candle.high - Math.max(candle.open, candle.close);

      if (pool.type === "sellSide") {
        const closeBackInside = candle.close > pool.price;
        const wickBodyRatio = bullishWick / body;
        const valid = candle.low < pool.price &&
          (!config.sweep.requireCloseBackInside || closeBackInside) &&
          wickBodyRatio >= config.sweep.minWickBodyRatio;
        if (candle.low < pool.price) {
          events.push({
            direction: "long",
            liquidity: { ...pool, swept: true },
            candleIndex: i,
            candleTime: candle.closeTime,
            sweepPrice: candle.low,
            closeBackInside,
            wickBodyRatio,
            valid
          });
          swept.add(pool.id);
        }
      }

      if (pool.type === "buySide") {
        const closeBackInside = candle.close < pool.price;
        const wickBodyRatio = bearishWick / body;
        const valid = candle.high > pool.price &&
          (!config.sweep.requireCloseBackInside || closeBackInside) &&
          wickBodyRatio >= config.sweep.minWickBodyRatio;
        if (candle.high > pool.price) {
          events.push({
            direction: "short",
            liquidity: { ...pool, swept: true },
            candleIndex: i,
            candleTime: candle.closeTime,
            sweepPrice: candle.high,
            closeBackInside,
            wickBodyRatio,
            valid
          });
          swept.add(pool.id);
        }
      }
    }
  }

  return events;
}

