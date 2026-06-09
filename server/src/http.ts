import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  credentialsStatus,
  hasCredentials,
  saveBinanceCredentials,
  staticConfig
} from "./config.js";
import {
  aiTrainingService,
  auditLog,
  backtestService,
  binanceClient,
  db,
  liquidationGuard,
  orderExecutor,
  positionManager,
  settingsService,
  sfpEngine,
  sfpMonitor,
  strategyEngine,
  wsManager
} from "./container.js";
import { appEvents } from "./events.js";
import type { AppEvent, RuntimeSettings, TradeSide } from "./types.js";
import { normalizeUsdFuturesSymbol } from "./symbols.js";
import { createSignalChart } from "./chart/signal-chart.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type AsyncRoute = (
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<void>;

function asyncRoute(route: AsyncRoute) {
  return (request: Request, response: Response, next: NextFunction) => {
    route(request, response, next).catch(next);
  };
}

function parseSettingsPatch(body: Record<string, unknown>): Partial<RuntimeSettings> {
  const patch: Partial<RuntimeSettings> = {};
  const booleanKeys = [
    "readOnly",
    "autoTradeEnabled",
    "dryRun",
    "binanceTestnet",
    "allowMarketOrder",
    "ruleSupertrendEma10Long",
    "ruleSupertrendEma10Short",
    "ruleRequireTrendDirection",
    "ruleRequireEma10Touch",
    "ruleRequireSupertrendTouch",
    "ruleBollingerReversion",
    "wyckoffUseVolumeFilter",
    "skipTradeOnExtremeVolatility",
    "sfpEnabled",
    "ruleSfpSignal",
    "sfpAutoExecute",
    "sfpOneTradeAtATime",
    "sfpUseTrailingStop",
    "smcRelaxedRRTP",
    "smcAvoidMiddleOfRange"
  ] as const;
  for (const key of booleanKeys) {
    if (key in body) patch[key] = Boolean(body[key]);
  }

  const numberKeys = [
    "maxOrderUsdt",
    "maxDailyLossUsdt",
    "maxOpenPositions",
    "maxLeverage",
    "tpPercent",
    "slPercent",
    "minConfidence",
    "strategyIntervalSeconds",
    "touchTolerancePercent",
    "wyckoffRsiLength",
    "wyckoffTrendSensitivity",
    "wyckoffPivotLength",
    "wyckoffVolumeMaLength",
    "wyckoffBreakoutBufferPct",
    "wyckoffRetestTolerancePct",
    "wyckoffMaxRiskDistancePct",
    "wyckoffMinConfidence",
    "wyckoffSlBufferPct",
    "supertrendPeriod",
    "supertrendMultiplier",
    "bollingerPeriod",
    "bollingerStdDev",
    "sarStep",
    "sarMax",
    "fixedLeverage",
    "minLeverage",
    "volatilityLookback",
    "lowVolatilityThreshold",
    "mediumVolatilityThreshold",
    "highVolatilityThreshold",
    "extremeVolatilityThreshold",
    "sfpLen",
    "sfpLeverage",
    "sfpMarginUsdt",
    "sfpTpPercent",
    "sfpCandlestickTpPercent",
    "sfpWaitCandles",
    "sfpTrailingCallbackRate",
    "sfpTrailingActivationPct",
    "smcPreferredRR",
    "smcTakeProfitRoiPercent",
    "smcMinScore",
    "smcMaxBarsAfterSweepForMSS",
    "smcFvgMinSizePct",
    "smcFvgMaxBarsAfterMss"
  ] as const;
  for (const key of numberKeys) {
    if (key in body) patch[key] = Number(body[key]);
  }

  if ("allowedSymbols" in body) {
    patch.allowedSymbols = Array.isArray(body.allowedSymbols)
      ? body.allowedSymbols.map(String)
      : String(body.allowedSymbols).split(",");
  }
  if ("sfpWatchSymbols" in body) {
    patch.sfpWatchSymbols = Array.isArray(body.sfpWatchSymbols)
      ? body.sfpWatchSymbols.map(String)
      : String(body.sfpWatchSymbols).split(",").map(s => s.trim()).filter(Boolean);
  }
  if ("sfpTimeframes" in body) {
    patch.sfpTimeframes = Array.isArray(body.sfpTimeframes)
      ? body.sfpTimeframes.map(String)
      : String(body.sfpTimeframes).split(",").map(s => s.trim()).filter(Boolean);
  }
  if ("smcAutoTimeframes" in body) {
    patch.smcAutoTimeframes = Boolean(body.smcAutoTimeframes);
  }
  if ("sfpStrategies" in body) {
    const raw = Array.isArray(body.sfpStrategies)
      ? body.sfpStrategies.map(String)
      : String(body.sfpStrategies).split(",");
    const strategies = raw
      .map(s => s.trim().toLowerCase())
      .filter((s): s is RuntimeSettings["sfpStrategies"][number] =>
        s === "sfp" || s === "candlestick" || s === "wyckoff" || s === "smc"
      );
    patch.sfpStrategies = [...new Set(strategies)];
  }
  if ("klineInterval" in body) patch.klineInterval = String(body.klineInterval);
  if ("volatilityTimeframe" in body) {
    patch.volatilityTimeframe = String(body.volatilityTimeframe);
  }
  if ("strategyMode" in body) {
    const mode = String(body.strategyMode);
    if (["score", "rules", "hybrid", "wyckoff", "smc"].includes(mode)) {
      patch.strategyMode = mode as RuntimeSettings["strategyMode"];
    }
  }
  if ("leverageMode" in body) {
    const mode = String(body.leverageMode);
    if (["fixed", "auto"].includes(mode)) {
      patch.leverageMode = mode as RuntimeSettings["leverageMode"];
    }
  }
  if ("sfpMarginType" in body) {
    const marginType = String(body.sfpMarginType).toUpperCase();
    if (["CROSSED", "ISOLATED"].includes(marginType)) {
      patch.sfpMarginType = marginType as RuntimeSettings["sfpMarginType"];
    }
  }

  return patch;
}

