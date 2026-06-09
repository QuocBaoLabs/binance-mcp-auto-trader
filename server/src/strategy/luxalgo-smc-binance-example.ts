import type { Kline } from "../types.js";
import { LuxAlgoSmcAdapter, SMC_WARMUP_CANDLES } from "./luxalgo-smc-adapter.js";

type BinanceKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  ...unknown[]
];

const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
const interval = process.argv[3] ?? "5m";
const limit = Number(process.argv[4] ?? SMC_WARMUP_CANDLES);

const rows = await fetchBinanceKlines(symbol, interval, limit);
const klines = rows.map(parseBinanceKline);
const adapter = new LuxAlgoSmcAdapter();
const signal = adapter.analyzeClosedKlines(symbol, interval, klines);

console.log(JSON.stringify({
  symbol,
  interval,
  closedCandles: signal.output ? signal.output.index + 1 : 0,
  signal: signal.signal,
  confidence: signal.confidence,
  reason: signal.reason,
  activeAlerts: signal.activeAlerts,
  internalTrend: signal.output?.internalTrend ?? 0,
  swingTrend: signal.output?.swingTrend ?? 0,
  latestClosedCandle: signal.latestClosedCandle
}, null, 2));

async function fetchBinanceKlines(
  targetSymbol: string,
  targetInterval: string,
  targetLimit: number
): Promise<BinanceKlineRow[]> {
  const url = new URL("https://fapi.binance.com/fapi/v1/klines");
  url.searchParams.set("symbol", targetSymbol);
  url.searchParams.set("interval", targetInterval);
  url.searchParams.set("limit", String(Math.min(Math.max(Math.floor(targetLimit), 1), 1500)));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance klines failed ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error("Binance klines response is not an array");
  return payload.map(toBinanceKlineRow);
}

function toBinanceKlineRow(value: unknown): BinanceKlineRow {
  if (!Array.isArray(value) || value.length < 9) {
    throw new Error("Invalid Binance kline row");
  }
  return [
    Number(value[0]),
    String(value[1]),
    String(value[2]),
    String(value[3]),
    String(value[4]),
    String(value[5]),
    Number(value[6]),
    String(value[7]),
    Number(value[8]),
    ...value.slice(9)
  ];
}

function parseBinanceKline(row: BinanceKlineRow): Kline {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    quoteVolume: Number(row[7]),
    trades: row[8]
  };
}
