import { BinanceClient } from "./binance/client.js";
import { AITrainingService } from "./ai/ai-training-service.js";
import { BacktestService } from "./backtest/backtest-service.js";
import { BinanceWSManager } from "./binance/ws-manager.js";
import { AppDatabase } from "./db/database.js";
import { OrderExecutor } from "./orders/order-executor.js";
import { LiquidationGuard } from "./risk/liquidation-guard.js";
import { PositionManager } from "./risk/position-manager.js";
import { RiskManager } from "./risk/risk-manager.js";
import { AuditLogService } from "./services/audit-log.js";
import { SettingsService } from "./services/settings.js";
import { SFPEngine } from "./sfp/sfp-engine.js";
import { SFPMonitor } from "./sfp/sfp-monitor.js";
import { StrategyEngine } from "./strategy/strategy-engine.js";
import { staticConfig } from "./config.js";

export const db = new AppDatabase();
export const settingsService = new SettingsService(db);
export const auditLog = new AuditLogService(db);
export const aiTrainingService = new AITrainingService(db, auditLog);
export const binanceClient = new BinanceClient(settingsService);
export const backtestService = new BacktestService(binanceClient, settingsService);
export const wsManager = new BinanceWSManager(
  "wss://fstream.binance.com",
  "https://fapi.binance.com",
  "wss://stream.binancefuture.com",
  "https://testnet.binancefuture.com",
  () => settingsService.get().binanceTestnet,
  () => staticConfig.apiKey
);
export const riskManager = new RiskManager(
  settingsService,
  binanceClient,
  db,
  auditLog
);
export const orderExecutor = new OrderExecutor(
  settingsService,
  binanceClient,
  db,
  riskManager,
  auditLog
);
export const strategyEngine = new StrategyEngine(
  settingsService,
  binanceClient,
  wsManager,
  db,
  auditLog,
  orderExecutor
);
export const sfpEngine = new SFPEngine(
  settingsService,
  binanceClient,
  wsManager,
  db,
  orderExecutor,
  auditLog
);
export const liquidationGuard = new LiquidationGuard(
  binanceClient,
  orderExecutor,
  settingsService,
  auditLog
);
export const sfpMonitor = new SFPMonitor(db, binanceClient, auditLog);
export const positionManager = new PositionManager(binanceClient, wsManager, settingsService, auditLog);
