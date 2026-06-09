import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Kline } from "../types.js";
import { logger } from "../logger.js";

const TF_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000
};
const MAX_KLINE_BUFFER = 300;

interface KlineBuffer {
  klines: Kline[];
  lastClosedTime: number;
}

export interface MarkPriceEvent {
  symbol: string;
  markPrice: number;
  fundingRate: number;
}

export interface KlineClosedEvent {
  symbol: string;
  interval: string;
  klines: Kline[];
}

export interface PositionUpdateEvent {
  positions: Array<{
    symbol: string;
    positionAmt: string;
    entryPrice: string;
    unrealizedProfit: string;
    marginType: string;
    leverage: string;
    positionSide: string;
  }>;
  balances: Array<{ asset: string; walletBalance: string; crossUnPnl: string }>;
}

export class BinanceWSManager extends EventEmitter {
  private klineWs = new Map<string, WebSocket>(); // key: "SYMBOL:interval"
  private klineBuffers = new Map<string, KlineBuffer>();
  private markPriceWs = new Map<string, WebSocket>(); // key: symbol
  private userDataWs?: WebSocket;
  private listenKey?: string;
  private listenKeyTimer?: NodeJS.Timeout;
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly liveWsUrl: string,
    private readonly liveRestUrl: string,
    private readonly testnetWsUrl: string,
    private readonly testnetRestUrl: string,
    private isTestnet: () => boolean,
    private getApiKey: () => string
  ) {
    super();
    this.setMaxListeners(100);
  }

  private get wsBase(): string {
    return this.isTestnet() ? this.testnetWsUrl : this.liveWsUrl;
  }
  private get restBase(): string {
    return this.isTestnet() ? this.testnetRestUrl : this.liveRestUrl;
  }

  // ── Kline streams ─────────────────────────────────────────────────────────

  subscribeKlines(symbol: string, interval: string, seedKlines: Kline[]): void {
    const key = `${symbol}:${interval}`;
    const existing = this.klineBuffers.get(key);
    if (!existing) {
      this.klineBuffers.set(key, { klines: seedKlines.slice(-MAX_KLINE_BUFFER), lastClosedTime: 0 });
    } else if (seedKlines.length > existing.klines.length) {
      this.klineBuffers.set(key, {
        klines: seedKlines.slice(-MAX_KLINE_BUFFER),
        lastClosedTime: existing.lastClosedTime
      });
    }
    this.openKlineWs(symbol, interval);
  }

  unsubscribeKlines(symbol: string, interval: string): void {
    const key = `${symbol}:${interval}`;
    this.klineWs.get(key)?.close();
    this.klineWs.delete(key);
    this.klineBuffers.delete(key);
    const t = this.reconnectTimers.get(key);
    if (t) { clearTimeout(t); this.reconnectTimers.delete(key); }
  }

  getKlines(symbol: string, interval: string): Kline[] {
    return [...(this.klineBuffers.get(`${symbol}:${interval}`)?.klines ?? [])];
  }

  private openKlineWs(symbol: string, interval: string): void {
    const key = `${symbol}:${interval}`;
    const existing = this.klineWs.get(key);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const url = `${this.wsBase}/ws/${stream}`;
    const ws = new WebSocket(url);

    ws.on("open", () => logger.debug(`WS kline open: ${key}`));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { e: string; k: Record<string, unknown> };
        if (msg.e === "kline") this.handleKlineMsg(symbol, interval, msg.k);
      } catch { /* skip bad frames */ }
    });

    ws.on("error", (err) => logger.warn(`WS kline error ${key}: ${err.message}`));

    ws.on("close", () => {
      logger.debug(`WS kline closed: ${key} — reconnecting in 5s`);
      const t = setTimeout(() => this.openKlineWs(symbol, interval), 5_000);
      this.reconnectTimers.set(key, t);
    });

    this.klineWs.set(key, ws);
  }

  private handleKlineMsg(symbol: string, interval: string, k: Record<string, unknown>): void {
    const key = `${symbol}:${interval}`;
    const buf = this.klineBuffers.get(key);
    if (!buf) return;

    const candle: Kline = {
      openTime: Number(k["t"]),
      open: Number(k["o"]),
      high: Number(k["h"]),
      low: Number(k["l"]),
      close: Number(k["c"]),
      volume: Number(k["v"]),
      closeTime: Number(k["T"]),
      quoteVolume: Number(k["q"]),
      trades: Number(k["n"])
    };

    const last = buf.klines.at(-1);
    if (last && last.openTime === candle.openTime) {
      buf.klines[buf.klines.length - 1] = candle;
    } else {
      buf.klines.push(candle);
      if (buf.klines.length > MAX_KLINE_BUFFER) buf.klines.shift();
    }

    // Fire only when candle closes, and only once per candle
    if (k["x"] === true && candle.openTime !== buf.lastClosedTime) {
      buf.lastClosedTime = candle.openTime;
      const ev: KlineClosedEvent = { symbol, interval, klines: [...buf.klines] };
      this.emit("kline:closed", ev);
      logger.debug(`WS kline closed: ${symbol} ${interval} @ ${new Date(candle.openTime).toISOString()}`);
    }
  }

  // ── Mark price streams ────────────────────────────────────────────────────

  subscribeMarkPrice(symbol: string): void {
    const sym = symbol.toUpperCase();
    if (this.markPriceWs.has(sym)) return;
    this.openMarkPriceWs(sym);
  }

  unsubscribeMarkPrice(symbol: string): void {
    const sym = symbol.toUpperCase();
    this.markPriceWs.get(sym)?.close();
    this.markPriceWs.delete(sym);
    const t = this.reconnectTimers.get(`mp:${sym}`);
    if (t) { clearTimeout(t); this.reconnectTimers.delete(`mp:${sym}`); }
  }

  private openMarkPriceWs(symbol: string): void {
    const key = `mp:${symbol}`;
    const existing = this.markPriceWs.get(symbol);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

    const url = `${this.wsBase}/ws/${symbol.toLowerCase()}@markPrice@1s`;
    const ws = new WebSocket(url);

    ws.on("open", () => logger.debug(`WS markPrice open: ${symbol}`));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { e: string; s: string; p: string; r: string };
        if (msg.e === "markPriceUpdate") {
          const ev: MarkPriceEvent = {
            symbol: msg.s,
            markPrice: parseFloat(msg.p),
            fundingRate: parseFloat(msg.r),
          };
          this.emit("markPrice:update", ev);
        }
      } catch { /* skip bad frames */ }
    });

    ws.on("error", (err) => logger.warn(`WS markPrice error ${symbol}: ${err.message}`));

    ws.on("close", () => {
      logger.debug(`WS markPrice closed: ${symbol} — reconnecting in 3s`);
      const t = setTimeout(() => this.openMarkPriceWs(symbol), 3_000);
      this.reconnectTimers.set(key, t);
    });

    this.markPriceWs.set(symbol, ws);
  }

  // ── User data stream (positions / PNL) ────────────────────────────────────

  async subscribeUserData(): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) return;
    try {
      const res = await fetch(`${this.restBase}/fapi/v1/listenKey`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": apiKey }
      });
      if (!res.ok) throw new Error(`listenKey HTTP ${res.status}`);
      const body = await res.json() as { listenKey: string };
      this.listenKey = body.listenKey;

      // Keep-alive every 25 min
      if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
      this.listenKeyTimer = setInterval(() => void this.keepAliveListenKey(), 25 * 60_000);

      this.openUserDataWs();
      logger.debug("WS user data stream started");
    } catch (e) {
      logger.warn(`WS subscribeUserData failed: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => void this.subscribeUserData(), 30_000);
    }
  }

  private openUserDataWs(): void {
    if (!this.listenKey) return;
    const url = `${this.wsBase}/ws/${this.listenKey}`;
    const ws = new WebSocket(url);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { e: string; a?: Record<string, unknown> };
        if (msg.e === "ACCOUNT_UPDATE") this.handleAccountUpdate(msg);
      } catch { /* skip */ }
    });

    ws.on("error", (err) => logger.warn(`WS user data error: ${err.message}`));

    ws.on("close", () => {
      logger.debug("WS user data closed — reconnecting in 5s");
      setTimeout(() => void this.subscribeUserData(), 5_000);
    });

    this.userDataWs = ws;
  }

  private handleAccountUpdate(msg: Record<string, unknown>): void {
    const a = msg["a"] as Record<string, unknown> | undefined;
    if (!a) return;
    const positions = (a["P"] as unknown[] ?? []) as Array<Record<string, unknown>>;
    const balances = (a["B"] as unknown[] ?? []) as Array<Record<string, unknown>>;

    const ev: PositionUpdateEvent = {
      positions: positions.map(p => ({
        symbol: String(p["s"] ?? ""),
        positionAmt: String(p["pa"] ?? "0"),
        entryPrice: String(p["ep"] ?? "0"),
        unrealizedProfit: String(p["up"] ?? "0"),
        marginType: String(p["mt"] ?? "cross"),
        leverage: String(p["l"] ?? "1"),
        positionSide: String(p["ps"] ?? "BOTH")
      })),
      balances: balances.map(b => ({
        asset: String(b["a"] ?? ""),
        walletBalance: String(b["wb"] ?? "0"),
        crossUnPnl: String(b["cw"] ?? "0")
      }))
    };

    this.emit("position:update", ev);
  }

  private async keepAliveListenKey(): Promise<void> {
    if (!this.listenKey) return;
    try {
      await fetch(`${this.restBase}/fapi/v1/listenKey`, {
        method: "PUT",
        headers: { "X-MBX-APIKEY": this.getApiKey() }
      });
    } catch (e) {
      logger.warn(`WS keepAlive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  stop(): void {
    for (const ws of this.klineWs.values()) ws.close();
    this.klineWs.clear();
    this.klineBuffers.clear();
    for (const ws of this.markPriceWs.values()) ws.close();
    this.markPriceWs.clear();
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    this.userDataWs?.close();
    if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
  }
}
