import type { BinanceClient } from "../binance/client.js";
import { appEvents } from "../events.js";
import type { OrderExecutor } from "../orders/order-executor.js";
import type { AuditLogService } from "../services/audit-log.js";
import type { SettingsService } from "../services/settings.js";

const PRICE_CLOSE_THRESHOLD_PCT = 0.8;   // fallback khi không có marginRatio
const PRICE_WARN_THRESHOLD_PCT  = 2.0;
// Đóng ngay khi marginRatio >= 75% (25% buffer còn lại trước liq)
// Ghi cảnh báo sớm từ 60% để có thời gian phản ứng
const MARGIN_RATIO_CRITICAL_PCT = 85;   // cực kỳ nguy hiểm — cooldown 5s
const MARGIN_RATIO_CLOSE_PCT    = 75;   // nguy hiểm — cooldown 15s (từ 90)
const MARGIN_RATIO_WARN_PCT     = 60;   // cảnh báo sớm — chỉ log (từ 70)
const CHECK_INTERVAL_ACTIVE_MS  = 5_000;
const CHECK_INTERVAL_IDLE_MS    = 30_000;
const CLOSE_RETRY_COOLDOWN_CRITICAL_MS = 5_000;   // critical: retry sau 5s
const CLOSE_RETRY_COOLDOWN_MS          = 15_000;  // normal:   retry sau 15s (từ 60s)

function numberField(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function marginRatioPct(position: Record<string, unknown>): number | null {
  const maintMargin = numberField(position, "maintMargin");
  const unrealizedProfit = numberField(position, "unRealizedProfit");
  const isolatedWallet = numberField(position, "isolatedWallet");
  const isolatedMargin = numberField(position, "isolatedMargin");
  const initialMargin = numberField(position, "initialMargin");
  const positionInitialMargin = numberField(position, "positionInitialMargin");

  const marginBalance =
    (isolatedWallet > 0 ? isolatedWallet + unrealizedProfit : 0) ||
    (isolatedMargin > 0 ? isolatedMargin : 0) ||
    (initialMargin > 0 ? initialMargin + unrealizedProfit : 0) ||
    (positionInitialMargin > 0 ? positionInitialMargin + unrealizedProfit : 0);

  if (maintMargin <= 0 || marginBalance <= 0) return null;
  return (maintMargin / marginBalance) * 100;
}

export class LiquidationGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWarnAt: Map<string, number> = new Map();
  private lastCloseAttemptAt: Map<string, number> = new Map();
  private hasOpenPositions = false; // adaptive polling state

  constructor(
    private readonly binance: BinanceClient,
    private readonly executor: OrderExecutor,
    private readonly settings: SettingsService,
    private readonly audit: AuditLogService
  ) {}

  start(): void {
    if (this.timer) return;
    this.scheduleNext();
    this.audit.info("LiquidationGuard da khoi dong (adaptive interval)");
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    const intervalMs = this.hasOpenPositions ? CHECK_INTERVAL_ACTIVE_MS : CHECK_INTERVAL_IDLE_MS;
    this.timer = setTimeout(() => void this.check(), intervalMs);
  }

  private async check(): Promise<void> {
    const settings = this.settings.get();
    if (settings.dryRun || settings.readOnly || this.binance.rateLimitStatus().banned) {
      this.scheduleNext();
      return;
    }

    let positions: Array<Record<string, unknown>>;
    try {
      positions = (await this.binance.getPosition()) as Array<Record<string, unknown>>;
    } catch {
      this.scheduleNext();
      return;
    }

    for (const pos of positions) {
      const amt = numberField(pos, "positionAmt");
      if (Math.abs(amt) < 1e-9) continue;

      const symbol = String(pos.symbol ?? "");
      const markPrice = numberField(pos, "markPrice");
      const liqPrice = numberField(pos, "liquidationPrice");

      if (!symbol || markPrice <= 0 || liqPrice <= 0) continue;

      const isLong = amt > 0;
      const distancePct = isLong
        ? ((markPrice - liqPrice) / markPrice) * 100
        : ((liqPrice - markPrice) / markPrice) * 100;
      const marginRatio = marginRatioPct(pos);

      // Binance returns maintMargin/margin data for live futures positions.
      // Prefer margin ratio because high-leverage isolated positions naturally
      // sit close to liquidation in price-percent terms even when they are not
      // actually close to liquidation.
      const isCritical = marginRatio !== null
        ? marginRatio >= MARGIN_RATIO_CRITICAL_PCT
        : distancePct <= PRICE_CLOSE_THRESHOLD_PCT * 0.6;

      const shouldClose = marginRatio !== null
        ? marginRatio >= MARGIN_RATIO_CLOSE_PCT
        : distancePct <= PRICE_CLOSE_THRESHOLD_PCT;

      const shouldWarn = marginRatio !== null
        ? marginRatio >= MARGIN_RATIO_WARN_PCT
        : distancePct <= PRICE_WARN_THRESHOLD_PCT;

      if (shouldClose) {
        // Cooldown ngắn hơn khi cực kỳ nguy hiểm — cần retry nhanh
        const cooldownMs = isCritical ? CLOSE_RETRY_COOLDOWN_CRITICAL_MS : CLOSE_RETRY_COOLDOWN_MS;
        const lastClose = this.lastCloseAttemptAt.get(symbol) ?? 0;
        if (Date.now() - lastClose < cooldownMs) continue;
        this.lastCloseAttemptAt.set(symbol, Date.now());

        this.audit.error("LiquidationGuard: đóng khẩn cấp vị thế sắp thanh lý", {
          symbol, markPrice, liqPrice, positionAmt: amt,
          distancePct, marginRatio, critical: isCritical
        });

        try {
          await this.executor.closePosition(symbol, "liquidation-guard");
          this.audit.info("LiquidationGuard: đã đóng vị thế thành công", {
            symbol, distancePct, marginRatio
          });
          appEvents.publish("liquidation.warning", {
            symbol, markPrice, liqPrice, distancePct, marginRatio,
            action: "auto_closed"
          });
        } catch (error) {
          this.audit.error("LiquidationGuard: không đóng được vị thế", {
            symbol, distancePct, marginRatio,
            error: error instanceof Error ? error.message : String(error)
          });
          appEvents.publish("liquidation.warning", {
            symbol, markPrice, liqPrice, distancePct, marginRatio,
            action: "close_failed"
          });
        }
        continue;
      }

      if (shouldWarn) {
        const lastWarn = this.lastWarnAt.get(symbol) ?? 0;
        if (Date.now() - lastWarn < 120_000) continue; // cảnh báo sớm: mỗi 2 phút
        this.lastWarnAt.set(symbol, Date.now());

        this.audit.warn("LiquidationGuard: cảnh báo sớm margin đang giảm", {
          symbol, markPrice, liqPrice, positionAmt: amt,
          distancePct, marginRatio
        });
        appEvents.publish("liquidation.warning", {
          symbol, markPrice, liqPrice, distancePct, marginRatio,
          action: "warned"
        });
      }
    }

    // Update adaptive interval: poll fast only when positions are open
    const openCount = positions.filter(p => Math.abs(Number(p.positionAmt ?? 0)) > 1e-9).length;
    this.hasOpenPositions = openCount > 0;
    this.scheduleNext();
  }
}
