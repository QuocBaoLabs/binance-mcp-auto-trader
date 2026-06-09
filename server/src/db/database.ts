import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { staticConfig } from "../config.js";
import type {
  AITrainingDocument,
  AITrainingDocumentKind,
  AITrainingRun,
  MarketSignal,
  RuntimeSettings,
  SFPSignalRecord,
  SFPSignalStatus
} from "../types.js";

type SFPSignalRow = Omit<SFPSignalRecord, "confirmed" | "decisionDetails"> & {
  confirmed: number;
  decisionDetails?: string | null;
  hasSfp?: number | null;
  chartPath?: string | null;
  chartUrl?: string | null;
  executeAfter?: string | null;
  closedAt?: string | null;
  closePrice?: number | null;
  realizedPnlUsdt?: number | null;
  realizedPnlPct?: number | null;
};

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(filePath = staticConfig.sqlitePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.pruneTransientTradeData();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        signal TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        price REAL NOT NULL,
        ema_fast REAL,
        ema_slow REAL,
        ema_10 REAL,
        ema_36 REAL,
        rsi REAL,
        volume_change REAL,
        funding_rate REAL,
        open_interest REAL,
        long_short_ratio REAL,
        supertrend REAL,
        supertrend_direction TEXT,
        bb_upper REAL,
        bb_middle REAL,
        bb_lower REAL,
        sar REAL,
        sar_direction TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_signals_symbol_time
        ON signals(symbol, created_at DESC);

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity TEXT,
        price TEXT,
        stop_price TEXT,
        status TEXT NOT NULL,
        binance_order_id TEXT,
        client_order_id TEXT,
        dry_run INTEGER NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_orders_symbol_time
        ON orders(symbol, created_at DESC);

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_logs_time
        ON logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS daily_risk (
        date TEXT PRIMARY KEY,
        realized_pnl_usdt REAL NOT NULL DEFAULT 0,
        tripped INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tradingview_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        trade_side TEXT,
        order_type TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        entry_price REAL NOT NULL,
        take_profit_price REAL NOT NULL,
        stop_loss_price REAL NOT NULL,
        margin_usdt REAL,
        leverage REAL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tradingview_signals_time
        ON tradingview_signals(created_at DESC);

      DROP TABLE IF EXISTS strategies;

      CREATE TABLE IF NOT EXISTS sfp_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy TEXT NOT NULL DEFAULT 'sfp',
        pattern_name TEXT,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0,
        swing_price REAL NOT NULL,
        opposite_level REAL NOT NULL,
        sfp_candle_high REAL NOT NULL,
        sfp_candle_low REAL NOT NULL,
        entry_price REAL NOT NULL,
        sl_price REAL NOT NULL,
        tp_price REAL NOT NULL,
        leverage INTEGER NOT NULL,
        margin_usdt REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT NOT NULL DEFAULT '',
        decision TEXT,
        decision_score REAL,
        decision_summary TEXT,
        decision_details TEXT,
        has_sfp INTEGER NOT NULL DEFAULT 0,
        chart_path TEXT,
        chart_url TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_sfp_signals_time
        ON sfp_signals(created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_training_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_training_documents_time
        ON ai_training_documents(created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_training_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        document_ids TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT NOT NULL,
        parsed_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_training_runs_time
        ON ai_training_runs(created_at DESC);
    `);
    this.addMissingSignalColumns();
    this.addMissingSFPColumns();
  }

  private addMissingSFPColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(sfp_signals)").all() as Array<{ name: string }>;
    const existing = new Set(rows.map(r => r.name));
    if (!existing.has("execute_after")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN execute_after TEXT");
    }
    if (!existing.has("strategy")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN strategy TEXT NOT NULL DEFAULT 'sfp'");
    }
    if (!existing.has("pattern_name")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN pattern_name TEXT");
    }
    if (!existing.has("closed_at")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN closed_at TEXT");
    }
    if (!existing.has("close_price")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN close_price REAL");
    }
    if (!existing.has("realized_pnl_usdt")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN realized_pnl_usdt REAL");
    }
    if (!existing.has("realized_pnl_pct")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN realized_pnl_pct REAL");
    }
    if (!existing.has("decision")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN decision TEXT");
    }
    if (!existing.has("decision_score")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN decision_score REAL");
    }
    if (!existing.has("decision_summary")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN decision_summary TEXT");
    }
    if (!existing.has("decision_details")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN decision_details TEXT");
    }
    if (!existing.has("has_sfp")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN has_sfp INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE sfp_signals SET has_sfp = 1 WHERE strategy = 'sfp' OR pattern_name LIKE '%SFP%'");
    }
    if (!existing.has("chart_path")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN chart_path TEXT");
    }
    if (!existing.has("chart_url")) {
      this.db.exec("ALTER TABLE sfp_signals ADD COLUMN chart_url TEXT");
    }
  }

  private addMissingSignalColumns(): void {
    const rows = this.db.prepare("PRAGMA table_info(signals)").all() as Array<{
      name: string;
    }>;
    const existing = new Set(rows.map((row) => row.name));
    const columns: Record<string, string> = {
      ema_10: "REAL",
      ema_36: "REAL",
      supertrend: "REAL",
      supertrend_direction: "TEXT",
      bb_upper: "REAL",
      bb_middle: "REAL",
      bb_lower: "REAL",
      sar: "REAL",
      sar_direction: "TEXT"
    };
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE signals ADD COLUMN ${name} ${type}`);
      }
    }
  }

  getSetting(key: keyof RuntimeSettings): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: keyof RuntimeSettings, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(key, JSON.stringify(value));
  }

  insertSignal(signal: MarketSignal): void {
    this.db
      .prepare(
        `INSERT INTO signals (
          symbol, interval, signal, confidence, reason, price,
          ema_fast, ema_slow, ema_10, ema_36, rsi, volume_change, funding_rate,
          open_interest, long_short_ratio, supertrend, supertrend_direction,
          bb_upper, bb_middle, bb_lower, sar, sar_direction, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        signal.symbol,
        signal.interval,
        signal.signal,
        signal.confidence,
        signal.reason,
        signal.price,
        signal.emaFast,
        signal.emaSlow,
        signal.ema10,
        signal.ema36,
        signal.rsi,
        signal.volumeChange,
        signal.fundingRate,
        signal.openInterest,
        signal.longShortRatio,
        signal.supertrend,
        signal.supertrendDirection,
        signal.bbUpper,
        signal.bbMiddle,
        signal.bbLower,
        signal.sar,
        signal.sarDirection,
        signal.createdAt
      );
  }

  listSignals(limit = 100): MarketSignal[] {
    const rows = this.db
      .prepare(
        `SELECT symbol, interval, signal, confidence, reason, price,
          ema_fast AS emaFast, ema_slow AS emaSlow, ema_10 AS ema10,
          ema_36 AS ema36, rsi, volume_change AS volumeChange,
          funding_rate AS fundingRate, open_interest AS openInterest,
          long_short_ratio AS longShortRatio, supertrend,
          supertrend_direction AS supertrendDirection, bb_upper AS bbUpper,
          bb_middle AS bbMiddle, bb_lower AS bbLower, sar,
          sar_direction AS sarDirection, created_at AS createdAt
        FROM signals ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as MarketSignal[];
    return rows;
  }

  latestSignalBySymbol(symbol: string): MarketSignal | undefined {
    const row = this.db
      .prepare(
        `SELECT symbol, interval, signal, confidence, reason, price,
          ema_fast AS emaFast, ema_slow AS emaSlow, ema_10 AS ema10,
          ema_36 AS ema36, rsi, volume_change AS volumeChange,
          funding_rate AS fundingRate, open_interest AS openInterest,
          long_short_ratio AS longShortRatio, supertrend,
          supertrend_direction AS supertrendDirection, bb_upper AS bbUpper,
          bb_middle AS bbMiddle, bb_lower AS bbLower, sar,
          sar_direction AS sarDirection, created_at AS createdAt
        FROM signals WHERE symbol = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(symbol) as MarketSignal | undefined;
    return row;
  }

  insertOrder(order: {
    symbol: string;
    side: string;
    type: string;
    quantity?: string;
    price?: string;
    stopPrice?: string;
    status: string;
    binanceOrderId?: string | number;
    clientOrderId?: string;
    dryRun: boolean;
    source: string;
    payload: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO orders (
          symbol, side, type, quantity, price, stop_price, status,
          binance_order_id, client_order_id, dry_run, source, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        order.symbol,
        order.side,
        order.type,
        order.quantity ?? null,
        order.price ?? null,
        order.stopPrice ?? null,
        order.status,
        order.binanceOrderId?.toString() ?? null,
        order.clientOrderId ?? null,
        order.dryRun ? 1 : 0,
        order.source,
        JSON.stringify(order.payload)
      );
  }

  listOrders(limit = 100): unknown[] {
    return this.db
      .prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  insertLog(level: string, message: string, context?: unknown): void {
    this.db
      .prepare("INSERT INTO logs (level, message, context) VALUES (?, ?, ?)")
      .run(level, message, context === undefined ? null : JSON.stringify(context));
  }

  listLogs(limit = 200): unknown[] {
    return this.db
      .prepare("SELECT * FROM logs ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  pruneTransientTradeData(): {
    marketSignals: number;
    transientSfpSignals: number;
    dryRunOrders: number;
    chartFiles: number;
  } {
    const chartRows = this.db
      .prepare(
        `SELECT chart_path AS chartPath
         FROM sfp_signals
         WHERE status = 'simulated'
           AND chart_path IS NOT NULL
           AND chart_path != ''`
      )
      .all() as Array<{ chartPath: string }>;

    const marketSignals = this.db.prepare("DELETE FROM signals").run().changes;
    const transientSfpSignals = this.db
      .prepare("DELETE FROM sfp_signals WHERE status = 'simulated'")
      .run().changes;
    const dryRunOrders = this.db.prepare("DELETE FROM orders WHERE dry_run = 1").run().changes;

    let chartFiles = 0;
    for (const row of chartRows) {
      if (this.deleteSignalChart(row.chartPath)) chartFiles += 1;
    }

    return { marketSignals, transientSfpSignals, dryRunOrders, chartFiles };
  }

  private deleteSignalChart(chartPath: string): boolean {
    try {
      const resolvedPath = path.resolve(chartPath);
      const chartDir = path.resolve(staticConfig.signalChartDir);
      const relative = path.relative(chartDir, resolvedPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
      if (!fs.existsSync(resolvedPath)) return false;
      fs.unlinkSync(resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  insertAITrainingDocument(document: AITrainingDocument): AITrainingDocument {
    const result = this.db
      .prepare(
        `INSERT INTO ai_training_documents (
          name, kind, mime_type, content, size_bytes, tags, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.name,
        document.kind,
        document.mimeType,
        document.content,
        document.sizeBytes,
        JSON.stringify(document.tags),
        document.createdAt
      );
    return { ...document, id: Number(result.lastInsertRowid) };
  }

  listAITrainingDocuments(limit = 100): AITrainingDocument[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, kind, mime_type AS mimeType, content, size_bytes AS sizeBytes,
          tags, created_at AS createdAt
        FROM ai_training_documents ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<Omit<AITrainingDocument, "tags" | "kind"> & { kind: string; tags: string }>;
    return rows.map((row) => this.mapAITrainingDocument(row));
  }

  getAITrainingDocuments(ids: number[]): AITrainingDocument[] {
    const cleanIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (cleanIds.length === 0) return [];
    const placeholders = cleanIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, name, kind, mime_type AS mimeType, content, size_bytes AS sizeBytes,
          tags, created_at AS createdAt
        FROM ai_training_documents WHERE id IN (${placeholders})`
      )
      .all(...cleanIds) as Array<Omit<AITrainingDocument, "tags" | "kind"> & { kind: string; tags: string }>;
    return rows.map((row) => this.mapAITrainingDocument(row));
  }

  deleteAITrainingDocument(id: number): boolean {
    const result = this.db.prepare("DELETE FROM ai_training_documents WHERE id = ?").run(id);
    return result.changes > 0;
  }

  insertAITrainingRun(run: AITrainingRun): AITrainingRun {
    const result = this.db
      .prepare(
        `INSERT INTO ai_training_runs (
          prompt, document_ids, model, status, output, parsed_json, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.prompt,
        JSON.stringify(run.documentIds),
        run.model,
        run.status,
        run.output,
        run.parsedJson === undefined ? null : JSON.stringify(run.parsedJson),
        run.error ?? null,
        run.createdAt
      );
    return { ...run, id: Number(result.lastInsertRowid) };
  }

  listAITrainingRuns(limit = 30): AITrainingRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, prompt, document_ids AS documentIds, model, status, output,
          parsed_json AS parsedJson, error, created_at AS createdAt
        FROM ai_training_runs ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<Omit<AITrainingRun, "documentIds" | "parsedJson"> & {
        documentIds: string;
        parsedJson: string | null;
        status: string;
      }>;
    return rows.map((row) => ({
      ...row,
      status: row.status === "ok" ? "ok" : "error",
      documentIds: parseJsonArray(row.documentIds).map(Number).filter((id) => Number.isInteger(id)),
      parsedJson: parseOptionalJson(row.parsedJson)
    }));
  }

  private mapAITrainingDocument(
    row: Omit<AITrainingDocument, "tags" | "kind"> & { kind: string; tags: string }
  ): AITrainingDocument {
    const kindValues: AITrainingDocumentKind[] = ["text", "image", "prompt", "candlestick", "strategy", "other"];
    const kind = kindValues.includes(row.kind as AITrainingDocumentKind)
      ? (row.kind as AITrainingDocumentKind)
      : "other";
    return {
      ...row,
      kind,
      tags: parseJsonArray(row.tags).map(String)
    };
  }

  getTodayRisk(date: string): { realized_pnl_usdt: number; tripped: number } {
    const row = this.db
      .prepare("SELECT realized_pnl_usdt, tripped FROM daily_risk WHERE date = ?")
      .get(date) as { realized_pnl_usdt: number; tripped: number } | undefined;
    return row ?? { realized_pnl_usdt: 0, tripped: 0 };
  }

  insertSFPSignal(signal: SFPSignalRecord): SFPSignalRecord {
    const result = this.db
      .prepare(
        `INSERT INTO sfp_signals (
          strategy, pattern_name, symbol, timeframe, direction, confirmed, swing_price, opposite_level,
          sfp_candle_high, sfp_candle_low, entry_price, sl_price, tp_price,
          leverage, margin_usdt, status, message, decision, decision_score,
          decision_summary, decision_details, has_sfp, chart_path, chart_url,
          execute_after, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        signal.strategy ?? "sfp", signal.patternName ?? null,
        signal.symbol, signal.timeframe, signal.direction, signal.confirmed ? 1 : 0,
        signal.swingPrice, signal.oppositeLevel, signal.sfpCandleHigh, signal.sfpCandleLow,
        signal.entryPrice, signal.slPrice, signal.tpPrice,
        signal.leverage, signal.marginUsdt, signal.status, signal.message,
        signal.decision ?? null, signal.decisionScore ?? null,
        signal.decisionSummary ?? null,
        signal.decisionDetails ? JSON.stringify(signal.decisionDetails) : null,
        signal.hasSfp ? 1 : 0,
        signal.chartPath ?? null,
        signal.chartUrl ?? null,
        signal.executeAfter ?? null, signal.createdAt
      );
    return { ...signal, id: Number(result.lastInsertRowid) };
  }

  updateSFPSignalChart(id: number, chartPath: string, chartUrl: string): void {
    this.db
      .prepare("UPDATE sfp_signals SET chart_path = ?, chart_url = ? WHERE id = ?")
      .run(chartPath, chartUrl, id);
  }

  updateSFPSignalMargin(id: number, marginUsdt: number): void {
    this.db
      .prepare("UPDATE sfp_signals SET margin_usdt = ? WHERE id = ?")
      .run(marginUsdt, id);
  }

  updateSFPSignalStatus(id: number, status: SFPSignalStatus, message: string): void {
    this.db
      .prepare("UPDATE sfp_signals SET status = ?, message = ? WHERE id = ?")
      .run(status, message, id);
  }

  ignoreSFPSignal(id: number, message: string): void {
    this.db
      .prepare("UPDATE sfp_signals SET status = 'ignored', message = ?, execute_after = NULL WHERE id = ?")
      .run(message, id);
  }

  ignorePendingSFPSignals(message: string): number {
    const result = this.db
      .prepare("UPDATE sfp_signals SET status = 'ignored', message = ?, execute_after = NULL WHERE status = 'pending'")
      .run(message);
    return result.changes;
  }

  // Called when a LIMIT order is physically sent to Binance.
  // Sets a dedicated status so the auto queue won't re-queue it and exposure is counted correctly.
  markLimitPlaced(id: number, message: string): void {
    this.db
      .prepare("UPDATE sfp_signals SET status = 'limit_placed', message = ?, execute_after = NULL WHERE id = ?")
      .run(message, id);
  }

  // Signals where a LIMIT order was placed and is waiting for fill
  listPendingLimitSignals(): SFPSignalRecord[] {
    const rows = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals
      WHERE status = 'limit_placed'
      ORDER BY created_at DESC`)
      .all() as SFPSignalRow[];
    return rows.map(r => this.mapSFP(r));
  }

  closeSFPSignal(id: number, status: SFPSignalStatus, closePrice: number, realizedPnlUsdt: number, realizedPnlPct: number): void {
    this.db
      .prepare(`UPDATE sfp_signals
        SET status = ?, closed_at = CURRENT_TIMESTAMP, close_price = ?,
            realized_pnl_usdt = ?, realized_pnl_pct = ?
        WHERE id = ?`)
      .run(status, closePrice, realizedPnlUsdt, realizedPnlPct, id);
  }

  listExecutedSFPSignals(): SFPSignalRecord[] {
    const rows = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals WHERE status = 'executed' ORDER BY created_at DESC`)
      .all() as SFPSignalRow[];
    return rows.map(r => this.mapSFP(r));
  }

  rejectAllPendingSFP(): number {
    const result = this.db
      .prepare("UPDATE sfp_signals SET status = 'rejected', message = 'Bỏ qua hàng loạt' WHERE status IN ('pending', 'limit_placed')")
      .run();
    return result.changes;
  }

  rejectPendingSFPExceptSymbols(excludedSymbols: string[]): number {
    const symbols = [...new Set(excludedSymbols.filter(Boolean))];
    const symbolClause = symbols.length > 0
      ? ` AND symbol NOT IN (${symbols.map(() => "?").join(",")})`
      : "";
    const result = this.db
      .prepare(`UPDATE sfp_signals
        SET status = 'rejected', message = 'Bỏ qua hàng loạt'
        WHERE status IN ('pending', 'limit_placed')${symbolClause}`)
      .run(...symbols);
    return result.changes;
  }

  markLatestSignalExecutedForOpenPosition(symbol: string, message: string, entryPrice = 0): number {
    const result = this.db
      .prepare(`UPDATE sfp_signals
        SET status = 'executed',
            message = ?,
            execute_after = NULL,
            entry_price = CASE WHEN ? > 0 THEN ? ELSE entry_price END
        WHERE id = (
          SELECT id FROM sfp_signals
          WHERE symbol = ?
            AND status IN ('pending', 'limit_placed', 'rejected', 'ignored', 'executed')
            AND closed_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        )`)
      .run(message, entryPrice, entryPrice, symbol);
    return result.changes;
  }

  private static readonly SFP_SELECT = `SELECT id, strategy, pattern_name AS patternName,
    symbol, timeframe, direction,
    confirmed, swing_price AS swingPrice, opposite_level AS oppositeLevel,
    sfp_candle_high AS sfpCandleHigh, sfp_candle_low AS sfpCandleLow,
    entry_price AS entryPrice, sl_price AS slPrice, tp_price AS tpPrice,
    leverage, margin_usdt AS marginUsdt, status, message,
    decision, decision_score AS decisionScore, decision_summary AS decisionSummary,
    decision_details AS decisionDetails,
    has_sfp AS hasSfp, chart_path AS chartPath, chart_url AS chartUrl,
    execute_after AS executeAfter, created_at AS createdAt,
    closed_at AS closedAt, close_price AS closePrice,
    realized_pnl_usdt AS realizedPnlUsdt, realized_pnl_pct AS realizedPnlPct`;

  private mapSFP(row: SFPSignalRow): SFPSignalRecord {
    let decisionDetails: SFPSignalRecord["decisionDetails"] = undefined;
    if (typeof row.decisionDetails === "string" && row.decisionDetails.trim()) {
      try {
        decisionDetails = JSON.parse(row.decisionDetails) as SFPSignalRecord["decisionDetails"];
      } catch {
        decisionDetails = undefined;
      }
    }
    return {
      ...row,
      confirmed: row.confirmed === 1,
      decisionDetails,
      hasSfp: row.hasSfp === 1 || row.strategy === "sfp" || /SFP/i.test(row.patternName ?? ""),
      chartPath: row.chartPath ?? undefined,
      chartUrl: row.chartUrl ?? undefined,
      executeAfter: row.executeAfter ?? undefined,
      closedAt: row.closedAt ?? undefined,
      closePrice: row.closePrice ?? undefined,
      realizedPnlUsdt: row.realizedPnlUsdt ?? undefined,
      realizedPnlPct: row.realizedPnlPct ?? undefined,
    };
  }

  getSFPSignal(id: number): SFPSignalRecord | undefined {
    const row = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals WHERE id = ?`)
      .get(id) as SFPSignalRow | undefined;
    if (!row) return undefined;
    return this.mapSFP(row);
  }

  listSFPSignals(limit = 50): SFPSignalRecord[] {
    const rows = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as SFPSignalRow[];
    return rows.map(r => this.mapSFP(r));
  }

  latestSFPSignal(symbol: string, timeframe: string): SFPSignalRecord | undefined {
    const row = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals WHERE symbol = ? AND timeframe = ? ORDER BY created_at DESC LIMIT 1`)
      .get(symbol, timeframe) as SFPSignalRow | undefined;
    if (!row) return undefined;
    return this.mapSFP(row);
  }

  recentSFPSignals(symbol: string, sinceIso: string, limit = 100): SFPSignalRecord[] {
    const rows = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals
      WHERE symbol = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?`)
      .all(symbol, sinceIso, limit) as SFPSignalRow[];
    return rows.map(r => this.mapSFP(r));
  }

  listPendingAutoExecute(nowIso: string): SFPSignalRecord[] {
    const rows = this.db.prepare(`${AppDatabase.SFP_SELECT} FROM sfp_signals
      WHERE status = 'pending' AND execute_after IS NOT NULL AND execute_after <= ?
      ORDER BY execute_after ASC`)
      .all(nowIso) as SFPSignalRow[];
    return rows.map(r => this.mapSFP(r));
  }

  upsertTodayRisk(date: string, realizedPnlUsdt: number, tripped: boolean): void {
    this.db
      .prepare(
        `INSERT INTO daily_risk (date, realized_pnl_usdt, tripped, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(date) DO UPDATE SET
           realized_pnl_usdt = excluded.realized_pnl_usdt,
           tripped = excluded.tripped,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(date, realizedPnlUsdt, tripped ? 1 : 0);
  }

}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseOptionalJson(value: string | null | undefined): unknown | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
