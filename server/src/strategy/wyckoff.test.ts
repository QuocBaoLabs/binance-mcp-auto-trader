import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeWyckoff,
  generateWyckoffTradeSignal,
  type Candle
} from "./wyckoff.js";

function candle(index: number, close: number, volume = 100): Candle {
  return {
    time: index,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume
  };
}

test("analyzeWyckoff returns RSI, boxes and non-repainting pivot indexes", () => {
  const closes = [
    100, 99, 98, 97, 96, 95, 96, 97, 98, 99,
    100, 101, 100, 99, 98, 99, 100, 101, 102, 103,
    104, 105, 106, 107, 108, 109, 110, 111, 112, 113
  ];
  const candles = closes.map((close, index) => candle(index, close));
  const analysis = analyzeWyckoff(candles, {
    rsiLength: 5,
    trendSensitivity: 15,
    pivotLength: 2
  });

  assert.equal(analysis.rsi.length, candles.length);
  assert.ok(analysis.boxes.length >= 1);
  for (const signal of analysis.signals) {
    assert.ok(signal.confirmedIndex >= signal.signalIndex + 2);
  }
});

test("generateWyckoffTradeSignal explains missing setup instead of forcing a trade", () => {
  const candles = Array.from({ length: 40 }, (_, index) => candle(index, 100 + index * 0.1));
  const analysis = analyzeWyckoff(candles, {
    rsiLength: 14,
    trendSensitivity: 20,
    pivotLength: 5
  });
  const signal = generateWyckoffTradeSignal(candles, analysis, {
    rsiLength: 14,
    trendSensitivity: 20,
    pivotLength: 5,
    minConfidence: 60
  });

  assert.equal(signal.side, "NONE");
  assert.ok(signal.reason.length > 0);
});
