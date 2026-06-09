import { BinanceClient } from "../binance/client.js";
import type { MarkPriceEvent } from "../binance/ws-manager.js";
import { BinanceWSManager } from "../binance/ws-manager.js";
import { appEvents } from "../events.js";
import { AuditLogService } from "../services/audit-log.js";
import { SettingsService } from "../services/settings.js";
import type { TradeSide } from "../types.js";

const ROUND_TRIP_FEE_PCT    = 0.1;  // 0.1% round-trip fees (used as buffer)
const MAX_TRAILING_CALLBACK = 5;    // Binance USDT-M max callbackRate = 5%
const POSITION_REFRESH_MS   = 10_000;
const FIRST_LOCK_ACTIVATION_ROI = 30;
const FIRST_LOCK_CONFIRM_MS = 0;
const FIRST_LOCK_TARGET_ROI = 10;   // lock in 10% ROI when milestone fires

interface Milestone {
  roi: number;
  activationRoi?: number;
  confirmMs?: number;
  label: string;
  newSL: (entry: number, mark: number, isLong: boolean, leverage: number) => number | null;
  trailing?: { callbackRate: number };
}

// Helper: SL price that locks in `lockRoi`% ROI for the position
function lockRoiSL(entry: number, isLong: boolean, lev: number, lockRoi: number): number {
  const priceMove = (lockRoi / Math.max(1, lev) / 100) + ROUND_TRIP_FEE_PCT / 100;
  return isLong ? entry * (1 + priceMove) : entry * (1 - priceMove);
}

const MILESTONES: Milestone[] = [
  // Tất cả milestone dùng "khóa X% ROI" nhất quán — tránh khoảng trống logic
  {
    roi: 30,
    activationRoi: FIRST_LOCK_ACTIVATION_ROI,
    confirmMs: FIRST_LOCK_CONFIRM_MS,
    label: "Khóa ROI +10% (kích hoạt ROI 30%)",
    newSL: (entry, _mark, isLong, lev) => lockRoiSL(entry, isLong, lev, 10),
  },
  {
    roi: 50,
    label: "Khóa ROI +25% (kích hoạt ROI 50%)",
    newSL: (entry, _mark, isLong, lev) => lockRoiSL(entry, isLong, lev, 25),
  },
  {
    roi: 80,
    label: "Khóa ROI +50% (kích hoạt ROI 80%)",
    newSL: (entry, _mark, isLong, lev) => lockRoiSL(entry, isLong, lev, 50),
  },
  {
    roi: 120,
    label: "Khóa ROI +80% (kích hoạt ROI 120%)",
    newSL: (entry, _mark, isLong, lev) => lockRoiSL(entry, isLong, lev, 80),
  },
  {
    roi: 180,
    label: "Trailing stop 5% (ROI 180%)",
    newSL: () => null,
    trailing: { callbackRate: 5 },
  },
];

