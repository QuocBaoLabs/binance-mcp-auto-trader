import crypto from "node:crypto";
import { activeBaseUrl, hasCredentials, staticConfig } from "../config.js";
import type { BinanceOrderRequest, Kline, RuntimeSettings, TradeSide } from "../types.js";
import { logger, redact } from "../logger.js";
import { SettingsService } from "../services/settings.js";

interface RequestOptions {
  signed?: boolean;
  baseUrl?: string;
}

export interface SymbolRules {
  tickSize: number;
  tickDecimals: number;
  stepSize: number;
  stepDecimals: number;
  minQty: number;
  marketStepSize: number;
  marketStepDecimals: number;
  marketMinQty: number;
}

const WEIGHT_THROTTLE_THRESHOLD = 2000; // start throttling at this used-weight level
const WEIGHT_LIMIT = 2400; // Binance 1-minute REQUEST_WEIGHT limit
const FETCH_TIMEOUT_MS = 12_000; // abort any Binance request that takes > 12s
const MAX_CONCURRENT_REQUESTS = 2;
const MIN_REQUEST_INTERVAL_MS = 150;
const BAN_GRACE_MS = 1_500;
const PRICE_CACHE_MS = 1_500;
const KLINES_CACHE_MS = 5_000;
const EXCHANGE_INFO_CACHE_MS = 60 * 60_000;
const TICKERS_CACHE_MS = 60_000;

type CacheEntry<T> = { data: T; fetchedAt: number };

export class BinanceClient {
  private timeOffsetMs = 0;
  private lastTimeSyncMs = 0;
  private symbolRulesCache = new Map<string, SymbolRules>();
  private symbolRulesCacheMs = 0;
  private bannedUntilMs = 0; // IP ban expiry (418/429)
  private usedWeight1m = 0; // last known X-MBX-USED-WEIGHT-1M value
  private weightReadAt = 0; // when usedWeight1m was last read
  private lastSuccessAt = 0; // last time a Binance call succeeded
  private maxLeverageCache = new Map<string, { value: number; fetchedAt: number }>();
  private activeRequests = 0;
  private waiters: Array<() => void> = [];
  private nextRequestAt = 0;
  private priceCache = new Map<string, CacheEntry<unknown>>();
  private klinesCache = new Map<string, CacheEntry<Kline[]>>();
  private tickersCache?: CacheEntry<unknown[]>;
  private exchangeInfoCache?: CacheEntry<unknown>;

  constructor(private readonly settingsService: SettingsService) {}

  rateLimitStatus(): { banned: boolean; waitSeconds: number; bannedUntil?: string; usedWeight1m: number; lastSuccessAgoMs: number } {
    const waitMs = Math.max(0, this.bannedUntilMs - Date.now());
    // Weight resets every 60s — if our reading is stale, report 0
    const weightAge = Date.now() - this.weightReadAt;
    const currentWeight = weightAge < 60_000 ? this.usedWeight1m : 0;
    return {
      banned: waitMs > 0,
      waitSeconds: Math.ceil(waitMs / 1000),
      bannedUntil: waitMs > 0 ? new Date(this.bannedUntilMs).toISOString() : undefined,
      usedWeight1m: currentWeight,
      lastSuccessAgoMs: this.lastSuccessAt > 0 ? Date.now() - this.lastSuccessAt : Infinity
    };
  }

