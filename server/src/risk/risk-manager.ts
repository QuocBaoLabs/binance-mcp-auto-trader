import { hasCredentials, staticConfig } from "../config.js";
import { BinanceClient } from "../binance/client.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { AuditLogService } from "../services/audit-log.js";
import { SettingsService } from "../services/settings.js";
import type {
  BinanceOrderRequest,
  ProtectedTradeRequest,
  RiskCheckResult
} from "../types.js";
import { normalizeUsdFuturesSymbol } from "../symbols.js";

const MIN_REWARD_TO_RISK = 1;
const MIN_BINANCE_NOTIONAL_USDT = 5;
const MAX_ISOLATED_SL_LOSS_OF_MARGIN_PCT = 35;
const MAX_CROSSED_SL_LOSS_OF_MARGIN_PCT = 25;
const LIQUIDATION_DANGER_LOSS_PCT = 85;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function numericField(row: unknown, key: string): number {
  if (!row || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)[key];
  return Number(value ?? 0);
}

export class RiskManager {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly binance: BinanceClient,
    private readonly db: AppDatabase,
    private readonly audit: AuditLogService
  ) {}

  async assertProtectedTrade(request: ProtectedTradeRequest): Promise<void> {
    const result = await this.validateProtectedTrade(request);
    if (!result.ok) {
      appEvents.publish("risk.blocked", {
        symbol: request.symbol,
        source: request.source,
        reasons: result.reasons
      });
      this.audit.warn("Giao dịch bị risk manager chặn", {
        symbol: request.symbol,
        source: request.source,
        reasons: result.reasons
      });
      throw new Error(`Kiểm tra rủi ro thất bại: ${result.reasons.join("; ")}`);
    }
  }

  async validateProtectedTrade(
    request: ProtectedTradeRequest
  ): Promise<RiskCheckResult> {
    const settings = this.settingsService.get();
    const symbol = normalizeUsdFuturesSymbol(request.symbol);
    const reasons: string[] = [];

    this.baseTradingChecks(symbol, reasons, request.source !== "dashboard");

    if (request.quantity <= 0) reasons.push("khối lượng phải lớn hơn 0");
    if (request.entryPrice <= 0) reasons.push("giá vào lệnh phải lớn hơn 0");
    if (request.stopLossPrice <= 0) {
      reasons.push("bắt buộc có stop loss và giá stop loss phải lớn hơn 0");
    }
    if (request.takeProfitPrice <= 0) {
      reasons.push("bắt buộc có take profit và giá take profit phải lớn hơn 0");
    }
    if (request.leverage > settings.maxLeverage) {
      reasons.push(
        `đòn bẩy ${request.leverage} vượt MAX_LEVERAGE ${settings.maxLeverage}`
      );
    }

    if (request.leverage < settings.minLeverage) {
      reasons.push(
        `đòn bẩy ${request.leverage} thấp hơn MIN_LEVERAGE ${settings.minLeverage}`
      );
    }
    if (request.entryType === "MARKET" && !settings.allowMarketOrder) {
      reasons.push("lệnh market bị chặn vì ALLOW_MARKET_ORDER=false");
    }

    const notional = request.quantity * request.entryPrice;
    const initialMargin = notional / Math.max(1, request.leverage);
    this.enforceProtectedTradeShape(request, reasons);
    if (notional < MIN_BINANCE_NOTIONAL_USDT) {
      reasons.push(
        `notional lệnh ${notional.toFixed(2)} USDT nhỏ hơn mức tối thiểu Binance ${MIN_BINANCE_NOTIONAL_USDT} USDT; tăng ký quỹ hoặc đòn bẩy`
      );
    }
    if (request.source !== "dashboard" && initialMargin > settings.maxOrderUsdt) {
      reasons.push(
        `ký quỹ lệnh ${initialMargin.toFixed(2)} USDT vượt MAX_ORDER_USDT ${
          settings.maxOrderUsdt
        }`
      );
    }

    if (request.side === "BUY") {
      if (!(request.stopLossPrice < request.entryPrice)) {
        reasons.push("stop loss của lệnh long phải thấp hơn giá vào");
      }
      if (!(request.takeProfitPrice > request.entryPrice)) {
        reasons.push("take profit của lệnh long phải cao hơn giá vào");
      }
    } else {
      if (!(request.stopLossPrice > request.entryPrice)) {
        reasons.push("stop loss của lệnh short phải cao hơn giá vào");
      }
      if (!(request.takeProfitPrice < request.entryPrice)) {
        reasons.push("take profit của lệnh short phải thấp hơn giá vào");
      }
    }

    if (!settings.dryRun && !hasCredentials()) {
      reasons.push("cần cấu hình Binance API key/secret khi DRY_RUN=false");
    }
    if (!settings.dryRun && !settings.binanceTestnet && !staticConfig.enableLiveTrading) {
      reasons.push("ENABLE_LIVE_TRADING=false, không cho phép gửi lệnh live");
    }

    await this.enforceDailyLoss(reasons);
    await this.enforcePositionLimits(symbol, reasons);

    return { ok: reasons.length === 0, reasons };
  }

  private enforceProtectedTradeShape(
    request: ProtectedTradeRequest,
    reasons: string[]
  ): void {
    const entry = request.entryPrice;
    const sl = request.stopLossPrice;
    const tp = request.takeProfitPrice;
    const leverage = Math.max(1, request.leverage);

    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(sl) ||
      !Number.isFinite(tp) ||
      entry <= 0 ||
      sl <= 0 ||
      tp <= 0 ||
      request.quantity <= 0
    ) {
      return;
    }

    const slDistance = Math.abs(entry - sl);
    const tpDistance = Math.abs(tp - entry);
    if (slDistance <= 0 || tpDistance <= 0) return;

    const riskReward = tpDistance / slDistance;
    const slMovePct = (slDistance / entry) * 100;
    const tpMovePct = (tpDistance / entry) * 100;
    const slLossOfMarginPct = slMovePct * leverage;
    const tpGainOfMarginPct = tpMovePct * leverage;
    const lossUsdtAtSl = request.quantity * slDistance;
    const profitUsdtAtTp = request.quantity * tpDistance;
    const marginType = request.marginType ?? "CROSSED";
    const maxSlLossOfMarginPct = marginType === "ISOLATED"
      ? MAX_ISOLATED_SL_LOSS_OF_MARGIN_PCT
      : MAX_CROSSED_SL_LOSS_OF_MARGIN_PCT;

    if (!request.skipRewardRiskCheck && riskReward < MIN_REWARD_TO_RISK) {
      reasons.push(
        `SL xa hơn TP: hit SL lỗ khoảng ${lossUsdtAtSl.toFixed(2)} USDT (${slLossOfMarginPct.toFixed(1)}% ký quỹ), TP chỉ lời khoảng ${profitUsdtAtTp.toFixed(2)} USDT (${tpGainOfMarginPct.toFixed(1)}% ký quỹ), RR ${riskReward.toFixed(2)} < ${MIN_REWARD_TO_RISK}`
      );
    }

    if (slLossOfMarginPct > maxSlLossOfMarginPct) {
      reasons.push(
        `SL quá xa cho ${marginType}: hit SL có thể mất ${slLossOfMarginPct.toFixed(1)}% ký quỹ lệnh, vượt giới hạn ${maxSlLossOfMarginPct}%`
      );
    }

    if (slLossOfMarginPct >= LIQUIDATION_DANGER_LOSS_PCT) {
      reasons.push(
        `SL gần/vượt vùng thanh lý ước tính: khoảng cách SL ${slMovePct.toFixed(2)}% × ${leverage}x = ${slLossOfMarginPct.toFixed(1)}% ký quỹ`
      );
    }

    if (!request.skipRewardRiskCheck && marginType === "CROSSED" && slLossOfMarginPct > tpGainOfMarginPct) {
      reasons.push("CROSS bị chặn vì SL lớn hơn TP; nếu giá chạy mạnh có thể ăn sang số dư ví cross");
    }
  }

  assertTradingToolOrder(order: BinanceOrderRequest): void {
    const reasons: string[] = [];
    this.baseTradingChecks(order.symbol, reasons);
    const settings = this.settingsService.get();

    if (order.type === "MARKET" && !settings.allowMarketOrder) {
      reasons.push("lệnh market bị chặn vì ALLOW_MARKET_ORDER=false");
    }
    if (!settings.dryRun && !hasCredentials()) {
      reasons.push("cần cấu hình Binance API key/secret khi DRY_RUN=false");
    }
    if (!settings.dryRun && !settings.binanceTestnet && !staticConfig.enableLiveTrading) {
      reasons.push("ENABLE_LIVE_TRADING=false, không cho phép gửi lệnh live");
    }

    if (reasons.length > 0) {
      appEvents.publish("risk.blocked", { symbol: order.symbol, reasons });
      this.audit.warn("Lệnh bị risk manager chặn", {
        symbol: order.symbol,
        type: order.type,
        reasons
      });
      throw new Error(`Kiểm tra rủi ro thất bại: ${reasons.join("; ")}`);
    }
  }

  assertReduceOnlyAction(symbol: string, usesMarketOrder = false): void {
    const settings = this.settingsService.get();
    const reasons: string[] = [];
    const normalized = normalizeUsdFuturesSymbol(symbol);
    if (settings.readOnly) reasons.push("READ_ONLY=true");
    if (!settings.allowedSymbols.includes(normalized)) {
      reasons.push(`${normalized} không nằm trong ALLOWED_SYMBOLS`);
    }
    void usesMarketOrder;
    if (!settings.dryRun && !hasCredentials()) {
      reasons.push("cần cấu hình Binance API key/secret khi DRY_RUN=false");
    }
    if (reasons.length > 0) {
      appEvents.publish("risk.blocked", { symbol, reasons });
      this.audit.warn("Hành động giảm vị thế bị risk manager chặn", {
        symbol,
        reasons
      });
      throw new Error(`Kiểm tra rủi ro thất bại: ${reasons.join("; ")}`);
    }
  }

  private baseTradingChecks(
    symbol: string,
    reasons: string[],
    requireAutoTrade = true
  ): void {
    const settings = this.settingsService.get();
    const normalized = normalizeUsdFuturesSymbol(symbol);
    if (settings.readOnly) reasons.push("READ_ONLY=true");
    if (requireAutoTrade && !settings.autoTradeEnabled) {
      reasons.push("AUTO_TRADE_ENABLED=false");
    }
    if (!settings.allowedSymbols.includes(normalized)) {
      reasons.push(`${normalized} không nằm trong ALLOWED_SYMBOLS`);
    }
  }

  private async enforceDailyLoss(reasons: string[]): Promise<void> {
    const settings = this.settingsService.get();
    const risk = this.db.getTodayRisk(todayKey());
    const realizedLoss = Math.max(0, -Number(risk.realized_pnl_usdt));
    let unrealizedLoss = 0;

    if (!settings.dryRun && hasCredentials()) {
      try {
        const account = (await this.binance.getAccount()) as Record<string, unknown>;
        unrealizedLoss = Math.max(0, -Number(account.totalUnrealizedProfit ?? 0));
      } catch (error) {
        this.audit.warn("Không thể đọc PnL tài khoản để kiểm tra lỗ trong ngày", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const effectiveLoss = Math.max(realizedLoss, unrealizedLoss);
    if (risk.tripped || effectiveLoss >= settings.maxDailyLossUsdt) {
      reasons.push(
        `lỗ trong ngày ${effectiveLoss.toFixed(2)} USDT đã chạm MAX_DAILY_LOSS_USDT ${
          settings.maxDailyLossUsdt
        }`
      );
    }
  }

  private async enforcePositionLimits(
    symbol: string,
    reasons: string[]
  ): Promise<void> {
    const settings = this.settingsService.get();
    if (settings.dryRun || !hasCredentials()) return;

    try {
      const positions = (await this.binance.getPosition()) as unknown[];
      const active = positions.filter(
        (position) => Math.abs(numericField(position, "positionAmt")) > 0
      );
      if (
        active.some(
          (position) =>
            String((position as Record<string, unknown>).symbol).toUpperCase() ===
            symbol
        )
      ) {
        reasons.push(`đã có vị thế mở trên ${symbol}, không mở trùng symbol`);
      }
      if (active.length >= settings.maxOpenPositions) {
        reasons.push(
          `số vị thế mở ${active.length} đã chạm MAX_OPEN_POSITIONS ${settings.maxOpenPositions}`
        );
      }
    } catch (error) {
      this.audit.warn("Bỏ qua kiểm tra vị thế đang mở vì Binance từ chối positionRisk", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
