import { BinanceClient } from "../binance/client.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { AuditLogService } from "../services/audit-log.js";
import type { SFPSignalStatus } from "../types.js";

const CHECK_INTERVAL_MS = 5_000;

type OrderRow = {
  type: string;
  status: string;
  avgPrice: string;
  price: string;
  side: string;
  updateTime: number;
};

export class SFPMonitor {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: AppDatabase,
    private readonly binance: BinanceClient,
    private readonly audit: AuditLogService
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async check(): Promise<void> {
    if (this.binance.rateLimitStatus().banned) return;

    const executed = this.db.listExecutedSFPSignals();
    if (!executed.length) return;

    // Fetch all open positions once — cheaper than per-symbol calls
    let activeSymbols = new Set<string>();
    try {
      const positions = await this.binance.getPosition() as Array<Record<string, unknown>>;
      activeSymbols = new Set(
        positions
          .filter(p => Math.abs(Number(p.positionAmt ?? 0)) > 0)
          .map(p => String(p.symbol))
      );
    } catch { /* will retry */ }

    // Current prices for price-based fallback
    const symbols = [...new Set(executed.map(s => s.symbol))];
    const priceMap: Record<string, number> = {};
    await Promise.all(symbols.map(async sym => {
      try {
        const t = await this.binance.getPrice(sym) as { price: string };
        const p = parseFloat(t.price);
        if (Number.isFinite(p) && p > 0) priceMap[sym] = p;
      } catch { /* skip */ }
    }));

    for (const sig of executed) {
      if (!sig.id) continue;

      const positionStillOpen = activeSymbols.has(sig.symbol);
      const cur = priceMap[sig.symbol];

      // --- Path 1: Price-based detection (position still open) ---
      if (positionStillOpen && cur) {
        const isLong = sig.direction === "BULLISH";
        const tpHit = this.isTrailingActivationSignal(sig)
          ? false
          : isLong ? cur >= sig.tpPrice : cur <= sig.tpPrice;
        const slHit = isLong ? cur <= sig.slPrice : cur >= sig.slPrice;
        if (tpHit || slHit) {
          const closePrice = tpHit ? sig.tpPrice : sig.slPrice;
          this.closeSignal(sig, tpHit ? "tp_hit" : "sl_hit", closePrice);
        }
        continue;
      }

      // --- Path 2: Position is gone — detect via Binance order history ---
      if (!positionStillOpen) {
        await this.detectClosedPosition(sig, cur);
      }
    }
  }

  private async detectClosedPosition(
    sig: ReturnType<AppDatabase["listExecutedSFPSignals"]>[number],
    curPrice: number | undefined
  ): Promise<void> {
    let closePrice: number | null = null;
    let status: SFPSignalStatus = "sl_hit"; // default pessimistic

    try {
      const orders = await this.binance.getRecentOrders(sig.symbol, 30) as OrderRow[];
      // Find most recent FILLED reduce-only order (TP or SL)
      const filled = orders
        .filter(o =>
          o.status === "FILLED" &&
          (o.type === "TAKE_PROFIT_MARKET" ||
           o.type === "TRAILING_STOP_MARKET" ||
           o.type === "STOP_MARKET" ||
           o.type === "TAKE_PROFIT" ||
           o.type === "STOP")
        )
        .sort((a, b) => b.updateTime - a.updateTime);

      const last = filled[0];
      if (last) {
        const fillPrice = parseFloat(last.avgPrice || last.price);
        if (Number.isFinite(fillPrice) && fillPrice > 0) {
          closePrice = fillPrice;
          status = last.type === "TRAILING_STOP_MARKET"
            ? this.isProfitableClose(sig, fillPrice) ? "tp_hit" : "sl_hit"
            : last.type.startsWith("TAKE_PROFIT") ? "tp_hit" : "sl_hit";
        }
      }
    } catch { /* fall through to price-based guess */ }

    // Fallback: guess from current price proximity
    if (closePrice === null && curPrice && !this.isTrailingActivationSignal(sig)) {
      const isLong = sig.direction === "BULLISH";
      const distToTp = Math.abs(curPrice - sig.tpPrice);
      const distToSl = Math.abs(curPrice - sig.slPrice);
      status   = distToTp < distToSl ? "tp_hit" : "sl_hit";
      closePrice = status === "tp_hit" ? sig.tpPrice : sig.slPrice;
    }

    if (closePrice === null) return; // can't determine yet

    this.closeSignal(sig, status, closePrice);
    await this.cleanupProtectiveOrders(sig.symbol);
  }

  private closeSignal(
    sig: ReturnType<AppDatabase["listExecutedSFPSignals"]>[number],
    status: SFPSignalStatus,
    closePrice: number
  ): void {
    if (!sig.id) return;
    const isLong = sig.direction === "BULLISH";
    const dir    = isLong ? 1 : -1;
    const rawPct = dir * (closePrice - sig.entryPrice) / sig.entryPrice * 100;
    const realizedPnlPct  = rawPct * sig.leverage;
    const realizedPnlUsdt = rawPct / 100 * sig.leverage * sig.marginUsdt;

    this.db.closeSFPSignal(sig.id, status, closePrice, realizedPnlUsdt, realizedPnlPct);

    appEvents.publish("sfp.closed", {
      id: sig.id, symbol: sig.symbol, timeframe: sig.timeframe,
      direction: sig.direction, status, closePrice,
      realizedPnlUsdt, realizedPnlPct,
    });

    this.audit.info(
      `SFP ${status === "tp_hit" ? "ĐẠT TP ✓" : "HIT SL ✗"}: ${sig.symbol} ${sig.timeframe} ${sig.direction} — PNL ${realizedPnlUsdt >= 0 ? "+" : ""}${realizedPnlUsdt.toFixed(2)}$`,
      { id: sig.id, closePrice, realizedPnlUsdt, realizedPnlPct, source: "position-check" }
    );
  }

  private isTrailingActivationSignal(
    sig: ReturnType<AppDatabase["listExecutedSFPSignals"]>[number]
  ): boolean {
    if (sig.strategy !== "smc") return false;
    return (sig.decisionDetails ?? []).some((rule) =>
      /Relaxed RR\/TP|trailing|ROI/i.test(rule.detail)
    );
  }

  private async cleanupProtectiveOrders(symbol: string): Promise<void> {
    try {
      await this.binance.cancelAllOpenOrders(symbol);
    } catch (error) {
      this.audit.warn("Khong the huy lenh thuong con sot sau khi vi the dong", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      await this.binance.cancelAllOpenAlgoOrders(symbol);
    } catch (error) {
      this.audit.warn("Khong the huy lenh algo con sot sau khi vi the dong", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private isProfitableClose(
    sig: ReturnType<AppDatabase["listExecutedSFPSignals"]>[number],
    closePrice: number
  ): boolean {
    return sig.direction === "BULLISH"
      ? closePrice > sig.entryPrice
      : closePrice < sig.entryPrice;
  }
}