  async getPrice(symbol: string): Promise<unknown> {
    const normalized = this.symbol(symbol);
    const cached = this.priceCache.get(normalized);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_MS) return cached.data;
    const data = await this.request("GET", "/fapi/v2/ticker/price", {
      symbol: normalized
    });
    this.priceCache.set(normalized, { data, fetchedAt: Date.now() });
    return data;
  }

  async get24hrTickers(): Promise<unknown[]> {
    if (this.tickersCache && Date.now() - this.tickersCache.fetchedAt < TICKERS_CACHE_MS) {
      return this.tickersCache.data;
    }
    const data = await this.request("GET", "/fapi/v1/ticker/24hr", {}) as unknown[];
    this.tickersCache = { data, fetchedAt: Date.now() };
    return data;
  }

  async getExchangeInfo(): Promise<unknown> {
    if (this.exchangeInfoCache && Date.now() - this.exchangeInfoCache.fetchedAt < EXCHANGE_INFO_CACHE_MS) {
      return this.exchangeInfoCache.data;
    }
    const data = await this.request("GET", "/fapi/v1/exchangeInfo", {});
    this.exchangeInfoCache = { data, fetchedAt: Date.now() };
    return data;
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<Kline[]> {
    const normalized = this.symbol(symbol);
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 1500);
    const cacheKey = `${normalized}:${interval}:${safeLimit}`;
    const cached = this.klinesCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < KLINES_CACHE_MS) return cached.data;

    const rows = (await this.request("GET", "/fapi/v1/klines", {
      symbol: normalized,
      interval,
      limit: safeLimit
    })) as unknown[][];

    const data = rows.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
      quoteVolume: Number(row[7]),
      trades: Number(row[8])
    }));
    this.klinesCache.set(cacheKey, { data, fetchedAt: Date.now() });
    return data;
  }

  async getFundingRate(symbol: string, limit = 10): Promise<unknown> {
    return this.request("GET", "/fapi/v1/fundingRate", {
      symbol: this.symbol(symbol),
      limit: Math.min(Math.max(Math.floor(limit), 1), 1000)
    });
  }

  async getOpenInterest(symbol: string): Promise<unknown> {
    return this.request("GET", "/fapi/v1/openInterest", {
      symbol: this.symbol(symbol)
    });
  }

  async getLongShortRatio(
    symbol: string,
    period = "5m",
    limit = 30
  ): Promise<unknown> {
    return this.request(
      "GET",
      "/futures/data/globalLongShortAccountRatio",
      {
        symbol: this.symbol(symbol),
        period,
        limit: Math.min(Math.max(Math.floor(limit), 1), 500)
      },
      {
        baseUrl: staticConfig.liveBaseUrl
      }
    );
  }

  async getBalance(): Promise<unknown> {
    return this.request("GET", "/fapi/v3/balance", {}, { signed: true });
  }

  async getAccount(): Promise<unknown> {
    return this.request("GET", "/fapi/v3/account", {}, { signed: true });
  }

  async getPosition(symbol?: string): Promise<unknown> {
    return this.request(
      "GET",
      "/fapi/v3/positionRisk",
      symbol ? { symbol: this.symbol(symbol) } : {},
      { signed: true }
    );
  }

  async getRecentOrders(symbol: string, limit = 20): Promise<unknown> {
    return this.request(
      "GET",
      "/fapi/v1/allOrders",
      { symbol: this.symbol(symbol), limit },
      { signed: true }
    );
  }

  async getOpenOrders(symbol?: string): Promise<unknown> {
    return this.request(
      "GET",
      "/fapi/v1/openOrders",
      symbol ? { symbol: this.symbol(symbol) } : {},
      { signed: true }
    );
  }

  async changeLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.request(
      "POST",
      "/fapi/v1/leverage",
      {
        symbol: this.symbol(symbol),
        leverage
      },
      { signed: true }
    );
  }

  async getMaxLeverage(symbol: string): Promise<number> {
    const cached = this.maxLeverageCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60_000) return cached.value;
    try {
      const data = await this.request("GET", "/fapi/v1/leverageBracket", { symbol: this.symbol(symbol) }, { signed: true });
      const brackets = data as Array<{ brackets: Array<{ initialLeverage: number }> }>;
      const maxLev = brackets?.[0]?.brackets?.[0]?.initialLeverage ?? 20;
      this.maxLeverageCache.set(symbol, { value: maxLev, fetchedAt: Date.now() });
      return maxLev;
    } catch {
      return 20; // safe fallback; changeLeverage will surface the real error if needed
    }
  }

  async changeMarginType(
    symbol: string,
    marginType: "CROSSED" | "ISOLATED"
  ): Promise<unknown> {
    return this.request(
      "POST",
      "/fapi/v1/marginType",
      {
        symbol: this.symbol(symbol),
        marginType
      },
      { signed: true }
    );
  }

  async getOrderRules(symbol: string): Promise<SymbolRules> {
    return this.getSymbolRules(symbol);
  }

  async createOrder(order: BinanceOrderRequest): Promise<unknown> {
    const normalized = await this.normalizeOrder(order);
    if (this.isAlgoOrder(normalized.type)) {
      return this.createAlgoOrder(normalized);
    }

    const params: Record<string, string | number | boolean> = {
      symbol: this.symbol(normalized.symbol),
      side: normalized.side,
      type: normalized.type,
      newOrderRespType: "RESULT"
    };
    if (normalized.quantity !== undefined) params.quantity = normalized.quantity;
    if (normalized.price !== undefined) params.price = normalized.price;
    if (normalized.stopPrice !== undefined) params.stopPrice = normalized.stopPrice;
    if (normalized.timeInForce !== undefined) {
      params.timeInForce = normalized.timeInForce;
    }
    if (normalized.reduceOnly !== undefined) params.reduceOnly = normalized.reduceOnly;
    if (normalized.closePosition !== undefined) {
      params.closePosition = normalized.closePosition;
    }
    if (normalized.callbackRate !== undefined) {
      params.callbackRate = normalized.callbackRate;
    }
    if (normalized.activationPrice !== undefined) {
      params.activationPrice = normalized.activationPrice;
    }
    if (normalized.newClientOrderId !== undefined) {
      params.newClientOrderId = normalized.newClientOrderId;
    }
    return this.request("POST", "/fapi/v1/order", params, { signed: true });
  }

  // Place STOP_MARKET directly via /fapi/v1/order (bypasses algo routing).
  // Used by PositionManager to move SL without conflicting with existing TP algo orders.
  async createStopMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    stopPrice: number,
    clientOrderId?: string
  ): Promise<unknown> {
    const rules = await this.getSymbolRules(this.symbol(symbol));
    const rounded = this.formatToStep(stopPrice, rules.tickSize, rules.tickDecimals, "round");
    const params: Record<string, string | number | boolean> = {
      symbol:        this.symbol(symbol),
      side,
      type:          "STOP_MARKET",
      stopPrice:     String(rounded),
      closePosition: true,
      newOrderRespType: "RESULT"
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;
    return this.request("POST", "/fapi/v1/order", params, { signed: true });
  }

  // Amend (modify) stopPrice of an existing STOP_MARKET order via PUT /fapi/v1/order.
  // Much safer than cancel+replace — no temporary gap in SL protection.
  async amendStopOrder(
    symbol: string,
    orderId: string | number,
    newStopPrice: number
  ): Promise<unknown> {
    const rules   = await this.getSymbolRules(this.symbol(symbol));
    const rounded = this.formatToStep(newStopPrice, rules.tickSize, rules.tickDecimals, "round");
    return this.request("PUT", "/fapi/v1/order", {
      symbol:    this.symbol(symbol),
      orderId:   String(orderId),
      stopPrice: String(rounded)
    }, { signed: true });
  }

  async createAlgoOrder(order: BinanceOrderRequest): Promise<unknown> {
    const normalized = await this.normalizeOrder(order);
    if (!this.isAlgoOrder(normalized.type)) {
      throw new Error(`Loại lệnh ${normalized.type} không phải lệnh algo TP/SL`);
    }

    const params: Record<string, string | number | boolean> = {
      algoType: "CONDITIONAL",
      symbol: this.symbol(normalized.symbol),
      side: normalized.side,
      type: normalized.type,
      newOrderRespType: "RESULT"
    };
    if (normalized.quantity !== undefined) params.quantity = normalized.quantity;
    if (normalized.price !== undefined) params.price = normalized.price;
    if (normalized.stopPrice !== undefined) {
      params.triggerPrice = normalized.stopPrice;
    }
    if (normalized.timeInForce !== undefined) {
      params.timeInForce = normalized.timeInForce;
    }
    if (normalized.workingType !== undefined) params.workingType = normalized.workingType;
    if (normalized.priceProtect !== undefined) {
      params.priceProtect = normalized.priceProtect;
    }
    if (normalized.reduceOnly !== undefined) params.reduceOnly = normalized.reduceOnly;
    if (normalized.closePosition !== undefined) {
      params.closePosition = normalized.closePosition;
    }
    if (normalized.newClientOrderId !== undefined) {
      params.clientAlgoId = normalized.newClientOrderId;
    }
    if (normalized.callbackRate !== undefined) {
      params.callbackRate = normalized.callbackRate;
    }
    if (normalized.activationPrice !== undefined) {
      params.activatePrice = normalized.activationPrice;
    }

    return this.request("POST", "/fapi/v1/algoOrder", params, { signed: true });
  }

  async cancelOrder(symbol: string, orderId: string | number): Promise<unknown> {
    return this.request(
      "DELETE",
      "/fapi/v1/order",
      {
        symbol: this.symbol(symbol),
        orderId
      },
      { signed: true }
    );
  }

  async cancelAllOpenOrders(symbol: string): Promise<unknown> {
    return this.request(
      "DELETE",
      "/fapi/v1/allOpenOrders",
      {
        symbol: this.symbol(symbol)
      },
      { signed: true }
    );
  }

  async cancelAlgoOrder(options: {
    algoId?: string | number;
    clientAlgoId?: string;
  }): Promise<unknown> {
    const params: Record<string, string | number | boolean> = {};
    if (options.algoId !== undefined) params.algoId = options.algoId;
    if (options.clientAlgoId !== undefined) params.clientAlgoId = options.clientAlgoId;
    if (Object.keys(params).length === 0) {
      throw new Error("Cần algoId hoặc clientAlgoId để hủy lệnh algo");
    }

    return this.request("DELETE", "/fapi/v1/algoOrder", params, {
      signed: true
    });
  }

  async getOpenAlgoOrders(symbol?: string): Promise<unknown> {
    return this.request(
      "GET",
      "/fapi/v1/openAlgoOrders",
      symbol ? { symbol: this.symbol(symbol) } : {},
      { signed: true }
    );
  }

  async createTrailingStopOrder(symbol: string, side: TradeSide, callbackRate: number, activationPrice: number): Promise<unknown> {
    const rules = await this.getOrderRules(this.symbol(symbol));
    const activation = parseFloat(activationPrice.toFixed(rules.tickDecimals));
    const params: Record<string, string | number | boolean> = {
      symbol: this.symbol(symbol),
      side,
      type: "TRAILING_STOP_MARKET",
      callbackRate: Math.min(Math.max(callbackRate, 0.1), 5),
      activationPrice: activation.toString(),
      closePosition: true,
      newClientOrderId: `pm-trail-${Date.now()}`
    };
    return this.request("POST", "/fapi/v1/order", params, { signed: true });
  }

  async cancelAllOpenAlgoOrders(symbol: string): Promise<unknown> {
    return this.request(
      "DELETE",
      "/fapi/v1/algoOpenOrders",
      {
        symbol: this.symbol(symbol)
      },
      { signed: true }
    );
  }

  private async request(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    params: Record<string, string | number | boolean> = {},
    options: RequestOptions = {},
    retryTimeSync = true
  ): Promise<unknown> {
    const settings = this.settingsService.get();
    const baseUrl = this.baseUrl(settings, options.baseUrl);
    const release = await this.acquireRequestSlot();
    try {
    if (this.bannedUntilMs > Date.now()) {
      const waitSec = Math.ceil((this.bannedUntilMs - Date.now()) / 1000);
      throw new Error(`Binance IP bị cấm ${waitSec}s nữa. Vui lòng chờ.`);
    }
    if (options.signed) await this.ensureServerTime(baseUrl);

    const query = this.buildQuery(params, options.signed);
    const url = new URL(`${baseUrl}${path}`);
    if (query) url.search = query;

    const headers: Record<string, string> = {};
    if (options.signed) {
      if (!hasCredentials()) {
        throw new Error("Chưa cấu hình Binance API key/secret");
      }
      headers["X-MBX-APIKEY"] = staticConfig.apiKey;
    }

    // Check IP ban before sending
    if (this.bannedUntilMs > Date.now()) {
      const waitSec = Math.ceil((this.bannedUntilMs - Date.now()) / 1000);
      throw new Error(`Binance IP bị cấm ${waitSec}s nữa. Vui lòng chờ.`);
    }

    // Proactive throttle: if we're near the 2400 weight/min limit, pause briefly
    if (this.usedWeight1m >= WEIGHT_THROTTLE_THRESHOLD && Date.now() - this.weightReadAt < 60_000) {
      const remaining = WEIGHT_LIMIT - this.usedWeight1m;
      const pauseMs = remaining <= 0 ? 5000 : Math.min(3000, Math.round((WEIGHT_LIMIT - WEIGHT_THROTTLE_THRESHOLD - remaining) * 10));
      if (pauseMs > 0) {
        logger.warn(`Binance weight cao (${this.usedWeight1m}/${WEIGHT_LIMIT}), tam dung ${pauseMs}ms`);
        await new Promise(r => setTimeout(r, pauseMs));
      }
    }

    logger.debug("Gửi request Binance", redact({ method, path, params }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { method, headers, signal: controller.signal });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr instanceof Error && fetchErr.name === "AbortError") {
        throw new Error(`Binance ${method} ${path} timeout sau ${FETCH_TIMEOUT_MS / 1000}s — mang cham hoac Binance qua tai`);
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    // Track used weight from response header
    const usedWeight = response.headers.get("X-MBX-USED-WEIGHT-1M");
    if (usedWeight) {
      this.usedWeight1m = Number(usedWeight);
      this.weightReadAt = Date.now();
    }

    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Binance ${method} ${path} trả về phản hồi không phải JSON: ${text.slice(
          0,
          120
        )}`
      );
    }

    if (!response.ok) {
      // Rate limit / IP ban — parse ban expiry and reset success timestamp
      if (response.status === 418 || response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter) {
          this.bannedUntilMs = Date.now() + this.parseRetryAfterMs(retryAfter) + BAN_GRACE_MS;
        } else if (typeof data === "object" && data !== null && "msg" in data) {
          // Parse "banned until TIMESTAMP" from message
          const m = String((data as Record<string, unknown>).msg).match(/until\s+(\d+)/);
          if (m) this.bannedUntilMs = Number(m[1]) + BAN_GRACE_MS;
        }
        if (!this.bannedUntilMs || this.bannedUntilMs <= Date.now()) {
          // Fallback: ban for 60 seconds
          this.bannedUntilMs = Date.now() + 60_000 + BAN_GRACE_MS;
        }
        const waitSec = Math.ceil((this.bannedUntilMs - Date.now()) / 1000);
        logger.warn(`Binance rate limit (${response.status}) — chờ ${waitSec}s`);
        throw new Error(`Binance IP bị cấm ${waitSec}s nữa. Hệ thống tự tạm dừng.`);
      }
      if (options.signed && retryTimeSync && this.isTimestampError(data)) {
        await this.syncServerTime(baseUrl, true);
        return this.request(method, path, params, options, false);
      }
      throw new Error(
        `Binance ${method} ${path} thất bại (${response.status}): ${JSON.stringify(
          redact(data)
        )}`
      );
    }

    this.lastSuccessAt = Date.now();
    return data;
    } finally {
      release();
    }
  }

  private async acquireRequestSlot(): Promise<() => void> {
    this.throwIfBanned("Vui lÃ²ng chá».");
    while (this.activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.throwIfBanned("Vui lÃ²ng chá».");
    }

    this.activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.waiters.shift()?.();
    };

    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + MIN_REQUEST_INTERVAL_MS;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    try {
      this.throwIfBanned("Vui lÃ²ng chá».");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private throwIfBanned(suffix: string): void {
    if (this.bannedUntilMs <= Date.now()) return;
    const waitSec = Math.ceil((this.bannedUntilMs - Date.now()) / 1000);
    throw new Error(`Binance IP bá»‹ cáº¥m ${waitSec}s ná»¯a. ${suffix}`);
  }

  private parseRetryAfterMs(value: string): number {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    return 60_000;
  }

  private buildQuery(
    params: Record<string, string | number | boolean>,
    signed = false
  ): string {
    const entries = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)] as [string, string]);

    if (signed) {
      entries.push(["recvWindow", "5000"]);
      entries.push(["timestamp", this.timestamp().toString()]);
    }

    const query = new URLSearchParams(entries).toString();
    if (!signed) return query;

    const signature = crypto
      .createHmac("sha256", staticConfig.apiSecret)
      .update(query)
      .digest("hex");
    return `${query}&signature=${signature}`;
  }

  private baseUrl(settings: RuntimeSettings, override?: string): string {
    return (override ?? activeBaseUrl(settings)).replace(/\/+$/, "");
  }

  private async normalizeOrder(
    order: BinanceOrderRequest
  ): Promise<BinanceOrderRequest> {
    const rules = await this.getSymbolRules(order.symbol);
    const normalized: BinanceOrderRequest = { ...order };

    if (order.quantity !== undefined) {
      const quantity = Number(order.quantity);
      const isMarket = order.type === "MARKET";
      const stepSize =
        isMarket && rules.marketStepSize > 0
          ? rules.marketStepSize
          : rules.stepSize;
      const decimals =
        isMarket && rules.marketStepSize > 0
          ? rules.marketStepDecimals
          : rules.stepDecimals;
      const minQty =
        isMarket && rules.marketMinQty > 0 ? rules.marketMinQty : rules.minQty;
      normalized.quantity = this.formatToStep(quantity, stepSize, decimals, "floor");
      if (Number(normalized.quantity) <= 0 || Number(normalized.quantity) < minQty) {
        throw new Error(
          `${this.symbol(order.symbol)} quantity quá nhỏ. Tối thiểu ${this.trimFixed(
            Math.max(minQty, stepSize),
            decimals
          )}, stepSize ${stepSize}. Tăng ký quỹ hoặc đòn bẩy.`
        );
      }
    }

    if (order.price !== undefined) {
      normalized.price = this.formatToStep(
        Number(order.price),
        rules.tickSize,
        rules.tickDecimals,
        "round"
      );
    }
    if (order.stopPrice !== undefined) {
      normalized.stopPrice = this.formatToStep(
        Number(order.stopPrice),
        rules.tickSize,
        rules.tickDecimals,
        "round"
      );
    }

    return normalized;
  }

  private isAlgoOrder(type: BinanceOrderRequest["type"]): boolean {
    // Binance USD-M sends TP/SL and trailing stops through /fapi/v1/algoOrder.
    return (
      type === "STOP_MARKET" ||
      type === "TAKE_PROFIT_MARKET" ||
      type === "TRAILING_STOP_MARKET" ||
      type === "STOP" ||
      type === "TAKE_PROFIT"
    );
  }

  private async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const normalized = this.symbol(symbol);
    const fresh = Date.now() - this.symbolRulesCacheMs < 60 * 60 * 1000;
    const cached = this.symbolRulesCache.get(normalized);
    if (fresh && cached) return cached;

    const data = (await this.request("GET", "/fapi/v1/exchangeInfo")) as Record<
      string,
      unknown
    >;
    const symbols = Array.isArray(data.symbols) ? data.symbols : [];
    this.symbolRulesCache.clear();

    for (const item of symbols) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const rowSymbol = String(row.symbol ?? "").toUpperCase();
      const filters = Array.isArray(row.filters) ? row.filters : [];
      const priceFilter = this.findFilter(filters, "PRICE_FILTER");
      const lotFilter = this.findFilter(filters, "LOT_SIZE");
      const marketLotFilter = this.findFilter(filters, "MARKET_LOT_SIZE");
      const tickSizeText = String(priceFilter?.tickSize ?? "0.000001");
      const stepSizeText = String(lotFilter?.stepSize ?? "0.000001");
      const minQtyText = String(lotFilter?.minQty ?? stepSizeText);
      const marketStepSizeText = String(
        marketLotFilter?.stepSize ?? stepSizeText
      );
      const marketMinQtyText = String(
        marketLotFilter?.minQty ?? minQtyText
      );

      this.symbolRulesCache.set(rowSymbol, {
        tickSize: Number(tickSizeText),
        tickDecimals: this.decimalsFromStep(tickSizeText),
        stepSize: Number(stepSizeText),
        stepDecimals: this.decimalsFromStep(stepSizeText),
        minQty: Number(minQtyText),
        marketStepSize: Number(marketStepSizeText),
        marketStepDecimals: this.decimalsFromStep(marketStepSizeText),
        marketMinQty: Number(marketMinQtyText)
      });
    }
    this.symbolRulesCacheMs = Date.now();

    const rules = this.symbolRulesCache.get(normalized);
    if (!rules) throw new Error(`Không tìm thấy exchangeInfo cho ${normalized}`);
    return rules;
  }

  private findFilter(
    filters: unknown[],
    filterType: string
  ): Record<string, unknown> | undefined {
    return filters.find(
      (filter) =>
        filter &&
        typeof filter === "object" &&
        String((filter as Record<string, unknown>).filterType) === filterType
    ) as Record<string, unknown> | undefined;
  }

  private decimalsFromStep(step: string): number {
    const fraction = step.split(".")[1] ?? "";
    return fraction.replace(/0+$/u, "").length;
  }

  private formatToStep(
    value: number,
    step: number,
    decimals: number,
    mode: "floor" | "round"
  ): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (!Number.isFinite(step) || step <= 0) {
      return this.trimFixed(value, Math.max(0, decimals));
    }

    const units = value / step;
    const adjusted =
      mode === "floor"
        ? Math.floor(units + Number.EPSILON)
        : Math.round(units);
    const result = adjusted * step;
    return this.trimFixed(result, Math.max(0, decimals));
  }

  private trimFixed(value: number, decimals: number): string {
    return value
      .toFixed(decimals)
      .replace(/(\.\d*?)0+$/u, "$1")
      .replace(/\.$/u, "");
  }

  private timestamp(): number {
    return Date.now() + this.timeOffsetMs;
  }

  private async ensureServerTime(baseUrl: string): Promise<void> {
    const stale = Date.now() - this.lastTimeSyncMs > 15 * 60 * 1000;
    if (this.lastTimeSyncMs === 0 || stale) {
      await this.syncServerTime(baseUrl);
    }
  }

  private async syncServerTime(baseUrl: string, forceLog = false): Promise<void> {
    const response = await fetch(`${baseUrl}/fapi/v1/time`);
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        `Không thể đồng bộ giờ Binance (${response.status}): ${JSON.stringify(
          redact(data)
        )}`
      );
    }

    const serverTime = Number(data.serverTime);
    if (!Number.isFinite(serverTime) || serverTime <= 0) {
      throw new Error("Không thể đồng bộ giờ Binance: phản hồi thiếu serverTime");
    }

    this.timeOffsetMs = serverTime - Date.now();
    this.lastTimeSyncMs = Date.now();
    if (forceLog || Math.abs(this.timeOffsetMs) > 500) {
      logger.warn("Đã đồng bộ timestamp Binance", {
        timeOffsetMs: this.timeOffsetMs
      });
    }
  }

  private isTimestampError(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    return Number((data as Record<string, unknown>).code) === -1021;
  }

  private symbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }
}