function inferLeverage(position: Record<string, unknown>, fallback = 1): number {
  const explicit = Number(position.leverage ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return normalizeLeverage(explicit);

  const amount = Math.abs(Number(position.positionAmt ?? 0));
  const mark = Number(position.markPrice ?? 0);
  const notional =
    Math.abs(Number(position.notional ?? 0)) ||
    (amount > 0 && mark > 0 ? amount * mark : 0);
  const initialMargin =
    Number(position.initialMargin ?? 0) ||
    Number(position.positionInitialMargin ?? 0) ||
    Number(position.isolatedMargin ?? 0);

  if (notional > 0 && initialMargin > 0) {
    const inferred = notional / initialMargin;
    if (Number.isFinite(inferred) && inferred > 0) return normalizeLeverage(inferred);
  }

  return fallback;
}

function normalizeLeverage(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? rounded : value;
}

interface CachedPos {
  entryPrice: number;
  leverage: number;
  isLong: boolean;
}

interface PosState {
  lastMilestone: number;
  currentSL: number;
  pendingMilestone?: number;
  pendingSince?: number;
}

export class PositionManager {
  private refreshTimer?: NodeJS.Timeout;
  private readonly positions  = new Map<string, CachedPos>(); // live position cache
  private readonly milestones = new Map<string, PosState>();  // milestone state per symbol

  constructor(
    private readonly binance: BinanceClient,
    private readonly ws: BinanceWSManager,
    private readonly settings: SettingsService,
    private readonly audit: AuditLogService
  ) {}

  start(): void {
    // Listen to mark price updates — fires every 1s per subscribed symbol
    this.ws.on("markPrice:update", (ev: MarkPriceEvent) => {
      void this.onMarkPrice(ev.symbol, ev.markPrice);
    });

    // Refresh position list immediately, then every 10s
    void this.refreshPositions();
    this.refreshTimer = setInterval(() => void this.refreshPositions(), POSITION_REFRESH_MS);

    this.audit.info("Position Manager khởi động — WS mark price + milestone SL tự động");
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.ws.removeAllListeners("markPrice:update");
    for (const symbol of this.positions.keys()) {
      this.ws.unsubscribeMarkPrice(symbol);
    }
    this.positions.clear();
    this.milestones.clear();
  }

  // ── Refresh position list via REST ────────────────────────────────────────

  private async refreshPositions(): Promise<void> {
    const cfg = this.settings.get();
    if (cfg.dryRun || cfg.readOnly || this.binance.rateLimitStatus().banned) return;

    let rawList: unknown[];
    try {
      rawList = (await this.binance.getPosition()) as unknown[];
    } catch { return; }

    const freshSymbols = new Set<string>();

    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const p      = raw as Record<string, unknown>;
      const symbol = String(p.symbol ?? "").toUpperCase();
      const amt    = Number(p.positionAmt ?? 0);
      const entry  = Number(p.entryPrice ?? 0);
      const lev    = inferLeverage(p);

      if (!symbol) continue;

      if (Math.abs(amt) < 1e-9 || !entry || !lev) {
        // Position closed — clean up
        if (this.positions.has(symbol)) {
          this.positions.delete(symbol);
          this.milestones.delete(symbol);
          this.ws.unsubscribeMarkPrice(symbol);
        }
        continue;
      }

      freshSymbols.add(symbol);
      this.positions.set(symbol, { entryPrice: entry, leverage: lev, isLong: amt > 0 });

      // Subscribe to mark price WS if not already
      this.ws.subscribeMarkPrice(symbol);

      const mark = Number(p.markPrice ?? 0);
      if (Number.isFinite(mark) && mark > 0) {
        await this.onMarkPrice(symbol, mark);
      }
    }

    // Unsubscribe symbols that disappeared from position list
    for (const sym of this.positions.keys()) {
      if (!freshSymbols.has(sym)) {
        this.positions.delete(sym);
        this.milestones.delete(sym);
        this.ws.unsubscribeMarkPrice(sym);
      }
    }
  }

  // ── React to live mark price ───────────────────────────────────────────────

  private async onMarkPrice(symbol: string, markPrice: number): Promise<void> {
    const cfg = this.settings.get();
    if (cfg.dryRun || cfg.readOnly) return;

    const pos = this.positions.get(symbol);
    if (!pos) return;

    const { entryPrice, leverage, isLong } = pos;
    const rawMovePct = (isLong ? 1 : -1) * (markPrice - entryPrice) / entryPrice * 100;
    const roi = rawMovePct * leverage;
    if (roi <= 0) return;

    // Log every 10% ROI milestone for visibility
    const roiRounded = Math.floor(roi / 10) * 10;
    const stateCheck = this.milestones.get(symbol) ?? { lastMilestone: 0, currentSL: 0 };
    if (roiRounded > 0 && roiRounded >= (stateCheck.lastMilestone + 10)) {
      this.audit.info(`PM 📈 ${symbol} ROI=${roi.toFixed(1)}% | entry=${entryPrice} mark=${markPrice} | SL hiện tại=${stateCheck.currentSL || "chưa dời"}`, { symbol, roi: roi.toFixed(1) });
    }

    const state = this.milestones.get(symbol) ?? { lastMilestone: 0, currentSL: 0 };

    // Find highest milestone that applies. A milestone can require a higher
    // activation ROI than the SL level it protects.
    let applicable: Milestone | undefined;
    for (const m of MILESTONES) {
      if (roi >= (m.activationRoi ?? m.roi)) applicable = m;
    }
    if (!applicable) {
      if (state.pendingMilestone !== undefined) {
        this.milestones.set(symbol, { lastMilestone: state.lastMilestone, currentSL: state.currentSL });
      }
      return;
    }

    if (applicable.roi <= state.lastMilestone) return;

    if (applicable.confirmMs && applicable.confirmMs > 0) {
      const now = Date.now();
      const pendingSince =
        state.pendingMilestone === applicable.roi && state.pendingSince
          ? state.pendingSince
          : now;

      if (state.pendingMilestone !== applicable.roi || !state.pendingSince) {
        this.milestones.set(symbol, {
          ...state,
          pendingMilestone: applicable.roi,
          pendingSince,
        });
        this.audit.info(`PM ▶ Cho xac nhan moc SL: ${symbol} ${applicable.label}`, {
          symbol,
          roi,
          requiredRoi: applicable.activationRoi ?? applicable.roi,
          confirmMs: applicable.confirmMs,
        });
        return;
      }

      if (now - pendingSince < applicable.confirmMs) return;
    }

    const side: TradeSide = isLong ? "SELL" : "BUY";

    if (applicable.trailing) {
      await this.activateTrailing(symbol, side, applicable.trailing.callbackRate, markPrice, applicable.label);
      this.milestones.set(symbol, { lastMilestone: applicable.roi, currentSL: 0 });
    } else {
      const newSL = applicable.newSL(entryPrice, markPrice, isLong, leverage);
      if (newSL === null) return;

      // Only move SL in favorable direction — never pull back
      if (isLong  && newSL <= state.currentSL) return;
      if (!isLong && state.currentSL > 0 && newSL >= state.currentSL) return;

      await this.moveSL(symbol, side, newSL, applicable.label);
      this.milestones.set(symbol, { lastMilestone: applicable.roi, currentSL: newSL });
    }
  }

  // ── SL replacement ────────────────────────────────────────────────────────

  private async moveSL(symbol: string, side: TradeSide, newSL: number, label: string): Promise<void> {
    this.audit.info(`PM ▶ Bắt đầu dời SL [${label}]: ${symbol} → ${newSL}`, { symbol, newSL, label });

    // Step 1: Try to AMEND existing STOP_MARKET order (no cancel needed, no gap in SL protection)
    let amended = false;
    try {
      const openOrders = (await this.binance.getOpenOrders(symbol)) as Array<Record<string, unknown>>;
      for (const o of openOrders) {
        const type = String(o.type ?? o.orderType ?? "");
        if (type !== "STOP_MARKET" && type !== "STOP") continue;
        const oid = o.orderId ?? o.algoId;
        if (oid === undefined) continue;

        try {
          await this.binance.amendStopOrder(symbol, oid as string | number, newSL);
          amended = true;
          this.audit.info(`PM ✓ Amend SL thành công [${label}]: ${symbol} orderId=${oid} → ${newSL}`, { symbol, newSL, orderId: oid });
          break;
        } catch (amendErr) {
          // Amend failed (e.g. algo orders can't be amended) → fall through to cancel+replace
          this.audit.info(`PM: Amend thất bại (${amendErr instanceof Error ? amendErr.message : amendErr}), thử cancel+replace`, { symbol });
        }
      }
    } catch (fetchErr) {
      this.audit.warn(`PM: Không lấy được open orders để amend`, { symbol, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
    }

    if (amended) {
      appEvents.publish("position.update", { symbol, action: "sl_moved", label, newSL });
      return;
    }

    // Step 2: Fallback — cancel existing SL (algo + regular) then place new one
    this.audit.info(`PM: Fallback cancel+replace cho ${symbol}`, { symbol });
    try {
      await this.cancelAlgoSLOrders(symbol);

      try {
        const openOrders = (await this.binance.getOpenOrders(symbol)) as Array<Record<string, unknown>>;
        for (const o of openOrders) {
          const type = String(o.type ?? o.orderType ?? "");
          if (type !== "STOP_MARKET" && type !== "STOP") continue;
          const oid = o.orderId ?? o.algoId;
          if (oid === undefined) continue;
          try { await this.binance.cancelOrder(symbol, oid as string | number); }
          catch { try { await this.binance.cancelAlgoOrder({ algoId: oid as string | number }); } catch { /* filled */ } }
        }
      } catch { /* proceed */ }

      await this.binance.createStopMarketOrder(symbol, side, newSL, `pm-sl-${Date.now()}`);
      this.audit.info(`PM ✓ Cancel+replace SL thành công [${label}]: ${symbol} → ${newSL}`, { symbol, newSL, label });
      appEvents.publish("position.update", { symbol, action: "sl_moved", label, newSL });
    } catch (e) {
      this.audit.warn(`PM ✗ Dời SL thất bại hoàn toàn: ${symbol}`, {
        symbol, newSL, label, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async activateTrailing(symbol: string, side: TradeSide, callbackRate: number, activationPrice: number, label: string): Promise<void> {
    try {
      await this.cancelAlgoSLOrders(symbol);

      // Also cancel any existing TRAILING_STOP_MARKET regular orders
      const openOrders = (await this.binance.getOpenOrders(symbol)) as unknown[];
      for (const raw of openOrders) {
        if (!raw || typeof raw !== "object") continue;
        const o = raw as Record<string, unknown>;
        if (String(o.type ?? "") === "TRAILING_STOP_MARKET") {
          try { await this.binance.cancelOrder(symbol, o.orderId as string | number); } catch { /* ignore */ }
        }
      }

      const capped = Math.min(callbackRate, MAX_TRAILING_CALLBACK);
      await this.binance.createTrailingStopOrder(symbol, side, capped, activationPrice);

      this.audit.info(
        `PM ▶ Bật trailing stop [${label}]: ${symbol} callback ${capped}% từ ${activationPrice}`,
        { symbol, callbackRate: capped, activationPrice, label },
      );
      appEvents.publish("position.update", { symbol, action: "trailing_activated", callbackRate: capped, activationPrice });
    } catch (e) {
      this.audit.warn(`PM ✗ Trailing stop thất bại: ${symbol}`, {
        symbol, label, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Cancel all STOP_MARKET algo SL orders for a symbol (leaves TP intact)
  private async cancelAlgoSLOrders(symbol: string): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.binance.getOpenAlgoOrders(symbol);
    } catch { return; }

    // Binance returns { algoOrders: [...] } OR a direct array — handle both.
    // Also handles legacy key "orders" just in case.
    const r = raw as Record<string, unknown>;
    const orders: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray(r.algoOrders) ? (r.algoOrders as unknown[])
      : Array.isArray(r.orders)     ? (r.orders     as unknown[])
      : [];

    for (const item of orders) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      // Binance algo API returns field "orderType", not "type"
      const type = String(o.type ?? o.orderType ?? "");
      if (type !== "STOP_MARKET" && type !== "STOP") continue;
      const algoId = o.algoId ?? o.orderId;
      if (algoId === undefined) continue;
      this.audit.info(`PM: Hủy algo SL ${symbol} algoId=${algoId} type=${type}`);
      try {
        await this.binance.cancelAlgoOrder({ algoId: algoId as string | number });
      } catch (e) {
        this.audit.warn(`PM: Hủy algo SL thất bại`, { symbol, algoId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