function isLiveMode(settings: RuntimeSettings): boolean {
  return !settings.dryRun && !settings.binanceTestnet;
}

function bodyNumber(
  body: Record<string, unknown>,
  key: string,
  fallback = 0
): number {
  const value = Number(body[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function tickerPrice(ticker: unknown): number {
  if (!ticker || typeof ticker !== "object") return 0;
  return Number((ticker as Record<string, unknown>).price ?? 0);
}

function validateConfigSafety(
  current: RuntimeSettings,
  next: RuntimeSettings,
  riskAccepted: boolean
): void {
  const errors: string[] = [];
  const enteringLive = !isLiveMode(current) && isLiveMode(next);
  const enablingLiveAuto =
    isLiveMode(next) && !current.autoTradeEnabled && next.autoTradeEnabled;

  if (isLiveMode(next) && next.readOnly) {
    errors.push("Không thể chọn Giao dịch thật khi vẫn bật Chỉ xem dữ liệu");
  }
  if (isLiveMode(next) && !staticConfig.enableLiveTrading) {
    errors.push("ENABLE_LIVE_TRADING=false nên backend không cho phép mở giao dịch thật");
  }
  if (isLiveMode(next) && next.slPercent <= 0) {
    errors.push("Không thể bật Giao dịch thật khi chưa cấu hình Stop Loss");
  }
  if (isLiveMode(next) && next.tpPercent <= 0) {
    errors.push("Không thể bật Giao dịch thật khi chưa cấu hình Take Profit");
  }
  if (isLiveMode(next) && next.maxOrderUsdt <= 0) {
    errors.push("Không thể bật Giao dịch thật khi số tiền tối đa mỗi lệnh <= 0");
  }
  if (isLiveMode(next) && next.maxOpenPositions < 1) {
    errors.push("Không thể bật Giao dịch thật khi số lệnh tối đa cùng lúc < 1");
  }
  if (next.fixedLeverage > next.maxLeverage) {
    errors.push("Đòn bẩy cố định không được vượt quá đòn bẩy tối đa");
  }
  if (next.minLeverage > next.maxLeverage) {
    errors.push("Đòn bẩy tối thiểu không được lớn hơn đòn bẩy tối đa");
  }
  if ((enteringLive || enablingLiveAuto) && !riskAccepted) {
    errors.push("Cần xác nhận rủi ro trước khi bật Giao dịch thật");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function createHttpApp() {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "8mb" }));
  app.use("/charts/signals", express.static(staticConfig.signalChartDir));

  app.get("/api/health", (_request, response) => {
    // Health check is ZERO-WEIGHT — never makes new Binance API calls.
    // Connectivity status is derived from the last-known state of existing background calls.
    const settings = settingsService.get();
    const rateLimit = binanceClient.rateLimitStatus();
    const errors: string[] = [];

    if (rateLimit.banned) {
      errors.push(`Binance API: IP đang bị cấm tạm thời, còn khoảng ${rateLimit.waitSeconds}s.`);
      errors.push("Balance API: Tạm ngừng kiểm tra để tránh kéo dài rate-limit.");
    }

    // "reachable" = had a successful Binance call within last 90s and not currently banned
    const recentSuccessMs = 90_000;
    const binanceReachable = !rateLimit.banned && rateLimit.lastSuccessAgoMs < recentSuccessMs;
    // "balanceOk" mirrors binance reachable (balance is fetched by background polling)
    const balanceOk = binanceReachable && hasCredentials();

    if (!binanceReachable && !rateLimit.banned) {
      const agoSec = rateLimit.lastSuccessAgoMs === Infinity ? "chưa có" : `${Math.round(rateLimit.lastSuccessAgoMs / 1000)}s`;
      errors.push(`Binance API: Chưa kết nối được (lần cuối thành công: ${agoSec} trước).`);
    }

    response.json({
      server: true,
      timestamp: new Date().toISOString(),
      binanceReachable,
      balanceOk,
      apiKeyConfigured: hasCredentials(),
      sfpEnabled: settings.sfpEnabled,
      sfpSubscriptions: sfpEngine.subscribed.size,
      binanceCooldownSeconds: rateLimit.banned ? rateLimit.waitSeconds : undefined,
      binanceBannedUntil: rateLimit.bannedUntil,
      usedWeight1m: rateLimit.usedWeight1m,
      errors
    });
  });

  app.get("/api/config", (_request, response) => {
    response.json(settingsService.safe());
  });

  app.get("/api/credentials", (_request, response) => {
    response.json(credentialsStatus());
  });

  app.post(
    "/api/credentials",
    asyncRoute(async (request, response) => {
      const apiKey = String(request.body?.apiKey ?? "");
      const apiSecret = String(request.body?.apiSecret ?? "");
      saveBinanceCredentials(apiKey, apiSecret);
      const status = credentialsStatus();
      auditLog.info("Đã lưu Binance API key vào backend local", {
        apiKeyPreview: status.apiKeyPreview
      });
      response.json(status);
    })
  );

  app.post(
    "/api/trading/enable-live",
    asyncRoute(async (request, response) => {
      if (!hasCredentials()) {
        throw new Error("Cần lưu Binance API key/secret trước khi bật giao dịch thật");
      }
      const current = settingsService.get();
      const candidate = settingsService.preview({
        readOnly: false,
        autoTradeEnabled: true,
        dryRun: false,
        binanceTestnet: false
      });
      validateConfigSafety(current, candidate, Boolean(request.body?.riskAccepted));
      strategyEngine.resumeAfterEmergency();
      const settings = settingsService.update({
        readOnly: false,
        autoTradeEnabled: true,
        dryRun: false,
        binanceTestnet: false
      });
      auditLog.warn("Đã mở khóa giao dịch thật", {
        readOnly: settings.readOnly,
        autoTradeEnabled: settings.autoTradeEnabled,
        dryRun: settings.dryRun,
        binanceTestnet: settings.binanceTestnet
      });
      response.json(settingsService.safe(settings));
    })
  );

  app.post(
    "/api/trading/enable-dry-run",
    asyncRoute(async (_request, response) => {
      strategyEngine.resumeAfterEmergency();
      const settings = settingsService.update({
        readOnly: false,
        autoTradeEnabled: true,
        dryRun: true
      });
      auditLog.info("Đã bật giao dịch mô phỏng", {
        readOnly: settings.readOnly,
        autoTradeEnabled: settings.autoTradeEnabled,
        dryRun: settings.dryRun
      });
      response.json(settingsService.safe(settings));
    })
  );

  app.patch(
    "/api/config",
    asyncRoute(async (request, response) => {
      const patch = parseSettingsPatch(request.body ?? {});
      const current = settingsService.get();
      const candidate = settingsService.preview(patch);
      validateConfigSafety(current, candidate, Boolean(request.body?.riskAccepted));
      const next = settingsService.update(patch);
      if (patch.autoTradeEnabled === true) strategyEngine.resumeAfterEmergency();
      // Re-sync WS subscriptions if SFP symbols/timeframes changed — must await so
      // kline buffers are seeded before any subsequent /api/sfp/scan request runs
      if (patch.sfpWatchSymbols !== undefined || patch.sfpTimeframes !== undefined || patch.sfpEnabled !== undefined) {
        await sfpEngine.syncSubscriptions();
      }
      response.json(settingsService.safe(next));
    })
  );

  app.get("/api/overview", (_request, response) => {
    const settings = settingsService.get();
    response.json({
      config: settingsService.safe(settings),
      strategy: strategyEngine.status(),
      latestSignals: strategyEngine.latestSignalsFor(settings.allowedSymbols),
      recentOrders: db.listOrders(10),
      recentLogs: db.listLogs(20)
    });
  });

  app.get(
    "/api/market/overview",
    asyncRoute(async (_request, response) => {
      type RawTicker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string; };
      type RawSymbolInfo = { symbol: string; status: string; contractType: string; quoteAsset: string; onboardDate: number; };

      const [tickers, info] = await Promise.all([
        binanceClient.get24hrTickers() as Promise<RawTicker[]>,
        (binanceClient.getExchangeInfo() as Promise<{ symbols: RawSymbolInfo[] }>),
      ]);

      // Active USDT perpetual contracts only
      const activeSet = new Set<string>();
      const onboardMap = new Map<string, number>();
      for (const s of (info.symbols ?? [])) {
        if (s.status === "TRADING" && s.contractType === "PERPETUAL" && s.quoteAsset === "USDT") {
          activeSet.add(s.symbol);
          onboardMap.set(s.symbol, s.onboardDate);
        }
      }

      const tickerMap = new Map(tickers.map(t => [t.symbol, t]));

      // Gainers/losers: minimum $30M volume → chỉ coin đủ lớn, loại micro-cap pump
      // TopVolume: minimum $5M để không bỏ sót coin mới có volume thật
      const toEntry = (t: RawTicker) => ({
        symbol: t.symbol,
        price: Number(t.lastPrice),
        changePct: Number(t.priceChangePercent),
        volume: Number(t.quoteVolume),
      });

      const movers = tickers
        .filter(t =>
          activeSet.has(t.symbol) &&
          Number(t.quoteVolume) >= 30_000_000 &&   // $30M minimum 24h volume
          Number(t.lastPrice) > 0 &&
          Math.abs(Number(t.priceChangePercent)) < 50  // bỏ qua coin bơm ảo >50%
        )
        .map(toEntry);

      const volList = tickers
        .filter(t => activeSet.has(t.symbol) && Number(t.quoteVolume) >= 5_000_000 && Number(t.lastPrice) > 0)
        .map(toEntry);

      const gainers   = [...movers].sort((a, b) => b.changePct - a.changePct).slice(0, 6);
      const losers    = [...movers].sort((a, b) => a.changePct - b.changePct).slice(0, 6);
      const topVolume = [...volList].sort((a, b) => b.volume - a.volume).slice(0, 6);

      // New listings: sorted by onboardDate desc (real listing date from Binance)
      const newList = [...activeSet]
        .filter(s => tickerMap.has(s) && Number(tickerMap.get(s)!.quoteVolume) > 0)
        .sort((a, b) => (onboardMap.get(b) ?? 0) - (onboardMap.get(a) ?? 0))
        .slice(0, 6)
        .map(s => {
          const t = tickerMap.get(s)!;
          return { symbol: s, price: Number(t.lastPrice), changePct: Number(t.priceChangePercent), volume: Number(t.quoteVolume) };
        });

      response.json({ gainers, losers, newList, topVolume });
    })
  );

  app.get(
    "/api/market/price/:symbol",
    asyncRoute(async (request, response) => {
      response.json(
        await binanceClient.getPrice(
          normalizeUsdFuturesSymbol(String(request.params.symbol))
        )
      );
    })
  );

  app.get(
    "/api/market/rules/:symbol",
    asyncRoute(async (request, response) => {
      response.json(
        await binanceClient.getOrderRules(
          normalizeUsdFuturesSymbol(String(request.params.symbol))
        )
      );
    })
  );

  app.get(
    "/api/market/klines",
    asyncRoute(async (request, response) => {
      const symbol = normalizeUsdFuturesSymbol(
        String(request.query.symbol ?? "BTCUSDT")
      );
      const interval = String(request.query.interval ?? "5m");
      const limit = Number(request.query.limit ?? 100);
      response.json(await binanceClient.getKlines(symbol, interval, limit));
    })
  );

  app.get("/api/market/signals", (request, response) => {
    response.json(strategyEngine.listLatestSignals(Number(request.query.limit ?? 100)));
  });

  app.get(
    "/api/market/top-movers",
    asyncRoute(async (_request, response) => {
      const STABLE = new Set(["BUSDUSDT", "USDCUSDT", "TUSDUSDT", "FDUSDUSDT", "USDTUSDT"]);
      const [tickers, info] = await Promise.all([
        binanceClient.get24hrTickers(),
        binanceClient.getExchangeInfo()
      ]);

      type MoverRow = { symbol: string; change: number; price: number; volume: number; listedAt?: number };
      const toRow = (t: Record<string, unknown>): MoverRow => ({
        symbol: String(t.symbol),
        change: parseFloat(String(t.priceChangePercent)),
        price: parseFloat(String(t.lastPrice)),
        volume: parseFloat(String(t.quoteVolume))
      });

      const activeSet = new Set<string>();
      const onboardMap = new Map<string, number>();
      const syms = (info as Record<string, unknown>).symbols;
      if (Array.isArray(syms)) {
        for (const s of syms as Array<Record<string, unknown>>) {
          const sym = String(s.symbol ?? "").toUpperCase();
          const date = Number(s.onboardDate ?? 0);
          const isActive =
            String(s.status ?? "") === "TRADING" &&
            String(s.contractType ?? "") === "PERPETUAL" &&
            String(s.quoteAsset ?? "") === "USDT" &&
            !STABLE.has(sym);
          if (isActive) activeSet.add(sym);
          if (sym.endsWith("USDT") && date > 0) onboardMap.set(sym, date);
        }
      }

      const filtered = (tickers as Array<Record<string, unknown>>).filter(t => {
        const sym = String(t.symbol ?? "");
        return activeSet.has(sym) && parseFloat(String(t.quoteVolume)) > 1_000_000;
      });

      const gainers = [...filtered]
        .sort((a, b) => parseFloat(String(b.priceChangePercent)) - parseFloat(String(a.priceChangePercent)))
        .slice(0, 5).map(toRow);

      const losers = [...filtered]
        .sort((a, b) => parseFloat(String(a.priceChangePercent)) - parseFloat(String(b.priceChangePercent)))
        .slice(0, 5).map(toRow);

      const newListings = [...filtered]
        .filter(t => onboardMap.has(String(t.symbol)))
        .sort((a, b) => (onboardMap.get(String(b.symbol)) ?? 0) - (onboardMap.get(String(a.symbol)) ?? 0))
        .slice(0, 5)
        .map(t => ({ ...toRow(t), listedAt: onboardMap.get(String(t.symbol)) ?? 0 }));

      const topVolume = [...filtered]
        .sort((a, b) => parseFloat(String(b.quoteVolume)) - parseFloat(String(a.quoteVolume)))
        .slice(0, 100)
        .map(toRow);

      const lowCap = [...filtered]
        .sort((a, b) => parseFloat(String(a.quoteVolume)) - parseFloat(String(b.quoteVolume)))
        .slice(0, 100)
        .map(toRow);

      response.json({ gainers, losers, newListings, topVolume, lowCap });
    })
  );

  const listOpenPositionRows = async (): Promise<Array<{ symbol: string; entryPrice: number }>> => {
    const raw = await binanceClient.getPosition() as unknown[];
    const rows = Array.isArray(raw) ? raw : [raw];
    return rows
      .filter((row) => Math.abs(Number((row as Record<string, unknown>).positionAmt ?? 0)) > 0)
      .map((row) => ({
        symbol: String((row as Record<string, unknown>).symbol ?? ""),
        entryPrice: Number((row as Record<string, unknown>).entryPrice ?? 0)
      }))
      .filter((row) => row.symbol);
  };

  const reconcileOpenPositionSignals = async (): Promise<string[]> => {
    const openPositions = await listOpenPositionRows();
    for (const position of openPositions) {
      db.markLatestSignalExecutedForOpenPosition(
        position.symbol,
        "Đối chiếu Binance: symbol đang có vị thế thật mở, không được hiển thị là bỏ qua.",
        position.entryPrice
      );
    }
    return openPositions.map((position) => position.symbol);
  };

  app.get("/api/sfp/signals", asyncRoute(async (request, response) => {
    await reconcileOpenPositionSignals();
    response.json(db.listSFPSignals(Number(request.query.limit ?? 200)));
  }));

  app.post(
    "/api/sfp/signals/:id/chart",
    asyncRoute(async (request, response) => {
      const id = Number(request.params.id);
      const signal = db.getSFPSignal(id);
      if (!signal) {
        response.status(404).json({ error: "Không tìm thấy SFP signal" });
        return;
      }

      const klines = await binanceClient.getKlines(signal.symbol, signal.timeframe, 100);
      const closedKlines = klines.length > 1 ? klines.slice(0, -1) : klines;
      const chart = await createSignalChart(signal, closedKlines);
      db.updateSFPSignalChart(id, chart.chartPath, chart.chartUrl);
      response.json({ ...signal, chartPath: chart.chartPath, chartUrl: chart.chartUrl });
    })
  );

  app.get("/api/sfp/debug", asyncRoute(async (request, response) => {
    const symbol = normalizeUsdFuturesSymbol(String(request.query.symbol ?? "BTCUSDT"));
    const interval = String(request.query.interval ?? "5m");
    const settings = settingsService.get();

    let klines: unknown[] = [];
    try {
      klines = await binanceClient.getKlines(symbol, interval, 100) as unknown[];
    } catch (e) {
      response.json({ error: `Không lấy được klines: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }

    const { swingFailurePattern } = await import("./strategy/indicators.js");
    type K = { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number; quoteVolume: number; trades: number };
    const typedKlines = klines as K[];
    const closedKlines = typedKlines.length > 1 ? typedKlines.slice(0, -1) : typedKlines;
    const last3 = closedKlines.slice(-3).map(k => ({
      time: new Date(k.openTime).toISOString(),
      open: k.open, high: k.high, low: k.low, close: k.close
    }));

    const results = [];
    for (let lb = 0; lb < 5; lb++) {
      const slice = closedKlines.slice(0, closedKlines.length - lb);
      if (slice.length < 10) break;
      const sfp = swingFailurePattern(slice, settings.sfpLen);
      const lastC = slice[slice.length - 1];
      results.push({
        lookback: lb,
        candleTime: new Date(lastC.openTime).toISOString(),
        candle: { open: lastC.open, high: lastC.high, low: lastC.low, close: lastC.close },
        sfpFound: !!sfp,
        sfpResult: sfp,
        blockedBy: sfp
          ? ((settings.sfpTpPercent > 0 ? settings.sfpTpPercent : settings.tpPercent) <= 0 ? "TP percent <= 0" : null)
          : null
      });
    }

    response.json({
      symbol, interval,
      settings: {
        sfpEnabled: settings.sfpEnabled,
        sfpLen: settings.sfpLen,
        sfpTpPercent: settings.sfpTpPercent,
        sfpCandlestickTpPercent: settings.sfpCandlestickTpPercent,
        sfpLeverage: settings.sfpLeverage,
        sfpMarginUsdt: settings.sfpMarginUsdt,
        sfpAutoExecute: settings.sfpAutoExecute,
        sfpWatchSymbols: settings.sfpWatchSymbols,
        sfpTimeframes: settings.sfpTimeframes,
      },
      last3ClosedCandles: last3,
      analysis: results,
    });
  }));

  app.get("/api/strategy/htf-bias", (_request, response) => {
    const settings = settingsService.get();
    const result: Record<string, unknown> = {};
    for (const sym of settings.allowedSymbols) {
      result[sym] = strategyEngine.getHtfBias(sym);
    }
    response.json(result);
  });

  app.get("/api/sfp/status", (_request, response) => {
    const settings = settingsService.get();
    response.json({
      sfpEnabled: settings.sfpEnabled,
      sfpAutoExecute: settings.sfpAutoExecute,
      subscriptions: sfpEngine.subscribed.size,
      activeKeys: [...sfpEngine.subscribed],
    });
  });

  app.post(
    "/api/sfp/scan",
    asyncRoute(async (_request, response) => {
      const { results, scanned, skipped } = await sfpEngine.scanNow();
      response.json({ ok: true, found: results.length, scanned, skipped, signals: results });
    })
  );

  app.post(
    "/api/sfp/signals/:id/execute",
    asyncRoute(async (request, response) => {
      const id = Number(request.params.id);
      const signal = db.getSFPSignal(id);
      if (!signal) { response.status(404).json({ error: "Không tìm thấy SFP signal" }); return; }
      if (signal.status !== "pending") { response.status(400).json({ error: `Signal đã ở trạng thái ${signal.status}` }); return; }
      const result = await sfpEngine.executeSignal(signal);
      db.pruneTransientTradeData();
      response.json({ ok: result.status === "executed", signal: result });
    })
  );

  app.post(
    "/api/sfp/signals/:id/reject",
    asyncRoute(async (request, response) => {
      const id = Number(request.params.id);
      const signal = db.getSFPSignal(id);
      if (!signal) { response.status(404).json({ error: "Không tìm thấy SFP signal" }); return; }
      const openSymbols = await reconcileOpenPositionSignals();
      if (openSymbols.includes(signal.symbol)) {
        response.json({
          ok: false,
          skipped: true,
          message: "Không thể từ chối: Binance đang có vị thế thật mở cho symbol này."
        });
        return;
      }
      db.updateSFPSignalStatus(id, "rejected", "Đã từ chối bởi người dùng.");
      db.pruneTransientTradeData();
      response.json({ ok: true });
    })
  );

  app.post("/api/sfp/signals/reject-all", asyncRoute(async (_request, response) => {
    const openSymbols = await reconcileOpenPositionSignals();
    const count = db.rejectPendingSFPExceptSymbols(openSymbols);
    db.pruneTransientTradeData();
    auditLog.info(`SFP reject-all: ${count} signal bị bỏ qua`, { skippedOpenSymbols: openSymbols });
    response.json({ ok: true, count, skippedOpenSymbols: openSymbols });
  }));

  app.post(
    "/api/strategy/run-once",
    asyncRoute(async (_request, response) => {
      response.json(await strategyEngine.runOnce());
    })
  );

  app.post(
    "/api/strategy/preview",
    asyncRoute(async (request, response) => {
      const body = request.body as Record<string, unknown>;
      const symbols = Array.isArray(body.symbols)
        ? body.symbols.map(String).map(normalizeUsdFuturesSymbol).filter(Boolean)
        : undefined;
      const intervals = Array.isArray(body.timeframes)
        ? body.timeframes.map(String).map((item) => item.trim()).filter(Boolean)
        : undefined;
      response.json(await strategyEngine.previewOnce({ symbols, intervals }));
    })
  );

  app.post(
    "/api/backtest/strategy",
    asyncRoute(async (request, response) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const strategy = String(body.strategy ?? "smc").toLowerCase();
      if (!["smc", "wyckoff"].includes(strategy)) {
        throw new Error("Backtest hiện hỗ trợ SMC và Wyckoff.");
      }
      const minConfidence = Number(body.minConfidence);
      response.json(await backtestService.run({
        strategy: strategy as "smc" | "wyckoff",
        symbol: normalizeUsdFuturesSymbol(String(body.symbol ?? "BTCUSDT")),
        timeframe: String(body.timeframe ?? "1m"),
        candles: bodyNumber(body, "candles", 1000),
        minConfidence: Number.isFinite(minConfidence) ? minConfidence : undefined,
        maxHoldCandles: bodyNumber(body, "maxHoldCandles", 120),
        maxWaitCandles: bodyNumber(body, "maxWaitCandles", 20)
      }));
    })
  );

  app.get(
    "/api/balance",
    asyncRoute(async (_request, response) => {
      response.json(await binanceClient.getBalance());
    })
  );

  app.get(
    "/api/positions",
    asyncRoute(async (request, response) => {
      const symbol = request.query.symbol
        ? normalizeUsdFuturesSymbol(String(request.query.symbol))
        : undefined;
      response.json(await binanceClient.getPosition(symbol));
    })
  );

  // Move SL to a new price (cancel existing STOP_MARKET then place new one)
  app.post(
    "/api/positions/:symbol/set-sl",
    asyncRoute(async (request, response) => {
      const symbol    = normalizeUsdFuturesSymbol(String(request.params.symbol));
      const newSLPrice = Number(request.body?.stopLossPrice ?? 0);
      if (newSLPrice <= 0) throw new Error("stopLossPrice phải > 0");

      // Get position to know direction
      const positions = (await binanceClient.getPosition(symbol)) as Array<Record<string, unknown>>;
      const pos = positions.find(p => Math.abs(Number(p.positionAmt ?? 0)) > 0);
      if (!pos) throw new Error(`Không tìm thấy vị thế mở cho ${symbol}`);
      const isLong = Number(pos.positionAmt ?? 0) > 0;
      const side   = isLong ? "BUY" : "SELL";

      // Cancel existing STOP_MARKET orders
      const openOrders = (await binanceClient.getOpenOrders(symbol)) as Array<Record<string, unknown>>;
      for (const o of openOrders) {
        if (String(o.type ?? "").includes("STOP") && !String(o.type ?? "").includes("TAKE")) {
          try { await binanceClient.cancelOrder(symbol, o.orderId as string | number); } catch { /* ignore */ }
        }
      }

      // Place new STOP_MARKET
      const result = await binanceClient.createOrder({
        symbol, side, type: "STOP_MARKET",
        stopPrice: String(newSLPrice),
        closePosition: true,
        newClientOrderId: `manual-sl-${Date.now()}`
      });

      auditLog.info(`Manual set SL: ${symbol} → ${newSLPrice}`, { symbol, newSLPrice, side });
      response.json({ ok: true, symbol, newSLPrice, result });
    })
  );

  app.post(
    "/api/positions/:symbol/close",
    asyncRoute(async (request, response) => {
      response.json(
        await orderExecutor.closePosition(
          normalizeUsdFuturesSymbol(String(request.params.symbol)),
          "dashboard"
        )
      );
    })
  );

  app.post(
    "/api/orders/protected",
    asyncRoute(async (request, response) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const settings = settingsService.get();
      const symbol = normalizeUsdFuturesSymbol(String(body.symbol ?? ""));
      const side: TradeSide =
        String(body.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
      const entryType =
        String(body.orderType ?? body.entryType ?? "LIMIT").toUpperCase() ===
        "MARKET"
          ? "MARKET"
          : "LIMIT";
      const leverage = Math.floor(bodyNumber(body, "leverage", settings.fixedLeverage));
      const marginType =
        String(body.marginType ?? settings.sfpMarginType).toUpperCase() === "ISOLATED"
          ? "ISOLATED"
          : "CROSSED";
      const marginUsdt = bodyNumber(body, "marginUsdt", 0);
      let entryPrice = bodyNumber(body, "price", bodyNumber(body, "entryPrice", 0));
      const takeProfitPrice = bodyNumber(body, "takeProfitPrice", 0);
      const stopLossPrice = bodyNumber(body, "stopLossPrice", 0);

      if (!symbol) throw new Error("Cần nhập cặp giao dịch");
      if (!symbol.endsWith("USDT")) {
        throw new Error("Tab này chỉ hỗ trợ Binance Futures USD-M, symbol nên kết thúc bằng USDT");
      }
      if (marginUsdt <= 0) throw new Error("Ký quỹ ban đầu phải lớn hơn 0 USDT");
      if (leverage <= 0) throw new Error("Đòn bẩy phải từ 1x trở lên");
      if (entryType === "LIMIT" && entryPrice <= 0) {
        throw new Error("Lệnh Limit cần giá vào lệnh lớn hơn 0");
      }
      if (entryType === "MARKET" && entryPrice <= 0) {
        entryPrice = tickerPrice(await binanceClient.getPrice(symbol));
      }
      if (entryPrice <= 0) throw new Error("Không xác định được giá vào lệnh");
      if (takeProfitPrice <= 0 || stopLossPrice <= 0) {
        throw new Error("Bắt buộc nhập cả Take Profit và Stop Loss");
      }

      const quantity = (marginUsdt * leverage) / entryPrice;
      const result = await orderExecutor.executeProtectedTrade({
        symbol,
        side,
        entryType,
        quantity,
        entryPrice,
        stopLossPrice,
        takeProfitPrice,
        leverage,
        marginType,
        source: "dashboard",
        reason: "manual-dashboard"
      });
      response.json({ ok: true, result });
    })
  );

  app.get(
    "/api/orders/open",
    asyncRoute(async (request, response) => {
      const symbol = request.query.symbol ? String(request.query.symbol) : undefined;
      const ordersRaw = await binanceClient.getOpenOrders(symbol);
      let algoOrdersRaw: unknown = [];
      try {
        algoOrdersRaw = await binanceClient.getOpenAlgoOrders(symbol);
      } catch (error) {
        auditLog.warn("Khong the doc openAlgoOrders TP/SL", {
          symbol,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
      const algoOrders = (Array.isArray(algoOrdersRaw) ? algoOrdersRaw : []).map((row) => {
        if (!row || typeof row !== "object") return row;
        const order = row as Record<string, unknown>;
        return {
          ...order,
          type: order.type ?? order.orderType,
          stopPrice: order.stopPrice ?? order.triggerPrice,
          status: order.status ?? order.algoStatus,
          orderId: order.orderId ?? order.algoId,
          clientOrderId: order.clientOrderId ?? order.clientAlgoId,
          isAlgo: true
        };
      });
      response.json([...orders, ...algoOrders]);
    })
  );

  app.get("/api/orders/history", (request, response) => {
    response.json(db.listOrders(Number(request.query.limit ?? 100)));
  });

  app.get("/api/logs", (request, response) => {
    response.json(db.listLogs(Number(request.query.limit ?? 200)));
  });

  app.get("/api/ai/config", (_request, response) => {
    response.json(aiTrainingService.config());
  });

  app.post(
    "/api/ai/config",
    asyncRoute(async (request, response) => {
      response.json(aiTrainingService.saveConfig({
        apiKey: request.body?.apiKey === undefined ? undefined : String(request.body.apiKey),
        baseUrl: request.body?.baseUrl === undefined ? undefined : String(request.body.baseUrl),
        model: request.body?.model === undefined ? undefined : String(request.body.model)
      }));
    })
  );

  app.post(
    "/api/ai/test",
    asyncRoute(async (_request, response) => {
      response.json(await aiTrainingService.testConnection());
    })
  );

  app.get("/api/ai/documents", (request, response) => {
    response.json(aiTrainingService.listDocuments(Number(request.query.limit ?? 100)));
  });

  app.post(
    "/api/ai/documents",
    asyncRoute(async (request, response) => {
      response.json(aiTrainingService.addDocument({
        name: request.body?.name,
        kind: request.body?.kind,
        mimeType: request.body?.mimeType,
        content: request.body?.content,
        tags: Array.isArray(request.body?.tags) ? request.body.tags : []
      }));
    })
  );

  app.delete(
    "/api/ai/documents/:id",
    asyncRoute(async (request, response) => {
      response.json(aiTrainingService.deleteDocument(Number(request.params.id)));
    })
  );

  app.get("/api/ai/runs", (request, response) => {
    response.json(aiTrainingService.listRuns(Number(request.query.limit ?? 30)));
  });

  app.post(
    "/api/ai/analyze",
    asyncRoute(async (request, response) => {
      response.json(await aiTrainingService.analyze({
        prompt: request.body?.prompt,
        documentIds: Array.isArray(request.body?.documentIds) ? request.body.documentIds : []
      }));
    })
  );

  app.post(
    "/api/emergency-stop",
    asyncRoute(async (_request, response) => {
      strategyEngine.emergencyStop();
      const currentSettings = settingsService.get();
      const cancelResults = [];
      for (const symbol of currentSettings.allowedSymbols) {
        try {
          cancelResults.push(await orderExecutor.cancelAllOpenOrders(symbol));
        } catch (error) {
          cancelResults.push({
            symbol,
            skipped: true,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const settings = settingsService.update({ autoTradeEnabled: false });
      auditLog.warn("Đã kích hoạt dừng khẩn cấp", { cancelResults });
      response.json({
        ok: true,
        config: settingsService.safe(settings),
        strategy: strategyEngine.status(),
        cancelResults
      });
    })
  );

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();

    const send = (event: AppEvent) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      send({
        type: "strategy.tick",
        data: { heartbeat: true },
        createdAt: new Date().toISOString()
      });
    }, staticConfig.sseHeartbeatSeconds * 1000);

    appEvents.on("event", send);
    request.on("close", () => {
      clearInterval(heartbeat);
      appEvents.off("event", send);
    });
  });

  const dashboardDist = path.resolve(process.cwd(), "dist/dashboard");
  if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
    app.use(express.static(dashboardDist));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(dashboardDist, "index.html"));
    });
  }

  app.use(
    (
      error: Error,
      _request: Request,
      response: Response,
      _next: NextFunction
    ) => {
      auditLog.error("HTTP request thất bại", { error: error.message });
      const rateLimit = binanceClient.rateLimitStatus();
      const isBinanceCooldown = rateLimit.banned || error.message.includes("Binance IP");
      if (isBinanceCooldown) {
        response.setHeader("Retry-After", String(Math.max(1, rateLimit.waitSeconds)));
        response.status(429).json({
          error: error.message,
          binanceCooldownSeconds: Math.max(1, rateLimit.waitSeconds),
          binanceBannedUntil: rateLimit.bannedUntil
        });
        return;
      }
      response.status(400).json({ error: error.message });
    }
  );

  return app;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entryPath) {
  const app = createHttpApp();
  const listenHost = process.env.HOST ?? "::";
  app.listen(staticConfig.port, listenHost, () => {
    auditLog.info(`API đang lắng nghe tại ${listenHost}:${staticConfig.port}`);
    const pruneTransientData = () => {
      const result = db.pruneTransientTradeData();
      const total =
        result.marketSignals +
        result.transientSfpSignals +
        result.dryRunOrders +
        result.chartFiles;
      if (total > 0) {
        auditLog.info("Da don du lieu scan khong vao lenh that", result);
      }
    };
    pruneTransientData();
    const pruneTimer = setInterval(pruneTransientData, 30_000);
    pruneTimer.unref?.();
    strategyEngine.start();
    liquidationGuard.start();
    sfpMonitor.start();
    positionManager.start();
    // Start WS manager first, then SFP engine (which needs WS subscriptions)
    void wsManager.subscribeUserData().then(() => {
      void sfpEngine.start();
    });
    // Push real-time position updates from WS to SSE clients
    wsManager.on("position:update", (ev) => {
      appEvents.publish("position.update", ev);
    });
  });
}
