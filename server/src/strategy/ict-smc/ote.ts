import type { Direction, ICTStrategyConfig, OTEZone, SwingPoint } from "./types.js";

export function detectOTEZone(
  direction: Direction,
  swingStart: SwingPoint,
  swingEnd: SwingPoint,
  config: ICTStrategyConfig,
  testPrice?: number
): OTEZone {
  const high = Math.max(swingStart.price, swingEnd.price);
  const low = Math.min(swingStart.price, swingEnd.price);
  const fib618 = direction === "long"
    ? high - (high - low) * config.ote.fibMin
    : low + (high - low) * config.ote.fibMin;
  const fib786 = direction === "long"
    ? high - (high - low) * config.ote.fibMax
    : low + (high - low) * config.ote.fibMax;
  const zoneLow = Math.min(fib618, fib786);
  const zoneHigh = Math.max(fib618, fib786);
  return {
    direction,
    swingStart,
    swingEnd,
    fib618,
    fib786,
    inZone: testPrice === undefined ? false : testPrice >= zoneLow && testPrice <= zoneHigh
  };
}

