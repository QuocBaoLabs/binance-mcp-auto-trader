import type { Candle, ICTStrategyConfig, LiquidityPool, SwingPoint, Timeframe } from "./types.js";

export function detectLiquidityPools(
  candles: Candle[],
  swings: SwingPoint[],
  timeframe: Timeframe,
  config: ICTStrategyConfig
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  if (config.liquidity.detectSwingLiquidity) {
    for (const swing of swings) {
      pools.push({
        id: `${timeframe}:swing:${swing.type}:${swing.time}:${swing.price}`,
        type: swing.type === "high" ? "buySide" : "sellSide",
        price: swing.price,
        source: "swing",
        timeframe,
        strength: swing.strength,
        createdAt: swing.time,
        swept: false
      });
    }
  }

  if (config.liquidity.detectEqualHighLow) {
    pools.push(...detectEqualHighLow(swings, timeframe, config));
  }

  if (config.liquidity.useRangeHighLow && candles.length >= 20) {
    const range = candles.slice(-Math.min(80, candles.length));
    const high = Math.max(...range.map((candle) => candle.high));
    const low = Math.min(...range.map((candle) => candle.low));
    const createdAt = range.at(-1)?.closeTime ?? candles.at(-1)?.closeTime ?? 0;
    pools.push({
      id: `${timeframe}:range:high:${createdAt}:${high}`,
      type: "buySide",
      price: high,
      source: "range",
      timeframe,
      strength: 2,
      createdAt,
      swept: false
    });
    pools.push({
      id: `${timeframe}:range:low:${createdAt}:${low}`,
      type: "sellSide",
      price: low,
      source: "range",
      timeframe,
      strength: 2,
      createdAt,
      swept: false
    });
  }

  return pools;
}

export function nearestLiquidity(
  pools: LiquidityPool[],
  side: "buySide" | "sellSide",
  entry: number
): LiquidityPool[] {
  const candidates = pools.filter((pool) =>
    side === "buySide" ? pool.price > entry : pool.price < entry
  );
  return candidates.sort((left, right) =>
    side === "buySide" ? left.price - right.price : right.price - left.price
  );
}

function detectEqualHighLow(
  swings: SwingPoint[],
  timeframe: Timeframe,
  config: ICTStrategyConfig
): LiquidityPool[] {
  const pools: LiquidityPool[] = [];
  const tolerance = config.liquidity.equalTolerancePct;
  const highs = swings.filter((swing) => swing.type === "high");
  const lows = swings.filter((swing) => swing.type === "low");

  for (let i = 1; i < highs.length; i++) {
    const prev = highs[i - 1];
    const current = highs[i];
    if (Math.abs(prev.price - current.price) / prev.price * 100 <= tolerance) {
      pools.push({
        id: `${timeframe}:eqh:${current.time}:${current.price}`,
        type: "buySide",
        price: (prev.price + current.price) / 2,
        source: "equalHighLow",
        timeframe,
        strength: prev.strength + current.strength + 1,
        createdAt: current.time,
        swept: false
      });
    }
  }

  for (let i = 1; i < lows.length; i++) {
    const prev = lows[i - 1];
    const current = lows[i];
    if (Math.abs(prev.price - current.price) / prev.price * 100 <= tolerance) {
      pools.push({
        id: `${timeframe}:eql:${current.time}:${current.price}`,
        type: "sellSide",
        price: (prev.price + current.price) / 2,
        source: "equalHighLow",
        timeframe,
        strength: prev.strength + current.strength + 1,
        createdAt: current.time,
        swept: false
      });
    }
  }

  return pools;
}

