import { BinanceClient } from "../binance/client.js";
import { AppDatabase } from "../db/database.js";
import { appEvents } from "../events.js";
import { AuditLogService } from "../services/audit-log.js";
import { SettingsService } from "../services/settings.js";
import type {
  BinanceOrderRequest,
  ProtectedTradeRequest,
  TradeSide
} from "../types.js";
import { RiskManager } from "../risk/risk-manager.js";
import { normalizeUsdFuturesSymbol } from "../symbols.js";

function decimal(value: number, precision = 6): string {
  return Number(value.toFixed(precision)).toString();
}

function orderIdFrom(result: unknown): string | number | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = result as Record<string, unknown>;
  return (row.orderId ?? row.algoId) as string | number | undefined;
}

function clientOrderIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = result as Record<string, unknown>;
  return (row.clientOrderId ?? row.clientAlgoId) as string | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LIMIT_ENTRY_FILL_TIMEOUT_MS = 60_000;
const LIMIT_ENTRY_POLL_MS = 2_000;
const PROTECTIVE_TRIGGER_BUFFER_PCT = 0.0005;
const BALANCE_BUFFER_MULTIPLIER = 1.08;
const BALANCE_BUFFER_LABEL = "8%";

export class OrderExecutor {
  private readonly pendingProtectionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly binance: BinanceClient,
    private readonly db: AppDatabase,
    private readonly risk: RiskManager,
    private readonly audit: AuditLogService
  ) {}

  async executeProtectedTrade(request: ProtectedTradeRequest): Promise<unknown> {
    await this.risk.assertProtectedTrade(request);
    const settings = this.settingsService.get();
    const symbol = normalizeUsdFuturesSymbol(request.symbol);
    const oppositeSide: TradeSide = request.side === "BUY" ? "SELL" : "BUY";
    const entryType = request.entryType ?? "LIMIT";

    const entryOrder: BinanceOrderRequest = {
      symbol,
      side: request.side,
      type: entryType,
      quantity: decimal(request.quantity),
      newClientOrderId: `mcp-entry-${Date.now()}`
    };
    if (entryType === "LIMIT") {
      entryOrder.price = decimal(request.entryPrice);
      entryOrder.timeInForce = request.postOnly ? "GTX" : "GTC";
    }
    const stopLossOrder: BinanceOrderRequest = {
      symbol,
      side: oppositeSide,
      type: "STOP_MARKET",
      stopPrice: decimal(request.stopLossPrice),
      closePosition: true,
      newClientOrderId: `mcp-sl-${Date.now()}`
    };

    // Trailing stop: gòng lệnh theo trend, không chốt lời sớm
    const useTrailing = request.useTrailingStop === true && !settings.dryRun;
    const callbackRate = Math.min(5, Math.max(0.1, request.trailingCallbackRate ?? 1.5));
    const takeProfitOrder: BinanceOrderRequest = useTrailing
      ? {
          symbol,
          side: oppositeSide,
          type: "TRAILING_STOP_MARKET",
          quantity: decimal(request.quantity),
          callbackRate: callbackRate.toFixed(1),
          // activationPrice: chỉ set khi > 0 để tránh lỗi Binance
          ...(request.trailingActivationPrice && request.trailingActivationPrice > 0
            ? { activationPrice: decimal(request.trailingActivationPrice) }
            : {}),
          reduceOnly: true,
          workingType: "MARK_PRICE",
          newClientOrderId: `mcp-trail-${Date.now()}`
        }
      : {
          symbol,
          side: oppositeSide,
          type: "TAKE_PROFIT_MARKET",
          stopPrice: decimal(request.takeProfitPrice),
          closePosition: true,
          newClientOrderId: `mcp-tp-${Date.now()}`
        };

    this.audit.info("Đang thực thi giao dịch có bảo vệ", {
      symbol,
      side: request.side,
      source: request.source,
      dryRun: settings.dryRun,
      marginType: request.marginType ?? "CROSSED",
      notional: request.quantity * request.entryPrice,
      exitMode: useTrailing
        ? `trailing ${callbackRate}%` + (request.trailingActivationPrice ? ` act@${decimal(request.trailingActivationPrice)}` : "")
        : `fixed TP@${decimal(request.takeProfitPrice)}`
    });

    if (settings.dryRun) {
      const dryRunResults = [entryOrder, stopLossOrder, takeProfitOrder].map(
        (order) => this.recordDryRunOrder(order, request.source)
      );
      return { dryRun: true, orders: dryRunResults };
    }

    let entryResult: unknown;
    try {
      await this.assertPositionReadable(symbol);
      await this.ensureMarginMode(symbol, request.marginType ?? "CROSSED");

      // Guard: check available balance before placing order to avoid -2019
      try {
        const bal = await this.binance.getBalance() as Array<Record<string, string>>;
        const usdt = Array.isArray(bal) ? bal.find(a => a.asset === "USDT") : undefined;
        const available = usdt ? parseFloat(usdt.availableBalance ?? "0") : 0;
        const initialMargin = request.quantity * request.entryPrice / Math.max(1, request.leverage);
        // Headroom for taker fee, maintenance margin, precision rounding and algo-order margin locks.
        const needed = initialMargin * BALANCE_BUFFER_MULTIPLIER;
        if (available < needed) {
          throw new Error(
            `Số dư khả dụng ${available.toFixed(2)} USDT không đủ cho lệnh ${initialMargin.toFixed(2)} USDT (cần ${needed.toFixed(2)} USDT với buffer phí ${BALANCE_BUFFER_LABEL})`
          );
        }
      } catch (e) {
        if ((e as Error).message.includes("không đủ")) throw e;
        // Ignore balance check errors (will let Binance reject if truly insufficient)
      }

      // Cap leverage to Binance's max allowed for this symbol.
      const maxLev = await this.binance.getMaxLeverage(symbol).catch(() => request.leverage);
      const actualLeverage = Math.min(request.leverage, maxLev);
      if (actualLeverage < request.leverage) {
        this.audit.info(`Leverage capped: ${symbol} max=${maxLev}x, dùng ${actualLeverage}x`, { symbol });
      }
      await this.binance.changeLeverage(symbol, actualLeverage);
      if (entryType === "MARKET") {
        await this.assertProtectiveTriggersSafe(
          symbol,
          stopLossOrder,
          takeProfitOrder
        );
      }
      entryResult = await this.placeOrder(entryOrder, request.source);

      const positionAmount = await this.waitForOpenPosition(
        symbol,
        request.side,
        entryType === "MARKET" ? 10_000 : 1_500
      );

      if (positionAmount === null) {
        if (entryType === "LIMIT") {
          this.scheduleProtectiveOrdersAfterFill({
            key: entryOrder.newClientOrderId ?? `entry-${Date.now()}`,
            entryOrderId: orderIdFrom(entryResult),
            symbol,
            side: request.side,
            source: request.source,
            stopLossOrder,
            takeProfitOrder,
            onFilled: request.onEntryFilled,
            onExpired: request.onEntryExpired
          });
          this.audit.warn("Lệnh Limit chưa khớp; TP/SL sẽ gửi sau khi vị thế mở", {
            symbol,
            entryClientOrderId: entryOrder.newClientOrderId,
            stopLossPrice: request.stopLossPrice,
            takeProfitPrice: request.takeProfitPrice
          });
          return {
            entry: entryResult,
            stopLoss: { status: "PENDING_POSITION", order: stopLossOrder },
            takeProfit: { status: "PENDING_POSITION", order: takeProfitOrder }
          };
        }

        throw new Error(
          "Không xác nhận được vị thế sau lệnh Market, bot không gửi TP/SL để tránh lỗi Binance -4509"
        );
      }

      // Kiểm tra liqPrice không nằm trong vùng SL trước khi đặt TP/SL
      // Nếu nguy hiểm: đóng ngay, không đặt TP/SL, ném lỗi
      await this.assertLiqPriceSaferThanSL(
        symbol,
        request.side,
        request.stopLossPrice,
        stopLossOrder,
        takeProfitOrder,
        entryResult
      );

      const { stopLoss: stopResult, takeProfit: takeProfitResult } =
        await this.placeProtectiveOrders(
          stopLossOrder,
          takeProfitOrder,
          request.source
        );
      this.audit.info("Đã xác nhận vị thế và gửi TP/SL", {
        symbol,
        positionAmount,
        stopLossPrice: request.stopLossPrice,
        takeProfitPrice: request.takeProfitPrice
      });
      return { entry: entryResult, stopLoss: stopResult, takeProfit: takeProfitResult };
    } catch (error) {
      this.audit.error("Giao dịch có bảo vệ thất bại; đang dọn dẹp lệnh/vị thế", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
      if (entryResult !== undefined) {
        await this.cleanupFailedProtectedTrade(symbol, entryResult, [
          stopLossOrder,
          takeProfitOrder
        ]);
      }
      throw error;
    }
  }

  async createStopLossOrder(
    symbol: string,
    side: TradeSide,
    stopPrice: number
  ): Promise<unknown> {
    const order: BinanceOrderRequest = {
      symbol: normalizeUsdFuturesSymbol(symbol),
      side,
      type: "STOP_MARKET",
      stopPrice: decimal(stopPrice),
      closePosition: true
    };
    this.risk.assertTradingToolOrder(order);
    await this.assertOpenPositionForProtectiveOrder(order.symbol, order.side);
    return this.placeOrDryRun(order, "mcp");
  }

  async createTakeProfitOrder(
    symbol: string,
    side: TradeSide,
    takeProfitPrice: number
  ): Promise<unknown> {
    const order: BinanceOrderRequest = {
      symbol: normalizeUsdFuturesSymbol(symbol),
      side,
      type: "TAKE_PROFIT_MARKET",
      stopPrice: decimal(takeProfitPrice),
      closePosition: true
    };
    this.risk.assertTradingToolOrder(order);
    await this.assertOpenPositionForProtectiveOrder(order.symbol, order.side);
    return this.placeOrDryRun(order, "mcp");
  }

  async cancelOrder(symbol: string, orderId: string | number): Promise<unknown> {
    const normalized = normalizeUsdFuturesSymbol(symbol);
    this.risk.assertReduceOnlyAction(normalized);
    const settings = this.settingsService.get();
    if (settings.dryRun) {
      this.audit.info("Mô phỏng hủy lệnh", { symbol, orderId });
      return { dryRun: true, symbol: normalized, orderId, status: "CANCELED" };
    }
    const result = await this.binance.cancelOrder(normalized, orderId);
    this.audit.info("Đã hủy lệnh", { symbol, orderId });
    return result;
  }

  async closePosition(symbol: string, source = "dashboard"): Promise<unknown> {
    const normalized = normalizeUsdFuturesSymbol(symbol);
    this.risk.assertReduceOnlyAction(normalized, true);
    const settings = this.settingsService.get();

    if (settings.dryRun) {
      const order: BinanceOrderRequest = {
        symbol: normalized,
        side: "SELL",
        type: "MARKET",
        reduceOnly: true,
        quantity: "0"
      };
      return this.recordDryRunOrder(order, source);
    }

    const positions = (await this.binance.getPosition(normalized)) as unknown[];
    const position = positions.find(
      (item) =>
        Math.abs(Number((item as Record<string, unknown>).positionAmt ?? 0)) > 0
    );

    if (!position) {
      this.audit.info("Không có vị thế mở để đóng", { symbol: normalized });
      const cleanup = await this.cancelAllOpenOrders(normalized);
      return { symbol: normalized, status: "NO_POSITION", cleanup };
    }

    const amount = Number((position as Record<string, unknown>).positionAmt);
    const closeOrder: BinanceOrderRequest = {
      symbol: normalized,
      side: amount > 0 ? "SELL" : "BUY",
      type: "MARKET",
      quantity: decimal(Math.abs(amount)),
      reduceOnly: true
    };
    const closeResult = await this.placeOrder(closeOrder, source);
    let cleanup: unknown = null;
    try {
      cleanup = await this.cancelAllOpenOrders(normalized);
    } catch (error) {
      this.audit.warn("Khong the huy lenh bao ve sau khi dong vi the", {
        symbol: normalized,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { closeResult, cleanup };
  }

  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    const normalized = normalizeUsdFuturesSymbol(symbol);
    this.risk.assertReduceOnlyAction(normalized);
    const settings = this.settingsService.get();
    if (settings.dryRun) {
      this.audit.info("Mô phỏng hủy toàn bộ lệnh chờ", { symbol });
      return { dryRun: true, symbol: normalized, code: 200 };
    }
    const result = await this.binance.cancelAllOpenOrders(normalized);
    let algoResult: unknown = null;
    try {
      algoResult = await this.binance.cancelAllOpenAlgoOrders(normalized);
    } catch (error) {
      this.audit.error("Không thể hủy toàn bộ lệnh algo TP/SL", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    this.audit.warn("Đã hủy toàn bộ lệnh chờ", { symbol });
    return { orders: result, algoOrders: algoResult };
  }

  private async placeOrDryRun(
    order: BinanceOrderRequest,
    source: string
  ): Promise<unknown> {
    const settings = this.settingsService.get();
    if (settings.dryRun) return this.recordDryRunOrder(order, source);
    return this.placeOrder(order, source);
  }

  private async placeOrder(
    order: BinanceOrderRequest,
    source: string
  ): Promise<unknown> {
    const result = await this.binance.createOrder(order);
    this.db.insertOrder({
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
      status: "SUBMITTED",
      binanceOrderId: orderIdFrom(result),
      clientOrderId: clientOrderIdFrom(result),
      dryRun: false,
      source,
      payload: result
    });
    appEvents.publish("order.created", {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      stopPrice: order.stopPrice,
      quantity: order.quantity,
      reduceOnly: order.reduceOnly,
      closePosition: order.closePosition,
      source
    });
    this.audit.info("Đã gửi lệnh", {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      source
    });
    return result;
  }

  private recordDryRunOrder(order: BinanceOrderRequest, source: string): unknown {
    const payload = {
      dryRun: true,
      orderId: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...order,
      source,
      status: "SIMULATED"
    };
    this.db.insertOrder({
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
      status: "SIMULATED",
      binanceOrderId: payload.orderId,
      clientOrderId: order.newClientOrderId,
      dryRun: true,
      source,
      payload
    });
    appEvents.publish("order.created", payload);
    this.audit.info("Đã mô phỏng lệnh dry-run", {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      source
    });
    return payload;
  }

  private async placeProtectiveOrders(
    stopLossOrder: BinanceOrderRequest,
    takeProfitOrder: BinanceOrderRequest,
    source: string
  ): Promise<{ stopLoss: unknown; takeProfit: unknown }> {
    await this.assertProtectiveTriggersSafe(
      stopLossOrder.symbol,
      stopLossOrder,
      takeProfitOrder
    );
    const stopLoss = await this.placeProtectiveOrderWithPositionRetry(
      stopLossOrder,
      source
    );
    const takeProfit = await this.placeProtectiveOrderWithPositionRetry(
      takeProfitOrder,
      source
    );
    return { stopLoss, takeProfit };
  }

  private async assertProtectiveTriggersSafe(
    symbol: string,
    stopLossOrder: BinanceOrderRequest,
    takeProfitOrder: BinanceOrderRequest
  ): Promise<void> {
    const markPrice = await this.getLivePrice(symbol);
    const unsafeOrders = [stopLossOrder, takeProfitOrder].filter((order) =>
      this.wouldProtectiveOrderTriggerNow(order, markPrice)
    );
    if (unsafeOrders.length === 0) return;

    throw new Error(
      `TP/SL sẽ kích hoạt ngay cho ${symbol} tại ${decimal(markPrice)}: ${unsafeOrders
        .map((order) => `${order.type}@${order.stopPrice}`)
        .join(", ")}`
    );
  }

  private async getLivePrice(symbol: string): Promise<number> {
    const ticker = (await this.binance.getPrice(symbol)) as Record<string, unknown>;
    const price = Number(ticker.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Không đọc được giá hiện tại của ${symbol}`);
    }
    return price;
  }

  private wouldProtectiveOrderTriggerNow(
    order: BinanceOrderRequest,
    markPrice: number
  ): boolean {
    // Trailing stop không trigger ngay — chỉ trigger sau khi activation price bị vượt
    // và sau đó giá kéo ngược callbackRate%. Binance xử lý logic này phía server.
    if (order.type === "TRAILING_STOP_MARKET") return false;

    const stopPrice = Number(order.stopPrice);
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return true;

    const upperBuffer = markPrice * (1 + PROTECTIVE_TRIGGER_BUFFER_PCT);
    const lowerBuffer = markPrice * (1 - PROTECTIVE_TRIGGER_BUFFER_PCT);
    if (order.type === "STOP_MARKET") {
      return order.side === "BUY"
        ? upperBuffer >= stopPrice
        : lowerBuffer <= stopPrice;
    }
    if (order.type === "TAKE_PROFIT_MARKET") {
      return order.side === "BUY"
        ? lowerBuffer <= stopPrice
        : upperBuffer >= stopPrice;
    }
    return false;
  }

  private async placeProtectiveOrderWithPositionRetry(
    order: BinanceOrderRequest,
    source: string
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await this.placeOrder(order, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry = message.includes("-4509") && attempt < 5;
        if (!shouldRetry) throw error;
        this.audit.warn("Binance chưa nhận vị thế cho TP/SL, thử lại", {
          symbol: order.symbol,
          type: order.type,
          attempt,
          error: message
        });
        await delay(1_000);
      }
    }
    throw new Error(`Không thể gửi lệnh bảo vệ ${order.type} cho ${order.symbol}`);
  }

  private scheduleProtectiveOrdersAfterFill({
    key,
    entryOrderId,
    symbol,
    side,
    source,
    stopLossOrder,
    takeProfitOrder,
    onFilled,
    onExpired
  }: {
    key: string;
    entryOrderId?: string | number;
    symbol: string;
    side: TradeSide;
    source: ProtectedTradeRequest["source"];
    stopLossOrder: BinanceOrderRequest;
    takeProfitOrder: BinanceOrderRequest;
    onFilled?: () => void;
    onExpired?: () => void;
  }): void {
    const existing = this.pendingProtectionTimers.get(key);
    if (existing) clearTimeout(existing);

    const expiresAt = Date.now() + LIMIT_ENTRY_FILL_TIMEOUT_MS;
    const tick = async () => {
      try {
        const amount = await this.getPositionAmount(symbol);
        const hasPosition = side === "BUY" ? amount > 0 : amount < 0;
        if (hasPosition) {
          this.pendingProtectionTimers.delete(key);

          // Kiểm tra liqPrice trước khi đặt TP/SL cho LIMIT fill trễ
          const slPriceNum = Number(stopLossOrder.stopPrice ?? 0);
          if (await this.isLiqInsideSL(symbol, side, slPriceNum)) {
            this.audit.error("LIMIT khớp nhưng liqPrice trong vùng SL — đóng khẩn cấp, không đặt TP/SL", {
              symbol, slPrice: slPriceNum, entryClientOrderId: key
            });
            appEvents.publish("liquidation.warning", {
              symbol, slPrice: slPriceNum, action: "liq_inside_sl_limit_filled"
            });
            onExpired?.();
            await this.cleanupFailedProtectedTrade(symbol, undefined, [
              stopLossOrder,
              takeProfitOrder
            ]);
            return;
          }

          try {
            const result = await this.placeProtectiveOrders(
              stopLossOrder,
              takeProfitOrder,
              source
            );
            this.audit.info("Đã gửi TP/SL sau khi lệnh Limit khớp", {
              symbol,
              positionAmount: amount,
              entryClientOrderId: key
            });
            onFilled?.();
            return result;
          } catch (error) {
            this.audit.error("Không thể gửi TP/SL sau khi lệnh Limit khớp; đóng vị thế để tránh bị trống bảo vệ", {
              symbol,
              entryClientOrderId: key,
              error: error instanceof Error ? error.message : String(error)
            });
            onExpired?.();
            await this.cleanupFailedProtectedTrade(symbol, undefined, [
              stopLossOrder,
              takeProfitOrder
            ]);
            return;
          }
        }

        if (Date.now() >= expiresAt) {
          this.pendingProtectionTimers.delete(key);
          if (entryOrderId === undefined) {
            this.audit.warn("Limit entry timeout sau 60 giây nhưng không có order id để hủy", {
              symbol,
              entryClientOrderId: key
            });
            onExpired?.();
            return;
          }

          try {
            await this.binance.cancelOrder(symbol, entryOrderId);
            this.audit.warn("Đã hủy lệnh Limit chưa khớp sau 60 giây", {
              symbol,
              entryClientOrderId: key,
              entryOrderId
            });
            onExpired?.();
          } catch (cancelError) {
            const latestAmount = await this.getPositionAmount(symbol);
            const filledDuringCancel =
              side === "BUY" ? latestAmount > 0 : latestAmount < 0;

            if (filledDuringCancel) {
              // Kiểm tra liqPrice trước khi đặt TP/SL (fill trong lúc cancel)
              const slPriceNum = Number(stopLossOrder.stopPrice ?? 0);
              if (await this.isLiqInsideSL(symbol, side, slPriceNum)) {
                this.audit.error("Fill trong lúc cancel nhưng liqPrice trong vùng SL — đóng khẩn cấp", {
                  symbol, slPrice: slPriceNum, entryClientOrderId: key
                });
                appEvents.publish("liquidation.warning", {
                  symbol, slPrice: slPriceNum, action: "liq_inside_sl_cancel_race"
                });
                onExpired?.();
                await this.cleanupFailedProtectedTrade(symbol, undefined, [
                  stopLossOrder, takeProfitOrder
                ]);
                return;
              }
              try {
                const result = await this.placeProtectiveOrders(
                  stopLossOrder,
                  takeProfitOrder,
                  source
                );
                this.audit.info("Lệnh Limit khớp trong lúc hủy; đã gửi TP/SL", {
                  symbol,
                  positionAmount: latestAmount,
                  entryClientOrderId: key,
                  entryOrderId
                });
                onFilled?.();
                return result;
              } catch (protectiveError) {
                this.audit.error("Lệnh Limit khớp nhưng không gửi được TP/SL; đóng vị thế để tránh bị trống bảo vệ", {
                  symbol,
                  entryClientOrderId: key,
                  entryOrderId,
                  error:
                    protectiveError instanceof Error
                      ? protectiveError.message
                      : String(protectiveError)
                });
                onExpired?.();
                await this.cleanupFailedProtectedTrade(symbol, undefined, [
                  stopLossOrder,
                  takeProfitOrder
                ]);
                return;
              }
            }

            this.audit.error("Không thể hủy lệnh Limit chưa khớp sau 60 giây", {
              symbol,
              entryClientOrderId: key,
              entryOrderId,
              error:
                cancelError instanceof Error
                  ? cancelError.message
                  : String(cancelError)
            });
            onExpired?.();
          }
          return;
        }
      } catch (error) {
        this.audit.warn("Chưa thể kiểm tra vị thế để gửi TP/SL cho lệnh Limit", {
          symbol,
          entryClientOrderId: key,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      const timer = setTimeout(() => void tick(), LIMIT_ENTRY_POLL_MS);
      this.pendingProtectionTimers.set(key, timer);
    };

    const timer = setTimeout(() => void tick(), LIMIT_ENTRY_POLL_MS);
    this.pendingProtectionTimers.set(key, timer);
  }

  private async assertPositionReadable(symbol: string): Promise<void> {
    try {
      await this.getPositionAmount(symbol);
    } catch (error) {
      throw new Error(
        `Không đọc được vị thế ${symbol}; bot không gửi lệnh thật vì không thể đặt TP/SL an toàn: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async assertOpenPositionForProtectiveOrder(
    symbol: string,
    closeSide: TradeSide
  ): Promise<void> {
    if (this.settingsService.get().dryRun) return;
    const amount = await this.getPositionAmount(symbol);
    const canClose = closeSide === "SELL" ? amount > 0 : amount < 0;
    if (!canClose) {
      throw new Error(
        `Chưa có vị thế ${symbol} phù hợp để đặt TP/SL. Binance chỉ nhận TP/SL closePosition sau khi vị thế đã mở.`
      );
    }
  }

  private async waitForOpenPosition(
    symbol: string,
    side: TradeSide,
    timeoutMs: number
  ): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const amount = await this.getPositionAmount(symbol);
      if (side === "BUY" && amount > 0) return amount;
      if (side === "SELL" && amount < 0) return amount;
      if (timeoutMs <= 0) return null;
      await delay(500);
    } while (Date.now() < deadline);
    return null;
  }

  private async getPositionAmount(symbol: string): Promise<number> {
    const normalized = normalizeUsdFuturesSymbol(symbol);
    const response = await this.binance.getPosition(normalized);
    const positions = Array.isArray(response) ? response : [response];
    const position =
      positions.find(
        (item) =>
          item &&
          typeof item === "object" &&
          String((item as Record<string, unknown>).symbol ?? "").toUpperCase() ===
            normalized
      ) ?? positions[0];
    if (!position || typeof position !== "object") return 0;
    const amount = Number((position as Record<string, unknown>).positionAmt ?? 0);
    return Number.isFinite(amount) ? amount : 0;
  }

  private async ensureMarginMode(
    symbol: string,
    marginType: "CROSSED" | "ISOLATED"
  ): Promise<void> {
    try {
      await this.binance.changeMarginType(symbol, marginType);
      this.audit.info("Margin mode request", { symbol, marginType });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("-4046") || message.includes("No need")) {
        this.audit.info("Margin mode already set", { symbol, marginType });
        return;
      }
      throw error;
    }
  }

  /**
   * Sau khi position mở, kiểm tra liqPrice của Binance có nằm trong vùng SL không.
   * SHORT nguy hiểm khi liqPrice < SL (liq kích hoạt trước SL).
   * LONG  nguy hiểm khi liqPrice > SL (liq kích hoạt trước SL).
   * Nếu phát hiện: đóng vị thế ngay và ném lỗi để dừng flow.
   */
  private async assertLiqPriceSaferThanSL(
    symbol: string,
    side: TradeSide,
    slPrice: number,
    stopLossOrder: BinanceOrderRequest,
    takeProfitOrder: BinanceOrderRequest,
    entryResult: unknown
  ): Promise<void> {
    if (this.settingsService.get().dryRun) return;
    try {
      const positions = await this.binance.getPosition(symbol) as unknown[];
      const arr = Array.isArray(positions) ? positions : [positions];
      const pos = arr.find(
        (p) => Math.abs(Number((p as Record<string, unknown>).positionAmt ?? 0)) > 0
      ) as Record<string, unknown> | undefined;
      if (!pos) return;

      const liqPrice = Number(pos.liquidationPrice ?? 0);
      if (!Number.isFinite(liqPrice) || liqPrice <= 0) return;

      // SHORT: liqPrice nằm giữa entry và SL (đều > entry) → liq trước SL
      // LONG:  liqPrice nằm giữa entry và SL (đều < entry) → liq trước SL
      const dangerous = side === "SELL" ? liqPrice < slPrice : liqPrice > slPrice;
      if (!dangerous) return;

      this.audit.error("LiqPrice nằm trong vùng SL — đóng vị thế khẩn cấp trước khi đặt TP/SL", {
        symbol, side, slPrice, liqPrice,
        gap: Math.abs(liqPrice - slPrice).toFixed(8)
      });
      appEvents.publish("liquidation.warning", {
        symbol, liqPrice, slPrice, action: "liq_inside_sl_pre_tp"
      });
      await this.cleanupFailedProtectedTrade(symbol, entryResult, [stopLossOrder, takeProfitOrder]);
      throw new Error(
        `Đóng khẩn cấp ${symbol}: liqPrice ${liqPrice.toFixed(8)} nằm trong vùng SL ${slPrice.toFixed(8)} — leverage quá cao so với maintenance margin của coin này`
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Đóng khẩn cấp")) throw error;
      // Nếu lấy positionRisk thất bại, bỏ qua — LiquidationGuard sẽ bắt sau
      this.audit.warn("Bỏ qua kiểm tra liqPrice (không lấy được positionRisk)", {
        symbol, error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Kiểm tra nhẹ — dùng trong luồng LIMIT fill trễ (scheduleProtectiveOrdersAfterFill).
   * Trả về true nếu liqPrice đã vượt qua SL (nguy hiểm), false nếu an toàn hoặc lỗi.
   */
  private async isLiqInsideSL(symbol: string, side: TradeSide, slPrice: number): Promise<boolean> {
    if (this.settingsService.get().dryRun || slPrice <= 0) return false;
    try {
      const positions = await this.binance.getPosition(symbol) as unknown[];
      const arr = Array.isArray(positions) ? positions : [positions];
      const pos = arr.find(
        (p) => Math.abs(Number((p as Record<string, unknown>).positionAmt ?? 0)) > 0
      ) as Record<string, unknown> | undefined;
      if (!pos) return false;
      const liqPrice = Number((pos as Record<string, unknown>).liquidationPrice ?? 0);
      if (!Number.isFinite(liqPrice) || liqPrice <= 0) return false;
      return side === "SELL" ? liqPrice < slPrice : liqPrice > slPrice;
    } catch {
      return false; // fail-safe: nếu không check được thì không block
    }
  }

  private async cleanupFailedProtectedTrade(
    symbol: string,
    entryResult: unknown,
    protectiveOrders: BinanceOrderRequest[] = []
  ): Promise<void> {
    const orderId = orderIdFrom(entryResult);
    try {
      if (orderId !== undefined) await this.binance.cancelOrder(symbol, orderId);
    } catch (error) {
      this.audit.error("Không thể hủy lệnh vào trong bước dọn dẹp", {
        symbol,
        orderId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    for (const order of protectiveOrders) {
      if (!order.newClientOrderId) continue;
      try {
        await this.binance.cancelAlgoOrder({
          clientAlgoId: order.newClientOrderId
        });
      } catch (error) {
        this.audit.error("Không thể hủy lệnh TP/SL algo trong bước dọn dẹp", {
          symbol,
          clientAlgoId: order.newClientOrderId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      await this.closePosition(symbol, "cleanup");
    } catch (error) {
      this.audit.error("Không thể đóng vị thế trong bước dọn dẹp", {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
