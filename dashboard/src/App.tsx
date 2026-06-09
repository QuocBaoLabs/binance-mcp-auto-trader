import FuturisticBackground from "./FuturisticBackground";
import DataSphere from "./DataSphere";
import CursorGlow from "./CursorGlow";
import SplashScreen from "./SplashScreen";
import PriceWarpEffect, { type WarpTrigger } from "./PriceWarpEffect";
import MilitaryRadar from "./MilitaryRadar";
import {
  Activity,
  AlertTriangle,
  Brain,
  CircleStop,
  FlaskConical,
  Info,
  KeyRound,
  Lock,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Unlock,
  Upload,
  Volume2,
  Wallet,
  X,
  FileText,
  History as HistoryIcon,
  TrendingUp
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Page =
  | "overview"
  | "trade"
  | "positions"
  | "signals"
  | "history"
  | "logs"
  | "backtest"
  | "audio"
  | "ai"
  | "api";

type TradingMode = "dry_run" | "testnet" | "live";

interface RuntimeSettings {
  readOnly: boolean;
  autoTradeEnabled: boolean;
  dryRun: boolean;
  binanceTestnet: boolean;
  allowMarketOrder: boolean;
  allowedSymbols: string[];
  maxOrderUsdt: number;
  maxDailyLossUsdt: number;
  maxOpenPositions: number;
  maxLeverage: number;
  tpPercent: number;
  slPercent: number;
  minConfidence: number;
  strategyIntervalSeconds: number;
  klineInterval: string;
  strategyMode: "score" | "rules" | "hybrid" | "wyckoff" | "smc";
  touchTolerancePercent: number;
  ruleSupertrendEma10Long: boolean;
  ruleSupertrendEma10Short: boolean;
  ruleRequireTrendDirection: boolean;
  ruleRequireEma10Touch: boolean;
  ruleRequireSupertrendTouch: boolean;
  ruleBollingerReversion: boolean;
  wyckoffRsiLength: number;
  wyckoffTrendSensitivity: number;
  wyckoffPivotLength: number;
  wyckoffUseVolumeFilter: boolean;
  wyckoffVolumeMaLength: number;
  wyckoffBreakoutBufferPct: number;
  wyckoffRetestTolerancePct: number;
  wyckoffMaxRiskDistancePct: number;
  wyckoffMinConfidence: number;
  supertrendPeriod: number;
  supertrendMultiplier: number;
  bollingerPeriod: number;
  bollingerStdDev: number;
  sarStep: number;
  sarMax: number;
  leverageMode: "fixed" | "auto";
  fixedLeverage: number;
  minLeverage: number;
  volatilityTimeframe: string;
  volatilityLookback: number;
  lowVolatilityThreshold: number;
  mediumVolatilityThreshold: number;
  highVolatilityThreshold: number;
  extremeVolatilityThreshold: number;
  skipTradeOnExtremeVolatility: boolean;
  sfpEnabled: boolean;
  sfpStrategies: Array<"sfp" | "candlestick" | "wyckoff" | "smc">;
  sfpLen: number;
  ruleSfpSignal: boolean;
  sfpWatchSymbols: string[];
  sfpTimeframes: string[];
  smcAutoTimeframes: boolean;
  smcPreferredRR: number;
  smcRelaxedRRTP: boolean;
  smcTakeProfitRoiPercent: number;
  smcMinScore: number;
  smcMaxBarsAfterSweepForMSS: number;
  smcFvgMinSizePct: number;
  smcAvoidMiddleOfRange: boolean;
  smcFvgMaxBarsAfterMss: number;
  sfpLeverage: number;
  sfpMarginUsdt: number;
  sfpTpPercent: number;
  sfpCandlestickTpPercent: number;
  sfpMarginType: "CROSSED" | "ISOLATED";
  sfpAutoExecute: boolean;
  sfpWaitCandles: number;
  sfpOneTradeAtATime: boolean;
  credentialsConfigured?: boolean;
}

type SFPSettingsPatch = Pick<
  RuntimeSettings,
  | "sfpEnabled"
  | "allowMarketOrder"
  | "strategyMode"
  | "sfpStrategies"
  | "sfpLen"
  | "sfpWatchSymbols"
  | "sfpTimeframes"
  | "smcAutoTimeframes"
  | "smcPreferredRR"
  | "smcRelaxedRRTP"
  | "smcTakeProfitRoiPercent"
  | "smcMinScore"
  | "smcMaxBarsAfterSweepForMSS"
  | "smcFvgMinSizePct"
  | "smcAvoidMiddleOfRange"
  | "smcFvgMaxBarsAfterMss"
  | "sfpLeverage"
  | "sfpMarginUsdt"
  | "sfpTpPercent"
  | "sfpCandlestickTpPercent"
  | "sfpMarginType"
  | "sfpAutoExecute"
  | "sfpWaitCandles"
  | "sfpOneTradeAtATime"
  | "maxOpenPositions"
>;

interface OrderRow {
  id: number;
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  price: string;
  stop_price: string;
  status: string;
  binance_order_id: string;
  client_order_id: string;
  dry_run: number;
  source: string;
  payload?: string;
  created_at: string;
}

interface CredentialsStatus {
  configured: boolean;
  apiKeyPreview: string | null;
}

interface Overview {
  config: RuntimeSettings;
  strategy: { running: boolean; emergencyStopped: boolean };
  latestSignals?: Array<MarketSignal | null>;
  recentOrders: OrderRow[];
  recentLogs?: Row[];
}

type Row = Record<string, unknown>;

interface ManualTradePayload {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  price: number;
  marginUsdt: number;
  leverage: number;
  marginType?: "CROSSED" | "ISOLATED";
  takeProfitPrice: number;
  stopLossPrice: number;
}

interface AccountBalance {
  wallet: number;
  available: number;
  updatedAt: string;
}

interface OrderRules {
  stepSize: number;
  minQty: number;
  marketStepSize: number;
  marketMinQty: number;
}

interface LivePricePoint {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SFPSignalRecord {
  id: number;
  strategy?: "sfp" | "candlestick" | "wyckoff" | "smc";
  patternName?: string;
  symbol: string;
  timeframe: string;
  direction: "BULLISH" | "BEARISH";
  confirmed: boolean;
  swingPrice: number;
  oppositeLevel: number;
  sfpCandleHigh: number;
  sfpCandleLow: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  leverage: number;
  marginUsdt: number;
  status: "pending" | "limit_placed" | "simulated" | "executed" | "rejected" | "ignored" | "tp_hit" | "sl_hit";
  message: string;
  decision?: "TRADE" | "SKIP";
  decisionScore?: number;
  decisionSummary?: string;
  decisionDetails?: Array<{
    id: string;
    label: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    weight: number;
  }>;
  hasSfp?: boolean;
  chartPath?: string;
  chartUrl?: string;
  executeAfter?: string;
  createdAt: string;
  closedAt?: string;
  closePrice?: number;
  realizedPnlUsdt?: number;
  realizedPnlPct?: number;
}

interface AIConfigStatus {
  configured: boolean;
  apiKeyPreview: string | null;
  baseUrl: string;
  model: string;
}

interface TopMover {
  symbol: string;
  change: number;
  price: number;
  volume?: number;
  listedAt?: number;
}

interface TopMoversData {
  gainers: TopMover[];
  losers: TopMover[];
  newListings: TopMover[];
  topVolume: TopMover[];
  lowCap: TopMover[];
}

type AIDocumentKind = "text" | "image" | "prompt" | "candlestick" | "strategy" | "other";

interface AITrainingDocument {
  id: number;
  name: string;
  kind: AIDocumentKind;
  mimeType: string;
  content: string;
  sizeBytes: number;
  tags: string[];
  createdAt: string;
}

interface AITrainingRun {
  id: number;
  prompt: string;
  documentIds: number[];
  model: string;
  status: "ok" | "error";
  output: string;
  parsedJson?: unknown;
  error?: string;
  createdAt: string;
}

const SFP_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "12h", "1d", "3d", "1w"] as const;

const SFP_FAVORITE_COINS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","DOGEUSDT",
  "ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","LTCUSDT","TRXUSDT",
  "ATOMUSDT","ETCUSDT","INJUSDT","SUIUSDT","APTUSDT","ARBUSDT",
  "OPUSDT","NEARUSDT","FILUSDT","WLDUSDT","UNIUSDT","PHAUSDT"
];

const LEVERAGE_PRESETS = [1, 5, 10, 20, 50, 100];
const SMC_SAFE_DEFAULTS = {
  preferredRR: 2,
  relaxedRRTP: false,
  takeProfitRoiPercent: 30,
  minScore: 7,
  maxBarsAfterSweepForMSS: 10,
  fvgMinSizePct: 0.05,
  fvgMaxBarsAfterMss: 3,
  avoidMiddleOfRange: true
};
const SMC_SCALP_M1_DEFAULTS = {
  preferredRR: 1.5,
  relaxedRRTP: false,
  takeProfitRoiPercent: 30,
  minScore: 6,
  maxBarsAfterSweepForMSS: 15,
  fvgMinSizePct: 0.03,
  fvgMaxBarsAfterMss: 6,
  avoidMiddleOfRange: false
};

const COIN_COLORS = ["#3b82f6","#8b5cf6","#ec4899","#f59e0b","#10b981","#06b6d4","#84cc16","#f97316"];
function coinColor(symbol: string): string {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return COIN_COLORS[h % COIN_COLORS.length];
}

function toFuturesSymbol(raw: string): string {
  let s = raw.trim().toUpperCase();
  if (s.includes(":")) s = s.split(":").pop() ?? s;
  s = s.replace(/\.P(ERP)?$/, "").replace(/PERP$/, "");
  s = s.replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  return s.endsWith("USDT") ? s : `${s}USDT`;
}

const pages: Array<{ id: Page; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Tổng quan", icon: Activity },
  { id: "trade", label: "Vào lệnh", icon: Play },
  { id: "positions", label: "Vị thế", icon: Wallet },
  { id: "signals", label: "Tín hiệu", icon: TrendingUp },
  { id: "history", label: "Lịch sử lệnh", icon: HistoryIcon },
  { id: "logs", label: "Nhật ký", icon: FileText },
  { id: "backtest", label: "Backtest AI", icon: FlaskConical },
  { id: "audio", label: "Âm thanh", icon: Volume2 },
  { id: "ai", label: "Huấn luyện AI", icon: Brain },
  { id: "api", label: "API Binance", icon: KeyRound }
];

type AudioAlertKey = "signal" | "entry" | "tp" | "sl";
type BacktestStrategy = "smc" | "wyckoff";
type BacktestOutcome = "tp" | "sl" | "timeout" | "expired" | "open";

interface BacktestTrade {
  index: number;
  symbol: string;
  strategy: BacktestStrategy;
  timeframe: string;
  side: "LONG" | "SHORT";
  setupType: string;
  confidence: number;
  signalTime: string;
  entryTime?: string;
  exitTime?: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice?: number;
  outcome: BacktestOutcome;
  pnlR: number;
  barsHeld: number;
  reason: string;
}

interface BacktestResult {
  symbol: string;
  strategy: BacktestStrategy;
  timeframe: string;
  requestedCandles: number;
  candles: number;
  testedCandles: number;
  minConfidence: number;
  maxHoldCandles: number;
  maxWaitCandles: number;
  elapsedMs: number;
  cacheHit: boolean;
  summary: {
    rawSignals: number;
    qualifiedSignals: number;
    filledTrades: number;
    closedTrades: number;
    wins: number;
    losses: number;
    timeouts: number;
    expired: number;
    open: number;
    slOnlySignals: number;
    winRate: number;
    netR: number;
    avgR: number;
    bestR: number;
    worstR: number;
  };
  diagnostics: Record<string, number>;
  trades: BacktestTrade[];
}

interface AudioAlertConfig {
  enabled: boolean;
  volume: number;
}

interface AudioSoundRecord {
  key: AudioAlertKey;
  name: string;
  type: string;
  updatedAt: number;
  blob: Blob;
}

interface AudioSoundMeta {
  name: string;
  type: string;
  updatedAt: number;
}

const AUDIO_ALERT_KEYS: AudioAlertKey[] = ["signal", "entry", "tp", "sl"];
const AUDIO_ALERT_STORAGE_KEY = "binance_edge_audio_alerts_v1";
const AUDIO_ALERT_DB_NAME = "binance-edge-audio-alerts";
const AUDIO_ALERT_DB_VERSION = 1;
const AUDIO_ALERT_STORE = "sounds";

const AUDIO_ALERT_LABELS: Record<AudioAlertKey, { title: string; detail: string }> = {
  signal: { title: "Có tín hiệu", detail: "SFP/SMC đủ điều kiện hoặc điểm tín hiệu cao" },
  entry: { title: "Vào lệnh", detail: "Lệnh entry thật được gửi lên Binance" },
  tp: { title: "Chốt TP", detail: "Vị thế đóng ở take-profit" },
  sl: { title: "Dính SL", detail: "Vị thế đóng ở stop-loss" }
};

const AUDIO_ALERT_COOLDOWN_MS: Record<AudioAlertKey, number> = {
  signal: 15000,
  entry: 1500,
  tp: 1500,
  sl: 1500
};

const DEFAULT_AUDIO_ALERT_CONFIG: AudioAlertConfig = {
  enabled: true,
  volume: 0.85
};

let audioDbPromise: Promise<IDBDatabase> | null = null;
let audioLastPlayedMs: Partial<Record<AudioAlertKey, number>> = {};

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function loadAudioAlertConfig(): AudioAlertConfig {
  try {
    const saved = localStorage.getItem(AUDIO_ALERT_STORAGE_KEY);
    if (!saved) return DEFAULT_AUDIO_ALERT_CONFIG;
    const parsed = JSON.parse(saved) as Partial<AudioAlertConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_AUDIO_ALERT_CONFIG.enabled,
      volume: clampNumber(Number(parsed.volume ?? DEFAULT_AUDIO_ALERT_CONFIG.volume), 0, 1)
    };
  } catch {
    return DEFAULT_AUDIO_ALERT_CONFIG;
  }
}

function saveAudioAlertConfig(config: AudioAlertConfig): void {
  try {
    localStorage.setItem(AUDIO_ALERT_STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore storage errors */ }
}

function openAudioAlertDb(): Promise<IDBDatabase> {
  if (audioDbPromise) return audioDbPromise;
  audioDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_ALERT_DB_NAME, AUDIO_ALERT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_ALERT_STORE)) {
        db.createObjectStore(AUDIO_ALERT_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Không mở được kho âm thanh"));
  });
  return audioDbPromise;
}

function getAudioSound(key: AudioAlertKey): Promise<AudioSoundRecord | null> {
  return openAudioAlertDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_ALERT_STORE, "readonly");
    const req = tx.objectStore(AUDIO_ALERT_STORE).get(key);
    req.onsuccess = () => resolve((req.result as AudioSoundRecord | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Không đọc được âm thanh"));
  }));
}

function putAudioSound(record: AudioSoundRecord): Promise<void> {
  return openAudioAlertDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_ALERT_STORE, "readwrite");
    tx.objectStore(AUDIO_ALERT_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Không lưu được âm thanh"));
  }));
}

function deleteAudioSound(key: AudioAlertKey): Promise<void> {
  return openAudioAlertDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(AUDIO_ALERT_STORE, "readwrite");
    tx.objectStore(AUDIO_ALERT_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Không xóa được âm thanh"));
  }));
}

async function loadAudioSoundMetas(): Promise<Record<AudioAlertKey, AudioSoundMeta | null>> {
  const entries = await Promise.all(AUDIO_ALERT_KEYS.map(async key => {
    const sound = await getAudioSound(key);
    return [key, sound ? { name: sound.name, type: sound.type, updatedAt: sound.updatedAt } : null] as const;
  }));
  return Object.fromEntries(entries) as Record<AudioAlertKey, AudioSoundMeta | null>;
}

async function playAudioAlert(key: AudioAlertKey): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - (audioLastPlayedMs[key] ?? 0) < AUDIO_ALERT_COOLDOWN_MS[key]) return;
  const config = loadAudioAlertConfig();
  if (!config.enabled || config.volume <= 0) return;

  try {
    const sound = await getAudioSound(key);
    audioLastPlayedMs = { ...audioLastPlayedMs, [key]: nowMs };
    if (!sound) {
      playAudioFallbackAlert(key, config.volume);
      return;
    }
    const url = URL.createObjectURL(sound.blob);
    const audio = new Audio(url);
    audio.volume = clampNumber(config.volume, 0, 1);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {
    playAudioFallbackAlert(key, config.volume);
    // Browser may block sound until the user has interacted with the page.
  }
}

function playAudioFallbackAlert(key: AudioAlertKey, volume: number): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    void ctx.resume().catch(() => undefined);

    const patterns: Record<AudioAlertKey, number[]> = {
      signal: [740, 980],
      entry: [880, 1320],
      tp: [1040, 1320, 1560],
      sl: [420, 330]
    };
    const gain = ctx.createGain();
    const baseVolume = clampNumber(volume, 0, 1) * 0.22;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.02, baseVolume), ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    gain.connect(ctx.destination);

    patterns[key].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      osc.type = key === "sl" ? "sawtooth" : "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + index * 0.16);
      osc.connect(gain);
      osc.start(ctx.currentTime + index * 0.16);
      osc.stop(ctx.currentTime + index * 0.16 + 0.13);
    });

    window.setTimeout(() => void ctx.close().catch(() => undefined), 800);
  } catch {
    // Browser may block sound until the user has interacted with the page.
  }
}

function shouldPlayEntryAlert(data: Record<string, unknown>): boolean {
  const type = String(data.type ?? "").toUpperCase();
  const source = String(data.source ?? "").toLowerCase();
  if (data.reduceOnly === true || data.closePosition === true) return false;
  if (source === "cleanup" || source.includes("protect")) return false;
  return type === "LIMIT" || type === "MARKET";
}

function shouldPlaySignalAlert(data: Record<string, unknown>): boolean {
  const decision = String(data.decision ?? "");
  const status = String(data.status ?? "");
  const score = Number(data.decisionScore ?? 0);
  if (decision === "SKIP") return false;
  return decision === "TRADE" || status === "pending" || status === "limit_placed" || (decision === "" && score >= 60);
}

const columnLabels: Record<string, string> = {
  id: "ID",
  symbol: "Symbol",
  side: "Phía lệnh",
  type: "Loại lệnh",
  quantity: "Khối lượng",
  price: "Giá",
  stop_price: "Giá kích hoạt",
  status: "Trạng thái",
  binance_order_id: "ID lệnh Binance",
  client_order_id: "ID lệnh local",
  dry_run: "Mô phỏng",
  source: "Nguồn",
  payload: "Dữ liệu",
  created_at: "Thời gian",
  level: "Mức",
  message: "Thông báo",
  context: "Ngữ cảnh",
  positionAmt: "Khối lượng vị thế",
  entryPrice: "Giá vào",
  markPrice: "Giá đánh dấu",
  unRealizedProfit: "Lãi/lỗ chưa chốt",
  liquidationPrice: "Giá thanh lý",
  leverage: "Đòn bẩy",
  maxNotionalValue: "Notional tối đa",
  marginType: "Loại margin",
  isolatedMargin: "Margin isolated",
  isAutoAddMargin: "Tự thêm margin",
  positionSide: "Chiều vị thế",
  notional: "Giá trị vị thế",
  isolatedWallet: "Ví isolated",
  updateTime: "Cập nhật lúc"
};

const BACKEND_CONNECTION_ERROR =
  "Khong ket noi duoc backend local. Kiem tra server API dang chay.";
const BACKEND_SYNCING_STATUS = "Đang đồng bộ lại dashboard...";

class ApiNetworkError extends Error {
  constructor() {
    super(BACKEND_CONNECTION_ERROR);
    this.name = "ApiNetworkError";
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (isBinanceApiPath(path) && isBinanceCooldownActive()) {
    throw new Error(`Binance API dang tam dung, con ${getBinanceCooldownSeconds()}s.`);
  }
  let response!: Response;
  const method = String(init?.method ?? "GET").toUpperCase();
  const maxAttempts = method === "GET" || method === "HEAD" ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init
      });
      break;
    } catch {
      if (attempt >= maxAttempts) throw new ApiNetworkError();
      await wait(350);
    }
  }
  const data = await response.json().catch(() => ({}));
  const cooldownSeconds = Number(
    (data as Record<string, unknown>).binanceCooldownSeconds ??
      response.headers.get("Retry-After") ??
      0
  );
  if (response.status === 429 && cooldownSeconds > 0) {
    setBinanceCooldown(cooldownSeconds);
  }
  if (!response.ok) {
    throw new Error(data.error ?? `Yêu cầu thất bại: ${response.status}`);
  }
  return data as T;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(4) : "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function columnLabel(key: string): string {
  return columnLabels[key] ?? key;
}

function normalizeUsdFuturesSymbol(value: string): string {
  let raw = value.trim().toUpperCase();
  if (raw.includes(":")) raw = raw.split(":").pop() ?? raw;
  raw = raw.replace(/\.P(ERP)?$/, "").replace(/PERP$/, "");
  const compact = raw.replace(/[^A-Z0-9]/g, "");
  if (!compact) return "";
  return compact.endsWith("USDT") ? compact : `${compact}USDT`;
}

const BALANCE_REFRESH_MS = 10_000;
const PRICE_REFRESH_MS = 5_000;
const SFP_REFRESH_MS = 10_000;
const POSITION_REFRESH_MS = 10_000;
const STATUS_REFRESH_MS = 15_000;

let binanceCooldownUntilMs = 0;

const BINANCE_API_PREFIXES = [
  "/api/balance",
  "/api/positions",
  "/api/orders/open",
  "/api/orders/protected",
  "/api/market/",
  "/api/strategy/",
  "/api/sfp/scan",
  "/api/sfp/signals/"
];

function setBinanceCooldown(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  binanceCooldownUntilMs = Math.max(binanceCooldownUntilMs, Date.now() + seconds * 1000);
}

function getBinanceCooldownSeconds(): number {
  return Math.max(0, Math.ceil((binanceCooldownUntilMs - Date.now()) / 1000));
}

function isBinanceCooldownActive(): boolean {
  return getBinanceCooldownSeconds() > 0;
}

function isBinanceApiPath(path: string): boolean {
  return BINANCE_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function parseUsdtBalance(rows: unknown[]): AccountBalance | null {
  const usdt = rows.find(
    (row) =>
      row &&
      typeof row === "object" &&
      String((row as Record<string, unknown>).asset).toUpperCase() === "USDT"
  ) as Record<string, unknown> | undefined;
  if (!usdt) return null;

  const wallet = Number(
    usdt.balance ?? usdt.walletBalance ?? usdt.crossWalletBalance ?? 0
  );
  const available = Number(usdt.availableBalance ?? wallet);
  if (!Number.isFinite(wallet) || !Number.isFinite(available)) return null;
  return {
    wallet,
    available,
    updatedAt: new Date().toLocaleTimeString("vi-VN", { hour12: false })
  };
}

function getTradingMode(config: RuntimeSettings): TradingMode {
  if (config.dryRun) return "dry_run";
  if (config.binanceTestnet) return "testnet";
  return "live";
}

function tradingModeLabel(mode: TradingMode): string {
  if (mode === "dry_run") return "Mô phỏng";
  if (mode === "testnet") return "Mạng thử nghiệm";
  return "Giao dịch thật";
}

function maxCapitalAtRisk(config: RuntimeSettings): number {
  return config.maxOrderUsdt * Math.max(1, config.maxOpenPositions);
}


function pageFromUrl(): Page {
  const pageParam = new URLSearchParams(window.location.search).get("page");
  return pages.some((item) => item.id === pageParam)
    ? (pageParam as Page)
    : "overview";
}

interface HealthStatus {
  server: boolean;
  binanceReachable: boolean;
  balanceOk: boolean;
  apiKeyConfigured: boolean;
  sfpEnabled: boolean;
  sfpSubscriptions: number;
  usedWeight1m?: number;
  binanceCooldownSeconds?: number;
  binanceBannedUntil?: string;
  errors: string[];
  timestamp: string;
}

export function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [page, setPage] = useState<Page>(() => pageFromUrl());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [credentials, setCredentials] = useState<CredentialsStatus | null>(null);
  const [positions, setPositions] = useState<Row[]>([]);
  const [openOrders, setOpenOrders] = useState<Row[]>([]);
  const [overviewBalance, setOverviewBalance] = useState<AccountBalance | null>(null);
  const [overviewPositions, setOverviewPositions] = useState<Row[]>([]);
  const [configDraft, setConfigDraft] = useState<RuntimeSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [manualSymbol, setManualSymbol] = useState("BTCUSDT");
  const [historyOrders, setHistoryOrders] = useState<OrderRow[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [warpTrigger, setWarpTrigger] = useState<WarpTrigger | null>(null);
  const backendMisses = useRef(0);
  const healthMisses = useRef(0);

  const config = configDraft ?? overview?.config ?? null;

  const markBackendOk = () => {
    backendMisses.current = 0;
    healthMisses.current = 0;
    setError(previous => previous === BACKEND_CONNECTION_ERROR ? "" : previous);
    setStatus(previous => previous === BACKEND_SYNCING_STATUS ? "" : previous);
  };

  const reportBackgroundError = (nextError: unknown) => {
    if (nextError instanceof ApiNetworkError) {
      backendMisses.current += 1;
      if (backendMisses.current >= 3) {
        setError(nextError.message);
      } else {
        setStatus(BACKEND_SYNCING_STATUS);
      }
      return;
    }
    setError(nextError instanceof Error ? nextError.message : String(nextError));
  };

  const loadAll = async () => {
    try {
      const [nextOverview, nextCredentials, historyData, balanceRows, positionRows] = await Promise.all([
        api<Overview>("/api/overview"),
        api<CredentialsStatus>("/api/credentials"),
        api<OrderRow[]>("/api/orders/history?limit=1000"),
        api<unknown[]>("/api/balance").catch(() => [] as unknown[]),
        api<Row[]>("/api/positions").catch(() => [] as Row[])
      ]);
      const safeConfig = {
        ...nextOverview.config,
        credentialsConfigured: nextCredentials.configured
      };
      setOverview({ ...nextOverview, config: safeConfig });
      setCredentials(nextCredentials);
      setConfigDraft(safeConfig);
      setHistoryOrders(Array.isArray(historyData) ? historyData : []);
      setOverviewBalance(parseUsdtBalance(Array.isArray(balanceRows) ? balanceRows : []));
      setOverviewPositions(
        (Array.isArray(positionRows) ? positionRows : []).filter(row => Math.abs(Number(row.positionAmt ?? 0)) > 0)
      );
      // Pre-fill API key field with preview so user sees it's already saved
      if (nextCredentials.configured && nextCredentials.apiKeyPreview) {
        setApiKey(nextCredentials.apiKeyPreview);
      }
      markBackendOk();
    } catch (nextError) {
      reportBackgroundError(nextError);
    }
  };

  const loadPositions = async () => {
    if (isBinanceCooldownActive()) return;
    try {
      const [posData, ordData] = await Promise.all([
        api<Row[]>("/api/positions"),
        api<Row[]>("/api/orders/open").catch(() => [] as Row[])
      ]);
      setPositions(Array.isArray(posData) ? posData : []);
      setOpenOrders(Array.isArray(ordData) ? ordData : []);
      markBackendOk();
    } catch (nextError) {
      reportBackgroundError(nextError);
    }
  };

  const checkHealth = async () => {
    try {
      const h = await api<HealthStatus>("/api/health");
      if (h.binanceCooldownSeconds) setBinanceCooldown(h.binanceCooldownSeconds);
      setHealth(h);
      markBackendOk();
    } catch {
      healthMisses.current += 1;
      if (healthMisses.current >= 3) {
        setHealth({ server: false, binanceReachable: false, balanceOk: false, apiKeyConfigured: false, sfpEnabled: false, sfpSubscriptions: 0, errors: ["Không kết nối được server"], timestamp: new Date().toISOString() });
      }
    }
  };

  useEffect(() => {
    void loadAll();
    void checkHealth();
    const timer = setInterval(() => void loadAll(), 15000);
    const hTimer = setInterval(() => void checkHealth(), 30000);
    return () => { clearInterval(timer); clearInterval(hTimer); };
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data ?? "{}") as { type?: string; data?: Record<string, unknown> };
        if (parsed.data?.heartbeat) return;
        // Visual-only: trigger warp effect on new trading signals
        if (parsed.type === "risk.blocked") {
          playSosRejectAlarm();
        } else if (parsed.type === "sfp.signal" && parsed.data) {
          const d = parsed.data;
          if (d.status === "rejected" && !("decision" in d)) {
            playSosRejectAlarm();
          }
          if (shouldPlaySignalAlert(d)) {
            void playAudioAlert("signal");
          }
          if (d.decision === "TRADE" || Number(d.decisionScore) >= 60) {
            const dir = d.direction === "BULLISH" ? "LONG" : "SHORT";
            const intensity = Math.min(1, (Number(d.decisionScore ?? 72) - 60) / 40 + 0.45);
            setWarpTrigger({ key: Date.now(), direction: dir as 'LONG' | 'SHORT', intensity });
          }
        } else if (parsed.type === "order.created" && parsed.data) {
          if (shouldPlayEntryAlert(parsed.data)) {
            void playAudioAlert("entry");
          }
        } else if (parsed.type === "sfp.closed" && parsed.data) {
          const closeStatus = String(parsed.data.status ?? "");
          if (closeStatus === "tp_hit") void playAudioAlert("tp");
          if (closeStatus === "sl_hit") void playAudioAlert("sl");
        } else if (parsed.type === "signal.created" && parsed.data) {
          const d = parsed.data;
          const sig = String(d.signal ?? "");
          const conf = Number(d.confidence ?? 0);
          if ((sig === "LONG" || sig === "SHORT") && conf >= 55) {
            const intensity = Math.min(1, (conf - 50) / 50 + 0.3);
            setWarpTrigger({ key: Date.now(), direction: sig as 'LONG' | 'SHORT', intensity });
          }
        }
      } catch { /* ignore malformed SSE data */ }
      void loadAll();
    };
    source.onerror = () => setStatus("Đang kết nối lại realtime...");
    return () => source.close();
  }, []);

  useEffect(() => {
    if (page === "positions") void loadPositions();
  }, [page]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", page);
    window.history.replaceState(null, "", url);
  }, [page]);

  const safeMode = useMemo(() => {
    if (!config) return "Đang tải";
    const mode = getTradingMode(config);
    if (mode === "dry_run") return "Mô phỏng";
    if (mode === "testnet") return "Mạng thử nghiệm";
    if (config.readOnly) return "Giao dịch thật bị khóa";
    return "Giao dịch thật";
  }, [config]);

  const saveCredentials = async () => {
    // If user hasn't typed a real key (field still shows the short preview), skip
    const preview = credentials?.apiKeyPreview ?? "";
    if (apiKey.trim() === preview || apiKey.trim().length < 20) {
      setStatus("Vui lòng nhập API Key mới để cập nhật");
      return;
    }
    setStatus("Đang lưu API Binance...");
    setError("");
    try {
      const saved = await api<CredentialsStatus>("/api/credentials", {
        method: "POST",
        body: JSON.stringify({ apiKey, apiSecret })
      });
      setCredentials(saved);
      setApiSecret("");
      setStatus("Đã lưu API Binance vào backend local");
      await loadAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  const enableLiveTrading = async () => {
    setStatus("Đang mở giao dịch thật...");
    setError("");
    try {
      const saved = await api<RuntimeSettings>("/api/trading/enable-live", {
        method: "POST",
        body: JSON.stringify({ riskAccepted: true })
      });
      setConfigDraft({
        ...saved,
        credentialsConfigured: credentials?.configured ?? saved.credentialsConfigured
      });
      setStatus("Đã mở giao dịch thật");
      await loadAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  const enableDryRunTrading = async () => {
    setStatus("Đang bật giao dịch mô phỏng...");
    setError("");
    try {
      const saved = await api<RuntimeSettings>("/api/trading/enable-dry-run", {
        method: "POST"
      });
      setConfigDraft({
        ...saved,
        credentialsConfigured: credentials?.configured ?? saved.credentialsConfigured
      });
      setStatus("Đã bật giao dịch mô phỏng");
      await loadAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  const closePosition = async (symbol = manualSymbol) => {
    const normalizedSymbol = normalizeUsdFuturesSymbol(symbol);
    setStatus(`Đang đóng vị thế ${normalizedSymbol}...`);
    setError("");
    try {
      await api(`/api/positions/${normalizedSymbol}/close`, {
        method: "POST"
      });
      setStatus(`Đã gửi yêu cầu đóng vị thế ${normalizedSymbol}`);
      await loadPositions();
      await loadAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  const placeManualTrade = async (payload: ManualTradePayload) => {
    setStatus(
      `Đang gửi lệnh ${payload.side === "BUY" ? "Mua/Long" : "Bán/Short"} ${payload.symbol}...`
    );
    setError("");
    try {
      await api("/api/orders/protected", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setStatus(
        `Đã gửi lệnh ${payload.side === "BUY" ? "Mua/Long" : "Bán/Short"} ${payload.symbol}`
      );
      await loadAll();
      if (page === "positions") await loadPositions();
    } catch (nextError) {
      playSosRejectAlarm();
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  const triggerEmergencyStop = async () => {
    setStatus("Đang kích hoạt DỪNG KHẨN CẤP...");
    setError("");
    try {
      await api("/api/emergency-stop", {
        method: "POST"
      });
      setStatus("ĐÃ DỪNG KHẨN CẤP: Đã tắt tự động giao dịch và hủy toàn bộ lệnh chờ.");
      await loadAll();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    }
  };

  return (
    <>
      <FuturisticBackground />
      <PriceWarpEffect trigger={warpTrigger} />
      <DataSphere />
      <CursorGlow />
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-top">
            <div className="brand">
              <TrendingUp size={22} />
              <strong>BINANCE EDGE</strong>
            </div>
            <nav>
              {pages.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={page === item.id ? "active" : ""}
                    onClick={() => setPage(item.id)}
                    title={item.label}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="sidebar-footer">
            {/* ── API Health Status ─────────────────────────────── */}
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--muted)", textTransform: "uppercase", paddingLeft: 4 }}>
                Trạng thái hệ thống
              </div>
              {[
                { label: "Server", ok: health?.server ?? null },
                { label: "Binance API", ok: health?.binanceReachable ?? null },
                { label: "Balance API", ok: health?.balanceOk ?? null },
                { label: `SFP WS (${health?.sfpSubscriptions ?? 0})`, ok: (health?.sfpSubscriptions ?? 0) > 0 },
              ].map(({ label, ok }) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6, background: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
                  <span className={ok ? "dot-live" : ""} style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: ok === null ? "#555" : ok ? "var(--green)" : "var(--red)", boxShadow: ok ? "0 0 6px var(--green-glow)" : ok === false ? "0 0 6px var(--red-glow)" : "none" }} />
                  <span style={{ fontSize: 11, color: ok === null ? "var(--muted)" : ok ? "var(--text-dim)" : "#ffb3c0", flex: 1 }}>{label}</span>
                  <span style={{ fontSize: 10, color: ok === null ? "var(--muted)" : ok ? "var(--green)" : "var(--red)", fontFamily: "var(--font-mono)" }}>
                    {ok === null ? "..." : ok ? "OK" : "ERR"}
                  </span>
                </div>
              ))}
              {health?.usedWeight1m !== undefined && health.usedWeight1m > 0 && (
                <div style={{ padding: "5px 8px", borderRadius: 6, background: "rgba(0,0,0,0.2)", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>API Weight/min</span>
                    <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: health.usedWeight1m > 2000 ? "var(--red)" : health.usedWeight1m > 1200 ? "#f0a500" : "var(--green)" }}>
                      {health.usedWeight1m}/2400
                    </span>
                  </div>
                  <div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.08)" }}>
                    <div style={{ height: "100%", borderRadius: 2, width: `${Math.min(100, (health.usedWeight1m / 2400) * 100).toFixed(1)}%`, background: health.usedWeight1m > 2000 ? "var(--red)" : health.usedWeight1m > 1200 ? "#f0a500" : "var(--green)", transition: "width 0.3s" }} />
                  </div>
                </div>
              )}
              {health && health.errors.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--red)", padding: "4px 8px", background: "var(--red-dim)", borderRadius: 5, lineHeight: 1.5 }}>
                  {health.errors[0]}
                </div>
              )}
              <button onClick={() => void checkHealth()} style={{ fontSize: 11, minHeight: 28, padding: "0 10px", marginTop: 2 }}>
                <RefreshCw size={11} /> Kiểm tra lại
              </button>
            </div>

            <div className="profile-card">
              <div className="avatar-box">TP</div>
              <div className="profile-info">
                <span className="profile-name">Trader Pro</span>
                <span className="profile-plan">{health?.timestamp ? new Date(health.timestamp).toLocaleTimeString("vi") : "..."}</span>
              </div>
              <Lock size={14} />
            </div>
          </div>
        </aside>

        <main className="workspace">
          <header className="topbar">
            <div>
              <h1>{pages.find((item) => item.id === page)?.label}</h1>
              <p>
                REST Binance Futures USD-M, MCP local và lệnh có kiểm soát.
              </p>
            </div>
            <div className="topActions">
              <Badge tone={config?.readOnly ? "safe" : "warn"} icon={Lock}>
                {safeMode}
              </Badge>
              <Badge tone={config && getTradingMode(config) === "live" ? "danger" : "info"} icon={Shield}>
                {config ? tradingModeLabel(getTradingMode(config)) : "Đang tải"}
              </Badge>
              <Badge tone={credentials?.configured ? "safe" : "warn"} icon={KeyRound}>
                {credentials?.configured ? "API OK" : "Thiếu API"}
              </Badge>
              <button
                className="emergencyButton"
                onClick={() => void triggerEmergencyStop()}
                title="Dừng khẩn cấp"
              >
                <CircleStop size={15} />
                <span>Dừng khẩn cấp</span>
              </button>
              <button className="iconButton" onClick={() => void loadAll()} title="Làm mới">
                <RefreshCw size={18} />
              </button>
            </div>
          </header>

          {error ? (
            <div className="notice error">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button onClick={() => setError("")} title="Đóng">
                <X size={16} />
              </button>
            </div>
          ) : null}
          {status ? <div className="notice">{status}</div> : null}

          {page === "overview" && (
            <OverviewPage
              config={config}
              strategy={overview?.strategy ?? null}
              historyOrders={historyOrders}
              balance={overviewBalance}
              positions={overviewPositions}
              latestSignals={overview?.latestSignals ?? []}
            />
          )}
          {page === "trade" && (
            <ManualTradePage
              config={config}
              symbol={manualSymbol}
              setSymbol={setManualSymbol}
              onSubmit={(payload) => void placeManualTrade(payload)}
            />
          )}
          {page === "positions" && (
            <PositionsPage
              positions={positions}
              openOrders={openOrders}
              manualSymbol={manualSymbol}
              setManualSymbol={setManualSymbol}
              onClose={(symbol) => void closePosition(symbol)}
              onLoad={() => void loadPositions()}
            />
          )}
          {page === "signals" && (
            <SignalsPage />
          )}
          {page === "history" && (
            <OrderHistoryPage />
          )}
          {page === "logs" && (
            <LogsPage />
          )}
          {page === "backtest" && (
            <BacktestPage config={config} />
          )}
          {page === "audio" && (
            <AudioAlertsPage />
          )}
          {page === "ai" && (
            <AITrainingPage />
          )}
          {page === "api" && (
            <ApiPage
              config={config}
              credentials={credentials}
              apiKey={apiKey}
              apiSecret={apiSecret}
              setApiKey={setApiKey}
              setApiSecret={setApiSecret}
              onSaveCredentials={() => void saveCredentials()}
              onEnableLive={() => void enableLiveTrading()}
              onEnableDryRun={() => void enableDryRunTrading()}
            />
          )}
        </main>
      </div>
    </>
  );
}

function Badge({
  children,
  icon: Icon,
  tone
}: {
  children: string;
  icon: typeof Activity;
  tone: "safe" | "warn" | "info" | "danger";
}) {
  return (
    <span className={`badge ${tone}`}>
      <Icon size={15} />
      {children}
    </span>
  );
}

interface ClosedTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  side: string;
  pnl: number;
  date: Date;
}

interface OverviewStats {
  totalProfit: number;
  netProfit: number;
  profitFactor: number;
  winRate: number;
  totalTradesCount: number;
  winTradesCount: number;
  lossTradesCount: number;
  grossProfit: number;
  grossLoss: number;
  maxWin: number;
  maxLoss: number;
  avgWin: number;
  avgLoss: number;
  sparklines: {
    totalProfit: number[];
    netProfit: number[];
    profitFactor: number[];
    winRate: number[];
    totalTrades: number[];
  };
  profitGrowthData: Array<{ date: string; value: number }>;
  instrumentProfit: Array<{ name: string; value: number; percentage: number; colorClass: string }>;
  monthlyPerformance: Array<{ month: string; value: number; isPositive: boolean }>;
}

const EMPTY_OVERVIEW_STATS: OverviewStats = {
  totalProfit: 0,
  netProfit: 0,
  profitFactor: 0,
  winRate: 0,
  totalTradesCount: 0,
  winTradesCount: 0,
  lossTradesCount: 0,
  grossProfit: 0,
  grossLoss: 0,
  maxWin: 0,
  maxLoss: 0,
  avgWin: 0,
  avgLoss: 0,
  sparklines: {
    totalProfit: [0],
    netProfit: [0],
    profitFactor: [0],
    winRate: [0],
    totalTrades: [0]
  },
  profitGrowthData: [],
  instrumentProfit: [],
  monthlyPerformance: []
};

function parseOrderPayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === "object") return payload as Record<string, unknown>;
  if (typeof payload !== "string") return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numericPayloadValue(payload: Record<string, unknown>, row: OrderRow, keys: string[]): number {
  for (const key of keys) {
    const value = Number(payload[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  for (const key of keys) {
    const value = Number((row as unknown as Record<string, unknown>)[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function isTruthyPayload(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === "true";
}

function calculateClosedTradesFromOrders(orders: OrderRow[]): ClosedTrade[] {
  const filledOrders = [...orders]
    .map((row) => {
      const payload = parseOrderPayload(row.payload);
      const status = String(payload.status ?? row.status ?? "").toUpperCase();
      const type = String(payload.type ?? payload.orderType ?? row.type ?? "").toUpperCase();
      const executedQty = numericPayloadValue(payload, row, ["executedQty", "cumQty", "quantity", "origQty"]);
      const avgPrice = numericPayloadValue(payload, row, ["avgPrice", "price"]);
      const reduceOnly = isTruthyPayload(payload.reduceOnly) || isTruthyPayload(payload.closePosition);
      const side = String(payload.side ?? row.side ?? "").toUpperCase();
      const createdAt = new Date(row.created_at);

      return {
        symbol: row.symbol,
        side,
        type,
        quantity: executedQty,
        price: avgPrice,
        reduceOnly,
        status,
        createdAt
      };
    })
    .filter((order) =>
      order.status === "FILLED" &&
      (order.type === "MARKET" || order.type === "LIMIT") &&
      (order.side === "BUY" || order.side === "SELL") &&
      order.quantity > 0 &&
      order.price > 0 &&
      Number.isFinite(order.createdAt.getTime())
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const openLots: Record<string, Array<{ side: string; price: number; quantity: number }>> = {};
  const closedTrades: ClosedTrade[] = [];

  for (const order of filledOrders) {
    const lots = openLots[order.symbol] ?? [];
    openLots[order.symbol] = lots;
    let remainingQty = order.quantity;

    while (remainingQty > 0 && lots.length > 0 && lots[0].side !== order.side) {
      const lot = lots[0];
      const qty = Math.min(remainingQty, lot.quantity);
      const pnl = lot.side === "BUY"
        ? (order.price - lot.price) * qty
        : (lot.price - order.price) * qty;

      closedTrades.push({
        symbol: order.symbol,
        entryPrice: lot.price,
        exitPrice: order.price,
        quantity: qty,
        side: lot.side,
        pnl,
        date: order.createdAt
      });

      lot.quantity -= qty;
      remainingQty -= qty;
      if (lot.quantity <= 0) lots.shift();
    }

    if (remainingQty > 0 && !order.reduceOnly) {
      lots.push({ side: order.side, price: order.price, quantity: remainingQty });
    }
  }

  return closedTrades;
}

function buildOverviewStats(orders: OrderRow[]): OverviewStats {
  const closedTrades = calculateClosedTradesFromOrders(orders);
  if (closedTrades.length === 0) return EMPTY_OVERVIEW_STATS;

  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const totalTradesCount = closedTrades.length;
  const winTradesCount = wins.length;
  const lossTradesCount = losses.length;
  const winRate = totalTradesCount > 0 ? (winTradesCount / totalTradesCount) * 100 : 0;
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = losses.reduce((sum, t) => sum + t.pnl, 0);
  const netProfit = grossProfit + grossLoss;
  const profitFactor = Math.abs(grossLoss) > 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? 99.9 : 0;
  const maxWin = wins.length > 0 ? Math.max(...wins.map(w => w.pnl)) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(l => l.pnl)) : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  const sparklineTotalProfit: number[] = [];
  const sparklineNetProfit: number[] = [];
  const sparklineProfitFactor: number[] = [];
  const sparklineWinRate: number[] = [];
  const sparklineTotalTrades: number[] = [];
  let cumGrossProfit = 0;
  let cumGrossLoss = 0;
  let cumNetProfit = 0;
  let cumWins = 0;

  closedTrades.forEach((trade, idx) => {
    if (trade.pnl > 0) {
      cumGrossProfit += trade.pnl;
      cumWins++;
    } else {
      cumGrossLoss += trade.pnl;
    }
    cumNetProfit += trade.pnl;
    const step = Math.max(1, Math.floor(closedTrades.length / 10));
    if (idx % step === 0 || idx === closedTrades.length - 1) {
      sparklineTotalProfit.push(cumGrossProfit);
      sparklineNetProfit.push(cumNetProfit);
      sparklineProfitFactor.push(Math.abs(cumGrossLoss) > 0 ? cumGrossProfit / Math.abs(cumGrossLoss) : cumGrossProfit > 0 ? 99.9 : 0);
      sparklineWinRate.push((cumWins / (idx + 1)) * 100);
      sparklineTotalTrades.push(idx + 1);
    }
  });

  let cumulative = 0;
  const stepGrowth = Math.max(1, Math.floor(closedTrades.length / 15));
  const profitGrowthData = closedTrades
    .map((trade) => {
      cumulative += trade.pnl;
      return {
        date: trade.date.toLocaleDateString("vi-VN", { month: "2-digit", day: "2-digit" }).replace("/", "-"),
        value: cumulative
      };
    })
    .filter((_, idx) => idx % stepGrowth === 0 || idx === closedTrades.length - 1);

  const symbolPnls: Record<string, number> = {};
  for (const trade of closedTrades) {
    symbolPnls[trade.symbol] = (symbolPnls[trade.symbol] ?? 0) + trade.pnl;
  }
  const totalAbsPnl = Object.values(symbolPnls).reduce((sum, value) => sum + Math.abs(value), 0) || 1;
  const colors = ["green", "blue", "purple", "gold", "muted"];
  const instrumentProfit = Object.entries(symbolPnls)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([name, value], idx) => ({
      name,
      value,
      percentage: (Math.abs(value) / totalAbsPnl) * 100,
      colorClass: colors[idx % colors.length]
    }));

  const monthlyPnls: Record<string, number> = {};
  for (const trade of closedTrades) {
    const month = trade.date.toLocaleDateString("vi-VN", { month: "short" });
    monthlyPnls[month] = (monthlyPnls[month] ?? 0) + trade.pnl;
  }
  const monthlyPerformance = Object.entries(monthlyPnls).map(([month, value]) => ({
    month,
    value,
    isPositive: value >= 0
  }));

  return {
    totalProfit: grossProfit,
    netProfit,
    profitFactor,
    winRate,
    totalTradesCount,
    winTradesCount,
    lossTradesCount,
    grossProfit,
    grossLoss,
    maxWin,
    maxLoss,
    avgWin,
    avgLoss,
    sparklines: {
      totalProfit: sparklineTotalProfit,
      netProfit: sparklineNetProfit,
      profitFactor: sparklineProfitFactor,
      winRate: sparklineWinRate,
      totalTrades: sparklineTotalTrades
    },
    profitGrowthData,
    instrumentProfit,
    monthlyPerformance
  };
}

function Sparkline({ data, color = "var(--green)" }: { data: number[]; color?: string }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const width = 70;
  const height = 30;
  const padding = 2;
  const denom = Math.max(1, data.length - 1);

  const points = data.map((val, idx) => {
    const x = (idx / denom) * (width - 2 * padding) + padding;
    const y = height - padding - ((val - min) / range) * (height - 2 * padding);
    return `${x},${y}`;
  });

  const pathD = `M ${points.join(" L ")}`;

  return (
    <svg width={width} height={height} className="sparkline">
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AreaChart({ data }: { data: Array<{ date: string; value: number }> }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);

  if (!data || data.length === 0) {
    return <div className="empty">Không có dữ liệu biểu đồ.</div>;
  }

  const svgWidth = 800;
  const svgHeight = 260;
  const paddingLeft = 60;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = svgWidth - paddingLeft - paddingRight;
  const chartHeight = svgHeight - paddingTop - paddingBottom;

  const values = data.map(d => d.value);
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 100);
  const valRange = maxVal - minVal || 1;

  const getCoords = (idx: number, val: number) => {
    const x = paddingLeft + (idx / Math.max(1, data.length - 1)) * chartWidth;
    const y = paddingTop + chartHeight - ((val - minVal) / valRange) * chartHeight;
    return { x, y };
  };

  const points = data.map((d, idx) => getCoords(idx, d.value));
  const pathD = points.length > 0 ? `M ${points.map(p => `${p.x},${p.y}`).join(" L ")}` : "";
  const fillD = points.length > 0
    ? `${pathD} L ${points[points.length - 1].x},${paddingTop + chartHeight} L ${points[0].x},${paddingTop + chartHeight} Z`
    : "";

  const gridLinesCount = 5;
  const gridLines = Array.from({ length: gridLinesCount }).map((_, i) => {
    const val = minVal + (i / (gridLinesCount - 1)) * valRange;
    const y = paddingTop + chartHeight - (i / (gridLinesCount - 1)) * chartHeight;
    return { y, val };
  });

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = ((e.clientX - rect.left) / rect.width) * svgWidth;
    
    let closestIdx = 0;
    let minDiff = Infinity;
    points.forEach((p, idx) => {
      const diff = Math.abs(p.x - clickX);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });

    setHoveredIdx(closestIdx);
    setHoveredPos(points[closestIdx]);
  };

  const handleMouseLeave = () => {
    setHoveredIdx(null);
    setHoveredPos(null);
  };

  return (
    <div className="profit-growth-svg-wrap">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        width="100%"
        height="100%"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <defs>
          <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--green)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--green)" stopOpacity="0.00" />
          </linearGradient>
        </defs>

        {gridLines.map((line, i) => (
          <g key={i}>
            <line
              x1={paddingLeft}
              y1={line.y}
              x2={svgWidth - paddingRight}
              y2={line.y}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray="4 4"
            />
            <text
              x={paddingLeft - 10}
              y={line.y + 4}
              fill="var(--muted)"
              fontSize="10"
              fontFamily="var(--font-mono)"
              textAnchor="end"
            >
              {line.val.toFixed(1)}
            </text>
          </g>
        ))}

        {data.map((d, idx) => {
          const step = Math.ceil(data.length / 6);
          if (idx % step !== 0 && idx !== data.length - 1) return null;
          const p = points[idx];
          return (
            <text
              key={idx}
              x={p.x}
              y={paddingTop + chartHeight + 18}
              fill="var(--muted)"
              fontSize="10"
              fontFamily="var(--font-mono)"
              textAnchor="middle"
            >
              {d.date}
            </text>
          );
        })}

        <path d={fillD} fill="url(#areaGradient)" />
        <path
          d={pathD}
          fill="none"
          stroke="var(--green)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {hoveredIdx !== null && hoveredPos !== null && (
          <g>
            <line
              x1={hoveredPos.x}
              y1={paddingTop}
              x2={hoveredPos.x}
              y2={paddingTop + chartHeight}
              stroke="rgba(255, 255, 255, 0.15)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle cx={hoveredPos.x} cy={hoveredPos.y} r="5" fill="var(--green)" stroke="#fff" strokeWidth="1.5" />
            <g transform={`translate(${Math.min(svgWidth - 110, Math.max(10, hoveredPos.x - 50))}, ${Math.max(10, hoveredPos.y - 45)})`}>
              <rect
                width="100"
                height="34"
                rx="4"
                fill="var(--card)"
                stroke="var(--border)"
                strokeWidth="1"
              />
              <text x="50" y="14" fill="var(--muted)" fontSize="9" textAnchor="middle" fontFamily="var(--font-sans)">
                {data[hoveredIdx].date}
              </text>
              <text x="50" y="26" fill="#fff" fontSize="10" fontWeight="700" textAnchor="middle" fontFamily="var(--font-mono)">
                ${data[hoveredIdx].value.toFixed(2)}
              </text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}

function DonutChart({
  data,
  centerText,
  centerSubtext
}: {
  data: Array<{ name: string; value: number; percentage: number; colorClass: string }>;
  centerText: string;
  centerSubtext: string;
}) {
  const r = 50;
  const circ = 2 * Math.PI * r;
  const strokeWidth = 10;

  let accumulatedPercent = 0;

  return (
    <div className="donut-chart-wrap">
      <div className="donut-svg-container">
        <svg viewBox="0 0 120 120" width="100%" height="100%">
          <circle
            cx="60"
            cy="60"
            r={r}
            fill="transparent"
            stroke="var(--border)"
            strokeWidth={strokeWidth}
          />
          {data.map((item, idx) => {
            const pct = item.percentage;
            const strokeLength = (pct / 100) * circ;
            const strokeOffset = circ - (accumulatedPercent / 100) * circ;
            accumulatedPercent += pct;

            let color = "var(--muted)";
            if (item.colorClass === "green") color = "var(--green)";
            if (item.colorClass === "red") color = "var(--red)";
            if (item.colorClass === "blue") color = "var(--blue)";
            if (item.colorClass === "purple") color = "var(--purple)";
            if (item.colorClass === "gold") color = "var(--gold)";

            return (
              <circle
                key={idx}
                cx="60"
                cy="60"
                r={r}
                fill="transparent"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${strokeLength} ${circ}`}
                strokeDashoffset={strokeOffset}
                transform="rotate(-90 60 60)"
                strokeLinecap={pct > 2 ? "round" : "butt"}
              />
            );
          })}
        </svg>
        <div className="donut-center-text">
          <strong>{centerText}</strong>
          <span>{centerSubtext}</span>
        </div>
      </div>

      <div className="donut-legend">
        {data.map((item, idx) => (
          <div key={idx} className="donut-legend-item">
            <div className="donut-legend-label">
              <span className={`legend-dot ${item.colorClass}`}></span>
              <span>{item.name} ({item.percentage.toFixed(1)}%)</span>
            </div>
            <span className="donut-legend-value">
              {item.value >= 0 ? `$${item.value.toFixed(2)}` : `-$${Math.abs(item.value).toFixed(2)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BarChart({ data }: { data: Array<{ month: string; value: number; isPositive: boolean }> }) {
  if (!data || data.length === 0) {
    return <div className="empty">Không có dữ liệu tháng.</div>;
  }

  const svgWidth = 300;
  const svgHeight = 180;
  const paddingLeft = 40;
  const paddingRight = 10;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = svgWidth - paddingLeft - paddingRight;
  const chartHeight = svgHeight - paddingTop - paddingBottom;
  const centerY = paddingTop + chartHeight / 2;

  const maxVal = Math.max(...data.map(d => Math.abs(d.value)), 50);
  const scale = (chartHeight / 2) / maxVal;

  const barWidth = Math.min(24, (chartWidth / data.length) * 0.6);
  const gap = (chartWidth - barWidth * data.length) / (data.length - 1 || 1);

  return (
    <div className="monthly-performance-wrap">
      <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} width="100%" height="100%">
        {[-1, -0.5, 0, 0.5, 1].map((ratio, idx) => {
          const y = centerY - ratio * (chartHeight / 2);
          const val = ratio * maxVal;
          return (
            <g key={idx}>
              <line
                x1={paddingLeft}
                y1={y}
                x2={svgWidth - paddingRight}
                y2={y}
                stroke={ratio === 0 ? "rgba(255, 255, 255, 0.2)" : "var(--border)"}
                strokeWidth={ratio === 0 ? "1" : "0.5"}
                strokeDasharray={ratio === 0 ? undefined : "3 3"}
              />
              {ratio !== 0 && (
                <text
                  x={paddingLeft - 8}
                  y={y + 3}
                  fill="var(--muted)"
                  fontSize="9"
                  fontFamily="var(--font-mono)"
                  textAnchor="end"
                >
                  {val >= 0 ? `+${val.toFixed(0)}` : val.toFixed(0)}
                </text>
              )}
            </g>
          );
        })}

        {data.map((item, idx) => {
          const x = paddingLeft + idx * (barWidth + gap) + gap / 2;
          const h = Math.abs(item.value) * scale;
          const y = item.value >= 0 ? centerY - h : centerY;
          const fill = item.value >= 0 ? "var(--green)" : "var(--red)";

          return (
            <g key={idx}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(2, h)}
                fill={fill}
                rx="3"
                opacity="0.85"
              />
              <text
                x={x + barWidth / 2}
                y={svgHeight - 10}
                fill="var(--muted)"
                fontSize="10"
                fontFamily="var(--font-sans)"
                textAnchor="middle"
              >
                {item.month}
              </text>
              <text
                x={x + barWidth / 2}
                y={item.value >= 0 ? y - 4 : y + h + 11}
                fill={fill}
                fontSize="9"
                fontFamily="var(--font-mono)"
                fontWeight="600"
                textAnchor="middle"
              >
                {item.value >= 0 ? `+${item.value.toFixed(0)}` : item.value.toFixed(0)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function OverviewPage({
  config,
  strategy,
  historyOrders,
  balance,
  positions,
  latestSignals
}: {
  config: RuntimeSettings | null;
  strategy: Overview["strategy"] | null;
  historyOrders: OrderRow[];
  balance: AccountBalance | null;
  positions: Row[];
  latestSignals: Array<MarketSignal | null>;
}) {
  const stats = useMemo(() => buildOverviewStats(historyOrders), [historyOrders]);
  const openUnrealizedPnl = positions.reduce((sum, row) => sum + Number(row.unRealizedProfit ?? row.unrealizedProfit ?? 0), 0);
  const actionableSignals = latestSignals.filter((signal) =>
    signal && (signal.signal === "LONG" || signal.signal === "SHORT") && Number(signal.confidence ?? 0) >= (config?.minConfidence ?? 0)
  ).length;

  const distributionData = [
    { name: "Win Trades", value: stats.winTradesCount, percentage: stats.winRate, colorClass: "green" },
    { name: "Loss Trades", value: stats.lossTradesCount, percentage: 100 - stats.winRate, colorClass: "red" }
  ];

  return (
    <>
      <div className="grid-5">
        <div className="metric-card">
          <span className="metric-header">Số dư ví</span>
          <div className="metric-row">
            <div className="metric-value-col">
              <span className="metric-value">{balance ? `${balance.wallet.toFixed(2)}` : "-"}</span>
              <span className="metric-pct neutral">
                {balance ? "USDT" : "Chưa đọc được"}
              </span>
            </div>
            <div className="sparkline-box">
              <Sparkline data={stats.sparklines.netProfit} color="var(--gold)" />
            </div>
          </div>
        </div>

        <div className="metric-card">
          <span className="metric-header">Khả dụng</span>
          <div className="metric-row">
            <div className="metric-value-col">
              <span className="metric-value">{balance ? `${balance.available.toFixed(2)}` : "-"}</span>
              <span className="metric-pct neutral">
                {balance ? `Cập nhật ${balance.updatedAt}` : "USDT"}
              </span>
            </div>
            <div className="sparkline-box">
              <Sparkline data={stats.sparklines.totalTrades} color="var(--blue)" />
            </div>
          </div>
        </div>

        <div className="metric-card">
          <span className="metric-header">PnL đã chốt</span>
          <div className="metric-row">
            <div className="metric-value-col">
              <span className="metric-value" style={{ color: stats.netProfit >= 0 ? "var(--green)" : "var(--red)" }}>
                {stats.netProfit >= 0 ? `$${stats.netProfit.toFixed(2)}` : `-$${Math.abs(stats.netProfit).toFixed(2)}`}
              </span>
              <span className={`metric-pct ${stats.netProfit >= 0 ? "up" : "down"}`}>Realized</span>
            </div>
            <div className="sparkline-box">
              <Sparkline data={stats.sparklines.netProfit} color={stats.netProfit >= 0 ? "var(--green)" : "var(--red)"} />
            </div>
          </div>
        </div>

        <div className="metric-card">
          <span className="metric-header">PnL đang mở</span>
          <div className="metric-row">
            <div className="metric-value-col">
              <span className="metric-value" style={{ color: openUnrealizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                {openUnrealizedPnl >= 0 ? `$${openUnrealizedPnl.toFixed(2)}` : `-$${Math.abs(openUnrealizedPnl).toFixed(2)}`}
              </span>
              <span className={`metric-pct ${openUnrealizedPnl >= 0 ? "up" : "down"}`}>
                {positions.length} vị thế
              </span>
            </div>
            <div className="sparkline-box">
              <Sparkline data={[0, openUnrealizedPnl]} color={openUnrealizedPnl >= 0 ? "var(--green)" : "var(--red)"} />
            </div>
          </div>
        </div>

        <div className="metric-card">
          <span className="metric-header">Win Rate</span>
          <div className="metric-row">
            <div className="metric-value-col">
              <span className="metric-value">{stats.winRate.toFixed(1)}%</span>
              <span className="metric-pct neutral">
                {stats.totalTradesCount} closed · {actionableSignals} tín hiệu
              </span>
            </div>
            <div className="sparkline-box">
              <Sparkline data={stats.sparklines.winRate} color="var(--green)" />
            </div>
          </div>
        </div>
      </div>

      <div className="analytics-grid">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <h2>Lợi nhuận tích lũy (Profit Growth)</h2>
              <p className="helperText">Biểu đồ biểu diễn tăng trưởng vốn tài khoản theo thời gian.</p>
            </div>
          </div>
          <AreaChart data={stats.profitGrowthData} />
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Tỷ lệ thắng/thua (Win/Loss)</h2>
          </div>
          <DonutChart
            data={distributionData}
            centerText={`${stats.winRate.toFixed(0)}%`}
            centerSubtext="Win Rate"
          />
        </div>
      </div>

      <div className="analytics-bottom-grid">
        <div className="panel performance-breakdown-card">
          <div className="panelHeader">
            <h2>Thống kê chi tiết</h2>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Lợi nhuận gộp (Gross Profit)</span>
            <span className="breakdown-value green">${stats.grossProfit.toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Tổng lỗ gộp (Gross Loss)</span>
            <span className="breakdown-value red">-${Math.abs(stats.grossLoss).toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Lệnh thắng lớn nhất (Max Win)</span>
            <span className="breakdown-value green">${stats.maxWin.toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Lệnh thua lớn nhất (Max Loss)</span>
            <span className="breakdown-value red">-${Math.abs(stats.maxLoss).toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Lợi nhuận TB lệnh thắng</span>
            <span className="breakdown-value green">${stats.avgWin.toFixed(2)}</span>
          </div>
          <div className="breakdown-row">
            <span className="breakdown-label">Lỗ TB lệnh thua</span>
            <span className="breakdown-value red">-${Math.abs(stats.avgLoss).toFixed(2)}</span>
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Cặp giao dịch hiệu quả</h2>
          </div>
          {stats.instrumentProfit.length > 0 ? (
            <DonutChart
              data={stats.instrumentProfit}
              centerText="Cặp"
              centerSubtext="PnL Share"
            />
          ) : (
            <div className="empty">Chưa có giao dịch.</div>
          )}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <h2>Hiệu suất theo tháng</h2>
          </div>
          <BarChart data={stats.monthlyPerformance} />
        </div>
      </div>

      <section className="settingsGrid">
        {config ? (
          <BotStatusCard
            config={config}
            strategy={strategy}
            balance={balance}
            positions={positions}
            closedTradeCount={stats.totalTradesCount}
          />
        ) : null}
      </section>
    </>
  );
}

function BotStatusCard({
  config,
  strategy,
  balance,
  positions,
  closedTradeCount
}: {
  config: RuntimeSettings;
  strategy: Overview["strategy"] | null;
  balance: AccountBalance | null;
  positions: Row[];
  closedTradeCount: number;
}) {
  const mode = getTradingMode(config);
  const live = mode === "live";
  const running = Boolean(strategy?.running && !strategy.emergencyStopped);
  const message = live
    ? "CẢNH BÁO: Bot đang ở chế độ Giao dịch thật. Lệnh có thể gây lỗ tiền thật."
    : mode === "testnet"
      ? "Bot đang chạy ở chế độ mạng thử nghiệm. Lệnh gửi lên mạng thử nghiệm Binance, không dùng tiền thật."
      : "Bot đang chạy mô phỏng. Bot không gửi lệnh lên Binance và không dùng tiền thật.";

  return (
    <section className={`panel full statusPanel ${live ? "live" : ""}`}>
      <div className="statusHeader">
        <div>
          <h2>Trạng thái bot</h2>
          <p>{message}</p>
        </div>
        <div className="cluster">
          <Badge tone={running ? "safe" : "warn"} icon={Activity}>
            {running ? "Đang chạy" : "Đang dừng"}
          </Badge>
          <Badge tone={live ? "danger" : "info"} icon={Shield}>
            {tradingModeLabel(mode)}
          </Badge>
        </div>
      </div>
      <div className="statusGrid">
        <Metric label="Tự động vào lệnh" value={config.autoTradeEnabled ? "Bật" : "Tắt"} />
        <Metric label="Lệnh thật" value={live && !config.readOnly ? "Bật" : "Tắt"} />
        <Metric label="Số dư ví" value={balance ? `${balance.wallet.toFixed(2)} USDT` : "-"} />
        <Metric label="Khả dụng" value={balance ? `${balance.available.toFixed(2)} USDT` : "-"} />
        <Metric label="Vị thế mở" value={positions.length} />
        <Metric label="Lệnh đã đóng" value={closedTradeCount} />
        <Metric label="Cặp được phép" value={config.allowedSymbols.length} />
        <Metric label="Tổng vốn tối đa" value={`${maxCapitalAtRisk(config)} USDT`} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{valueText(value)}</strong>
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function readFile(file: File): Promise<{ content: string; mimeType: string; kind: AIDocumentKind }> {
  const mimeType = file.type || "application/octet-stream";
  const isImage = mimeType.startsWith("image/");
  const isTextLike =
    mimeType.startsWith("text/") ||
    /\.(txt|md|json|csv|tsv|pine|js|ts|py)$/i.test(file.name);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Không đọc được file ${file.name}`));
    reader.onload = () => {
      resolve({
        content: String(reader.result ?? ""),
        mimeType,
        kind: isImage ? "image" : isTextLike ? "text" : "other"
      });
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

function AITrainingPage() {
  const [config, setConfig] = useState<AIConfigStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-5.5");
  const [documents, setDocuments] = useState<AITrainingDocument[]>([]);
  const [runs, setRuns] = useState<AITrainingRun[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manualName, setManualName] = useState("Ghi chú setup");
  const [manualKind, setManualKind] = useState<AIDocumentKind>("prompt");
  const [manualContent, setManualContent] = useState("");
  const [prompt, setPrompt] = useState(
    "Từ các tài liệu và ảnh chart đã chọn, hãy tạo một chiến lược SFP có entry, SL, TP, điều kiện bỏ qua, quản trị rủi ro và test plan dạng JSON."
  );
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<{ latencyMs: number; output: string } | null>(null);

  const load = async () => {
    try {
      const [cfg, docs, history] = await Promise.all([
        api<AIConfigStatus>("/api/ai/config"),
        api<AITrainingDocument[]>("/api/ai/documents?limit=100"),
        api<AITrainingRun[]>("/api/ai/runs?limit=20")
      ]);
      setConfig(cfg);
      setBaseUrl(cfg.baseUrl || "https://api.openai.com/v1");
      setModel(cfg.model || "gpt-5.5");
      setDocuments(docs);
      setRuns(history);
      if (cfg.apiKeyPreview) setApiKey(cfg.apiKeyPreview);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveConfig = async () => {
    setBusy(true);
    setError("");
    setStatus("Đang lưu cấu hình AI...");
    try {
      const saved = await api<AIConfigStatus>("/api/ai/config", {
        method: "POST",
        body: JSON.stringify({
          baseUrl,
          model,
          apiKey: apiKey === config?.apiKeyPreview ? undefined : apiKey
        })
      });
      setConfig(saved);
      setStatus("Đã lưu cấu hình AI.");
      if (saved.apiKeyPreview) setApiKey(saved.apiKeyPreview);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const testAI = async () => {
    setBusy(true);
    setError("");
    setStatus("Đang test kết nối live với AI...");
    try {
      const result = await api<{ ok: boolean; latencyMs: number; output: string }>("/api/ai/test", { method: "POST" });
      setLiveResult({ latencyMs: result.latencyMs, output: result.output });
      setStatus(`AI connected: ${result.latencyMs}ms.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
      setLiveResult(null);
    } finally {
      setBusy(false);
    }
  };

  const addManualDocument = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api<AITrainingDocument>("/api/ai/documents", {
        method: "POST",
        body: JSON.stringify({
          name: manualName,
          kind: manualKind,
          mimeType: "text/plain",
          content: manualContent,
          tags: []
        })
      });
      setDocuments((prev) => [saved, ...prev]);
      setSelectedIds((prev) => Array.from(new Set([saved.id, ...prev])));
      setManualContent("");
      setStatus("Đã thêm tài liệu vào kho AI.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const savedDocs: AITrainingDocument[] = [];
      for (const file of Array.from(files)) {
        const read = await readFile(file);
        const saved = await api<AITrainingDocument>("/api/ai/documents", {
          method: "POST",
          body: JSON.stringify({
            name: file.name,
            kind: read.kind,
            mimeType: read.mimeType,
            content: read.content,
            tags: []
          })
        });
        savedDocs.push(saved);
      }
      setDocuments((prev) => [...savedDocs.reverse(), ...prev]);
      setSelectedIds((prev) => Array.from(new Set([...savedDocs.map((doc) => doc.id), ...prev])));
      setStatus(`Đã upload ${savedDocs.length} file.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const deleteDocument = async (id: number) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/ai/documents/${id}`, { method: "DELETE" });
      setDocuments((prev) => prev.filter((doc) => doc.id !== id));
      setSelectedIds((prev) => prev.filter((docId) => docId !== id));
      setStatus("Đã xóa tài liệu.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const runAnalysis = async () => {
    setBusy(true);
    setError("");
    setStatus("AI đang phân tích và tạo chiến lược...");
    try {
      const run = await api<AITrainingRun>("/api/ai/analyze", {
        method: "POST",
        body: JSON.stringify({ prompt, documentIds: selectedIds })
      });
      setRuns((prev) => [run, ...prev]);
      setStatus("AI đã tạo bản nháp chiến lược.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const toggleDoc = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const latest = runs[0];

  return (
    <section className="aiTrainingGrid">
      {error ? <div className="notice error fullWidth">{error}</div> : null}
      {status ? <div className="notice fullWidth">{status}</div> : null}

      <div className="panel full">
        <div className="panelHeader">
          <h2>Kết nối AI</h2>
          <Badge tone={config?.configured ? "safe" : "warn"} icon={Brain}>
            {config?.configured ? "AI API OK" : "Chưa có API"}
          </Badge>
        </div>
        <div className="formGrid">
          <TextField label="AI Base URL" value={baseUrl} onChange={setBaseUrl} technicalKey="AI_BASE_URL" />
          <TextField label="Model" value={model} onChange={setModel} technicalKey="AI_MODEL" />
          <PasswordField label="AI API Key" value={apiKey} onChange={setApiKey} technicalKey="AI_API_KEY" />
        </div>
        <p className="helperText">
          Base URL mặc định là OpenAI. Có thể dùng endpoint OpenAI-compatible nếu cần router/fallback.
        </p>
        <div className="horizontal">
          <button disabled={busy} onClick={() => void saveConfig()}>
            <Save size={16} />
            Lưu cấu hình AI
          </button>
          <button disabled={busy} onClick={() => void testAI()}>
            <FlaskConical size={16} />
            Test live
          </button>
          {liveResult && (
            <span className="pill positive">Live {liveResult.latencyMs}ms</span>
          )}
        </div>
      </div>

      <div className="panel full">
        <div className="panelHeader">
          <h2>Kho tài liệu</h2>
          <span className="pill neutral">{documents.length} file</span>
        </div>
        <div className="aiUploadRow">
          <label className="aiUploadButton">
            <Upload size={16} />
            <span>Upload text / ảnh chart</span>
            <input
              type="file"
              multiple
              accept=".txt,.md,.json,.csv,.tsv,.pine,.js,.ts,.py,image/*"
              onChange={(event) => void uploadFiles(event.target.files)}
            />
          </label>
          <div className="field">
            <label>Loại ghi chú</label>
            <select value={manualKind} onChange={(event) => setManualKind(event.target.value as AIDocumentKind)}>
              <option value="prompt">Prompt</option>
              <option value="candlestick">Mẫu nến</option>
              <option value="strategy">Chiến lược</option>
              <option value="text">Tài liệu</option>
              <option value="other">Khác</option>
            </select>
          </div>
        </div>
        <TextField label="Tên ghi chú" value={manualName} onChange={setManualName} />
        <label className="field">
          <span>Nội dung ghi chú / rule / prompt</span>
          <textarea value={manualContent} onChange={(event) => setManualContent(event.target.value)} rows={7} />
        </label>
        <div className="horizontal">
          <button disabled={busy || !manualContent.trim()} onClick={() => void addManualDocument()}>
            <FileText size={16} />
            Thêm vào kho
          </button>
          <span className="helperText">PDF hiện nên dán phần text chính vào ghi chú để AI đọc chính xác.</span>
        </div>
      </div>

      <div className="panel full">
        <div className="panelHeader">
          <h2>Tài liệu đã chọn</h2>
          <span className="pill positive">{selectedIds.length} chọn</span>
        </div>
        <div className="aiDocList">
          {documents.map((doc) => (
            <div key={doc.id} className={`aiDocRow ${selectedIds.includes(doc.id) ? "selected" : ""}`}>
              <button className="aiDocMain" onClick={() => toggleDoc(doc.id)}>
                <span className="pill neutral">{doc.kind}</span>
                <strong>{doc.name}</strong>
                <small>{doc.mimeType} · {formatBytes(doc.sizeBytes)}</small>
              </button>
              <button className="iconButton" disabled={busy} onClick={() => void deleteDocument(doc.id)} title="Xóa">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {documents.length === 0 && <div className="empty">Chưa có tài liệu AI.</div>}
        </div>
      </div>

      <div className="panel full">
        <div className="panelHeader">
          <h2>Tạo chiến lược</h2>
          <Badge tone="info" icon={Shield}>Draft only</Badge>
        </div>
        <label className="field">
          <span>Prompt điều khiển AI</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
        </label>
        <div className="saveBar">
          <button disabled={busy || !prompt.trim()} onClick={() => void runAnalysis()}>
            <Brain size={17} />
            Tạo chiến lược JSON
          </button>
        </div>
      </div>

      <div className="panel fullWidth">
        <div className="panelHeader">
          <h2>Kết quả AI gần nhất</h2>
          <button onClick={() => void load()} disabled={busy}>
            <RefreshCw size={16} />
            Làm mới
          </button>
        </div>
        {latest ? (
          <div className="aiResult">
            <div className="horizontal">
              <span className={latest.status === "ok" ? "pill positive" : "pill negative"}>{latest.status}</span>
              <span className="pill neutral">{latest.model}</span>
              <span className="pill neutral">{new Date(latest.createdAt).toLocaleString("vi-VN")}</span>
            </div>
            <pre>{latest.parsedJson ? JSON.stringify(latest.parsedJson, null, 2) : latest.output || latest.error}</pre>
          </div>
        ) : (
          <div className="empty">Chưa có kết quả AI.</div>
        )}
      </div>
    </section>
  );
}

function ApiPage({
  config,
  credentials,
  apiKey,
  apiSecret,
  setApiKey,
  setApiSecret,
  onSaveCredentials,
  onEnableLive,
  onEnableDryRun
}: {
  config: RuntimeSettings | null;
  credentials: CredentialsStatus | null;
  apiKey: string;
  apiSecret: string;
  setApiKey: (value: string) => void;
  setApiSecret: (value: string) => void;
  onSaveCredentials: () => void;
  onEnableLive: () => void;
  onEnableDryRun: () => void;
}) {
  return (
    <section className="apiGrid">
      <div className="panel full">
        <div className="panelHeader">
          <h2>API Binance</h2>
          <Badge tone={credentials?.configured ? "safe" : "warn"} icon={KeyRound}>
            {credentials?.configured ? credentials.apiKeyPreview ?? "Đã lưu" : "Chưa lưu"}
          </Badge>
        </div>
        {credentials?.configured && (
          <div style={{
            background: "rgba(8,153,129,0.1)", border: "1px solid rgba(8,153,129,0.35)",
            borderRadius: 8, padding: "10px 14px", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 10, fontSize: 13
          }}>
            <span style={{ color: "var(--color-positive)", fontSize: 18 }}>✓</span>
            <div>
              <strong style={{ color: "var(--color-positive)" }}>API đã được cấu hình và lưu trong .env</strong>
              <div style={{ color: "#aaa", fontSize: 12, marginTop: 2 }}>
                Key: <code style={{ background: "#1a1a2e", padding: "1px 6px", borderRadius: 3 }}>{credentials.apiKeyPreview}</code>
                — Chỉ cần nhập lại khi muốn đổi key mới.
              </div>
            </div>
          </div>
        )}
        <div className="formGrid secretGrid">
          <TextField label="API Key mới (để thay đổi)" value={apiKey} onChange={setApiKey} technicalKey="BINANCE_API_KEY" />
          <PasswordField
            label="API Secret mới (để thay đổi)"
            value={apiSecret}
            onChange={setApiSecret}
            technicalKey="BINANCE_API_SECRET"
          />
        </div>
        <p className="helperText">
          API key chỉ lưu ở backend local (.env). Không bật quyền rút tiền cho key này.
        </p>
        <div className="saveBar">
          <button onClick={onSaveCredentials}>
            <Save size={16} />
            Lưu API
          </button>
        </div>
      </div>

      <div className="panel full">
        <div className="panelHeader">
          <h2>Điều khiển nhanh</h2>
          <Badge tone={config && getTradingMode(config) === "live" ? "danger" : "info"} icon={Shield}>
            {config ? tradingModeLabel(getTradingMode(config)) : "Đang tải"}
          </Badge>
        </div>
        <div className="stateGrid">
          <Metric label="API" value={credentials?.configured ? "Đã cấu hình" : "Chưa cấu hình"} />
          <Metric label="Chỉ xem dữ liệu" value={config?.readOnly ? "Bật" : "Tắt"} />
          <Metric label="Tự động vào lệnh" value={config?.autoTradeEnabled ? "Bật" : "Tắt"} />
          <Metric label="Stop Loss" value={config ? `${config.slPercent}%` : "-"} />
        </div>
        <div className="actionStack horizontal tradingButtons">
          <button onClick={onEnableDryRun}>
            <Play size={18} />
            Bật mô phỏng
          </button>
          <button className="dangerButton" onClick={onEnableLive}>
            <Unlock size={18} />
            Mở giao dịch thật
          </button>
        </div>
      </div>
    </section>
  );
}

function AudioAlertsPage() {
  const [config, setConfig] = useState<AudioAlertConfig>(() => loadAudioAlertConfig());
  const [sounds, setSounds] = useState<Record<AudioAlertKey, AudioSoundMeta | null>>(() => ({
    signal: null,
    entry: null,
    tp: null,
    sl: null
  }));
  const [busyKey, setBusyKey] = useState<AudioAlertKey | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const refreshSounds = async () => {
    try {
      setSounds(await loadAudioSoundMetas());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  useEffect(() => {
    void refreshSounds();
  }, []);

  const updateConfig = (patch: Partial<AudioAlertConfig>) => {
    const next = {
      ...config,
      ...patch,
      volume: clampNumber(patch.volume ?? config.volume, 0, 1)
    };
    setConfig(next);
    saveAudioAlertConfig(next);
  };

  const uploadSound = async (key: AudioAlertKey, file: File | null) => {
    if (!file) return;
    setBusyKey(key);
    setError("");
    setStatus("");
    try {
      await putAudioSound({
        key,
        name: file.name,
        type: file.type || "audio/mpeg",
        updatedAt: Date.now(),
        blob: file
      });
      await refreshSounds();
      setStatus(`Đã lưu âm thanh: ${AUDIO_ALERT_LABELS[key].title}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyKey(null);
    }
  };

  const clearSound = async (key: AudioAlertKey) => {
    setBusyKey(key);
    setError("");
    setStatus("");
    try {
      await deleteAudioSound(key);
      await refreshSounds();
      setStatus(`Đã xóa âm thanh: ${AUDIO_ALERT_LABELS[key].title}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyKey(null);
    }
  };

  const testSound = async (key: AudioAlertKey) => {
    setBusyKey(key);
    setError("");
    setStatus("");
    try {
      await playAudioAlert(key);
      setStatus(`Đã phát thử: ${AUDIO_ALERT_LABELS[key].title}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="apiGrid">
      {error ? <div className="notice error fullWidth">{error}</div> : null}
      {status ? <div className="notice fullWidth">{status}</div> : null}

      <div className="panel full">
        <div className="panelHeader">
          <h2>Âm thanh cảnh báo</h2>
          <Badge tone={config.enabled ? "safe" : "warn"} icon={Volume2}>
            {config.enabled ? "Đang bật" : "Đang tắt"}
          </Badge>
        </div>
        <div className="stateGrid">
          <label className="field" style={{ minHeight: 76 }}>
            <span>Bật âm thanh</span>
            <select
              value={config.enabled ? "on" : "off"}
              onChange={(event) => updateConfig({ enabled: event.target.value === "on" })}
            >
              <option value="on">Bật</option>
              <option value="off">Tắt</option>
            </select>
          </label>
          <label className="field" style={{ minHeight: 76 }}>
            <span>Volume</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={config.volume}
                onChange={(event) => updateConfig({ volume: Number(event.target.value) })}
                style={{ width: "100%" }}
              />
              <strong style={{ width: 42, textAlign: "right" }}>{Math.round(config.volume * 100)}%</strong>
            </div>
          </label>
        </div>
      </div>

      <div className="panel full">
        <div className="panelHeader">
          <h2>File âm thanh</h2>
          <span className="pill neutral">{AUDIO_ALERT_KEYS.filter(key => sounds[key]).length}/{AUDIO_ALERT_KEYS.length} file</span>
        </div>
        <div className="stateGrid">
          {AUDIO_ALERT_KEYS.map((key) => {
            const label = AUDIO_ALERT_LABELS[key];
            const sound = sounds[key];
            const busy = busyKey === key;
            return (
              <div
                key={key}
                style={{
                  padding: 14,
                  minHeight: 190,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.03)"
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <strong>{label.title}</strong>
                    <div className="helperText" style={{ marginTop: 4 }}>{label.detail}</div>
                  </div>
                  <span className={sound ? "pill positive" : "pill neutral"}>{sound ? "Đã có" : "Trống"}</span>
                </div>

                <div style={{ minHeight: 42 }}>
                  {sound ? (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, wordBreak: "break-word" }}>{sound.name}</div>
                      <div className="helperText">
                        {sound.type || "audio"} · {new Date(sound.updatedAt).toLocaleString("vi-VN")}
                      </div>
                    </>
                  ) : (
                    <div className="empty" style={{ padding: "10px 12px" }}>Chưa upload file.</div>
                  )}
                </div>

                <div className="horizontal" style={{ marginTop: "auto" }}>
                  <label className="aiUploadButton" style={{ minHeight: 38, padding: "0 12px" }}>
                    <Upload size={15} />
                    <span>Upload</span>
                    <input
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.ogg"
                      disabled={busy}
                      onChange={(event) => {
                        void uploadSound(key, event.target.files?.[0] ?? null);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  <button disabled={busy || !sound} onClick={() => void testSound(key)}>
                    <Play size={15} />
                    Test
                  </button>
                  <button className="iconButton" disabled={busy || !sound} onClick={() => void clearSound(key)} title="Xóa">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function BacktestPage({ config }: { config: RuntimeSettings | null }) {
  const [strategy, setStrategy] = useState<BacktestStrategy>("smc");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("1m");
  const [candles, setCandles] = useState(1000);
  const [minConfidence, setMinConfidence] = useState(70);
  const [maxHoldCandles, setMaxHoldCandles] = useState(120);
  const [maxWaitCandles, setMaxWaitCandles] = useState(20);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!config) return;
    setMinConfidence(strategy === "wyckoff" ? config.wyckoffMinConfidence : config.minConfidence);
  }, [config?.minConfidence, config?.wyckoffMinConfidence, strategy]);

  const runBacktest = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await api<BacktestResult>("/api/backtest/strategy", {
        method: "POST",
        body: JSON.stringify({
          strategy,
          symbol: normalizeUsdFuturesSymbol(symbol),
          timeframe,
          candles,
          minConfidence,
          maxHoldCandles,
          maxWaitCandles
        })
      });
      setResult(data);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const summary = result?.summary;
  const rows = result?.trades.slice(0, 120) ?? [];

  return (
    <section className="apiGrid">
      {error ? <div className="notice error fullWidth">{error}</div> : null}

      <div className="panel full">
        <div className="panelHeader">
          <h2>Backtest Chiến Lược AI</h2>
          <Badge tone="info" icon={Shield}>Không gửi lệnh</Badge>
        </div>
        <div className="formGrid">
          <label className="field">
            <span>Chiến lược</span>
            <select value={strategy} onChange={(event) => setStrategy(event.target.value as BacktestStrategy)}>
              <option value="smc">SMC</option>
              <option value="wyckoff">Wyckoff</option>
            </select>
          </label>
          <label className="field">
            <span>Coin</span>
            <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="BTCUSDT" />
          </label>
          <label className="field">
            <span>Khung thời gian</span>
            <select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>
              <option value="1m">1m</option>
              <option value="3m">3m</option>
              <option value="5m">5m</option>
              <option value="15m">15m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
            </select>
          </label>
          <label className="field">
            <span>Số nến quá khứ</span>
            <input type="number" min="120" max="1500" value={candles} onChange={(event) => setCandles(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Min confidence</span>
            <input type="number" min="0" max="100" value={minConfidence} onChange={(event) => setMinConfidence(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Giữ lệnh tối đa</span>
            <input type="number" min="5" max="500" value={maxHoldCandles} onChange={(event) => setMaxHoldCandles(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>Chờ entry tối đa</span>
            <input type="number" min="1" max="100" value={maxWaitCandles} onChange={(event) => setMaxWaitCandles(Number(event.target.value))} />
          </label>
        </div>
        <div className="saveBar">
          <button disabled={busy} onClick={() => void runBacktest()}>
            <FlaskConical size={16} />
            {busy ? "Đang chạy..." : "Chạy backtest"}
          </button>
          {result ? (
            <span className="helperText">
              {result.symbol} {result.timeframe} · {result.candles} nến · test {result.testedCandles} nến · {result.elapsedMs}ms{result.cacheHit ? " · cache" : ""}
            </span>
          ) : null}
        </div>
      </div>

      {summary ? (
        <>
          <div className="grid-5 fullWidth">
            <BacktestMetric label="Raw tín hiệu" value={summary.rawSignals} />
            <BacktestMetric label="Đạt chuẩn" value={summary.qualifiedSignals} />
            <BacktestMetric label="Đã fill" value={summary.filledTrades} />
            <BacktestMetric label="Đã close" value={summary.closedTrades} />
            <BacktestMetric label="Win rate" value={`${summary.winRate.toFixed(1)}%`} tone={summary.winRate >= 50 ? "up" : "down"} />
          </div>

          <div className="grid-5 fullWidth">
            <BacktestMetric label="TP thắng" value={summary.wins} tone="up" />
            <BacktestMetric label="SL thua" value={summary.losses} tone="down" />
            <BacktestMetric label="SL-only potential" value={summary.slOnlySignals} />
            <BacktestMetric label="Expired" value={summary.expired} />
            <BacktestMetric label="Net R" value={formatR(summary.netR)} tone={summary.netR >= 0 ? "up" : "down"} />
          </div>

          <div className="panel full">
            <div className="panelHeader">
              <h2>Lý do bị chặn</h2>
              <span className="pill neutral">Diagnostics</span>
            </div>
            {Object.keys(result?.diagnostics ?? {}).length > 0 ? (
              <div className="stateGrid">
                {Object.entries(result?.diagnostics ?? {})
                  .sort((left, right) => right[1] - left[1])
                  .slice(0, 8)
                  .map(([label, count]) => (
                    <Metric key={label} label={label} value={count} />
                  ))}
              </div>
            ) : (
              <div className="empty">Không có lý do chặn trong đoạn test này.</div>
            )}
          </div>

          <div className="panel full">
            <div className="panelHeader">
              <h2>Chi tiết lệnh backtest</h2>
              <span className="pill neutral">{rows.length}/{result?.trades.length ?? 0} dòng</span>
            </div>
            {rows.length > 0 ? (
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Thời gian tín hiệu</th>
                      <th>Side</th>
                      <th>Setup</th>
                      <th>Conf</th>
                      <th>Entry</th>
                      <th>SL</th>
                      <th>TP</th>
                      <th>Kết quả</th>
                      <th>R</th>
                      <th>Nến giữ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((trade) => (
                      <tr key={`${trade.index}-${trade.signalTime}`}>
                        <td>{trade.index}</td>
                        <td>{new Date(trade.signalTime).toLocaleString("vi-VN")}</td>
                        <td>{trade.side}</td>
                        <td>{trade.setupType}</td>
                        <td>{trade.confidence.toFixed(0)}</td>
                        <td>{formatTradePrice(trade.entry)}</td>
                        <td>{formatTradePrice(trade.stopLoss)}</td>
                        <td>{formatTradePrice(trade.takeProfit)}</td>
                        <td>
                          <span className={backtestOutcomeClass(trade.outcome)}>
                            {backtestOutcomeLabel(trade.outcome)}
                          </span>
                        </td>
                        <td>{formatR(trade.pnlR)}</td>
                        <td>{trade.barsHeld}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">Không có trade đạt chuẩn trong đoạn nến này.</div>
            )}
          </div>
        </>
      ) : (
        <div className="panel full">
          <div className="empty">Chọn coin, timeframe và chạy backtest để xem kết quả.</div>
        </div>
      )}
    </section>
  );
}

function BacktestMetric({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: unknown;
  tone?: "up" | "down" | "neutral";
}) {
  return (
    <div className="metric-card">
      <span className="metric-header">{label}</span>
      <div className="metric-row">
        <div className="metric-value-col">
          <span className="metric-value">{String(value ?? "-")}</span>
          <span className={`metric-pct ${tone}`}>{tone === "up" ? "Tốt" : tone === "down" ? "Yếu" : "Backtest"}</span>
        </div>
      </div>
    </div>
  );
}

function formatR(value: number): string {
  if (!Number.isFinite(value)) return "0.00R";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function formatTradePrice(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  return value.toFixed(8);
}

function backtestOutcomeLabel(outcome: BacktestOutcome): string {
  if (outcome === "tp") return "TP";
  if (outcome === "sl") return "SL";
  if (outcome === "timeout") return "Timeout";
  if (outcome === "expired") return "Không khớp";
  return "Đang mở";
}

function backtestOutcomeClass(outcome: BacktestOutcome): string {
  if (outcome === "tp") return "pill positive";
  if (outcome === "sl") return "pill negative";
  return "pill neutral";
}


interface MarketTicker {
  symbol: string;
  price: number;
  changePct: number;
  volume: number;
}
interface MarketOverviewData {
  gainers:   MarketTicker[];
  losers:    MarketTicker[];
  newList:   MarketTicker[];
  topVolume: MarketTicker[];
}

const CRYPTO_ICONS: Record<string, string> = {
  BTC:"₿",ETH:"Ξ",BNB:"◈",SOL:"◎",XRP:"✕",DOGE:"Ð",ADA:"₳",AVAX:"▲",
  LINK:"⬡",DOT:"●",LTC:"Ł",TRX:"◑",ATOM:"⚛",ETC:"ξ",INJ:"◈",SUI:"◈",
  APT:"◈",ARB:"◈",OP:"◈",NEAR:"◈",FIL:"◈",WLD:"◈",UNI:"◈",PHA:"◈",
};
function coinSymbol(sym: string) { return sym.replace(/USDT$/, ""); }
function coinIcon(sym: string) {
  const base = coinSymbol(sym);
  return CRYPTO_ICONS[base] ?? base.slice(0, 2);
}
function fmtMarketPrice(p: number): string {
  if (p >= 1000) return "$" + (p / 1000).toFixed(2) + "K";
  if (p >= 1)    return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  return "$" + p.toFixed(5);
}

const COLS_CFG: Array<{ key: keyof MarketOverviewData; label: string; accent: string }> = [
  { key: "gainers",   label: "Top tăng giá",    accent: "var(--green)" },
  { key: "losers",    label: "Top giảm giá",     accent: "var(--red)"   },
  { key: "newList",   label: "Mới niêm yết",     accent: "var(--cyan)"  },
  { key: "topVolume", label: "Volume lớn nhất",  accent: "var(--gold)"  },
];

function MarketOverview({ onSelectSymbol }: { onSelectSymbol: (s: string) => void }) {
  const [base, setBase] = useState<MarketOverviewData | null>(null);
  const [live, setLive] = useState<Map<string, { price: number; changePct: number }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [wsStatus, setWsStatus] = useState<"connecting"|"live"|"off">("connecting");

  // Fetch category lists from backend (refreshes every 60s — categories don't change fast)
  const loadBase = async () => {
    try {
      const d = await api<MarketOverviewData>("/api/market/overview");
      setBase(d);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => {
    void loadBase();
    const t = setInterval(() => void loadBase(), 60_000);
    return () => clearInterval(t);
  }, []);

  // WebSocket mini-ticker — direct from Binance Futures, updates every ~1s
  useEffect(() => {
    const WS_URL = "wss://fstream.binance.com/ws/!miniTicker@arr";
    let ws: WebSocket;
    let dead = false;
    let retryMs = 2000;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      setWsStatus("connecting");

      ws.onopen = () => { setWsStatus("live"); retryMs = 2000; };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const arr = JSON.parse(ev.data as string) as Array<{ s: string; c: string; o: string; q: string }>;
          setLive(prev => {
            const next = new Map(prev);
            for (const t of arr) {
              const price = Number(t.c);
              const open  = Number(t.o);
              const changePct = open > 0 ? (price - open) / open * 100 : 0;
              next.set(t.s, { price, changePct });
            }
            return next;
          });
        } catch { /* malformed */ }
      };

      ws.onerror = () => setWsStatus("off");
      ws.onclose = () => {
        setWsStatus("off");
        if (!dead) {
          setTimeout(() => { if (!dead) connect(); }, retryMs);
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      };
    };

    connect();
    return () => { dead = true; ws?.close(); };
  }, []);

  // Merge base list with live prices
  const merged = (key: keyof MarketOverviewData): MarketTicker[] =>
    (base?.[key] ?? []).map(t => {
      const l = live.get(t.symbol);
      return l ? { ...t, price: l.price, changePct: l.changePct } : t;
    });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
      {COLS_CFG.map(({ key, label, accent }) => (
        <div key={key} style={{
          background: "rgba(8,15,28,0.75)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "12px 14px",
          backdropFilter: "blur(14px)",
        }}>
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: "0.05em", textTransform: "uppercase" }}>
              {label}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{
                width: 5, height: 5, borderRadius: "50%",
                background: wsStatus === "live" ? "var(--green)" : wsStatus === "connecting" ? "var(--gold)" : "#555",
                boxShadow: wsStatus === "live" ? "0 0 4px var(--green-glow)" : "none",
              }} />
              <span style={{ fontSize: 9, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                {wsStatus === "live" ? "LIVE" : wsStatus === "connecting" ? "..." : "OFF"}
              </span>
            </span>
          </div>

          {/* Rows */}
          {loading && !base ? (
            [0,1,2,3,4].map(i => (
              <div key={i} className="skeleton" style={{ height: 28, marginBottom: 5, borderRadius: 6 }} />
            ))
          ) : merged(key).slice(0, 5).map((t) => {
            const base2 = coinSymbol(t.symbol);
            const isUp  = t.changePct >= 0;
            return (
              <div
                key={t.symbol}
                onClick={() => onSelectSymbol(t.symbol)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 6px", borderRadius: 6, cursor: "pointer",
                  transition: "background 0.15s", marginBottom: 2,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,212,255,0.07)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div style={{
                  width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                  background: `${coinColor(t.symbol)}18`,
                  border: "1px solid rgba(255,255,255,0.07)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700, color: coinColor(t.symbol),
                }}>
                  {coinIcon(t.symbol)}
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {base2}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                  {fmtMarketPrice(t.price)}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)",
                  color: isUp ? "var(--green)" : "var(--red)",
                  flexShrink: 0, minWidth: 58, textAlign: "right",
                }}>
                  {isUp ? "+" : ""}{t.changePct.toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ManualTradePage({
  config,
  symbol,
  setSymbol,
  onSubmit
}: {
  config: RuntimeSettings | null;
  symbol: string;
  setSymbol: (value: string) => void;
  onSubmit: (payload: ManualTradePayload) => void;
}) {
  const maxLeverage = Math.max(1, Math.floor(config?.maxLeverage ?? 1));
  const [orderType, setOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [leverage, setLeverage] = useState(1);
  const [marginType, setMarginType] = useState<"CROSSED" | "ISOLATED">("CROSSED");
  const [price, setPrice] = useState("");
  const [marginUsdt, setMarginUsdt] = useState(String(config?.maxOrderUsdt ?? 10));
  const [marginPercent, setMarginPercent] = useState(100);
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [stopLossPercent, setStopLossPercent] = useState(
    String(config?.slPercent ?? 0.8)
  );
  const [tpslEnabled, setTpslEnabled] = useState(true);
  const [marketPrice, setMarketPrice] = useState<number | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState("");
  const [balance, setBalance] = useState<AccountBalance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [orderRules, setOrderRules] = useState<OrderRules | null>(null);
  const [marginEditedManually, setMarginEditedManually] = useState(false);
  const [localError, setLocalError] = useState("");
  const [signalNotice, setSignalNotice] = useState("");

  useEffect(() => {
    const nextLeverage = Math.min(
      Math.max(1, Math.floor(config?.fixedLeverage ?? 1)),
      Math.max(1, Math.floor(config?.maxLeverage ?? 1))
    );
    setLeverage(nextLeverage);
  }, [config?.fixedLeverage, config?.maxLeverage]);

  useEffect(() => {
    if (!config) return;
    setStopLossPercent(String(config.slPercent));
  }, [config?.slPercent]);

  useEffect(() => {
    if (marginEditedManually) return;
    const baseUsdt =
      balance !== null && balance.available > 0
        ? balance.available
        : config?.maxOrderUsdt;
    if (!baseUsdt || baseUsdt <= 0) return;
    setMarginUsdt(((baseUsdt * marginPercent) / 100).toFixed(2));
  }, [balance?.available, config?.maxOrderUsdt, marginPercent, marginEditedManually]);

  useEffect(() => {
    const cleanSymbol = normalizeUsdFuturesSymbol(symbol);
    if (!cleanSymbol) return;

    let active = true;
    let requestInFlight = false;
    const fetchPrice = () => {
      if (requestInFlight || isBinanceCooldownActive()) return;
      requestInFlight = true;
      api<Record<string, unknown>>(`/api/market/price/${cleanSymbol}`)
        .then((ticker) => {
          if (!active) return;
          const nextPrice = Number(ticker.price ?? 0);
          if (Number.isFinite(nextPrice) && nextPrice > 0) {
            setMarketPrice(nextPrice);
            setPriceUpdatedAt(new Date().toLocaleTimeString("vi-VN", { hour12: false }));
            setPrice((current) => (current ? current : String(nextPrice)));
          }
        })
        .catch(() => {
          if (active) setMarketPrice(null);
        })
        .finally(() => {
          requestInFlight = false;
        });
    };

    setMarketPrice(null);
    setPriceUpdatedAt("");
    setPrice("");
    fetchPrice();
    const timer = window.setInterval(fetchPrice, PRICE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [symbol]);

  useEffect(() => {
    const cleanSymbol = normalizeUsdFuturesSymbol(symbol);
    if (!cleanSymbol) return;
    if (isBinanceCooldownActive()) return;
    api<OrderRules>(`/api/market/rules/${cleanSymbol}`)
      .then((rules) => setOrderRules(rules))
      .catch(() => setOrderRules(null));
  }, [symbol]);

  useEffect(() => {
    if (!config?.credentialsConfigured) {
      setBalance(null);
      setBalanceError("Chưa lưu API Binance.");
      return;
    }

    let active = true;
    let requestInFlight = false;
    const fetchBalance = () => {
      if (requestInFlight) return;
      if (isBinanceCooldownActive()) {
        setBalanceError(`Binance API dang tam dung, con ${getBinanceCooldownSeconds()}s.`);
        return;
      }
      requestInFlight = true;
      api<unknown[]>("/api/balance")
        .then((rows) => {
          if (!active) return;
          const parsed = parseUsdtBalance(rows);
          setBalance(parsed);
          setBalanceError(parsed ? "" : "Không tìm thấy số dư USDT.");
        })
        .catch((nextError) => {
          if (!active) return;
          setBalance(null);
          setBalanceError(
            nextError instanceof Error ? nextError.message : String(nextError)
          );
        })
        .finally(() => {
          requestInFlight = false;
        });
    };

    fetchBalance();
    const timer = window.setInterval(fetchBalance, BALANCE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [config?.credentialsConfigured]);

  if (!config) {
    return (
      <section className="panel full">
        <p className="helperText">Đang tải cấu hình giao dịch...</p>
      </section>
    );
  }

  const mode = getTradingMode(config);
  const cleanSymbol = normalizeUsdFuturesSymbol(symbol);
  const entryPrice =
    orderType === "MARKET" ? marketPrice ?? Number(price) : Number(price);
  const margin = Number(marginUsdt);
  const notional = Number.isFinite(margin) ? margin * leverage : 0;
  const quantity = entryPrice > 0 && notional > 0 ? notional / entryPrice : 0;
  const availableText =
    balance !== null
      ? `${balance.available.toFixed(2)} USDT`
      : `${config.maxOrderUsdt.toFixed(2)} USDT giới hạn/lệnh`;
  const walletText =
    balance !== null ? `${balance.wallet.toFixed(2)} USDT` : "Chưa đọc được";
  const sliderBaseUsdt =
    balance !== null && balance.available > 0
      ? balance.available
      : config.maxOrderUsdt;
  const maxNotional = sliderBaseUsdt * maxLeverage;
  const marketBlocked = orderType === "MARKET" && !config.allowMarketOrder;
  const activeMinQty =
    orderType === "MARKET" && orderRules?.marketMinQty
      ? orderRules.marketMinQty
      : orderRules?.minQty ?? 0;
  const activeStepSize =
    orderType === "MARKET" && orderRules?.marketStepSize
      ? orderRules.marketStepSize
      : orderRules?.stepSize ?? 0;
  const minTradeQty = Math.max(activeMinQty, activeStepSize);
  const minMarginUsdt =
    entryPrice > 0 && minTradeQty > 0
      ? (minTradeQty * entryPrice) / Math.max(1, leverage)
      : 0;
  const slPercentPreview = Number(stopLossPercent);
  const longSlPreview =
    entryPrice > 0 && Number.isFinite(slPercentPreview) && slPercentPreview > 0
      ? entryPrice * (1 - slPercentPreview / 100)
      : null;
  const shortSlPreview =
    entryPrice > 0 && Number.isFinite(slPercentPreview) && slPercentPreview > 0
      ? entryPrice * (1 + slPercentPreview / 100)
      : null;

  const updateMarginPercent = (value: number) => {
    setMarginEditedManually(false);
    setMarginPercent(value);
    setMarginUsdt(((sliderBaseUsdt * value) / 100).toFixed(2));
  };

  const nudge = (
    value: string,
    setter: (value: string) => void,
    delta: number
  ) => {
    const current = Number(value || 0);
    const next = Math.max(0, current + delta);
    setter(Number(next.toFixed(6)).toString());
  };

  const calculatedTpsl = (side: "BUY" | "SELL") => {
    const take = Number(takeProfitPrice);
    const stop = Number(stopLossPrice);
    const stopPercent = Number(stopLossPercent);
    if (entryPrice <= 0) return { takeProfitPrice: take, stopLossPrice: stop };

    if (side === "BUY") {
      return {
        takeProfitPrice:
          take > 0 ? take : entryPrice * (1 + config.tpPercent / 100),
        stopLossPrice:
          stop > 0
            ? stop
            : entryPrice *
              (1 - Math.max(0, Number.isFinite(stopPercent) ? stopPercent : 0) / 100)
      };
    }
    return {
      takeProfitPrice:
        take > 0 ? take : entryPrice * (1 - config.tpPercent / 100),
      stopLossPrice:
        stop > 0
          ? stop
          : entryPrice *
            (1 + Math.max(0, Number.isFinite(stopPercent) ? stopPercent : 0) / 100)
    };
  };

  const submit = (side: "BUY" | "SELL") => {
    setLocalError("");
    const tpsl = calculatedTpsl(side);
    if (!cleanSymbol) {
      setLocalError("Nhập symbol trước khi vào lệnh.");
      return;
    }
    if (!config.allowedSymbols.includes(cleanSymbol)) {
      setLocalError(`${cleanSymbol} chưa nằm trong danh sách symbol được phép trade.`);
      return;
    }
    if (config.readOnly) {
      setLocalError("Đang bật Chỉ xem dữ liệu, không thể gửi lệnh.");
      return;
    }
    if (marketBlocked) {
      setLocalError("Market Order đang bị chặn trong cấu hình an toàn.");
      return;
    }
    if (entryPrice <= 0) {
      setLocalError("Giá vào lệnh phải lớn hơn 0.");
      return;
    }
    if (!Number.isFinite(margin) || margin <= 0) {
      setLocalError("Ký quỹ ban đầu phải lớn hơn 0 USDT.");
      return;
    }
    if (balance && margin > balance.available) {
      setLocalError(`Ký quỹ không được vượt quá số dư khả dụng ${balance.available.toFixed(2)} USDT.`);
      return;
    }
    if (minMarginUsdt > 0 && margin < minMarginUsdt) {
      setLocalError(
        `${cleanSymbol} cần tối thiểu khoảng ${minMarginUsdt.toFixed(
          2
        )} USDT ký quỹ ở ${leverage}x để đạt quantity ${minTradeQty}.`
      );
      return;
    }
    const slPercentValue = Number(stopLossPercent);
    if (
      Number(stopLossPrice) <= 0 &&
      (!Number.isFinite(slPercentValue) || slPercentValue <= 0)
    ) {
      setLocalError("Nhập Stop Loss theo giá hoặc phần trăm lớn hơn 0.");
      return;
    }
    if (!tpslEnabled || tpsl.takeProfitPrice <= 0 || tpsl.stopLossPrice <= 0) {
      setLocalError("Bắt buộc có Take Profit và Stop Loss.");
      return;
    }

    onSubmit({
      symbol: cleanSymbol,
      side,
      orderType,
      price: entryPrice,
      marginUsdt: margin,
      leverage,
      marginType,
      takeProfitPrice: Number(tpsl.takeProfitPrice.toFixed(6)),
      stopLossPrice: Number(tpsl.stopLossPrice.toFixed(6))
    });
  };

  return (
    <section className="manualTradeShell">
      <MarketOverview onSelectSymbol={setSymbol} />
      <div className="tradeMainColumn">
        <SFPSettingsPanel />
      </div>

    </section>
  );
}

function TradePriceInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="tradePriceInput">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={value}
          placeholder="Giá"
          onChange={(event) => onChange(event.target.value)}
        />
        <strong>USDT</strong>
      </div>
    </label>
  );
}

function TradePercentInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="tradePriceInput">
      <span>{label}</span>
      <div>
        <input
          type="number"
          step="0.1"
          min="0"
          value={value}
          placeholder="0.5"
          onChange={(event) => onChange(event.target.value)}
        />
        <strong>%</strong>
      </div>
    </label>
  );
}

const FAV_STORAGE_KEY = "sfp_fav_coins";

function loadFavCoins(): string[] {
  try {
    const saved = localStorage.getItem(FAV_STORAGE_KEY);
    if (saved) return JSON.parse(saved) as string[];
  } catch { /* ignore */ }
  return [...SFP_FAVORITE_COINS];
}

function saveFavCoins(coins: string[]): void {
  try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(coins)); } catch { /* ignore */ }
}

function visibleScanSymbols(selected: string[], favorites: string[]): string[] {
  const favoriteSet = new Set(favorites.map(toFuturesSymbol).filter(Boolean));
  return Array.from(new Set(
    selected
      .map(toFuturesSymbol)
      .filter((symbol) => symbol && favoriteSet.has(symbol))
  ));
}

function playWarningBeep() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    gain.connect(ctx.destination);

    [880, 1175].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + index * 0.18);
      osc.stop(ctx.currentTime + index * 0.18 + 0.18);
    });

    window.setTimeout(() => void ctx.close().catch(() => undefined), 700);
  } catch {
    // Browser may block sound until the user has interacted with the page.
  }
}

let rejectAlarmLastMs = 0;

function playSosRejectAlarm() {
  const nowMs = Date.now();
  if (nowMs - rejectAlarmLastMs < 2500) return;
  rejectAlarmLastMs = nowMs;

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    void ctx.resume().catch(() => undefined);

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 0.03);
    master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.05);
    master.connect(ctx.destination);

    const dot = 0.10;
    const dash = 0.28;
    const gap = 0.08;
    const letterGap = 0.18;
    const pattern = [dot, dot, dot, dash, dash, dash, dot, dot, dot];
    let t = ctx.currentTime + 0.04;

    pattern.forEach((duration, index) => {
      const tone = ctx.createOscillator();
      const toneGain = ctx.createGain();
      const isDash = duration === dash;

      tone.type = "square";
      tone.frequency.setValueAtTime(isDash ? 660 : 940, t);
      tone.frequency.exponentialRampToValueAtTime(isDash ? 520 : 760, t + duration);

      toneGain.gain.setValueAtTime(0.0001, t);
      toneGain.gain.exponentialRampToValueAtTime(isDash ? 0.42 : 0.34, t + 0.012);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      tone.connect(toneGain);
      toneGain.connect(master);
      tone.start(t);
      tone.stop(t + duration + 0.02);

      t += duration + gap + (index === 2 || index === 5 ? letterGap : 0);
    });

    window.setTimeout(() => void ctx.close().catch(() => undefined), 2400);
  } catch {
    // Trinh duyet co the chan am thanh cho den khi nguoi dung tuong tac voi trang.
  }
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface PnlResult {
  pnlPct: number;
  pnlUsdt: number;
  currentPrice: number;
  entryPrice?: number;
  source?: "position" | "signal";
}

function useCountUp(target: number, duration = 380): number {
  const [value, setValue] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    if (prev.current === target) return;
    const start = prev.current;
    const t0 = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setValue(start + (target - start) * ease);
      if (p < 1) { raf = requestAnimationFrame(tick); }
      else { setValue(target); prev.current = target; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

function strategyLabel(strategy: SFPSignalRecord["strategy"]): string {
  if (strategy === "candlestick") return "Mẫu nến";
  if (strategy === "wyckoff") return "Wyckoff";
  if (strategy === "smc") return "SMC";
  return "SFP";
}

function SFPDecisionTable({ sig }: { sig: SFPSignalRecord }) {
  const details = sig.decisionDetails ?? [];
  const score = sig.decisionScore ?? 0;
  const tradeable = sig.decision === "TRADE";
  const statusText = tradeable ? "ĐỦ ĐIỀU KIỆN" : "KHÔNG VÀO";
  const statusColor = tradeable ? "var(--color-positive)" : "var(--color-negative)";

  return (
    <div style={{
      marginTop: 10,
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 8,
      overflow: "hidden",
      background: "rgba(0,0,0,0.18)"
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderBottom: "1px solid rgba(255,255,255,0.08)"
      }}>
        <strong style={{ color: statusColor, fontSize: 12 }}>{statusText}</strong>
        <span className="pill neutral">Score {score}/100</span>
        <span className="pill neutral">{strategyLabel(sig.strategy)}</span>
        {sig.patternName && <span className="pill positive">{sig.patternName}</span>}
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {sig.decisionSummary || sig.message || "Chưa có diễn giải."}
        </span>
      </div>
      {details.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "150px 78px 1fr", fontSize: 12 }}>
          <div style={{ padding: "7px 10px", color: "#888", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>Điều kiện</div>
          <div style={{ padding: "7px 10px", color: "#888", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>Kết quả</div>
          <div style={{ padding: "7px 10px", color: "#888", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>Lý do bot đánh giá</div>
          {details.map((item) => {
            const color = item.status === "pass"
              ? "var(--color-positive)"
              : item.status === "warn"
                ? "#f5a623"
                : "var(--color-negative)";
            const label = item.status === "pass" ? "Đạt" : item.status === "warn" ? "Cảnh báo" : "Trượt";
            return (
              <div key={item.id} style={{ display: "contents" }}>
                <div style={{ padding: "7px 10px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{item.label}</div>
                <div style={{ padding: "7px 10px", color, borderBottom: "1px solid rgba(255,255,255,0.04)", fontWeight: 700 }}>{label}</div>
                <div style={{ padding: "7px 10px", color: "var(--text-dim)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>{item.detail}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SmcStageStatus = "pass" | "wait" | "fail";

interface SmcStageInfo {
  label: string;
  status: SmcStageStatus;
  detail: string;
}

interface SmcExplanation {
  headline: string;
  bullets: string[];
  stages: SmcStageInfo[];
}

function viBias(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("bull")) return "thiên hướng tăng";
  if (lower.includes("bear")) return "thiên hướng giảm";
  return "chưa rõ hướng";
}

function explainSmcStatus(signal?: MarketSignal): SmcExplanation {
  if (!signal) {
    return {
      headline: "Chưa có dữ liệu SMC cho coin này.",
      bullets: ["Bấm LIVE lại hoặc chờ bot quét vòng tiếp theo."],
      stages: [
        { label: "Bias", status: "wait", detail: "Chờ hướng lớn" },
        { label: "Sweep", status: "wait", detail: "Chờ quét thanh khoản" },
        { label: "MSS", status: "wait", detail: "Chờ phá cấu trúc" },
        { label: "FVG/RR", status: "wait", detail: "Chờ điểm vào" }
      ]
    };
  }

  const reason = signal.reason ?? "";
  const isActionable = signal.signal === "LONG" || signal.signal === "SHORT";
  const bias = (reason.match(/bias=([^;]+)/i)?.[1] ?? reason.match(/HTF bias\s+([^;]+)/i)?.[1] ?? "neutral").trim();
  const htfBias = (reason.match(/HTF bias\s+([^;]+)/i)?.[1] ?? bias).trim();
  const sweepCount = Number(reason.match(/Sweep candidates\s+(\d+)/i)?.[1] ?? 0);
  const hasSweep = sweepCount > 0 || /Sweep (long|short) swing @/i.test(reason);
  const hasMss = /MSS broke/i.test(reason) || (isActionable && /MSS/i.test(reason));
  const missingMss = /MSS missing/i.test(reason);
  const fvgProblem = /FVG missing\/filled\/small/i.test(reason);
  const rrProblem = /TP liquidity\/RR invalid/i.test(reason);

  const stages: SmcStageInfo[] = [
    {
      label: "Bias",
      status: /bull|bear/i.test(bias) ? "pass" : "wait",
      detail: viBias(htfBias)
    },
    {
      label: "Sweep",
      status: hasSweep ? "pass" : "wait",
      detail: hasSweep ? `Có ${sweepCount || 1} vùng bị quét` : "Chưa quét thanh khoản"
    },
    {
      label: "MSS",
      status: hasMss ? "pass" : "wait",
      detail: hasMss ? "Đã phá cấu trúc nhỏ" : "Chưa xác nhận đảo nhịp"
    },
    {
      label: "FVG/RR",
      status: isActionable ? "pass" : rrProblem ? "fail" : "wait",
      detail: isActionable ? "Đủ vùng vào và RR" : rrProblem ? "RR hoặc TP chưa đẹp" : "Chờ vùng vào sạch"
    }
  ];

  if (isActionable) {
    return {
      headline: `${signal.signal} đã đủ chuỗi SMC, confidence ${signal.confidence}/100.`,
      bullets: [
        `${viBias(htfBias)}; đã có sweep thanh khoản, MSS và vùng entry.`,
        signal.signal === "LONG" ? "Bot đang ưu tiên kịch bản mua theo hồi về vùng vào." : "Bot đang ưu tiên kịch bản bán theo hồi về vùng vào."
      ],
      stages
    };
  }

  let headline = "Đang chờ đủ chuỗi SMC, chưa nên vào lệnh.";
  const bullets: string[] = [`HTF đang là ${viBias(htfBias)}.`];

  if (!hasSweep) {
    bullets.push("Chưa thấy cú quét thanh khoản đúng hướng.");
  } else if (missingMss) {
    headline = "Đã có sweep, nhưng chưa có MSS xác nhận.";
    bullets.push("Giá đã quét vùng thanh khoản, nhưng chưa phá cấu trúc nhỏ để xác nhận nhịp mới.");
  } else if (fvgProblem) {
    headline = "Đã có MSS, nhưng FVG chưa đủ sạch.";
    bullets.push("Vùng FVG đang thiếu, quá nhỏ, hoặc đã bị lấp nên bot chưa đặt lệnh.");
  } else if (rrProblem) {
    headline = "Setup có ý tưởng, nhưng RR/TP chưa đạt.";
    bullets.push("Mục tiêu thanh khoản hoặc tỷ lệ lời/lỗ chưa đủ đẹp nên bot bỏ qua.");
  } else if (/SMC chua co alert vao lenh/i.test(reason)) {
    bullets.push("Chưa có alert SMC đủ mạnh trên nến đã đóng.");
  } else {
    bullets.push("Bot vẫn đang chờ Sweep -> MSS -> FVG khớp đầy đủ.");
  }

  bullets.push(`Tín hiệu hiện tại: WAIT ${signal.confidence}/100.`);
  return { headline, bullets: bullets.slice(0, 3), stages };
}

function LiveStrategyChart({
  symbol,
  signal,
  points,
  loading,
  onClose
}: {
  symbol: string;
  signal?: MarketSignal;
  points: LivePricePoint[];
  loading: boolean;
  onClose: () => void;
}) {
  const clean = symbol.replace("USDT", "");
  const explanation = explainSmcStatus(signal);
  const latest = points.at(-1)?.close ?? signal?.price ?? 0;
  const first = points[0]?.close ?? latest;
  const changePct = first > 0 && latest > 0 ? (latest - first) / first * 100 : 0;
  const up = changePct >= 0;
  const fallbackPrice = latest || 1;
  const usable = points.length >= 2 ? points : [
    { t: Date.now() - 60_000, open: fallbackPrice, high: fallbackPrice * 1.001, low: fallbackPrice * 0.999, close: fallbackPrice },
    { t: Date.now(), open: fallbackPrice, high: fallbackPrice * 1.0015, low: fallbackPrice * 0.9985, close: fallbackPrice }
  ];
  const reason = signal?.reason ?? "";
  const smcLevels = Array.from(reason.matchAll(/Sweep (?:long|short) swing @\s*([0-9.eE+-]+)/gi))
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value > 0)
    .slice(-3);
  const fvgRanges = Array.from(reason.matchAll(/(?:long|short)\s+FVG\s+([0-9.eE+-]+)-([0-9.eE+-]+)/gi))
    .map(match => {
      const firstValue = Number(match[1]);
      const secondValue = Number(match[2]);
      return {
        low: Math.min(firstValue, secondValue),
        high: Math.max(firstValue, secondValue)
      };
    })
    .filter(range => Number.isFinite(range.low) && Number.isFinite(range.high) && range.low > 0 && range.high > 0)
    .slice(-2);
  const bounds = [
    ...usable.flatMap(p => [p.high, p.low]),
    ...smcLevels,
    ...fvgRanges.flatMap(range => [range.low, range.high])
  ];
  const min = Math.min(...bounds);
  const max = Math.max(...bounds);
  const span = Math.max(max - min, latest * 0.0005, 1e-12);
  const width = 100;
  const height = 48;
  const valueToY = (value: number) => height - ((value - min) / span * (height - 7) + 3.5);
  const closeLine = usable.map((point, index) => {
    const x = (index + 0.5) / usable.length * width;
    const y = valueToY(point.close);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const candleStep = width / usable.length;
  const candleWidth = Math.max(0.32, Math.min(1.35, candleStep * 0.62));
  const color = up ? "var(--green)" : "var(--red)";

  return (
    <div className="live-chart-card">
      <div className="live-chart-top">
        <div>
          <span className="live-chart-kicker">LIVE MONITOR</span>
          <strong>{clean}</strong>
          <span className="live-chart-tf">{signal?.interval ?? "..."}</span>
        </div>
        <div className="live-chart-price">
          <span style={{ color }}>{latest > 0 ? latest.toPrecision(7) : "..."}</span>
          <small style={{ color }}>{changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%</small>
          <button onClick={onClose} title="Đóng live chart">×</button>
        </div>
      </div>
      <div className="live-chart-stage">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={`Live chart ${symbol}`}>
          <defs>
            <linearGradient id={`liveFill-${symbol}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={up ? "#00ff9d" : "#ff4f68"} stopOpacity="0.28" />
              <stop offset="100%" stopColor={up ? "#00ff9d" : "#ff4f68"} stopOpacity="0.01" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={width} height={height} fill={`url(#liveFill-${symbol})`} opacity="0.3" />
          {[0.25, 0.5, 0.75].map(mark => (
            <line
              key={mark}
              x1="0"
              x2={width}
              y1={height * mark}
              y2={height * mark}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="0.35"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {fvgRanges.map((range, index) => {
            const yTop = valueToY(range.high);
            const yBottom = valueToY(range.low);
            return (
              <g key={`fvg-${index}`}>
                <rect
                  x="66"
                  y={Math.min(yTop, yBottom)}
                  width="34"
                  height={Math.max(Math.abs(yBottom - yTop), 0.8)}
                  fill="#a78bfa"
                  opacity="0.18"
                />
                <text x="67.5" y={Math.min(yTop, yBottom) + 2.7} fill="#d8c9ff" fontSize="2.2" fontWeight="800">FVG</text>
              </g>
            );
          })}
          {smcLevels.map((level, index) => (
            <g key={`sweep-${index}`}>
              <line
                x1="0"
                x2={width}
                y1={valueToY(level)}
                y2={valueToY(level)}
                stroke="#f5c84b"
                strokeWidth="0.75"
                strokeDasharray="2 1.6"
                opacity="0.8"
                vectorEffect="non-scaling-stroke"
              />
              <text x="1.2" y={Math.max(3, valueToY(level) - 1)} fill="#ffe08a" fontSize="2.2" fontWeight="800">SWEEP</text>
            </g>
          ))}
          {usable.map((point, index) => {
            const candleUp = point.close >= point.open;
            const x = (index + 0.5) / usable.length * width;
            const yHigh = valueToY(point.high);
            const yLow = valueToY(point.low);
            const yOpen = valueToY(point.open);
            const yClose = valueToY(point.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(Math.abs(yClose - yOpen), 0.45);
            const candleColor = candleUp ? "#00ff9d" : "#ff4f68";
            return (
              <g key={`${point.t}-${index}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={yHigh}
                  y2={yLow}
                  stroke={candleColor}
                  strokeWidth="0.65"
                  opacity="0.9"
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  x={x - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  rx="0.08"
                  fill={candleUp ? "rgba(0,255,157,0.78)" : "rgba(255,79,104,0.78)"}
                  stroke={candleColor}
                  strokeWidth="0.18"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          <polyline points={closeLine} fill="none" stroke={up ? "#a7ffd8" : "#ffc0cb"} strokeWidth="0.45" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.5" />
          {latest > 0 && (
            <line
              x1="0"
              x2={width}
              y1={valueToY(latest)}
              y2={valueToY(latest)}
              stroke={up ? "#00ff9d" : "#ff4f68"}
              strokeWidth="0.5"
              strokeDasharray="1.2 1.2"
              opacity="0.75"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div className="smc-stage-row">
          {explanation.stages.map(stage => (
            <span key={stage.label} className={`smc-stage-pill ${stage.status}`} title={stage.detail}>
              <b>{stage.label}</b>
              <small>{stage.detail}</small>
            </span>
          ))}
        </div>
        <div className="live-chart-overlay">
          <span className={signal?.signal === "WAIT" ? "live-wait" : signal?.signal === "LONG" ? "live-long" : "live-short"}>
            {signal?.signal ?? "WAIT"} {signal?.confidence ?? 0}/100
          </span>
          <p>{explanation.headline}</p>
          <ul>
            {explanation.bullets.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </div>
        {loading && <div className="live-chart-loading">Đang nạp nến...</div>}
      </div>
    </div>
  );
}

function SFPHistoryCard({ sig, pnl, fmtPrice, fmtUsdt, fmtPct, expandedId, setExpandedId, onChartClick, onLiveChart, chartLoading }: {
  sig: SFPSignalRecord;
  pnl: PnlResult | null;
  fmtPrice: (v: number) => string;
  fmtUsdt:  (v: number) => string;
  fmtPct:   (v: number) => string;
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  onChartClick?: (sig: SFPSignalRecord) => void;
  onLiveChart?: (id: number) => void;
  chartLoading?: boolean;
}) {
  const isLong   = sig.direction === "BULLISH";
  const isOpen   = expandedId === sig.id;
  const isClosed = sig.status === "tp_hit" || sig.status === "sl_hit";
  const isWin    = pnl ? pnl.pnlUsdt > 0 : false;
  const pnlColor = !pnl ? "var(--muted)" : pnl.pnlUsdt > 0 ? "var(--green)" : "var(--red)";
  const animPnlUsdt = useCountUp(pnl?.pnlUsdt ?? 0);
  const animPnlPct  = useCountUp(pnl?.pnlPct  ?? 0);

  const statusColor = sig.status === "executed" ? "var(--green)"
    : sig.status === "simulated" ? "#60a5fa"
    : sig.status === "tp_hit" ? "var(--green)"
    : sig.status === "sl_hit" ? "var(--red)"
    : "var(--muted)";
  const statusLabel = sig.status === "executed" ? "đang mở"
    : sig.status === "limit_placed" ? "chờ khớp"
    : sig.status === "simulated" ? "mô phỏng"
    : sig.status === "tp_hit" ? "TP ✓"
    : sig.status === "sl_hit" ? "SL ✗"
    : sig.status === "rejected" ? "bỏ qua"
    : sig.status === "ignored" ? "hết hiệu lực"
    : sig.status;
  const decisionLabel = sig.status === "tp_hit" ? "ĐẠT TP"
    : sig.status === "sl_hit" ? "HIT SL"
    : sig.status === "executed" ? "LỆNH THẬT"
    : sig.status === "simulated" ? "MÔ PHỎNG"
    : sig.status === "rejected" ? "TỪ CHỐI"
    : sig.status === "ignored" ? "HẾT HIỆU LỰC"
    : sig.decision === "TRADE" ? "ĐẠT RULE"
    : sig.decision === "SKIP" ? "BOT BỎ QUA"
    : "THEO DÕI";
  const decisionColor = sig.status === "tp_hit" ? "var(--green)"
    : sig.status === "sl_hit" ? "var(--red)"
    : sig.status === "executed" ? "var(--green)"
    : sig.status === "simulated" ? "#60a5fa"
    : sig.status === "rejected" ? "#f5a623"
    : sig.status === "ignored" ? "#f5a623"
    : sig.decision === "TRADE" ? "var(--green)"
    : sig.decision === "SKIP" ? "#f5a623"
    : "var(--muted)";
  const decisionBg = sig.status === "rejected" || sig.status === "ignored" || sig.decision === "SKIP"
    ? "rgba(245,166,35,0.12)"
    : sig.status === "sl_hit"
      ? "rgba(255,45,90,0.12)"
      : sig.status === "simulated"
        ? "rgba(96,165,250,0.12)"
        : "rgba(0,255,157,0.12)";
  const eventTime = new Date(sig.closedAt ?? sig.createdAt);
  const eventTimeText = eventTime.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const borderColor = (sig.status === "executed" || isClosed)
    ? (pnl ? (pnl.pnlUsdt > 0 ? "var(--green)" : "var(--red)") : "var(--green)")
    : "rgba(255,255,255,0.06)";

  // SL risk: % loss of margin if SL is hit
  const slDistancePct = sig.entryPrice > 0 ? Math.abs(sig.entryPrice - sig.slPrice) / sig.entryPrice * 100 : 0;
  const maxLossPct    = slDistancePct * sig.leverage;
  const slRiskLevel   = maxLossPct >= 50 ? "danger" : maxLossPct >= 30 ? "warn" : null;

  return (
    <div
      onClick={() => setExpandedId(isOpen ? null : (sig.id ?? null))}
      style={{
        borderRadius: 8,
        background: (sig.status === "executed" || isClosed)
          ? (isWin ? "rgba(0,255,157,0.05)" : "rgba(255,45,90,0.05)")
          : "rgba(255,255,255,0.02)",
        border: `1px solid ${borderColor}`,
        cursor: "pointer",
        overflow: "hidden",
        transition: "all 0.15s",
      }}
    >
      {/* ── Row chính ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13, color: "#fff" }}>{sig.symbol.replace("USDT","")}</strong>
            <span style={{
              fontSize: 13,
              fontWeight: 900,
              padding: "2px 9px",
              borderRadius: 5,
              color: isLong ? "#03070c" : "#fff",
              background: isLong ? "var(--green)" : "var(--red)",
              letterSpacing: "0.06em",
              fontFamily: "var(--font-mono)"
            }}>
              {isLong ? "LONG" : "SHORT"}
            </span>
            <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{sig.timeframe}</span>
            <span style={{ fontSize: 9, color: "var(--muted)", textTransform: "uppercase" }}>
              {strategyLabel(sig.strategy)}
            </span>
            {sig.patternName && (
              <span style={{ fontSize: 9, color: "var(--green)" }}>{sig.patternName}</span>
            )}
            {sig.status === "tp_hit" ? (
              <span className="badge-tp">TP ✓ {statusLabel}</span>
            ) : sig.status === "sl_hit" ? (
              <span className="badge-sl">SL ✗ {statusLabel}</span>
            ) : (
              <span style={{
                fontSize: 10, fontWeight: isClosed ? 700 : 400,
                color: statusColor, marginLeft: 2,
                padding: isClosed ? "1px 5px" : undefined,
                borderRadius: isClosed ? 4 : undefined,
              }}>{statusLabel}</span>
            )}
            {sig.status === "tp_hit" ? (
              <span className="badge-tp">
                {decisionLabel}{sig.decisionScore !== undefined ? ` ${sig.decisionScore}/100` : ""}
              </span>
            ) : sig.status === "sl_hit" ? (
              <span className="badge-sl">
                {decisionLabel}{sig.decisionScore !== undefined ? ` ${sig.decisionScore}/100` : ""}
              </span>
            ) : (
              <span style={{
                fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 4,
                color: decisionColor, background: decisionBg,
                border: `1px solid ${decisionColor}`,
                fontFamily: "var(--font-mono)", letterSpacing: "0.04em"
              }}>
                {decisionLabel}{sig.decisionScore !== undefined ? ` ${sig.decisionScore}/100` : ""}
              </span>
            )}
            {!isClosed && slRiskLevel && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                background: slRiskLevel === "danger" ? "rgba(255,45,90,0.2)" : "rgba(255,165,0,0.15)",
                color: slRiskLevel === "danger" ? "var(--red)" : "#ffb347",
                border: `1px solid ${slRiskLevel === "danger" ? "var(--red)" : "#ffb347"}`,
                fontFamily: "var(--font-mono)", letterSpacing: "0.04em"
              }}>
                ⚠ SL -{maxLossPct.toFixed(0)}%
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
            {eventTimeText} · entry {fmtPrice(pnl?.entryPrice ?? sig.entryPrice)}
            {isClosed && sig.closePrice
              ? <> → <span style={{ color: statusColor }}>{fmtPrice(sig.closePrice)}</span></>
              : pnl ? <> → <span style={{ color: "var(--text-dim)" }}>{fmtPrice(pnl.currentPrice)}</span></> : null}
          </div>
        </div>
        {/* P&L */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {pnl ? (
            <>
              <div className={isClosed ? undefined : "num-tick"} key={Math.round(pnl.pnlUsdt * 10)} style={{ fontSize: 16, fontWeight: 800, color: pnlColor, fontFamily: "var(--font-mono)", letterSpacing: "-0.01em" }}>
                {fmtUsdt(isClosed ? pnl.pnlUsdt : animPnlUsdt)}
              </div>
              <div style={{ fontSize: 11, color: pnlColor, fontFamily: "var(--font-mono)", opacity: 0.85 }}>
                {fmtPct(isClosed ? pnl.pnlPct : animPnlPct)}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>—</div>
          )}
        </div>
        <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 2 }}>{isOpen ? "▲" : "▼"}</span>
      </div>

      {/* ── Chi tiết mở rộng ── */}
      {isOpen && (
        <div style={{ padding: "8px 10px 10px", borderTop: "1px solid var(--border)",
          display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "6px 10px", fontSize: 11 }}>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>ENTRY</span><br />
            <strong style={{ fontFamily: "var(--font-mono)" }}>{fmtPrice(pnl?.entryPrice ?? sig.entryPrice)}</strong></div>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>{isClosed ? "GIÁ ĐÓNG" : "GIÁ HIỆN TẠI"}</span><br />
            <strong style={{ fontFamily: "var(--font-mono)", color: pnlColor }}>
              {isClosed && sig.closePrice ? fmtPrice(sig.closePrice) : pnl ? fmtPrice(pnl.currentPrice) : "—"}
            </strong></div>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>SL</span><br />
            <strong style={{ fontFamily: "var(--font-mono)", color: sig.status === "sl_hit" ? "var(--red)" : "rgba(255,45,90,0.6)" }}>{fmtPrice(sig.slPrice)}</strong></div>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>TP</span><br />
            <strong style={{ fontFamily: "var(--font-mono)", color: sig.status === "tp_hit" ? "var(--green)" : "rgba(0,255,157,0.6)" }}>{fmtPrice(sig.tpPrice)}</strong></div>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>ĐÒN BẨY</span><br />
            <strong>{sig.leverage}× · {sig.marginUsdt}$</strong></div>
          <div><span style={{ color: "var(--muted)", fontSize: 10 }}>P&L{isClosed || pnl?.source === "position" ? " (thực)" : sig.status === "rejected" ? " (giả định)" : ""}</span><br />
            <strong style={{ color: pnlColor, fontFamily: "var(--font-mono)" }}>
              {pnl ? `${fmtUsdt(pnl.pnlUsdt)} (${fmtPct(pnl.pnlPct)})` : "—"}
            </strong></div>
          <div style={{ gridColumn: "1/-1" }}>
            <span style={{ color: "var(--muted)", fontSize: 10 }}>THỜI GIAN</span><br />
            <strong style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {isClosed && sig.closedAt
                ? `Đóng: ${new Date(sig.closedAt).toLocaleString("vi-VN")}`
                : new Date(sig.createdAt).toLocaleString("vi-VN")}
            </strong>
          </div>
          <div style={{ gridColumn: "1/-1" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: "var(--muted)", fontSize: 10 }}>CHART</span>
              {sig.chartUrl && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (sig.id) onLiveChart?.(sig.id); }}
                  disabled={chartLoading}
                  title="Nạp lại nến thật mới nhất từ Binance"
                  style={{
                    minHeight: 26,
                    padding: "0 9px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    borderRadius: 6,
                    border: "1px solid rgba(0,229,255,0.45)",
                    background: "rgba(0,229,255,0.10)",
                    color: "#7ddcff",
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: chartLoading ? "wait" : "pointer"
                  }}
                >
                  <RefreshCw size={13} className={chartLoading ? "spin" : undefined} />
                  {chartLoading ? "Đang nạp" : "Live"}
                </button>
              )}
            </div>
            {sig.chartUrl ? (
              <img
                src={sig.chartUrl}
                alt={`${sig.symbol} ${sig.timeframe} signal chart`}
                onClick={(e) => { e.stopPropagation(); onChartClick?.(sig); }}
                style={{
                  display: "block",
                  width: "100%",
                  maxHeight: 360,
                  objectFit: "contain",
                  marginTop: 6,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "#03070c",
                  cursor: "zoom-in"
                }}
              />
            ) : (
              <strong style={{ color: "var(--muted)" }}>Chưa có chart</strong>
            )}
          </div>
          <div style={{ gridColumn: "1/-1" }}>
            <SFPDecisionTable sig={sig} />
          </div>
        </div>
      )}
    </div>
  );
}

function SFPSettingsPanel() {
  const [cfg, setCfg] = useState<RuntimeSettings | null>(null);
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [favCoins, setFavCoins] = useState<string[]>(loadFavCoins);
  const [newFav, setNewFav] = useState("");
  const [editFav, setEditFav] = useState(false);
  const [timeframes, setTimeframes] = useState<string[]>(["5m"]);
  const [smcAutoTimeframes, setSmcAutoTimeframes] = useState(true);
  const [leverage, setLeverage] = useState(1);
  const [marginUsdt, setMarginUsdt] = useState(10);
  const [maxOpenPositions, setMaxOpenPositions] = useState(1);
  const [sfpMarginType, setSfpMarginType] = useState<"CROSSED" | "ISOLATED">("CROSSED");
  const [autoExecute, setAutoExecute] = useState(false);
  const [sfpEnabled, setSfpEnabled] = useState(true);
  const [allowMarketOrder, setAllowMarketOrder] = useState(false);
  const [sfpStrategies, setSfpStrategies] = useState<Array<"sfp" | "candlestick" | "wyckoff" | "smc">>(["sfp"]);
  const [sfpLen, setSfpLen] = useState(5);
  const [sfpTpPercent, setSfpTpPercent] = useState(0);
  const [sfpCandlestickTpPercent, setSfpCandlestickTpPercent] = useState(0.5);
  const [sfpWaitCandles, setSfpWaitCandles] = useState(3);
  const [sfpOneTradeAtATime, setSfpOneTradeAtATime] = useState(true);
  const [smcPreferredRR, setSmcPreferredRR] = useState(SMC_SAFE_DEFAULTS.preferredRR);
  const [smcRelaxedRRTP, setSmcRelaxedRRTP] = useState(SMC_SAFE_DEFAULTS.relaxedRRTP);
  const [smcTakeProfitRoiPercent, setSmcTakeProfitRoiPercent] = useState(SMC_SAFE_DEFAULTS.takeProfitRoiPercent);
  const [smcMinScore, setSmcMinScore] = useState(SMC_SAFE_DEFAULTS.minScore);
  const [smcMaxBarsAfterSweepForMSS, setSmcMaxBarsAfterSweepForMSS] = useState(SMC_SAFE_DEFAULTS.maxBarsAfterSweepForMSS);
  const [smcFvgMinSizePct, setSmcFvgMinSizePct] = useState(SMC_SAFE_DEFAULTS.fvgMinSizePct);
  const [smcAvoidMiddleOfRange, setSmcAvoidMiddleOfRange] = useState(SMC_SAFE_DEFAULTS.avoidMiddleOfRange);
  const [smcFvgMaxBarsAfterMss, setSmcFvgMaxBarsAfterMss] = useState(SMC_SAFE_DEFAULTS.fvgMaxBarsAfterMss);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [signals, setSignals] = useState<SFPSignalRecord[]>([]);
  const [wyckoffPreviewSignals, setWyckoffPreviewSignals] = useState<MarketSignal[]>([]);
  const [coinStatusMap, setCoinStatusMap] = useState<Record<string, MarketSignal>>({});
  const [liveChartSymbol, setLiveChartSymbol] = useState<string | null>(null);
  const [visibleStrategyRows, setVisibleStrategyRows] = useState(10);
  const [liveChartPoints, setLiveChartPoints] = useState<Record<string, LivePricePoint[]>>({});
  const [liveChartLoading, setLiveChartLoading] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [openPositions, setOpenPositions] = useState<Row[]>([]);
  const [sfpOpenOrders, setSfpOpenOrders] = useState<Row[]>([]);
  const [usdtBalance, setUsdtBalance] = useState(0);
  const [walletBalance, setWalletBalance] = useState(0);
  const [unrealizedPnl, setUnrealizedPnl] = useState(0);
  const [balanceError, setBalanceError] = useState("");
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [liqWarnings, setLiqWarnings] = useState<Array<{ symbol: string; distancePct: number; action: string; ts: number }>>([]);
  const [liveStatus, setLiveStatus] = useState<{ sfpEnabled: boolean; sfpAutoExecute: boolean; subscriptions: number; activeKeys: string[] } | null>(null);
  const [activityFeed, setActivityFeed] = useState<Array<{ ts: number; text: string; color: string }>>([]);
  const [decisionPanelOpen, setDecisionPanelOpen] = useState(false);
  const [pendingDetailsOpen, setPendingDetailsOpen] = useState<Record<number, boolean>>({});
  const [chartLoadingIds, setChartLoadingIds] = useState<Record<number, boolean>>({});
  const [fullscreenChartUrl, setFullscreenChartUrl] = useState<string | null>(null);
  const [fullscreenChartSignalId, setFullscreenChartSignalId] = useState<number | null>(null);
  const lastSavedSfpConfig = useRef("");
  const autoSaveTimer = useRef<number | null>(null);
  const [topMovers, setTopMovers] = useState<TopMoversData | null>(null);
  const [topMoversTab, setTopMoversTab] = useState<'gainers' | 'losers' | 'new' | 'lowCap'>('gainers');
  const [topMoversOpen, setTopMoversOpen] = useState(false);
  const [topMoversLoading, setTopMoversLoading] = useState(false);
  const [topMoversError, setTopMoversError] = useState("");
  const isSmcMainMode = sfpStrategies.includes("smc");
  const smcTimeframesLocked = isSmcMainMode && smcAutoTimeframes;
  const liveChartInterval = liveChartSymbol
    ? coinStatusMap[liveChartSymbol]?.interval ?? timeframes[0] ?? "1m"
    : "";

  const normalizeMaxOpenPositions = (value: number) =>
    Math.max(1, Math.min(100, Math.floor(Number.isFinite(value) ? value : 1)));
  const roundUsdt = (value: number) => Number(Math.max(0.01, value).toFixed(2));
  const availableMarginUsdt = usdtBalance > 0 ? roundUsdt(usdtBalance) : 0;
  const marginFeeBufferMultiplier = cfg?.dryRun ? 1 : 1.08;
  const safeAvailableTotalUsdt = availableMarginUsdt > 0
    ? roundUsdt(availableMarginUsdt / marginFeeBufferMultiplier)
    : 0;
  const activeMarginSlots = openPositions.filter(row => Math.abs(Number(row.positionAmt ?? 0)) > 0).length;
  const remainingMarginSlots = Math.max(1, maxOpenPositions - activeMarginSlots);
  const safeAvailableMarginUsdt = safeAvailableTotalUsdt > 0
    ? roundUsdt(safeAvailableTotalUsdt / remainingMarginSlots)
    : 0;
  const marginSliderMax = safeAvailableMarginUsdt > 0
    ? safeAvailableMarginUsdt
    : Math.max(1, roundUsdt(marginUsdt));
  const clampMarginUsdt = (value: number) => {
    const clean = Number.isFinite(value) ? Math.max(0.01, value) : 0.01;
    return roundUsdt(safeAvailableMarginUsdt > 0 ? Math.min(clean, safeAvailableMarginUsdt) : clean);
  };

  const togglePendingDetails = (id: number) => {
    setPendingDetailsOpen(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const pushActivity = (text: string, color = "#aaa") => {
    setActivityFeed(prev => [{ ts: Date.now(), text, color }, ...prev].slice(0, 8));
  };

  const refreshAccountBalance = async (): Promise<AccountBalance | null> => {
    if (isBinanceCooldownActive()) {
      const msg = `Binance API dang tam dung, con ${getBinanceCooldownSeconds()}s.`;
      setBalanceError(msg);
      return null;
    }
    try {
      const rows = await api<unknown[]>("/api/balance");
      const parsed = parseUsdtBalance(Array.isArray(rows) ? rows : []);
      if (!parsed) {
        setBalanceError("Không tìm thấy số dư USDT trong tài khoản Futures.");
        return null;
      }
      const usdt = rows.find(
        (row) =>
          row &&
          typeof row === "object" &&
          String((row as Record<string, unknown>).asset).toUpperCase() === "USDT"
      ) as Record<string, unknown> | undefined;
      const upnl = Number(usdt?.crossUnPnl ?? usdt?.unrealizedProfit ?? 0);
      setUsdtBalance(parsed.available);
      setWalletBalance(parsed.wallet);
      setUnrealizedPnl(Number.isFinite(upnl) ? upnl : 0);
      setBalanceUpdatedAt(parsed.updatedAt);
      setBalanceError("");
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBalanceError(msg);
      return null;
    }
  };

  const loadTopMovers = async () => {
    setTopMoversLoading(true);
    setTopMoversError("");
    try {
      const data = await api<TopMoversData>("/api/market/top-movers");
      setTopMovers(data);
    } catch (e) {
      setTopMoversError(e instanceof Error ? e.message : "Lỗi tải dữ liệu");
    } finally {
      setTopMoversLoading(false);
    }
  };

  const applyTopVolumePreset = async (count: 50 | 100) => {
    setTopMoversLoading(true);
    setTopMoversError("");
    try {
      const data = topMovers ?? await api<TopMoversData>("/api/market/top-movers");
      setTopMovers(data);
      const preset = (data.topVolume ?? [])
        .slice(0, count)
        .map(row => toFuturesSymbol(row.symbol))
        .filter(Boolean);
      if (preset.length === 0) throw new Error("Không lấy được danh sách top volume.");
      setFavCoins(preset);
      saveFavCoins(preset);
      setSymbols(preset);
      setStatus(`Đã chọn ${preset.length} coin top volume để quét.`);
      setError("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi tải top volume";
      setTopMoversError(msg);
      setError(msg);
    } finally {
      setTopMoversLoading(false);
    }
  };

  const applyLowCapPreset = async (count: 100) => {
    setTopMoversLoading(true);
    setTopMoversError("");
    try {
      const data = topMovers ?? await api<TopMoversData>("/api/market/top-movers");
      setTopMovers(data);
      const preset = (data.lowCap ?? [])
        .slice(0, count)
        .map(row => toFuturesSymbol(row.symbol))
        .filter(Boolean);
      if (preset.length === 0) throw new Error("Không lấy được danh sách futures nhỏ.");
      setFavCoins(preset);
      saveFavCoins(preset);
      setSymbols(preset);
      setTopMoversTab("lowCap");
      setStatus(`Đã chọn ${preset.length} coin futures nhỏ để quét.`);
      setError("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Lỗi tải coin futures nhỏ";
      setTopMoversError(msg);
      setError(msg);
    } finally {
      setTopMoversLoading(false);
    }
  };

  const addCoinFromMover = (symbol: string) => {
    if (!favCoins.includes(symbol)) {
      const next = [...favCoins, symbol];
      setFavCoins(next);
      saveFavCoins(next);
    }
    if (!symbols.includes(symbol)) {
      setSymbols(prev => [...prev, symbol]);
    }
  };

  const normalizeSelectedStrategies = (
    strategies: RuntimeSettings["sfpStrategies"],
    fallbackMode?: RuntimeSettings["strategyMode"]
  ): RuntimeSettings["sfpStrategies"] => {
    const selected = new Set(strategies);
    if (fallbackMode === "wyckoff") selected.add("wyckoff");
    if (fallbackMode === "smc") selected.add("smc");
    return selected.size > 0 ? Array.from(selected) : ["sfp"];
  };

  const modeForStrategies = (strategies: RuntimeSettings["sfpStrategies"]): RuntimeSettings["strategyMode"] =>
    strategies.includes("smc") ? "smc" : strategies.includes("wyckoff") ? "wyckoff" : "hybrid";

  const toggleStrategy = (strategy: RuntimeSettings["sfpStrategies"][number]) => {
    setSfpStrategies(prev => {
      const next = prev.includes(strategy)
        ? prev.filter(item => item !== strategy)
        : [...prev, strategy];
      return normalizeSelectedStrategies(next);
    });
  };

  const setMainStrategyMode = async (mode: RuntimeSettings["strategyMode"]) => {
    const forceSmcAuto = mode === "smc";
    setCfg(prev => prev ? { ...prev, strategyMode: mode, ...(forceSmcAuto ? { smcAutoTimeframes: true } : {}) } : prev);
    if (forceSmcAuto) setSmcAutoTimeframes(true);
    try {
      const saved = await api<RuntimeSettings>("/api/config", {
        method: "PATCH",
        body: JSON.stringify(forceSmcAuto ? { strategyMode: mode, smcAutoTimeframes: true } : { strategyMode: mode })
      });
      setCfg(saved);
      setStatus(`Đã chọn chiến lược bot chính: ${mode === "wyckoff" ? "Wyckoff" : mode === "smc" ? "SMC" : mode}.`);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void load();
    }
  };

  const applySmcPreset = (preset: typeof SMC_SAFE_DEFAULTS) => {
    setSmcPreferredRR(preset.preferredRR);
    setSmcRelaxedRRTP(preset.relaxedRRTP);
    setSmcTakeProfitRoiPercent(preset.takeProfitRoiPercent);
    setSmcMinScore(preset.minScore);
    setSmcMaxBarsAfterSweepForMSS(preset.maxBarsAfterSweepForMSS);
    setSmcFvgMinSizePct(preset.fvgMinSizePct);
    setSmcFvgMaxBarsAfterMss(preset.fvgMaxBarsAfterMss);
    setSmcAvoidMiddleOfRange(preset.avoidMiddleOfRange);
  };

  const buildSfpPatch = (scanSymbols = visibleScanSymbols(symbols, favCoins)): SFPSettingsPatch => ({
    sfpEnabled,
    allowMarketOrder,
    strategyMode: modeForStrategies(sfpStrategies),
    sfpStrategies,
    sfpLen,
    sfpAutoExecute: autoExecute,
    sfpWatchSymbols: scanSymbols,
    sfpTimeframes: timeframes,
    smcAutoTimeframes,
    smcPreferredRR,
    smcRelaxedRRTP,
    smcTakeProfitRoiPercent,
    smcMinScore,
    smcMaxBarsAfterSweepForMSS,
    smcFvgMinSizePct,
    smcAvoidMiddleOfRange,
    smcFvgMaxBarsAfterMss,
    sfpLeverage: leverage,
    sfpMarginUsdt: marginUsdt,
    sfpTpPercent,
    sfpCandlestickTpPercent,
    sfpMarginType,
    sfpWaitCandles,
    sfpOneTradeAtATime: maxOpenPositions <= 1,
    maxOpenPositions
  });

  const load = async () => {
    try {
      const [config, sigs] = await Promise.all([
        api<RuntimeSettings>("/api/config"),
        api<SFPSignalRecord[]>("/api/sfp/signals?limit=200")
      ]);
      setCfg(config);
      const loadedSymbols = visibleScanSymbols(config.sfpWatchSymbols ?? ["BTCUSDT"], favCoins);
      const loadedStrategies = normalizeSelectedStrategies(
        Array.isArray(config.sfpStrategies) ? config.sfpStrategies : ["sfp"],
        config.strategyMode
      );
      setSymbols(loadedSymbols);
      setTimeframes(config.sfpTimeframes ?? ["5m"]);
      setLeverage(config.sfpLeverage ?? 1);
      setMarginUsdt(config.sfpMarginUsdt ?? 10);
      setMaxOpenPositions(normalizeMaxOpenPositions(config.maxOpenPositions ?? 1));
      setSfpMarginType(config.sfpMarginType ?? "CROSSED");
      setAutoExecute(config.sfpAutoExecute ?? false);
      setSfpEnabled(config.sfpEnabled ?? true);
      setAllowMarketOrder(config.allowMarketOrder ?? false);
      setSfpStrategies(loadedStrategies);
      setSmcAutoTimeframes(config.smcAutoTimeframes ?? true);
      setSfpLen(config.sfpLen ?? 5);
      setSfpTpPercent(config.sfpTpPercent ?? 0);
      setSfpCandlestickTpPercent(config.sfpCandlestickTpPercent ?? 0.5);
      setSfpWaitCandles(config.sfpWaitCandles ?? 3);
      setSfpOneTradeAtATime(config.sfpOneTradeAtATime ?? true);
      setSmcPreferredRR(config.smcPreferredRR ?? SMC_SAFE_DEFAULTS.preferredRR);
      setSmcRelaxedRRTP(config.smcRelaxedRRTP ?? SMC_SAFE_DEFAULTS.relaxedRRTP);
      setSmcTakeProfitRoiPercent(config.smcTakeProfitRoiPercent ?? SMC_SAFE_DEFAULTS.takeProfitRoiPercent);
      setSmcMinScore(config.smcMinScore ?? SMC_SAFE_DEFAULTS.minScore);
      setSmcMaxBarsAfterSweepForMSS(config.smcMaxBarsAfterSweepForMSS ?? SMC_SAFE_DEFAULTS.maxBarsAfterSweepForMSS);
      setSmcFvgMinSizePct(config.smcFvgMinSizePct ?? SMC_SAFE_DEFAULTS.fvgMinSizePct);
      setSmcAvoidMiddleOfRange(config.smcAvoidMiddleOfRange ?? SMC_SAFE_DEFAULTS.avoidMiddleOfRange);
      setSmcFvgMaxBarsAfterMss(config.smcFvgMaxBarsAfterMss ?? SMC_SAFE_DEFAULTS.fvgMaxBarsAfterMss);
      lastSavedSfpConfig.current = JSON.stringify({
        sfpEnabled: config.sfpEnabled ?? true,
        allowMarketOrder: config.allowMarketOrder ?? false,
        strategyMode: modeForStrategies(loadedStrategies),
        sfpStrategies: loadedStrategies,
        sfpLen: config.sfpLen ?? 5,
        sfpAutoExecute: config.sfpAutoExecute ?? false,
        sfpWatchSymbols: loadedSymbols,
        sfpTimeframes: config.sfpTimeframes ?? ["5m"],
        smcAutoTimeframes: config.smcAutoTimeframes ?? true,
        smcPreferredRR: config.smcPreferredRR ?? SMC_SAFE_DEFAULTS.preferredRR,
        smcRelaxedRRTP: config.smcRelaxedRRTP ?? SMC_SAFE_DEFAULTS.relaxedRRTP,
        smcTakeProfitRoiPercent: config.smcTakeProfitRoiPercent ?? SMC_SAFE_DEFAULTS.takeProfitRoiPercent,
        smcMinScore: config.smcMinScore ?? SMC_SAFE_DEFAULTS.minScore,
        smcMaxBarsAfterSweepForMSS: config.smcMaxBarsAfterSweepForMSS ?? SMC_SAFE_DEFAULTS.maxBarsAfterSweepForMSS,
        smcFvgMinSizePct: config.smcFvgMinSizePct ?? SMC_SAFE_DEFAULTS.fvgMinSizePct,
        smcAvoidMiddleOfRange: config.smcAvoidMiddleOfRange ?? SMC_SAFE_DEFAULTS.avoidMiddleOfRange,
        smcFvgMaxBarsAfterMss: config.smcFvgMaxBarsAfterMss ?? SMC_SAFE_DEFAULTS.fvgMaxBarsAfterMss,
        sfpLeverage: config.sfpLeverage ?? 1,
        sfpMarginUsdt: config.sfpMarginUsdt ?? 10,
        sfpTpPercent: config.sfpTpPercent ?? 0,
        sfpCandlestickTpPercent: config.sfpCandlestickTpPercent ?? 0.5,
        sfpMarginType: config.sfpMarginType ?? "CROSSED",
        sfpWaitCandles: config.sfpWaitCandles ?? 3,
        sfpOneTradeAtATime: (config.maxOpenPositions ?? 1) <= 1,
        maxOpenPositions: normalizeMaxOpenPositions(config.maxOpenPositions ?? 1)
      } satisfies SFPSettingsPatch);
      setSignals(sigs);
      void refreshAccountBalance();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshSignals = async () => {
    try {
      const sigs = await api<SFPSignalRecord[]>("/api/sfp/signals?limit=200");
      setSignals(sigs);
      await refreshAccountBalance();
      // Fetch latest market signal per coin for status table
      try {
        const [mSigs, currentConfig] = await Promise.all([
          api<MarketSignal[]>("/api/market/signals?limit=100"),
          api<RuntimeSettings>("/api/config").catch(() => cfg)
        ]);
        const map: Record<string, MarketSignal> = {};
        const selectedTimeframes = new Set(
          currentConfig?.strategyMode === "smc" && currentConfig.smcAutoTimeframes
            ? ["15m"]
            : currentConfig?.sfpTimeframes ?? timeframes
        );
        const selectedSymbols = new Set(visibleScanSymbols(currentConfig?.sfpWatchSymbols ?? symbols, favCoins));
        for (const ms of mSigs) {
          if (currentConfig?.strategyMode === "smc") {
            if (!selectedTimeframes.has(ms.interval)) continue;
            if (!selectedSymbols.has(ms.symbol)) continue;
          }
          if (!map[ms.symbol]) map[ms.symbol] = ms;
        }
        setCoinStatusMap(map);
      } catch { /* silent */ }

      // Fetch current prices for all unique symbols
      const syms = [...new Set(sigs.map(s => s.symbol))].slice(0, 12);
      const priceEntries = await Promise.all(syms.map(async sym => {
        if (isBinanceCooldownActive()) return [sym, 0] as [string, number];
        try {
          const r = await api<{ price: string }>(`/api/market/price/${sym}`);
          return [sym, parseFloat(r.price)] as [string, number];
        } catch { return [sym, 0] as [string, number]; }
      }));
      setPrices(Object.fromEntries(priceEntries.filter(([, v]) => v > 0)));
    } catch { /* silent */ }
  };

  const refreshPositions = async () => {
    if (isBinanceCooldownActive()) return;
    try {
      const [pos, ord] = await Promise.all([
        api<Row[]>("/api/positions").catch(() => [] as Row[]),
        api<Row[]>("/api/orders/open").catch(() => [] as Row[])
      ]);
      setOpenPositions((Array.isArray(pos) ? pos : []).filter(r => Math.abs(Number(r.positionAmt ?? 0)) > 0));
      setSfpOpenOrders(Array.isArray(ord) ? ord : []);
    } catch { /* silent */ }
  };

  useEffect(() => {
    void load();
    void refreshSignals();
    void refreshPositions();

    const refreshStatus = async () => {
      try {
        const s = await api<{ sfpEnabled: boolean; sfpAutoExecute: boolean; subscriptions: number; activeKeys: string[] }>("/api/sfp/status");
        setLiveStatus(s);
      } catch { /* silent */ }
    };
    void refreshStatus();

    const tSig = window.setInterval(() => void refreshSignals(), SFP_REFRESH_MS);
    const tPos = window.setInterval(() => void refreshPositions(), POSITION_REFRESH_MS);
    const tSts = window.setInterval(() => void refreshStatus(), STATUS_REFRESH_MS);

    // Lắng nghe SSE — khi auto-scanner tạo signal mới, refresh ngay lập tức
    const sse = new EventSource("/api/events");
    sse.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data ?? "{}") as { type?: string; data?: Record<string, unknown> };
        const { type, data } = parsed;
        if (data?.heartbeat) return;
        if (type === "liquidation.warning") {
          const d = data as { symbol: string; distancePct: number; action: string };
          playWarningBeep();
          setLiqWarnings(prev => [{ ...d, ts: Date.now() }, ...prev].slice(0, 5));
        } else if (type === "sfp.signal" && data) {
          const dir = String(data.direction ?? "") === "BULLISH" ? "LONG" : "SHORT";
          const decision = String(data.decision ?? "");
          const score = Number(data.decisionScore ?? 0);
          const verdict = decision === "TRADE"
            ? `đủ điều kiện ${score}/100`
            : decision === "SKIP"
              ? `không vào ${score}/100`
              : "phát hiện setup";
          pushActivity(
            `${String(data.symbol ?? "")} ${String(data.timeframe ?? "")} ${dir} — ${verdict}`,
            decision === "TRADE" ? "#4ade80" : "#f5a623"
          );
          void refreshSignals();
          void refreshStatus();
        } else if (type === "order.created" && data) {
          const sym = String(data.symbol ?? "");
          const price = Number(data.price ?? 0);
          pushActivity(`${sym} — Gửi LIMIT ${price > 0 ? price.toFixed(price < 1 ? 5 : 2) : ""}`, "#60a5fa");
          void refreshPositions();
        } else if (type === "sfp.closed" && data) {
          const sym = String(data.symbol ?? "");
          const status = String(data.status ?? "");
          const pnl = Number(data.realizedPnlUsdt ?? 0);
          const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "$";
          if (status === "tp_hit") pushActivity(`${sym} TP ✓ ${pnlStr}`, "#4ade80");
          else if (status === "sl_hit") pushActivity(`${sym} SL ✗ ${pnlStr}`, "#f87171");
          void refreshSignals();
        }
      } catch { /* ignore malformed */ }
    };
    return () => {
      window.clearInterval(tSig);
      window.clearInterval(tPos);
      window.clearInterval(tSts);
      sse.close();
    };
  }, []);

  useEffect(() => {
    if (!liveChartSymbol) return;
    if (symbols.length > 0 && !symbols.includes(liveChartSymbol)) {
      setLiveChartSymbol(null);
    }
  }, [liveChartSymbol, symbols]);

  useEffect(() => {
    if (safeAvailableMarginUsdt > 0 && marginUsdt > safeAvailableMarginUsdt) {
      setMarginUsdt(safeAvailableMarginUsdt);
    }
  }, [safeAvailableMarginUsdt, marginUsdt]);

  useEffect(() => {
    if (!liveChartSymbol) return;
    let active = true;
    let requestInFlight = false;

    const appendPoint = (price: number, t = Date.now()) => {
      if (!Number.isFinite(price) || price <= 0) return;
      setLiveChartPoints(prev => {
        const current = prev[liveChartSymbol] ?? [];
        const last = current.at(-1);
        const next = last
          ? [
              ...current.slice(0, -1),
              {
                ...last,
                t,
                high: Math.max(last.high, price),
                low: Math.min(last.low, price),
                close: price
              }
            ]
          : [{ t, open: price, high: price, low: price, close: price }];
        return { ...prev, [liveChartSymbol]: next.slice(-90) };
      });
    };

    const seedKlines = async () => {
      setLiveChartLoading(true);
      try {
        const rows = await api<Array<{ closeTime: number; open: number; high: number; low: number; close: number }>>(
          `/api/market/klines?symbol=${encodeURIComponent(liveChartSymbol)}&interval=${encodeURIComponent(liveChartInterval || "1m")}&limit=70`
        );
        if (!active) return;
        const points = rows
          .map(row => ({
            t: Number(row.closeTime),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close)
          }))
          .filter(point =>
            Number.isFinite(point.t) &&
            Number.isFinite(point.open) &&
            Number.isFinite(point.high) &&
            Number.isFinite(point.low) &&
            Number.isFinite(point.close) &&
            point.open > 0 &&
            point.high > 0 &&
            point.low > 0 &&
            point.close > 0
          )
          .slice(-70);
        setLiveChartPoints(prev => ({ ...prev, [liveChartSymbol]: points }));
      } catch {
        // Price polling below will still create a live line.
      } finally {
        if (active) setLiveChartLoading(false);
      }
    };

    const fetchPrice = async () => {
      if (requestInFlight || isBinanceCooldownActive()) return;
      requestInFlight = true;
      try {
        const ticker = await api<{ price: string }>(`/api/market/price/${liveChartSymbol}`);
        if (!active) return;
        appendPoint(Number(ticker.price));
      } catch {
        // Keep the last chart visible.
      } finally {
        requestInFlight = false;
      }
    };

    void seedKlines().then(() => void fetchPrice());
    const timer = window.setInterval(() => void fetchPrice(), PRICE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [liveChartSymbol, liveChartInterval]);

  useEffect(() => {
    if (!cfg) return;
    const scanSymbols = visibleScanSymbols(symbols, favCoins);
    if (scanSymbols.length === 0) return;
    const patch = buildSfpPatch(scanSymbols);
    const key = JSON.stringify(patch);
    if (key === lastSavedSfpConfig.current) return;

    if (!sameStringList(symbols, scanSymbols)) setSymbols(scanSymbols);
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      void (async () => {
        try {
          await api("/api/config", {
            method: "PATCH",
            body: JSON.stringify(patch)
          });
          lastSavedSfpConfig.current = key;
          setStatus("Đã tự lưu cài đặt scanner.");
          setError("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 350);

    return () => {
      if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    };
  }, [
    cfg,
    symbols,
    favCoins,
    timeframes,
    smcAutoTimeframes,
    leverage,
    marginUsdt,
    maxOpenPositions,
    sfpMarginType,
    autoExecute,
    sfpEnabled,
    allowMarketOrder,
    sfpStrategies,
    sfpLen,
    sfpTpPercent,
    sfpCandlestickTpPercent,
    sfpWaitCandles,
    sfpOneTradeAtATime,
    smcPreferredRR,
    smcRelaxedRRTP,
    smcTakeProfitRoiPercent,
    smcMinScore,
    smcMaxBarsAfterSweepForMSS,
    smcFvgMinSizePct,
    smcAvoidMiddleOfRange,
    smcFvgMaxBarsAfterMss
  ]);

  const save = async () => {
    try {
      const scanSymbols = visibleScanSymbols(symbols, favCoins);
      if (scanSymbols.length === 0) throw new Error("Chọn ít nhất một coin yêu thích để quét.");
      setSymbols(scanSymbols);
      const patch = buildSfpPatch(scanSymbols);
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      lastSavedSfpConfig.current = JSON.stringify(patch);
      setStatus("Đã lưu cài đặt scanner.");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const scanNow = async () => {
    setScanning(true);
    try {
      const scanSymbols = visibleScanSymbols(symbols, favCoins);
      if (scanSymbols.length === 0) throw new Error("Chọn ít nhất một coin yêu thích để quét.");
      setSymbols(scanSymbols);
      const patch = buildSfpPatch(scanSymbols);
      // Lưu settings hiện tại lên server trước để đảm bảo danh sách coin/timeframe đúng
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      lastSavedSfpConfig.current = JSON.stringify(patch);
      let sfpText = "Scanner SFP/Mẫu nến đang tắt";
      if (sfpStrategies.length > 0) {
        const res = await api<{ found: number; scanned: number; skipped: number }>("/api/sfp/scan", { method: "POST" });
        const skipTxt = res.skipped > 0 ? `, bỏ qua ${res.skipped} lỗi` : "";
        sfpText = `SFP/Mẫu nến: quét ${res.scanned} tổ hợp${skipTxt}, tìm thấy ${res.found}`;
      }

      let structureText = "";
      if (cfg?.strategyMode === "wyckoff" || cfg?.strategyMode === "smc") {
        const activeFrameCount = cfg.strategyMode === "smc" && smcAutoTimeframes ? 1 : Math.max(1, timeframes.length);
        const previewWork = scanSymbols.length * activeFrameCount;
        if (previewWork > 120) {
          setWyckoffPreviewSignals([]);
          structureText = ` | ${cfg.strategyMode === "smc" ? "SMC" : "Wyckoff"}: đã lưu ${scanSymbols.length} coin, scanner nền sẽ quét tuần tự (${previewWork} lượt)`;
        } else {
          const controller = new AbortController();
          const timer = window.setTimeout(() => controller.abort(), 45_000);
          const preview = await api<MarketSignal[]>("/api/strategy/preview", {
            method: "POST",
            body: JSON.stringify({ symbols: scanSymbols, timeframes }),
            signal: controller.signal
          }).finally(() => window.clearTimeout(timer));
          setWyckoffPreviewSignals(preview);
          const actionable = preview.filter((sig) => sig.signal === "LONG" || sig.signal === "SHORT").length;
          structureText = ` | ${cfg.strategyMode === "smc" ? "SMC" : "Wyckoff"}: quét ${preview.length}, tín hiệu vào lệnh ${actionable}`;
        }
      } else {
        setWyckoffPreviewSignals([]);
      }

      setStatus(`${sfpText}${structureText}.`);
      setError("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const execute = async (id: number) => {
    try {
      await refreshAccountBalance();
      const res = await api<{ ok: boolean; signal: { status: string; message: string } }>(
        `/api/sfp/signals/${id}/execute`, { method: "POST" }
      );
      if (res.ok) {
        setStatus("Đã vào lệnh thành công.");
        setError("");
      } else {
        playSosRejectAlarm();
        setError(`Lệnh bị từ chối: ${res.signal?.message ?? "lỗi không xác định"}`);
      }
      await Promise.all([refreshSignals(), refreshPositions(), refreshAccountBalance()]);
    } catch (e) {
      playSosRejectAlarm();
      setError(e instanceof Error ? e.message : String(e));
      void refreshAccountBalance();
    }
  };

  const reject = async (id: number) => {
    try {
      await api(`/api/sfp/signals/${id}/reject`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rejectAll = async () => {
    try {
      const res = await api<{ count: number; skippedOpenSymbols?: string[] }>("/api/sfp/signals/reject-all", { method: "POST" });
      const skipped = new Set(res.skippedOpenSymbols ?? []);
      setSignals(prev => prev.map(sig =>
        (sig.status === "pending" || sig.status === "limit_placed") && !skipped.has(sig.symbol)
          ? { ...sig, status: "rejected", message: "Bỏ qua hàng loạt" }
          : sig
      ));
      setStatus(`Đã bỏ qua ${res.count} tín hiệu đang chờ.`);
      setError("");
      await refreshSignals();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const chartUrlWithCacheBust = (url?: string) => {
    if (!url) return url;
    return `${url}${url.includes("?") ? "&" : "?"}live=${Date.now()}`;
  };

  const openSignalChart = (sig: SFPSignalRecord) => {
    if (!sig.chartUrl) return;
    setFullscreenChartSignalId(sig.id ?? null);
    setFullscreenChartUrl(sig.chartUrl);
  };

  const ensureSignalChart = async (id: number): Promise<SFPSignalRecord | null> => {
    setChartLoadingIds(prev => ({ ...prev, [id]: true }));
    try {
      const updated = await api<SFPSignalRecord>(`/api/sfp/signals/${id}/chart`, { method: "POST" });
      const next = { ...updated, chartUrl: chartUrlWithCacheBust(updated.chartUrl) };
      setSignals(prev => prev.map(sig => sig.id === id ? { ...sig, ...next } : sig));
      setError("");
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setChartLoadingIds(prev => ({ ...prev, [id]: false }));
    }
  };

  const refreshFullscreenChartLive = async () => {
    if (!fullscreenChartSignalId) return;
    const updated = await ensureSignalChart(fullscreenChartSignalId);
    if (updated?.chartUrl) setFullscreenChartUrl(updated.chartUrl);
  };

  const toggleCoin = (coin: string) => {
    setSymbols(prev => prev.includes(coin) ? prev.filter(s => s !== coin) : [...prev, coin]);
  };

  const addFavCoin = () => {
    const coin = toFuturesSymbol(newFav);
    if (!coin || favCoins.includes(coin)) { setNewFav(""); return; }
    const next = [...favCoins, coin];
    setFavCoins(next);
    saveFavCoins(next);
    setNewFav("");
  };

  const removeFavCoin = (coin: string) => {
    const next = favCoins.filter(c => c !== coin);
    setFavCoins(next);
    saveFavCoins(next);
    setSymbols(prev => prev.filter(s => s !== coin));
  };

  const clearFavCoins = () => {
    setFavCoins([]);
    saveFavCoins([]);
    setSymbols([]);
  };

  const favPreview = toFuturesSymbol(newFav);

  const activeSymbols = new Set(visibleScanSymbols(symbols, favCoins));
  const activeTimeframes = new Set(smcTimeframesLocked ? ["15m"] : timeframes);
  const pending = signals.filter(
    s => (s.status === "pending" || s.status === "limit_placed") && activeSymbols.has(s.symbol) && activeTimeframes.has(s.timeframe)
  );
  // Lịch sử: gồm cả signal bị bỏ qua để xem lý do không vào lệnh.
  const recent = signals.filter(s =>
    s.status === "executed" ||
    s.status === "tp_hit" ||
    s.status === "sl_hit" ||
    s.status === "simulated" ||
    s.status === "rejected" ||
    s.status === "ignored"
  );
  const recentLongs  = recent.filter(s => s.direction === "BULLISH");
  const recentShorts = recent.filter(s => s.direction === "BEARISH");
  // Real trades column: chỉ lệnh thật, không bao gồm simulated
  const realTrades = signals.filter(s => s.status === "executed" || s.status === "tp_hit" || s.status === "sl_hit");
  const latestDecisionSignal = signals.find(
    s => activeSymbols.has(s.symbol) && activeTimeframes.has(s.timeframe) && (s.decisionDetails?.length ?? 0) > 0
  );

  const fmtPrice = (v: number) => v > 0 ? v.toFixed(v < 1 ? 6 : 2) : "-";
  const fmtUsdt  = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + " $";
  const fmtPct   = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const openPositionBySymbol = Object.fromEntries(
    openPositions.map(row => [String(row.symbol ?? "").toUpperCase(), row])
  );

  const calcPnl = (sig: SFPSignalRecord): PnlResult | null => {
    // Closed signals: use stored realized PNL (frozen)
    if ((sig.status === "tp_hit" || sig.status === "sl_hit") && sig.realizedPnlUsdt !== undefined && sig.realizedPnlPct !== undefined && sig.closePrice) {
      return { pnlPct: sig.realizedPnlPct, pnlUsdt: sig.realizedPnlUsdt, currentPrice: sig.closePrice, source: "signal" };
    }
    if (sig.status === "executed") {
      const pos = openPositionBySymbol[sig.symbol.toUpperCase()];
      const amount = Number(pos?.positionAmt ?? 0);
      if (pos && Math.abs(amount) > 0) {
        const pnlUsdt = Number(pos.unRealizedProfit ?? pos.unrealizedProfit ?? 0);
        const mark = Number(pos.markPrice ?? 0);
        const entry = Number(pos.entryPrice ?? sig.entryPrice ?? 0);
        const margin = Number(pos.isolatedMargin ?? pos.initialMargin ?? pos.positionInitialMargin ?? sig.marginUsdt ?? 0);
        const pnlPct = margin > 0 ? pnlUsdt / margin * 100 : 0;
        return {
          pnlPct,
          pnlUsdt,
          currentPrice: mark > 0 ? mark : prices[sig.symbol] ?? sig.entryPrice,
          entryPrice: entry > 0 ? entry : undefined,
          source: "position"
        };
      }
    }
    // Live: calculate from current price
    const cur = prices[sig.symbol];
    if (!cur || !sig.entryPrice) return null;
    const dir = sig.direction === "BULLISH" ? 1 : -1;
    const rawPct = dir * (cur - sig.entryPrice) / sig.entryPrice * 100;
    const pnlPct  = rawPct * sig.leverage;
    const pnlUsdt = rawPct / 100 * sig.leverage * sig.marginUsdt;
    return { pnlPct, pnlUsdt, currentPrice: cur, entryPrice: sig.entryPrice, source: "signal" };
  };

  return (
    <section className="panel">
      {/* Fullscreen chart modal — rendered via Portal to bypass parent CSS transforms */}
      {fullscreenChartUrl && createPortal(
        <div
          onClick={() => { setFullscreenChartUrl(null); setFullscreenChartSignalId(null); }}
          style={{
            position: "fixed",
            top: 0, left: 0, right: 0, bottom: 0,
            width: "100vw", height: "100vh",
            background: "rgba(0,0,0,0.96)",
            zIndex: 99999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
            overflow: "hidden"
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setFullscreenChartUrl(null); setFullscreenChartSignalId(null); }}
            style={{
              position: "fixed", top: 20, right: 20,
              background: "#ff4f68", border: "none",
              borderRadius: "50%", width: 52, height: 52,
              color: "white", fontSize: 26, fontWeight: 700,
              cursor: "pointer", zIndex: 100000, lineHeight: "52px",
              boxShadow: "0 2px 16px rgba(255,79,104,0.6)"
            }}
          >✕</button>
          {fullscreenChartSignalId && (
            <button
              onClick={(e) => { e.stopPropagation(); void refreshFullscreenChartLive(); }}
              disabled={Boolean(chartLoadingIds[fullscreenChartSignalId])}
              title="Nạp lại chart bằng nến Binance mới nhất"
              style={{
                position: "fixed", top: 20, right: 84,
                minHeight: 52,
                padding: "0 16px",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "rgba(0,229,255,0.13)",
                border: "1px solid rgba(0,229,255,0.48)",
                borderRadius: 10,
                color: "#8be9ff",
                fontSize: 14,
                fontWeight: 900,
                cursor: chartLoadingIds[fullscreenChartSignalId] ? "wait" : "pointer",
                zIndex: 100000,
                boxShadow: "0 2px 16px rgba(0,229,255,0.22)"
              }}
            >
              <RefreshCw size={17} />
              {chartLoadingIds[fullscreenChartSignalId] ? "Đang nạp" : "Live"}
            </button>
          )}
          <img
            src={fullscreenChartUrl}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "98vw",
              maxHeight: "96vh",
              objectFit: "contain",
              borderRadius: 8,
              display: "block"
            }}
          />
        </div>,
        document.body
      )}
      <div className="panelHeader">
        <div>
          <h2>Swing Failure Pattern — Cài đặt &amp; Tín hiệu</h2>
          <p>Bot tự quét SFP, chấm điểm từng rule, giải thích vì sao vào hoặc bỏ qua; thủ công thì bạn duyệt, tự động thì bot chỉ vào khi setup đạt chuẩn.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => void scanNow()} disabled={scanning}>
            <Activity size={14} /> {scanning ? "Đang quét..." : "Quét ngay"}
          </button>
          {pending.length > 0 && (
            <button className="dangerButton" onClick={() => void rejectAll()}>
              Bỏ qua tất cả ({pending.length})
            </button>
          )}
          <button onClick={() => void load()}><RefreshCw size={14} /> Làm mới</button>
        </div>
      </div>

      {/* ── LIVE ACTIVITY LOG ────────────────────────────── */}
      {(() => {
        const isLive = !!(liveStatus?.sfpEnabled && liveStatus.subscriptions > 0);
        const subCount = liveStatus?.subscriptions ?? 0;
        const isAuto = liveStatus?.sfpAutoExecute ?? false;
        const fmtTs = (ts: number) => new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return (
          <div style={{
            marginBottom: 12, borderRadius: 8, overflow: "hidden",
            border: `1px solid ${isLive ? "rgba(74,222,128,0.18)" : "#1e1e2e"}`,
            background: "rgba(0,0,0,0.25)",
            transition: "border-color 0.4s"
          }}>
            {/* ── header ── */}
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "7px 12px", borderBottom: "1px solid #181826",
              background: "rgba(255,255,255,0.02)"
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                background: isLive ? "#4ade80" : "#383850",
                boxShadow: isLive ? "0 0 7px #4ade80" : "none",
                animation: isLive ? "livePulse 1.8s ease-in-out infinite" : "none"
              }} />
              <span style={{
                fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)",
                letterSpacing: "0.1em", color: isLive ? "#4ade80" : "#444"
              }}>
                {isLive ? "LIVE" : liveStatus ? "OFF" : "..."}
              </span>
              <span style={{ fontSize: 11, color: "#555", fontFamily: "var(--font-mono)" }}>
                {isLive ? `${subCount} tổ hợp đang theo dõi` : liveStatus ? "Scanner đang tắt" : "Đang kết nối..."}
              </span>
              {isAuto && (
                <span style={{
                  fontSize: 10, padding: "1px 7px", borderRadius: 3, flexShrink: 0,
                  background: "rgba(245,166,35,0.12)", border: "1px solid rgba(245,166,35,0.22)",
                  color: "#f5a623", fontWeight: 700, letterSpacing: "0.07em"
                }}>AUTO</span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: "#333", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}>
                SFP Scanner Log
              </span>
            </div>

            {/* ── log lines ── */}
            <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4, minHeight: 58 }}>
              {activityFeed.length === 0 ? (
                <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "#383850", lineHeight: 1.6 }}>
                  {isLive
                    ? `> Đang giám sát ${subCount} tổ hợp — chờ nến đóng...`
                    : "> Chưa có hoạt động nào được ghi nhận."}
                </div>
              ) : (
                activityFeed.slice(0, 6).map((item, i) => (
                  <div key={item.ts} style={{
                    display: "flex", gap: 10, fontSize: 11,
                    fontFamily: "var(--font-mono)", lineHeight: 1.5,
                    opacity: Math.max(0.2, 1 - i * 0.14)
                  }}>
                    <span style={{ color: "#444", flexShrink: 0, userSelect: "none" }}>{fmtTs(item.ts)}</span>
                    <span style={{ color: "#555", flexShrink: 0, userSelect: "none" }}>›</span>
                    <span style={{ color: item.color }}>{item.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {latestDecisionSignal && (
        <div style={{
          marginBottom: 14,
          padding: "12px 14px",
          borderRadius: 8,
          border: latestDecisionSignal.decision === "TRADE"
            ? "1px solid rgba(8,153,129,0.32)"
            : "1px solid rgba(245,166,35,0.28)",
          background: latestDecisionSignal.decision === "TRADE"
            ? "rgba(8,153,129,0.08)"
            : "rgba(245,166,35,0.07)"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => setDecisionPanelOpen(open => !open)}
              title={decisionPanelOpen ? "Ẩn chi tiết" : "Hiện chi tiết"}
              style={{
                width: 26,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--text-dim)",
                padding: 0,
                cursor: "pointer"
              }}
            >
              {decisionPanelOpen ? "▲" : "▼"}
            </button>
            <strong style={{ fontSize: 13 }}>Setup mới nhất</strong>
            <span className={latestDecisionSignal.direction === "BULLISH" ? "pill positive" : "pill negative"}>
              {latestDecisionSignal.symbol} {latestDecisionSignal.timeframe} {latestDecisionSignal.direction === "BULLISH" ? "LONG" : "SHORT"}
            </span>
            <span className={latestDecisionSignal.decision === "TRADE" ? "pill positive" : "pill negative"}>
              {latestDecisionSignal.decision === "TRADE" ? `Có thể duyệt ${latestDecisionSignal.decisionScore ?? 0}/100` : `Bot bỏ qua ${latestDecisionSignal.decisionScore ?? 0}/100`}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1, minWidth: 220 }}>
              {latestDecisionSignal.decisionSummary || latestDecisionSignal.message}
            </span>
          </div>
          {decisionPanelOpen && <SFPDecisionTable sig={latestDecisionSignal} />}
        </div>
      )}

      {/* ── CẢNH BÁO THANH LÝ ───────────────────────────── */}
      {liqWarnings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {liqWarnings.map((w, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
              borderRadius: 8, border: `1px solid ${w.action === "auto_closed" ? "var(--red)" : "#ffb347"}`,
              background: w.action === "auto_closed" ? "rgba(255,45,90,0.12)" : "rgba(255,179,71,0.08)",
              animation: "fadeInUp 0.2s ease"
            }}>
              <span style={{ fontSize: 18 }}>{w.action === "auto_closed" ? "🚨" : "⚠️"}</span>
              <div style={{ flex: 1 }}>
                <strong style={{ color: w.action === "auto_closed" ? "var(--red)" : "#ffb347", fontSize: 13 }}>
                  {w.action === "auto_closed" ? `ĐÃ ĐÓNG KHẨN CẤP` : `CẢNH BÁO THANH LÝ`} — {w.symbol}
                </strong>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                  {w.action === "auto_closed"
                    ? `Vị thế cách thanh lý ${w.distancePct.toFixed(2)}% — bot đã tự đóng để bảo vệ tài khoản`
                    : `Còn ${w.distancePct.toFixed(2)}% đến thanh lý — hãy kiểm tra vị thế ngay`}
                </div>
              </div>
              <button
                onClick={() => setLiqWarnings(prev => prev.filter((_, j) => j !== i))}
                style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 16, padding: "0 4px" }}
              >×</button>
            </div>
          ))}
        </div>
      )}

      {/* ── CẤU HÌNH ─────────────────────────────────────── */}
      <div className="sfpConfigGrid">

        {/* Coin yêu thích */}
        <div className="sfpConfigBox" style={{ gridColumn: "1 / -1" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="sectionTitle" style={{ marginBottom: 0 }}>
              Coin yêu thích
              <small style={{ fontWeight: 400, color: "#888", marginLeft: 6 }}>
                {symbols.length > 0 ? `${symbols.length} đang quét` : "bấm để chọn/bỏ"}
              </small>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => {
                  const opening = !topMoversOpen;
                  setTopMoversOpen(opening);
                  if (opening && !topMovers) void loadTopMovers();
                }}
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 5,
                  border: topMoversOpen ? "1px solid #00d4ff" : "1px solid #444",
                  background: topMoversOpen ? "rgba(0,212,255,0.1)" : "transparent",
                  color: topMoversOpen ? "#00d4ff" : "#888",
                  cursor: "pointer"
                }}
              >
                {topMoversLoading ? "..." : "📊 Thị trường"}
              </button>
              <button
                onClick={() => void applyTopVolumePreset(50)}
                disabled={topMoversLoading}
                title="Chọn 50 coin futures USDT có volume 24h lớn nhất"
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 5,
                  border: "1px solid rgba(0,255,157,0.35)",
                  background: "rgba(0,255,157,0.08)",
                  color: "var(--color-positive)",
                  cursor: topMoversLoading ? "wait" : "pointer",
                  opacity: topMoversLoading ? 0.65 : 1
                }}
              >
                Top 50
              </button>
              <button
                onClick={() => void applyTopVolumePreset(100)}
                disabled={topMoversLoading}
                title="Chọn 100 coin futures USDT có volume 24h lớn nhất"
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 5,
                  border: "1px solid rgba(0,212,255,0.35)",
                  background: "rgba(0,212,255,0.08)",
                  color: "#00d4ff",
                  cursor: topMoversLoading ? "wait" : "pointer",
                  opacity: topMoversLoading ? 0.65 : 1
                }}
              >
                Top 100
              </button>
              <button
                onClick={() => void applyLowCapPreset(100)}
                disabled={topMoversLoading}
                title="Chọn 100 coin futures USDT nhỏ hơn, sort theo volume 24h thấp trước"
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 5,
                  border: "1px solid rgba(255,184,77,0.42)",
                  background: "rgba(255,184,77,0.10)",
                  color: "#ffb84d",
                  cursor: topMoversLoading ? "wait" : "pointer",
                  opacity: topMoversLoading ? 0.65 : 1
                }}
              >
                Low-cap 100
              </button>
              <button
                onClick={() => setEditFav(e => !e)}
                style={{
                  fontSize: 12, padding: "3px 10px", borderRadius: 5,
                  border: editFav ? "1px solid var(--color-negative)" : "1px solid #444",
                  background: editFav ? "rgba(242,54,69,0.1)" : "transparent",
                  color: editFav ? "var(--color-negative)" : "#888",
                  cursor: "pointer"
                }}
              >
                {editFav ? "✓ Xong" : "✏ Chỉnh sửa"}
              </button>
            </div>
          </div>

          {/* Top Movers Picker */}
          {topMoversOpen && (
            <div style={{
              marginBottom: 12,
              border: "1px solid rgba(0,212,255,0.2)",
              borderRadius: 8,
              background: "rgba(0,212,255,0.04)",
              overflow: "hidden"
            }}>
              {/* Tabs */}
              <div style={{ display: "flex", borderBottom: "1px solid rgba(0,212,255,0.15)" }}>
                {([
                  { key: 'gainers', label: '🚀 Top tăng' },
                  { key: 'losers',  label: '📉 Top giảm' },
                  { key: 'new',     label: '🆕 Mới niêm yết' },
                  { key: 'lowCap',  label: 'Low-cap' },
                ] as const).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => {
                      setTopMoversTab(tab.key);
                      if (!topMovers) void loadTopMovers();
                    }}
                    style={{
                      flex: 1, padding: "7px 0", fontSize: 12, border: "none",
                      background: topMoversTab === tab.key ? "rgba(0,212,255,0.12)" : "transparent",
                      color: topMoversTab === tab.key ? "#00d4ff" : "#666",
                      fontWeight: topMoversTab === tab.key ? 700 : 400,
                      cursor: "pointer", borderBottom: topMoversTab === tab.key ? "2px solid #00d4ff" : "2px solid transparent"
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
                <button
                  onClick={() => void loadTopMovers()}
                  title="Làm mới"
                  style={{ padding: "0 10px", background: "transparent", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}
                >
                  ↻
                </button>
              </div>

              {/* Coins */}
              <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                {topMoversLoading && (
                  <div style={{ textAlign: "center", color: "#555", fontSize: 12, padding: "8px 0" }}>Đang tải...</div>
                )}
                {!topMoversLoading && topMoversError && (
                  <div style={{ textAlign: "center", padding: "8px 0" }}>
                    <div style={{ color: "#f87171", fontSize: 12, marginBottom: 6 }}>{topMoversError}</div>
                    <button
                      onClick={() => void loadTopMovers()}
                      style={{ fontSize: 12, padding: "4px 14px", borderRadius: 5, border: "1px solid #444", background: "transparent", color: "#aaa", cursor: "pointer" }}
                    >Thử lại</button>
                  </div>
                )}
                {!topMoversLoading && !topMoversError && !topMovers && (
                  <div style={{ textAlign: "center", color: "#555", fontSize: 12, padding: "8px 0" }}>Không có dữ liệu</div>
                )}
                {topMovers && (() => {
                  const list = topMoversTab === 'gainers' ? topMovers.gainers
                             : topMoversTab === 'losers'  ? topMovers.losers
                             : topMoversTab === 'lowCap'  ? topMovers.lowCap
                             : topMovers.newListings;
                  return list.map(m => {
                    const label = m.symbol.replace("USDT", "");
                    const isPos = m.change >= 0;
                    const alreadyIn = symbols.includes(m.symbol);
                    return (
                      <button
                        key={m.symbol}
                        onClick={() => addCoinFromMover(m.symbol)}
                        title={alreadyIn ? "Đang theo dõi" : "Bấm để thêm vào danh sách quét"}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "6px 10px", borderRadius: 6, border: "none",
                          background: alreadyIn ? "rgba(8,153,129,0.12)" : "rgba(255,255,255,0.03)",
                          cursor: "pointer", transition: "background 0.15s",
                          outline: alreadyIn ? "1px solid rgba(8,153,129,0.4)" : "none"
                        }}
                      >
                        <span style={{ fontWeight: 700, fontSize: 13, color: alreadyIn ? "var(--color-positive)" : "#ccc" }}>
                          {label}
                          {alreadyIn && <span style={{ fontSize: 10, marginLeft: 5, opacity: 0.7 }}>✓</span>}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {topMoversTab === 'new' && m.listedAt && (
                            <span style={{ fontSize: 10, color: "#555" }}>
                              {new Date(m.listedAt).toLocaleDateString("vi")}
                            </span>
                          )}
                          {topMoversTab === 'lowCap' && m.volume && (
                            <span style={{ fontSize: 10, color: "#777", minWidth: 72, textAlign: "right" }}>
                              Vol {(m.volume / 1_000_000).toFixed(1)}M
                            </span>
                          )}
                          <span style={{
                            fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)",
                            color: isPos ? "#4ade80" : "#f87171",
                            minWidth: 60, textAlign: "right"
                          }}>
                            {isPos ? "+" : ""}{m.change.toFixed(2)}%
                          </span>
                        </div>
                      </button>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 6 }}>
            {favCoins.map(coin => {
              const active = symbols.includes(coin);
              const label = coin.replace("USDT", "");
              return (
                <div key={coin} style={{ position: "relative" }}>
                  <button
                    onClick={() => !editFav && toggleCoin(coin)}
                    style={{
                      width: "100%",
                      padding: "7px 0",
                      borderRadius: 6,
                      border: active ? "1px solid var(--color-positive)" : "1px solid #333",
                      background: active ? "rgba(8,153,129,0.15)" : "transparent",
                      color: active ? "var(--color-positive)" : editFav ? "#555" : "#888",
                      fontWeight: active ? 700 : 400,
                      fontSize: 13,
                      cursor: editFav ? "default" : "pointer",
                      transition: "all 0.15s",
                      opacity: editFav ? 0.6 : 1
                    }}
                  >
                    {label}
                  </button>
                  {editFav && (
                    <button
                      onClick={() => removeFavCoin(coin)}
                      style={{
                        position: "absolute", top: -5, right: -5,
                        width: 18, height: 18, borderRadius: "50%",
                        background: "var(--color-negative)", color: "#fff",
                        border: "none", cursor: "pointer",
                        fontSize: 11, lineHeight: "18px", textAlign: "center",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        padding: 0
                      }}
                    >×</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Thêm coin mới vào favorites */}
          {editFav && (
            <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
              <input
                placeholder="Thêm coin (pha, sol...)"
                value={newFav}
                onChange={e => setNewFav(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addFavCoin()}
                style={{ flex: 1, fontSize: 13 }}
              />
              <button onClick={addFavCoin} style={{ whiteSpace: "nowrap" }}>+ Thêm</button>
              <button
                onClick={clearFavCoins}
                disabled={favCoins.length === 0}
                title="Xóa toàn bộ coin yêu thích"
                style={{
                  whiteSpace: "nowrap",
                  borderColor: favCoins.length === 0 ? "#333" : "var(--color-negative)",
                  color: favCoins.length === 0 ? "#555" : "var(--color-negative)",
                  cursor: favCoins.length === 0 ? "not-allowed" : "pointer"
                }}
              >
                Xóa tất cả
              </button>
              {newFav.trim() && (
                <small style={{ color: favPreview ? "#4ade80" : "#f87171", whiteSpace: "nowrap" }}>
                  {favPreview ? `→ ${favPreview}` : "không hợp lệ"}
                </small>
              )}
            </div>
          )}
        </div>

        {/* Chiến lược */}
        <div className="sfpConfigBox">
          <div className="sectionTitle">Chiến lược</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            {([
              { key: "sfp", title: "1. SFP", desc: "Sweep thanh khoản, entry theo setup SFP hiện tại." },
              { key: "candlestick", title: "2. Mẫu nến", desc: "Đảo chiều tăng/giảm, SL theo cụm nến, TP theo % riêng." },
              { key: "wyckoff", title: "3. Wyckoff", desc: "SC/AR/ST, trading range, breakout/retest và lọc volume." },
              { key: "smc", title: "4. SMC", desc: "LuxAlgo BOS/CHoCH, Order Block breakout, EQH/EQL và FVG." },
            ] as const).map(item => {
              const active = sfpStrategies.includes(item.key);
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    toggleStrategy(item.key);
                  }}
                  style={{
                    textAlign: "left",
                    padding: "14px 16px",
                    borderRadius: 8,
                    border: active ? "1px solid var(--color-positive)" : "1px solid #2a2a3a",
                    background: active ? "rgba(8,153,129,0.13)" : "rgba(255,255,255,0.02)",
                    color: active ? "var(--color-positive)" : "#aaa",
                    cursor: "pointer",
                    minHeight: 92
                  }}
                >
                  <strong style={{ display: "block", fontSize: 15, marginBottom: 7 }}>{item.title}</strong>
                  <span style={{ display: "block", fontSize: 12, lineHeight: 1.45, color: active ? "#9fffd6" : "#777" }}>
                    {item.desc}
                  </span>
                </button>
              );
            })}
          </div>
          {isSmcMainMode && (
            <div style={{
              marginTop: 12,
              padding: "12px",
              borderRadius: 8,
              border: "1px solid rgba(0,255,157,0.24)",
              background: "rgba(0,255,157,0.06)"
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <strong style={{ color: "var(--color-positive)", fontSize: 13 }}>Nới điều kiện SMC</strong>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="pill neutral" onClick={() => applySmcPreset(SMC_SAFE_DEFAULTS)}>
                    Mặc định an toàn
                  </button>
                  <button type="button" className="pill positive" onClick={() => applySmcPreset(SMC_SCALP_M1_DEFAULTS)}>
                    Gợi ý Scalp M1
                  </button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>RR TP2 tối thiểu</span>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    step={0.1}
                    value={smcPreferredRR}
                    disabled={smcRelaxedRRTP}
                    onChange={e => setSmcPreferredRR(Number(e.target.value))}
                    style={{ textAlign: "center", padding: "7px 8px", fontSize: 14, fontWeight: 800, opacity: smcRelaxedRRTP ? 0.55 : 1 }}
                  />
                  <small style={{ color: "#6f8da4" }}>{smcRelaxedRRTP ? "Đã bỏ lọc RR/TP2. TP trigger theo ROI 30%." : "Giảm = dễ có lệnh. Gốc 2.0, M1 gợi ý 1.5"}</small>
                </label>
                <label style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: 7,
                  border: smcRelaxedRRTP ? "1px solid rgba(0,255,157,0.35)" : "1px solid rgba(255,255,255,0.08)",
                  background: smcRelaxedRRTP ? "rgba(0,255,157,0.09)" : "rgba(0,0,0,0.16)"
                }}>
                  <span>
                    <span style={{ display: "block", fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>Bỏ RR/TP SMC</span>
                    <small style={{ color: "#6f8da4" }}>
                      {smcRelaxedRRTP ? `Bật: SL giữ nguyên, ROI ${smcTakeProfitRoiPercent}% kích hoạt trailing/dời SL` : "Tắt: cần TP2 liquidity và RR đạt ngưỡng"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={smcRelaxedRRTP}
                    onChange={e => {
                      setSmcRelaxedRRTP(e.target.checked);
                      setSmcTakeProfitRoiPercent(30);
                    }}
                    style={{ width: 18, height: 18, accentColor: "var(--color-positive)" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>Score tối thiểu</span>
                  <input
                    type="number"
                    min={4}
                    max={10}
                    step={1}
                    value={smcMinScore}
                    onChange={e => setSmcMinScore(Number(e.target.value))}
                    style={{ textAlign: "center", padding: "7px 8px", fontSize: 14, fontWeight: 800 }}
                  />
                  <small style={{ color: "#6f8da4" }}>Giảm = dễ có lệnh. Gốc 7, M1 gợi ý 6</small>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>Cho MSS trễ tối đa</span>
                  <input
                    type="number"
                    min={3}
                    max={30}
                    step={1}
                    value={smcMaxBarsAfterSweepForMSS}
                    onChange={e => setSmcMaxBarsAfterSweepForMSS(Number(e.target.value))}
                    style={{ textAlign: "center", padding: "7px 8px", fontSize: 14, fontWeight: 800 }}
                  />
                  <small style={{ color: "#6f8da4" }}>Tăng = nới. Gốc 10 nến, M1 gợi ý 15</small>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>FVG nhỏ nhất (%)</span>
                  <input
                    type="number"
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={smcFvgMinSizePct}
                    onChange={e => setSmcFvgMinSizePct(Number(e.target.value))}
                    style={{ textAlign: "center", padding: "7px 8px", fontSize: 14, fontWeight: 800 }}
                  />
                  <small style={{ color: "#6f8da4" }}>Giảm = nhận FVG nhỏ hơn. Gốc 0.05, M1 gợi ý 0.03</small>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>FVG cửa sổ sau MSS (nến)</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    value={smcFvgMaxBarsAfterMss}
                    onChange={e => setSmcFvgMaxBarsAfterMss(Number(e.target.value))}
                    style={{ textAlign: "center", padding: "7px 8px", fontSize: 14, fontWeight: 800 }}
                  />
                  <small style={{ color: "#6f8da4" }}>Tăng = nhận FVG trễ hơn sau MSS. Gốc 3, M1 gợi ý 6</small>
                </label>
                <label style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: 7,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.16)"
                }}>
                  <span>
                    <span style={{ display: "block", fontSize: 11, color: "#8aa0b6", fontWeight: 800 }}>Lọc giữa range</span>
                    <small style={{ color: "#6f8da4" }}>{smcAvoidMiddleOfRange ? "Đang chặt hơn" : "Đã nới cho M1"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={smcAvoidMiddleOfRange}
                    onChange={e => setSmcAvoidMiddleOfRange(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: "var(--color-positive)" }}
                  />
                </label>
              </div>
            </div>
          )}
          {sfpStrategies.includes("candlestick") && (
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "160px 1fr", gap: 10, alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 12, color: "#888" }}>TP mẫu nến (%)</span>
                <input
                  type="number"
                  min={0.05}
                  max={20}
                  step={0.05}
                  value={sfpCandlestickTpPercent}
                  onChange={e => setSfpCandlestickTpPercent(Number(e.target.value))}
                  style={{ textAlign: "center", padding: "7px 8px", fontSize: 15, fontWeight: 800 }}
                />
              </label>
              <small style={{ color: "#8aa0b6", lineHeight: 1.45 }}>
                ROI TP khoảng {(sfpCandlestickTpPercent * leverage).toFixed(2)}% với {leverage}x. SL vẫn tự động theo cụm nến; bot chặn setup nếu SL × đòn bẩy vượt ngưỡng an toàn hoặc quá gần vùng liquidation ước tính.
              </small>
            </div>
          )}
        </div>

        {/* Khung thời gian */}
        <div className="sfpConfigBox">
          <div className="sectionTitle" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>Khung thời gian <small style={{ fontWeight: 400, color: "#888" }}>(chọn nhiều)</small></span>
            {isSmcMainMode && (
              <button
                type="button"
                onClick={() => setSmcAutoTimeframes(v => !v)}
                style={{
                  border: smcAutoTimeframes ? "1px solid #ff2d5a" : "1px solid rgba(0,255,157,0.45)",
                  background: smcAutoTimeframes ? "rgba(255,45,90,0.16)" : "rgba(0,255,157,0.10)",
                  color: smcAutoTimeframes ? "#ff5f7d" : "var(--color-positive)",
                  borderRadius: 7,
                  padding: "4px 8px",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  cursor: "pointer"
                }}
                title={smcAutoTimeframes ? "SMC đang tự chọn HTF/MTF/LTF" : "SMC dùng khung thời gian bạn chọn"}
              >
                {smcAutoTimeframes ? "AUTO TF" : "MANUAL TF"}
              </button>
            )}
          </div>
          {smcTimeframesLocked && (
            <div style={{
              border: "1px solid rgba(255,45,90,0.35)",
              background: "rgba(255,45,90,0.10)",
              color: "#ff6b86",
              borderRadius: 7,
              padding: "7px 9px",
              marginBottom: 8,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              fontWeight: 700
            }}>
              SMC AUTO: bot tự dùng LTF 1m / MTF 15m / HTF 1h. Timeframe bên dưới đang bị khóa.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {SFP_TIMEFRAMES.map(tf => {
              const active = smcTimeframesLocked ? ["1m", "15m", "1h"].includes(tf) : timeframes.includes(tf);
              return (
                <button
                  key={tf}
                  className={active ? "pill positive" : "pill neutral"}
                  disabled={smcTimeframesLocked}
                  style={{
                    cursor: smcTimeframesLocked ? "not-allowed" : "pointer",
                    border: smcTimeframesLocked && active ? "1px solid #ff2d5a" : "none",
                    justifyContent: "center",
                    width: "100%",
                    opacity: smcTimeframesLocked ? (active ? 1 : 0.35) : 1,
                    background: smcTimeframesLocked && active ? "rgba(255,45,90,0.18)" : undefined,
                    color: smcTimeframesLocked && active ? "#ff5f7d" : undefined
                  }}
                  onClick={() => {
                    if (smcTimeframesLocked) return;
                    setTimeframes(
                      active
                        ? timeframes.filter(t => t !== tf)
                        : [...timeframes, tf]
                    );
                  }}
                >
                  {tf}
                </button>
              );
            })}
          </div>
          {!smcTimeframesLocked && timeframes.length === 0 && (
            <small style={{ color: "#f87171" }}>Chọn ít nhất 1 khung thời gian</small>
          )}
        </div>

        {/* Thông số lệnh */}
        <div className="sfpConfigBox">
          <div className="sectionTitle">Thông số lệnh</div>

          {/* Đòn bẩy */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>Đòn bẩy</span>
              <strong style={{ fontSize: 16, color: "var(--color-positive)" }}>{leverage}×</strong>
            </div>
            <input type="range" min={1} max={125} step={1} value={leverage}
              onChange={e => setLeverage(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--color-positive)", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 4 }}>
              {LEVERAGE_PRESETS.map(p => (
                <button key={p}
                  onClick={() => setLeverage(p)}
                  style={{
                    flex: 1, padding: "4px 0", fontSize: 12, borderRadius: 5,
                    border: leverage === p ? "1px solid var(--color-positive)" : "1px solid #333",
                    background: leverage === p ? "rgba(8,153,129,0.15)" : "transparent",
                    color: leverage === p ? "var(--color-positive)" : "#888",
                    cursor: "pointer", fontWeight: leverage === p ? 700 : 400
                  }}
                >{p}×</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Loại margin</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {(["CROSSED", "ISOLATED"] as const).map(mode => {
                const active = sfpMarginType === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setSfpMarginType(mode)}
                    style={{
                      padding: "8px 0",
                      borderRadius: 7,
                      border: active ? "1px solid var(--color-positive)" : "1px solid #333",
                      background: active ? "rgba(8,153,129,0.15)" : "transparent",
                      color: active ? "var(--color-positive)" : "#aaa",
                      cursor: "pointer",
                      fontWeight: active ? 700 : 500
                    }}
                  >
                    {mode === "CROSSED" ? "Cross" : "Isolated"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Ký quỹ */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>Ký quỹ mỗi lệnh</span>
              <strong style={{ fontSize: 16, color: "var(--color-positive)" }}>{marginUsdt.toFixed(2)} USDT</strong>
            </div>
            <input type="range" min={0.01} max={marginSliderMax} step={0.01}
              value={Math.min(marginUsdt, marginSliderMax)}
              onChange={e => setMarginUsdt(clampMarginUsdt(Number(e.target.value)))}
              style={{ width: "100%", accentColor: "var(--color-positive)", marginBottom: 8 }} />
            {usdtBalance > 0 ? (
              <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                {[25, 50, 75, 100].map(pct => {
                  const val = roundUsdt(safeAvailableMarginUsdt * pct / 100);
                  const active = Math.abs(marginUsdt - val) < 0.005;
                  return (
                    <button key={pct}
                      onClick={() => setMarginUsdt(clampMarginUsdt(val))}
                      title={`${pct}% an toàn = ${val.toFixed(2)} USDT`}
                      style={{
                        flex: 1, padding: "4px 0", fontSize: 12, borderRadius: 5,
                        border: active ? "1px solid var(--color-positive)" : "1px solid #333",
                        background: active ? "rgba(8,153,129,0.15)" : "transparent",
                        color: active ? "var(--color-positive)" : "#888",
                        cursor: "pointer", fontWeight: active ? 700 : 400
                      }}
                    >{pct}% - {val.toFixed(2)}</button>
                  );
                })}
              </div>
            ) : (
              <div style={{ marginBottom: 6 }}>
                {balanceError
                  ? <small style={{ color: "#f87171" }} title={balanceError}>Không kết nối tài khoản — nhập thủ công bên dưới</small>
                  : <small style={{ color: "#666" }}>Đang tải số dư...</small>}
              </div>
            )}
            <input
              type="number" min={0.01} max={safeAvailableMarginUsdt > 0 ? safeAvailableMarginUsdt : 10000} step={0.01}
              value={marginUsdt}
              onChange={e => setMarginUsdt(clampMarginUsdt(Number(e.target.value)))}
              style={{ width: "100%", textAlign: "right" }}
              placeholder="Nhập USDT"
            />
            {usdtBalance > 0 && (
              <small style={{ color: "#4ade80" }}>
                Khả dụng: {availableMarginUsdt.toFixed(2)} USDT · Mỗi lệnh tối đa: {safeAvailableMarginUsdt.toFixed(2)} USDT
                {remainingMarginSlots > 1 ? ` (${remainingMarginSlots} slot còn trống)` : ""}
                {marginFeeBufferMultiplier > 1 ? ` · Tổng an toàn ${safeAvailableTotalUsdt.toFixed(2)} USDT đã chừa phí 8%` : ""}
              </small>
            )}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            <span>Pivot lookback</span>
            <input type="number" min={2} max={50} value={sfpLen}
              onChange={e => setSfpLen(Number(e.target.value))} style={{ width: 80 }} />
          </label>
        </div>

        {/* Chế độ vào lệnh */}
        <div className="sfpConfigBox">
          <div className="sectionTitle">Chế độ vào lệnh</div>
          <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: 13 }}>
              <input type="checkbox" checked={sfpEnabled} onChange={e => setSfpEnabled(e.target.checked)} />
              <strong>Bật scanner</strong>
            </label>
            <label style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              cursor: "pointer",
              fontSize: 13,
              color: allowMarketOrder ? "var(--color-positive)" : "#aaa"
            }}>
              <input
                type="checkbox"
                checked={allowMarketOrder}
                onChange={e => setAllowMarketOrder(e.target.checked)}
                style={{ accentColor: "var(--color-positive)" }}
              />
              <strong>Vào lệnh Market</strong>
            </label>
          </div>
          {allowMarketOrder && (
            <div style={{
              marginBottom: 10,
              padding: "7px 9px",
              borderRadius: 7,
              border: "1px solid rgba(0,255,157,0.22)",
              background: "rgba(0,255,157,0.07)",
              color: "#9fffd6",
              fontSize: 11,
              lineHeight: 1.35
            }}>
              Market: bot vào ngay theo giá hiện tại. Nếu tắt, bot dùng LIMIT tại vùng entry.
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>
              Tối đa số lệnh được chạy cùng lúc
            </div>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={maxOpenPositions}
              onChange={e => {
                const next = normalizeMaxOpenPositions(Number(e.target.value));
                setMaxOpenPositions(next);
                setSfpOneTradeAtATime(next <= 1);
              }}
              style={{ width: "100%", textAlign: "center", fontSize: 16, fontWeight: 800 }}
            />
            <small style={{ color: "#888" }}>
              Ví dụ nhập 2 để cho phép tối đa 2 vị thế/lệnh chờ cùng lúc. Bot chỉ mở thêm khi còn slot và không mở trùng cùng coin.
            </small>
          </div>

          {/* Mode cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {/* Thủ công */}
            <div onClick={() => setAutoExecute(false)} style={{
              cursor: "pointer", borderRadius: 10, padding: "14px 16px",
              border: `2px solid ${!autoExecute ? "var(--color-positive)" : "#2a2a3a"}`,
              background: !autoExecute ? "rgba(8,153,129,0.1)" : "rgba(255,255,255,0.02)",
              transition: "border-color 0.15s, background 0.15s"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 15, color: !autoExecute ? "var(--color-positive)" : "#e0e0e0" }}>
                  Thủ công
                </strong>
                <span style={{
                  width: 18, height: 18, borderRadius: "50%", border: `2px solid ${!autoExecute ? "var(--color-positive)" : "#555"}`,
                  background: !autoExecute ? "var(--color-positive)" : "transparent",
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center"
                }}>
                  {!autoExecute && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", display: "block" }} />}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5 }}>
                Tất cả tín hiệu → hiển thị chờ bạn quyết định <strong style={{ color: "#ccc" }}>Vào lệnh</strong> hay bỏ qua
              </div>
            </div>

            {/* Tự động */}
            <div onClick={() => setAutoExecute(true)} style={{
              cursor: "pointer", borderRadius: 10, padding: "14px 16px",
              border: `2px solid ${autoExecute ? "#f5a623" : "#2a2a3a"}`,
              background: autoExecute ? "rgba(245,166,35,0.08)" : "rgba(255,255,255,0.02)",
              transition: "border-color 0.15s, background 0.15s"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 15, color: autoExecute ? "#f5a623" : "#e0e0e0" }}>
                  Tự động
                </strong>
                <span style={{
                  width: 18, height: 18, borderRadius: "50%", border: `2px solid ${autoExecute ? "#f5a623" : "#555"}`,
                  background: autoExecute ? "#f5a623" : "transparent",
                  flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center"
                }}>
                  {autoExecute && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", display: "block" }} />}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5 }}>
                Tín hiệu <strong style={{ color: "#ccc" }}>Đạt</strong> → đợi {sfpWaitCandles} nến → tự vào lệnh · Không đạt → tự bỏ qua
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {autoExecute && (
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#888" }}>Đợi bao nhiêu nến</span>
                <input type="number" min={0} max={20} value={sfpWaitCandles}
                  onChange={e => setSfpWaitCandles(Number(e.target.value))}
                  style={{ textAlign: "center", padding: "6px 8px", fontSize: 15, fontWeight: 700 }} />
              </label>
            )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, color: "#888" }}>Chốt lời % theo entry (0 = TP theo 2R từ SL)</span>
                <input type="number" min={0} max={100} step={0.1} value={sfpTpPercent}
                  onChange={e => setSfpTpPercent(Number(e.target.value))}
                  style={{ textAlign: "center", padding: "6px 8px", fontSize: 15, fontWeight: 700 }} />
              </label>
          </div>
        </div>

        {/* ── RADAR — chiếm cột 2–3 hàng dưới (khung đỏ) ─── */}
        <div style={{
          gridColumn: "2 / 4",
          borderRadius: "var(--r-lg)",
          overflow: "hidden",
          minHeight: 360,
          border: "1px solid rgba(0,180,220,0.15)",
          background: "#00060a"
        }}>
          <MilitaryRadar
            watchSymbols={symbols.length > 0 ? symbols : ["BTCUSDT","ETHUSDT"]}
            latestSignals={signals.slice(0, 40).map(s => ({
              symbol:    s.symbol,
              direction: s.direction,
              score:     s.decisionScore ?? 0,
              decision:  s.decision ?? null
            }))}
          />
        </div>

      </div>

      {/* ── LƯU CÀI ĐẶT ─────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "flex-end", alignItems: "center",
        gap: 12, marginTop: 16, paddingTop: 16, borderTop: "1px solid #232336"
      }}>
        {status && <span className="sfpSaveMessage sfpSaveStatus">{status}</span>}
        {error && <span className="sfpSaveMessage sfpSaveError">{error}</span>}
        <button
          onClick={() => void save()}
          style={{
            padding: "10px 28px", fontSize: 15, fontWeight: 700,
            background: "var(--color-positive)", color: "#fff",
            border: "none", borderRadius: 8, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8
          }}
        >
          <Save size={16} /> Lưu cài đặt
        </button>
      </div>

      {/* ── SỐ DƯ TÀI KHOẢN ─────────────────────────────── */}
      {(walletBalance > 0 || usdtBalance > 0 || balanceError) && (() => {
        const totalAssets = walletBalance + (unrealizedPnl > 0 ? unrealizedPnl : 0);
        const pnlColor = unrealizedPnl >= 0 ? "#12d18e" : "#ff4f68";
        const sparkles = [
          { top: "18%", left: "12%",  delay: "0s",    size: 5 },
          { top: "65%", left: "28%",  delay: "0.6s",  size: 4 },
          { top: "30%", left: "55%",  delay: "1.1s",  size: 6 },
          { top: "75%", left: "72%",  delay: "0.3s",  size: 4 },
          { top: "20%", left: "85%",  delay: "1.5s",  size: 5 },
          { top: "55%", left: "93%",  delay: "0.8s",  size: 3 },
          { top: "82%", left: "44%",  delay: "0.4s",  size: 4 },
          { top: "10%", left: "38%",  delay: "1.8s",  size: 3 },
          { top: "45%", left: "8%",   delay: "2.1s",  size: 5 },
          { top: "90%", left: "88%",  delay: "1.3s",  size: 3 },
        ];
        const cyanSparkles = [
          { top: "25%", left: "15%",  delay: "0.5s",  size: 4 },
          { top: "70%", left: "35%",  delay: "1.2s",  size: 5 },
          { top: "15%", left: "65%",  delay: "0.9s",  size: 3 },
          { top: "80%", left: "80%",  delay: "0.2s",  size: 5 },
          { top: "50%", left: "92%",  delay: "1.7s",  size: 4 },
          { top: "35%", left: "50%",  delay: "0.7s",  size: 3 },
        ];
        return (
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14,
            margin: "20px 0 8px"
          }}>
            {/* Tổng tài sản */}
            <div className="balance-card-gold" style={{
              position: "relative", overflow: "hidden",
              borderRadius: 14, padding: "18px 24px",
              background: "linear-gradient(135deg, #0d0a00 0%, #1a1200 50%, #0d0a00 100%)",
              border: "1px solid rgba(245,200,75,0.25)",
            }}>
              {sparkles.map((s, i) => (
                <span key={i} style={{
                  position: "absolute", top: s.top, left: s.left,
                  width: s.size, height: s.size,
                  borderRadius: "50%",
                  background: "#ffd700",
                  animation: `${i % 2 === 0 ? "sparkleFloat" : "sparkleFloat2"} ${2 + (i * 0.3) % 1.5}s ease-in-out ${s.delay} infinite`,
                  pointerEvents: "none"
                }} />
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(245,200,75,0.55)", marginBottom: 6, textTransform: "uppercase" }}>
                ✦ Tổng tài sản
              </div>
              <div className="balance-gold" style={{ fontSize: 36, fontWeight: 900, fontFamily: "var(--font-mono)", lineHeight: 1 }}>
                {totalAssets.toFixed(2)}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "rgba(245,200,75,0.45)", marginTop: 2 }}>USDT</div>
              {unrealizedPnl !== 0 && (
                <div style={{ marginTop: 8, fontSize: 12, color: pnlColor, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                  {unrealizedPnl >= 0 ? "▲" : "▼"} uPnL {unrealizedPnl >= 0 ? "+" : ""}{unrealizedPnl.toFixed(2)} USDT
                </div>
              )}
            </div>

            {/* Khả dụng */}
            <div className="balance-card-cyan" style={{
              position: "relative", overflow: "hidden",
              borderRadius: 14, padding: "18px 24px",
              background: "linear-gradient(135deg, #000e0d 0%, #001a18 50%, #000e0d 100%)",
              border: "1px solid rgba(0,220,200,0.22)",
            }}>
              {cyanSparkles.map((s, i) => (
                <span key={i} style={{
                  position: "absolute", top: s.top, left: s.left,
                  width: s.size, height: s.size,
                  borderRadius: "50%",
                  background: "#00e5cc",
                  animation: `${i % 2 === 0 ? "sparkleFloat" : "sparkleFloat2"} ${1.8 + (i * 0.4) % 1.6}s ease-in-out ${s.delay} infinite`,
                  pointerEvents: "none"
                }} />
              ))}
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "rgba(0,220,200,0.5)", marginBottom: 6, textTransform: "uppercase" }}>
                ◈ Khả dụng
              </div>
              <div className="balance-cyan" style={{ fontSize: 36, fontWeight: 900, fontFamily: "var(--font-mono)", lineHeight: 1 }}>
                {usdtBalance.toFixed(2)}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "rgba(0,220,200,0.4)", marginTop: 2 }}>USDT</div>
              <div style={{ marginTop: 8, fontSize: 12, color: "rgba(0,220,200,0.5)", fontFamily: "var(--font-mono)" }}>
                Ký quỹ đang dùng: {walletBalance > usdtBalance ? (walletBalance - usdtBalance).toFixed(2) : "0.00"} USDT
                {balanceUpdatedAt ? ` · cập nhật ${balanceUpdatedAt}` : ""}
              </div>
              {balanceError && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#f87171", fontWeight: 700 }}>
                  Lỗi đọc số dư: {balanceError}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── VỊ THẾ ĐANG MỞ + PNL ─────────────────────────── */}
      {openPositions.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="sectionTitle" style={{ marginBottom: 10 }}>Vị thế đang mở</div>
          {openPositions.map((row, i) => (
            <PositionCard
              key={i}
              row={row}
              openOrders={sfpOpenOrders}
              onClose={async (sym) => {
                if (!window.confirm(`Đóng vị thế ${sym}?`)) return;
                try {
                  await api(`/api/positions/${sym}/close`, { method: "POST" });
                  void refreshSignals();
                } catch (e) {
                  alert(`Lỗi đóng lệnh: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
            />
          ))}
        </div>
      )}

      {wyckoffPreviewSignals.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div className="sectionTitle" style={{ marginBottom: 10 }}>
            Kết quả quét {cfg?.strategyMode === "smc" ? "SMC" : "Wyckoff"} — {wyckoffPreviewSignals.filter(sig => sig.signal === "LONG" || sig.signal === "SHORT").length}/{wyckoffPreviewSignals.length} tín hiệu vào lệnh
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {wyckoffPreviewSignals.map((sig, index) => {
              const actionable = sig.signal === "LONG" || sig.signal === "SHORT";
              return (
                <div key={`${sig.symbol}-${sig.interval}-${index}`} className="sfpSignalCard"
                  style={{ borderLeft: `3px solid ${sig.signal === "LONG" ? "var(--color-positive)" : sig.signal === "SHORT" ? "var(--color-negative)" : "#64748b"}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className={`pill ${sig.signal === "LONG" ? "positive" : sig.signal === "SHORT" ? "negative" : "neutral"}`}>
                      {sig.signal}
                    </span>
                    <strong>{sig.symbol}</strong>
                    <span className="pill neutral">{sig.interval}</span>
                    <span className={actionable ? "pill positive" : "pill neutral"}>
                      {sig.confidence}/100
                    </span>
                    <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {fmtPrice(sig.price)}
                    </span>
                  </div>
                  <div style={{ marginTop: 8, color: "#c7d2de", fontSize: 12, lineHeight: 1.45 }}>
                    {sig.reason}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── TÍN HIỆU CHỜ XÁC NHẬN ─────────────────────────── */}
      {pending.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div className="sectionTitle pendingSignalTitle" style={{ marginBottom: 0 }}>
              Chờ xác nhận — {pending.length} setup
            </div>
            <button
              onClick={() => void rejectAll()}
              style={{
                padding: "5px 14px", fontSize: 12, fontWeight: 700,
                background: "rgba(242,54,69,0.12)", color: "var(--color-negative)",
                border: "1px solid rgba(242,54,69,0.35)", borderRadius: 6, cursor: "pointer"
              }}
            >
              Bỏ qua tất cả
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pending.map(sig => (
              <div key={sig.id} className="sfpSignalCard"
                style={{ borderLeft: `3px solid ${sig.direction === "BULLISH" ? "var(--color-positive)" : "var(--color-negative)"}` }}>
                {(() => {
                  const detailsOpen = Boolean(pendingDetailsOpen[sig.id]);
                  const executeAt = sig.executeAfter ? new Date(sig.executeAfter) : null;
                  const waitMs = executeAt ? executeAt.getTime() - Date.now() : 0;
                  const waitText = executeAt
                    ? waitMs > 0
                      ? `Auto chờ đến ${executeAt.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`
                      : "Auto đủ thời gian, đang chờ queue xử lý"
                    : autoExecute
                      ? "Auto chưa đặt lịch cho setup này"
                      : "Auto đang tắt";
                  return (
                    <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                      onClick={() => {
                        if (!detailsOpen && !sig.chartUrl) void ensureSignalChart(sig.id);
                        togglePendingDetails(sig.id);
                      }}
                      title={detailsOpen ? "Ẩn chi tiết" : "Hiện chi tiết"}
                      style={{
                        width: 24,
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.04)",
                        color: "var(--text-dim)",
                        padding: 0,
                        cursor: "pointer"
                      }}
                    >
                      {detailsOpen ? "▲" : "▼"}
                    </button>
                    <span className={`pill ${sig.direction === "BULLISH" ? "positive" : "negative"}`}>
                      {sig.direction === "BULLISH" ? "LONG" : "SHORT"}
                    </span>
                    <strong>{sig.symbol}</strong>
                    <span className="pill neutral">{sig.timeframe}</span>
                    <span className="pill neutral">{strategyLabel(sig.strategy)}</span>
                    {sig.patternName && <span className="pill positive">{sig.patternName}</span>}
                    {sig.confirmed && <span className="pill positive">Đã xác nhận</span>}
                    <span className={sig.decision === "TRADE" ? "pill positive" : "pill negative"}>
                      {sig.decision === "TRADE" ? `Đủ rule ${sig.decisionScore ?? 0}/100` : `Không vào ${sig.decisionScore ?? 0}/100`}
                    </span>
                    <span className="pill neutral" title={executeAt ? executeAt.toLocaleString("vi-VN") : undefined}>
                      {waitText}
                    </span>
                    {!detailsOpen && (
                      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {sig.decisionSummary || sig.message}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={{ background: "var(--color-positive)", color: "#fff" }}
                      onClick={() => void execute(sig.id)}>Vào lệnh</button>
                    <button onClick={() => void reject(sig.id)}>Bỏ qua</button>
                  </div>
                </div>
                {detailsOpen && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px 16px", marginTop: 8, fontSize: 13 }}>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>ENTRY</span><br />
                    <strong>{fmtPrice(sig.entryPrice)}</strong>
                  </div>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>SL</span><br />
                    <strong style={{ color: "var(--color-negative)" }}>{fmtPrice(sig.slPrice)}</strong>
                  </div>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>TP</span><br />
                    <strong style={{ color: "var(--color-positive)" }}>{fmtPrice(sig.tpPrice)}</strong>
                  </div>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>SWING</span><br />
                    <strong>{fmtPrice(sig.swingPrice)}</strong>
                  </div>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>ĐÒN BẨY</span><br />
                    <strong>{sig.leverage}× · {sig.marginUsdt} USDT</strong>
                  </div>
                  <div>
                    <span style={{ color: "#888", fontSize: 11 }}>PHÁT HIỆN</span><br />
                    <strong>{new Date(sig.createdAt).toLocaleTimeString("vi-VN")}</strong>
                  </div>
                </div>
                )}
                {detailsOpen && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: "#888", fontSize: 11 }}>CHART</span>
                      {sig.chartUrl && (
                        <button
                          onClick={(e) => { e.stopPropagation(); void ensureSignalChart(sig.id); }}
                          disabled={chartLoadingIds[sig.id]}
                          title="Nạp lại nến thật mới nhất từ Binance"
                          style={{
                            minHeight: 28,
                            padding: "0 10px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            borderRadius: 6,
                            border: "1px solid rgba(0,229,255,0.45)",
                            background: "rgba(0,229,255,0.10)",
                            color: "#7ddcff",
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: chartLoadingIds[sig.id] ? "wait" : "pointer"
                          }}
                        >
                          <RefreshCw size={13} />
                          {chartLoadingIds[sig.id] ? "Đang nạp" : "Live"}
                        </button>
                      )}
                    </div>
                    {sig.chartUrl ? (
                      <img
                        src={sig.chartUrl}
                        alt={`${sig.symbol} ${sig.timeframe} signal chart`}
                        onClick={() => openSignalChart(sig)}
                        style={{
                          display: "block",
                          width: "100%",
                          maxHeight: 360,
                          objectFit: "contain",
                          marginTop: 6,
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          background: "#03070c",
                          cursor: "zoom-in"
                        }}
                      />
                    ) : (
                      <div style={{
                        marginTop: 6,
                        border: "1px dashed var(--border)",
                        borderRadius: 8,
                        padding: "12px 14px",
                        color: "var(--text-dim)",
                        fontSize: 12
                      }}>
                        {chartLoadingIds[sig.id] ? "Đang tạo chart..." : "Chưa có chart cho signal này."}
                        {!chartLoadingIds[sig.id] && (
                          <button
                            onClick={() => void ensureSignalChart(sig.id)}
                            style={{ marginLeft: 10, minHeight: 28, padding: "0 10px", fontSize: 12 }}
                          >
                            Tạo chart
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {detailsOpen && <SFPDecisionTable sig={sig} />}
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── BẢNG TỔNG KẾT TÍN HIỆU BỎ QUA ─────────────── */}
      {recent.length > 0 && (() => {
        // Tính PnL mô phỏng cho từng tín hiệu bị từ chối
        const withPnl = recent.map(sig => ({ sig, pnl: calcPnl(sig) })).filter(x => x.pnl !== null) as { sig: SFPSignalRecord; pnl: PnlResult }[];

        const wins   = withPnl.filter(x => x.pnl.pnlUsdt > 0);
        const losses = withPnl.filter(x => x.pnl.pnlUsdt <= 0);
        const winRate = withPnl.length > 0 ? Math.round(wins.length / withPnl.length * 100) : 0;
        const simTotal = withPnl.reduce((s, x) => s + x.pnl.pnlUsdt, 0);
        const simTotalColor = simTotal >= 0 ? "var(--green)" : "var(--red)";

        // Theo coin
        const coinMap: Record<string, { w: number; l: number; pnl: number; sym: string }> = {};
        for (const { sig, pnl } of withPnl) {
          const k = sig.symbol;
          if (!coinMap[k]) coinMap[k] = { w: 0, l: 0, pnl: 0, sym: k.replace(/USDT$/, "") };
          coinMap[k].pnl += pnl.pnlUsdt;
          if (pnl.pnlUsdt > 0) coinMap[k].w++; else coinMap[k].l++;
        }
        const coinsSorted = Object.values(coinMap).sort((a, b) => b.pnl - a.pnl);
        const bestCoin  = coinsSorted[0];
        const worstCoin = coinsSorted[coinsSorted.length - 1];

        // Top 3 lãi và top 3 lỗ
        const topWins   = [...wins].sort((a, b) => b.pnl.pnlUsdt - a.pnl.pnlUsdt).slice(0, 3);
        const topLosses = [...losses].sort((a, b) => a.pnl.pnlUsdt - b.pnl.pnlUsdt).slice(0, 3);

        return (
          <div style={{ marginTop: 20, marginBottom: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--muted)", textTransform: "uppercase", paddingLeft: 2, marginBottom: 8 }}>
              Tổng kết tín hiệu bỏ qua
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>

              {/* ── Tổng quan ── */}
              <div style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", color: "var(--muted)", textTransform: "uppercase" }}>
                  Mô phỏng nếu vào hết
                </div>
                {/* Tổng PnL */}
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "var(--font-mono)", color: simTotalColor, lineHeight: 1, letterSpacing: "-0.02em" }}>
                    {simTotal >= 0 ? "+" : ""}{simTotal.toFixed(2)}<span style={{ fontSize: 14, fontWeight: 600 }}>$</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--green)", fontWeight: 700 }}>{wins.length}W</span>
                    {" / "}
                    <span style={{ color: "var(--red)", fontWeight: 700 }}>{losses.length}L</span>
                    {" / "}
                    <span style={{ color: "var(--muted)" }}>{recent.length - withPnl.length} chưa có giá</span>
                  </div>
                </div>
                {/* Win rate bar */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>Win rate (mô phỏng)</span>
                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 700, color: winRate >= 50 ? "var(--green)" : "var(--red)" }}>{winRate}%</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 3, background: "rgba(255,255,255,0.07)" }}>
                    <div style={{ height: "100%", borderRadius: 3, width: `${winRate}%`, background: winRate >= 50 ? "var(--green)" : "var(--red)", transition: "width 0.4s" }} />
                  </div>
                </div>
                {/* Best / Worst coin mini */}
                {coinsSorted.length > 0 && (
                  <div style={{ display: "flex", gap: 8 }}>
                    {bestCoin && (
                      <div style={{ flex: 1, background: "rgba(74,222,128,0.07)", border: "1px solid rgba(74,222,128,0.14)", borderRadius: 6, padding: "6px 8px" }}>
                        <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Win nhất</div>
                        <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--green)", lineHeight: 1.1 }}>+{bestCoin.pnl.toFixed(2)}<span style={{ fontSize: 10 }}>$</span></div>
                        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{bestCoin.sym} · {bestCoin.w}W/{bestCoin.l}L</div>
                      </div>
                    )}
                    {worstCoin && worstCoin.sym !== bestCoin?.sym && (
                      <div style={{ flex: 1, background: "rgba(242,54,69,0.07)", border: "1px solid rgba(242,54,69,0.14)", borderRadius: 6, padding: "6px 8px" }}>
                        <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Lỗ nhất</div>
                        <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--red)", lineHeight: 1.1 }}>{worstCoin.pnl.toFixed(2)}<span style={{ fontSize: 10 }}>$</span></div>
                        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{worstCoin.sym} · {worstCoin.w}W/{worstCoin.l}L</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Từ chối nhưng LÃI ── */}
              <div style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(74,222,128,0.18)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", color: "var(--green)", textTransform: "uppercase" }}>Bỏ qua nhưng lãi</span>
                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)", marginLeft: "auto" }}>{wins.length} lệnh</span>
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)", paddingLeft: 2 }}>Những setup bot từ chối nhưng thực tế giá đi đúng hướng — cơ hội bị bỏ lỡ.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {wins.length === 0 && <div style={{ color: "var(--muted)", fontSize: 11, padding: "4px 0" }}>Không có</div>}
                  {topWins.map(({ sig, pnl }) => (
                    <div key={sig.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 5, background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.1)" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 48 }}>{sig.symbol.replace(/USDT$/, "")}</span>
                      <span style={{ fontSize: 9, color: "var(--muted)", background: "rgba(255,255,255,0.05)", borderRadius: 3, padding: "1px 4px" }}>{sig.timeframe}</span>
                      <span style={{ fontSize: 9, color: sig.direction === "BULLISH" ? "var(--green)" : "var(--red)" }}>{sig.direction === "BULLISH" ? "▲" : "▼"}</span>
                      <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>score {sig.decisionScore ?? "—"}</span>
                      <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--green)" }}>+{pnl.pnlUsdt.toFixed(2)}$</span>
                    </div>
                  ))}
                  {wins.length > 3 && (
                    <div style={{ fontSize: 10, color: "var(--muted)", paddingLeft: 4 }}>... và {wins.length - 3} lệnh khác</div>
                  )}
                </div>
                {wins.length > 0 && (
                  <div style={{ marginTop: "auto", paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>Tổng bỏ lỡ</span>
                    <span style={{ fontSize: 13, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--green)" }}>
                      +{wins.reduce((s, x) => s + x.pnl.pnlUsdt, 0).toFixed(2)}$
                    </span>
                  </div>
                )}
              </div>

              {/* ── Từ chối đúng (LỖ) / Theo coin ── */}
              <div style={{ background: "rgba(0,0,0,0.25)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#666", flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.09em", color: "var(--muted)", textTransform: "uppercase" }}>Bot từ chối đúng (lỗ)</span>
                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted)", marginLeft: "auto" }}>{losses.length} lệnh</span>
                </div>
                {/* Top 3 worst miss */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {losses.length === 0 && <div style={{ color: "var(--muted)", fontSize: 11, padding: "4px 0" }}>Không có</div>}
                  {topLosses.map(({ sig, pnl }) => (
                    <div key={sig.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 5, background: "rgba(242,54,69,0.05)", border: "1px solid rgba(242,54,69,0.1)" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 48 }}>{sig.symbol.replace(/USDT$/, "")}</span>
                      <span style={{ fontSize: 9, color: "var(--muted)", background: "rgba(255,255,255,0.05)", borderRadius: 3, padding: "1px 4px" }}>{sig.timeframe}</span>
                      <span style={{ fontSize: 9, color: sig.direction === "BULLISH" ? "var(--green)" : "var(--red)" }}>{sig.direction === "BULLISH" ? "▲" : "▼"}</span>
                      <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: "auto" }}>score {sig.decisionScore ?? "—"}</span>
                      <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--red)" }}>{pnl.pnlUsdt.toFixed(2)}$</span>
                    </div>
                  ))}
                  {losses.length > 3 && (
                    <div style={{ fontSize: 10, color: "var(--muted)", paddingLeft: 4 }}>... và {losses.length - 3} lệnh khác</div>
                  )}
                </div>
                {/* Theo coin mini-table */}
                {coinsSorted.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 5 }}>PnL mô phỏng theo coin</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {coinsSorted.map(c => (
                        <div key={c.sym} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", minWidth: 46 }}>{c.sym}</span>
                          <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                            <span style={{ color: "var(--green)" }}>{c.w}W</span>/<span style={{ color: "var(--red)" }}>{c.l}L</span>
                          </span>
                          {/* mini bar */}
                          <div style={{ flex: 1, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 2,
                              width: `${Math.min(100, Math.abs(c.pnl) / Math.max(...coinsSorted.map(x => Math.abs(x.pnl)), 0.01) * 100)}%`,
                              background: c.pnl >= 0 ? "var(--green)" : "var(--red)"
                            }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 800, fontFamily: "var(--font-mono)", color: c.pnl >= 0 ? "var(--green)" : "var(--red)", minWidth: 56, textAlign: "right" }}>
                            {c.pnl >= 0 ? "+" : ""}{c.pnl.toFixed(2)}$
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── BẢNG TRẠNG THÁI CHIẾN LƯỢC TỪNG COIN ────────────── */}
      {Object.keys(coinStatusMap).length > 0 && (() => {
        const isSmcMode = cfg?.strategyMode === "smc";
        const strategyName = isSmcMode ? "SMC" : cfg?.strategyMode === "wyckoff" ? "Wyckoff" : "Tổng hợp";

        const smcTermLabel = (alert: string) => {
          if (/CHoCH/i.test(alert)) return "CHoCH";
          if (/BOS/i.test(alert)) return "BOS";
          if (/OrderBlock|OB/i.test(alert)) return "Order Block";
          if (/FairValueGap|FVG/i.test(alert)) return "FVG";
          if (/equalHighs|EQH/i.test(alert)) return "EQH";
          if (/equalLows|EQL/i.test(alert)) return "EQL";
          return "SMC";
        };

        const smcAlertVi = (alert: string) => {
          const scope = /swing/i.test(alert) ? "Swing" : /internal/i.test(alert) ? "Internal" : "SMC";
          const direction = /Bullish/i.test(alert) ? "tăng" : /Bearish/i.test(alert) ? "giảm" : "";
          const term = smcTermLabel(alert);
          if (term === "Order Block") return `${scope} OB breakout ${direction}`.trim();
          if (term === "FVG") return /bullish/i.test(alert) ? "Bullish FVG" : /bearish/i.test(alert) ? "Bearish FVG" : "FVG";
          if (term === "EQH" || term === "EQL") return term;
          return `${scope} ${term} ${direction}`.trim();
        };

        const parseSmcStatus = (sig: MarketSignal) => {
          const r = sig.reason ?? "";
          if (r.includes("ICT_SMC")) {
            const setup = (r.match(/ICT_SMC\s+([^;]+)/)?.[1] ?? "WAIT").trim();
            const bias = (r.match(/bias=([^;]+)/)?.[1] ?? "neutral").trim();
            const htf = (r.match(/HTF=([^;]+)/)?.[1] ?? "").trim();
            const mtf = (r.match(/MTF=([^;]+)/)?.[1] ?? "").trim();
            const ltf = (r.match(/LTF=([^;]+)/)?.[1] ?? "").trim();
            const rr2 = (r.match(/RR2=([^;]+)/)?.[1] ?? "").trim();
            const isActionable = sig.signal === "LONG" || sig.signal === "SHORT";
            const term = setup === "WAIT" ? "SMC" : setup.replaceAll("_", " ");
            const lastEvent = isActionable ? "Sweep → MSS → FVG" : "Chờ đủ chuỗi";
            const trigger = isActionable
              ? `FVG entry ${sig.signal} (${rr2 || "RR n/a"})`
              : "Chờ Sweep/MSS/FVG";
            const tfText = [htf && `HTF ${htf}`, mtf && `MTF ${mtf}`, ltf && `LTF ${ltf}`].filter(Boolean).join(", ");
            const reason = isActionable
              ? `${sig.signal} vì đã có sweep thanh khoản, MSS và FVG; bias=${bias}; ${tfText}.`
              : `Chưa vào lệnh: ${r.replace(/^ICT_SMC WAIT;\s*/, "").slice(0, 180)}`;
            return { term, lastEvent, trigger, reason, isActionable };
          }
          const mappedAlert = (r.match(/mappedAlert=([^;]+)/)?.[1] ?? "").trim();
          const activeAlerts = (r.match(/activeAlerts=([^;]+)/)?.[1] ?? "").trim();
          const eventText = (r.match(/events=([^;]+)/)?.[1] ?? "").trim();
          const internalTrend = (r.match(/internalTrend=([^;]+)/)?.[1] ?? "neutral").trim();
          const swingTrend = (r.match(/swingTrend=([^;]+)/)?.[1] ?? "neutral").trim();
          const alert = mappedAlert || activeAlerts.split(",").find(Boolean) || "";
          const isActionable = sig.signal === "LONG" || sig.signal === "SHORT";
          const term = alert ? smcTermLabel(alert) : eventText.includes("OB_BREAK") ? "Order Block" : eventText.includes("FVG") ? "FVG" : "—";
          const lastEvent = alert ? smcAlertVi(alert) : eventText && eventText !== "none" ? eventText.split("|")[0] : "—";
          const trigger = isActionable
            ? `${smcAlertVi(alert || term)} → ${sig.signal}`
            : eventText.includes("EQH") || eventText.includes("EQL")
              ? "Chờ sweep thanh khoản"
              : "Chờ BOS/CHoCH";
          const reason = isActionable
            ? `${sig.signal} vì ${lastEvent}; internal=${internalTrend}, swing=${swingTrend}; entry theo close nến đã đóng.`
            : `Chưa vào lệnh: chưa có alert SMC đủ mạnh. internal=${internalTrend}, swing=${swingTrend}.`;
          return { term, lastEvent, trigger, reason, isActionable };
        };

        const parseWyckoffStatus = (sig: MarketSignal) => {
          const r = sig.reason ?? "";
          const boxM = r.match(/box=(\w+)/);
          const boxType = boxM ? boxM[1] : "?";
          const evM = r.match(/lastSignal=([A-Z_]+)@/);
          const lastEvent = evM ? evM[1] : "—";
          const isActionable = sig.signal === "LONG" || sig.signal === "SHORT";
          let trigger = "—";
          if (isActionable) trigger = sig.signal === "LONG" ? "BREAKOUT/RETEST" : "BREAKDOWN/RETEST";
          else if (r.includes("chưa breakdown") || r.includes("chưa breakout")) trigger = "Chờ phá vỡ";
          else if (r.includes("thiếu SC") || r.includes("thiếu BC") || r.includes("thiếu AR") || r.includes("Chưa có")) trigger = "Chờ events";
          else if (r.includes("SPRING")) trigger = "Spring ✓";
          else if (r.includes("UPTHRUST")) trigger = "Upthrust ✓";
          else trigger = "Chờ events";
          const reason = isActionable
            ? `${sig.signal === "LONG" ? "Breakout/retest vùng Accumulation" : "Breakdown/retest vùng Distribution"}.`
            : "Chưa đủ event/trigger Wyckoff để vào lệnh.";
          return { boxType, lastEvent, trigger, reason, isActionable };
        };

        const TERM_COLOR: Record<string, string> = {
          Accumulation: "#12d18e",
          Distribution: "#ff4f68",
          Unknown: "#7390a8",
          BOS: "#38bdf8",
          CHoCH: "#f5c84b",
          "Order Block": "#00e5cc",
          FVG: "#a78bfa",
          EQH: "#f5c84b",
          EQL: "#00e5cc",
          "SWEEP MSS FVG": "#00e5cc",
          "INVERSION FVG": "#a78bfa",
          AMD: "#f5c84b",
          CRT: "#38bdf8",
          CISD: "#ff4f68",
          SMC: "#7390a8"
        };
        const watchList = symbols.length > 0 ? symbols : Object.keys(coinStatusMap);
        const visibleWatchList = watchList.slice(0, visibleStrategyRows);
        const headers = isSmcMode
          ? ["Coin", "Live", "Thuật ngữ SMC", "Alert / Structure", "Trigger vào lệnh", "Lý do vào lệnh", "Kết quả", "Conf"]
          : ["Coin", "Live", "Box", "Sự kiện cuối", "Trigger", "Lý do vào lệnh", "Kết quả", "Conf"];

        return (
          <div style={{ margin: "14px 0 10px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--muted)", textTransform: "uppercase", marginBottom: 8 }}>
              ◉ Trạng thái chiến lược {strategyName} — hiển thị {Math.min(visibleStrategyRows, watchList.length)}/{watchList.length} coin đang quét
            </div>
            {liveChartSymbol && (
              <LiveStrategyChart
                symbol={liveChartSymbol}
                signal={coinStatusMap[liveChartSymbol]}
                points={liveChartPoints[liveChartSymbol] ?? []}
                loading={liveChartLoading}
                onClose={() => setLiveChartSymbol(null)}
              />
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                    {headers.map(h => (
                      <th key={h} style={{ padding: "4px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleWatchList.map(sym => {
                    const sig = coinStatusMap[sym];
                    if (!sig) return null;
                    const smcStatus = parseSmcStatus(sig);
                    const wyckoffStatus = parseWyckoffStatus(sig);
                    const term = isSmcMode ? smcStatus.term : wyckoffStatus.boxType;
                    const lastEvent = isSmcMode ? smcStatus.lastEvent : wyckoffStatus.lastEvent;
                    const trigger = isSmcMode ? smcStatus.trigger : wyckoffStatus.trigger;
                    const reason = isSmcMode ? smcStatus.reason : wyckoffStatus.reason;
                    const isActionable = isSmcMode ? smcStatus.isActionable : wyckoffStatus.isActionable;
                    const resultColor = sig.signal === "LONG" ? "#12d18e" : sig.signal === "SHORT" ? "#ff4f68" : "var(--muted)";
                    const rowBg = isActionable ? "rgba(255,255,255,0.04)" : "transparent";
                    return (
                      <tr key={sym} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: rowBg }}>
                        <td style={{ padding: "5px 8px", fontWeight: 700, color: "#e0eaf5" }}>
                          {sym.replace("USDT","")}
                        </td>
                        <td style={{ padding: "5px 8px" }}>
                          <button
                            onClick={() => setLiveChartSymbol(current => current === sym ? null : sym)}
                            className={liveChartSymbol === sym ? "live-mini-button active" : "live-mini-button"}
                            title={`Mở chart live ${sym}`}
                          >
                            LIVE
                          </button>
                        </td>
                        <td style={{ padding: "5px 8px" }}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                            color: TERM_COLOR[term] ?? "#7390a8",
                            border: `1px solid ${TERM_COLOR[term] ?? "#7390a8"}`,
                            opacity: 0.9
                          }}>{term}</span>
                        </td>
                        <td style={{ padding: "5px 8px", color: "#8ba8bf" }}>{lastEvent}</td>
                        <td style={{ padding: "5px 8px", color: isActionable ? "#12d18e" : "#6a8aa0" }}>
                          {isActionable ? "✓ " : ""}{trigger}
                        </td>
                        <td style={{ padding: "5px 8px", color: isActionable ? "#c8dff0" : "#6a8aa0", maxWidth: 460, whiteSpace: "normal", lineHeight: 1.35 }}>
                          {reason}
                        </td>
                        <td style={{ padding: "5px 8px" }}>
                          <span style={{
                            fontWeight: 800, fontSize: 11,
                            color: resultColor,
                            padding: isActionable ? "2px 7px" : undefined,
                            borderRadius: isActionable ? 4 : undefined,
                            background: isActionable ? (sig.signal === "LONG" ? "rgba(18,209,142,0.12)" : "rgba(255,79,104,0.12)") : undefined,
                            border: isActionable ? `1px solid ${resultColor}` : undefined,
                          }}>{sig.signal}</span>
                        </td>
                        <td style={{ padding: "5px 8px", color: sig.confidence >= 60 ? "#f5c84b" : "var(--muted)" }}>
                          {sig.confidence}/100
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {watchList.length > visibleStrategyRows && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
                <button onClick={() => setVisibleStrategyRows((count) => Math.min(count + 10, watchList.length))}>
                  Xem thêm 10 coin ({Math.min(visibleStrategyRows, watchList.length)}/{watchList.length})
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── LỊCH SỬ 3 CỘT ───────────────────────────────── */}
      {(recent.length > 0 || realTrades.length > 0) && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <div className="sectionTitle" style={{ marginBottom: 0 }}>Lịch sử tín hiệu</div>
            <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{recent.length + realTrades.length} signal</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {/* ── LONG bỏ qua ── */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 6, paddingLeft: 4 }}>
                ▲ LONG ({recentLongs.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {recentLongs.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 4px" }}>Chưa có</div>}
                {recentLongs.map(sig => <SFPHistoryCard key={sig.id} sig={sig} pnl={calcPnl(sig)} fmtPrice={fmtPrice} fmtUsdt={fmtUsdt} fmtPct={fmtPct} expandedId={expandedId} setExpandedId={setExpandedId} onChartClick={openSignalChart} onLiveChart={(id) => void ensureSignalChart(id)} chartLoading={Boolean(chartLoadingIds[sig.id])} />)}
              </div>
            </div>
            {/* ── SHORT bỏ qua ── */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--red)", letterSpacing: "0.08em", marginBottom: 6, paddingLeft: 4 }}>
                ▼ SHORT ({recentShorts.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {recentShorts.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 4px" }}>Chưa có</div>}
                {recentShorts.map(sig => <SFPHistoryCard key={sig.id} sig={sig} pnl={calcPnl(sig)} fmtPrice={fmtPrice} fmtUsdt={fmtUsdt} fmtPct={fmtPct} expandedId={expandedId} setExpandedId={setExpandedId} onChartClick={openSignalChart} onLiveChart={(id) => void ensureSignalChart(id)} chartLoading={Boolean(chartLoadingIds[sig.id])} />)}
              </div>
            </div>
            {/* ── LỆNH THẬT ── */}
            <div>
              {/* Header + tổng kết */}
              {(() => {
                const realRows = realTrades
                  .map(sig => ({ sig, pnl: calcPnl(sig) }))
                  .filter(row => row.pnl !== null) as Array<{ sig: SFPSignalRecord; pnl: PnlResult }>;
                const closedRT = realTrades.filter(s => s.status === "tp_hit" || s.status === "sl_hit");
                const openRT = realTrades.filter(s => s.status === "executed").length;
                const totalPnl = realRows.reduce((sum, row) => sum + row.pnl.pnlUsdt, 0);
                const wins = closedRT.filter(s => (s.realizedPnlUsdt ?? 0) > 0).length;
                const losses = closedRT.length - wins;
                const winRate = closedRT.length > 0 ? Math.round(wins / closedRT.length * 100) : 0;
                const pnlColor = totalPnl >= 0 ? "var(--green)" : "var(--red)";
                const coinPnl: Record<string, number> = {};
                for (const { sig, pnl } of realRows) { coinPnl[sig.symbol] = (coinPnl[sig.symbol] ?? 0) + pnl.pnlUsdt; }
                const coinsSorted = Object.entries(coinPnl).sort((a, b) => b[1] - a[1]);
                const bestCoin = coinsSorted[0];
                const worstCoin = coinsSorted[coinsSorted.length - 1];
                const tfStats: Record<string, { pnl: number; w: number; n: number }> = {};
                for (const { sig, pnl } of realRows) {
                  if (!tfStats[sig.timeframe]) tfStats[sig.timeframe] = { pnl: 0, w: 0, n: 0 };
                  tfStats[sig.timeframe].pnl += pnl.pnlUsdt;
                  tfStats[sig.timeframe].n++;
                  if (pnl.pnlUsdt > 0) tfStats[sig.timeframe].w++;
                }
                const tfSorted = Object.entries(tfStats).sort((a, b) => b[1].pnl - a[1].pnl);
                return (
                  <>
                    {/* Tiêu đề cột */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: realRows.length > 0 ? 8 : 6, paddingLeft: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#e2b754", letterSpacing: "0.08em" }}>
                        ◆ LỆNH THẬT ({realTrades.length})
                      </div>
                      {realRows.length > 0 && (
                        <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 700, color: pnlColor }}>
                          {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} $
                        </span>
                      )}
                    </div>
                    {/* Summary box */}
                    {realRows.length > 0 && (
                      <div style={{
                        background: "rgba(226,183,84,0.06)",
                        border: "1px solid rgba(226,183,84,0.18)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        marginBottom: 8,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8
                      }}>
                        {/* Tổng PnL to */}
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ fontSize: 30, fontWeight: 800, fontFamily: "var(--font-mono)", color: pnlColor, lineHeight: 1, letterSpacing: "-0.02em" }}>
                            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)}<span style={{ fontSize: 16, fontWeight: 600 }}>$</span>
                          </span>
                          <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--muted)" }}>
                            <span style={{ color: "var(--green)", fontWeight: 700 }}>{wins}W</span>
                            {" / "}
                            <span style={{ color: "var(--red)", fontWeight: 700 }}>{losses}L</span>
                            {openRT > 0 ? <>{" · "}<span style={{ color: "var(--muted)" }}>{openRT} mở</span></> : null}
                            {" · "}
                            <span style={{ color: winRate >= 50 ? "var(--green)" : "var(--muted)" }}>{winRate}%</span>
                          </span>
                        </div>
                        {/* Coin lãi/lỗ nhiều nhất */}
                        {(bestCoin || (worstCoin && worstCoin[0] !== bestCoin?.[0])) && (
                          <div style={{ display: "flex", gap: 12 }}>
                            {bestCoin && (
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 1 }}>Lãi nhiều nhất</div>
                                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--green)", lineHeight: 1 }}>
                                  +{bestCoin[1].toFixed(2)}<span style={{ fontSize: 11 }}>$</span>
                                </div>
                                <div style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.05em" }}>{bestCoin[0].replace(/USDT$/, "")}</div>
                              </div>
                            )}
                            {worstCoin && worstCoin[0] !== bestCoin?.[0] && (
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 1 }}>Lỗ nhiều nhất</div>
                                <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono)", color: "var(--red)", lineHeight: 1 }}>
                                  {worstCoin[1].toFixed(2)}<span style={{ fontSize: 11 }}>$</span>
                                </div>
                                <div style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.05em" }}>{worstCoin[0].replace(/USDT$/, "")}</div>
                              </div>
                            )}
                          </div>
                        )}
                        {/* Theo coin (tất cả) */}
                        {coinsSorted.length > 0 && (
                          <div>
                            <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 4 }}>Theo coin</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              {coinsSorted.map(([sym, pnl]) => (
                                <div key={sym} style={{ display: "flex", justifyContent: "space-between" }}>
                                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{sym.replace(/USDT$/, "")}</span>
                                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", color: pnl >= 0 ? "var(--green)" : "var(--red)" }}>
                                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}$
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Theo khung TG */}
                        {tfSorted.length > 0 && (
                          <div>
                            <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 4 }}>Theo khung TG</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {tfSorted.map(([tf, stat]) => (
                                <div key={tf} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: "#e2b754" }}>{tf}</span>
                                  <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                                    {stat.w}W/{stat.n - stat.w}L
                                  </span>
                                  <span style={{ fontSize: 14, fontWeight: 800, fontFamily: "var(--font-mono)", color: stat.pnl >= 0 ? "var(--green)" : "var(--red)" }}>
                                    {stat.pnl >= 0 ? "+" : ""}{stat.pnl.toFixed(2)}$
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {realTrades.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12, padding: "8px 4px" }}>Chưa có lệnh nào khớp</div>}
                {realTrades.map(sig => <SFPHistoryCard key={sig.id} sig={sig} pnl={calcPnl(sig)} fmtPrice={fmtPrice} fmtUsdt={fmtUsdt} fmtPct={fmtPct} expandedId={expandedId} setExpandedId={setExpandedId} onChartClick={openSignalChart} onLiveChart={(id) => void ensureSignalChart(id)} chartLoading={Boolean(chartLoadingIds[sig.id])} />)}
              </div>
            </div>
          </div>
        </div>
      )}

      {pending.length === 0 && recent.length === 0 && realTrades.length === 0 && (
        <div className="empty" style={{ marginTop: 24 }}>Chưa có tín hiệu nào. Bấm "Quét ngay" để kiểm tra.</div>
      )}
    </section>
  );
}

function inferPositionLeverage(row: Row, fallback = 1): number {
  const explicit = Number(row.leverage ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return normalizeLeverage(explicit);

  const amount = Math.abs(Number(row.positionAmt ?? 0));
  const mark = Number(row.markPrice ?? 0);
  const notional =
    Math.abs(Number(row.notional ?? 0)) ||
    (amount > 0 && mark > 0 ? amount * mark : 0);
  const initialMargin =
    Number(row.initialMargin ?? 0) ||
    Number(row.positionInitialMargin ?? 0) ||
    Number(row.isolatedMargin ?? 0);

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

function PositionCard({ row, openOrders = [], onClose }: { row: Row; openOrders?: Row[]; onClose?: (symbol: string) => void }) {
  const symbol = String(row.symbol ?? "");
  const amt = Number(row.positionAmt ?? 0);
  const entry = Number(row.entryPrice ?? 0);
  const mark = Number(row.markPrice ?? 0);
  const pnl = Number(row.unRealizedProfit ?? 0);
  const liq = Number(row.liquidationPrice ?? 0);
  const lev = inferPositionLeverage(row);
  const marginType = String(row.marginType ?? "cross");
  const notional = Math.abs(Number(row.notional ?? 0)) || Math.abs(amt) * mark;
  const margin =
    Number(row.initialMargin ?? 0) ||
    Number(row.positionInitialMargin ?? 0) ||
    Number(row.isolatedMargin ?? 0) ||
    notional / Math.max(1, lev);
  const roi = margin > 0 ? (pnl / margin) * 100 : 0;
  const isLong = amt > 0;
  const pnlColor = pnl >= 0 ? "var(--color-positive)" : "var(--color-negative)";
  const dirColor = isLong ? "var(--color-positive)" : "var(--color-negative)";
  const capType = marginType.charAt(0).toUpperCase() + marginType.slice(1).toLowerCase();

  const symOrders = openOrders.filter(o => String(o.symbol ?? "") === symbol);
  const tpOrder = symOrders.find(o => /TAKE_PROFIT/i.test(String(o.type ?? "")));
  const slOrder = symOrders.find(o => /STOP/i.test(String(o.type ?? "")) && !/TAKE/i.test(String(o.type ?? "")));
  const tpPrice = tpOrder ? Number(tpOrder.stopPrice ?? 0) : 0;
  const slPrice = slOrder ? Number(slOrder.stopPrice ?? 0) : 0;

  const fmt = (n: number) => n > 0 ? n.toFixed(n < 0.1 ? 6 : n < 10 ? 4 : n < 1000 ? 3 : 2) : "–";
  const lbl = (t: string) => <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{t}</div>;
  const sep = <div style={{ height: 1, background: "#232336", margin: "12px 0" }} />;

  return (
    <div style={{
      background: "#12121e", borderRadius: 12, border: "1px solid #232336",
      padding: "16px 18px", marginBottom: 14
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
          background: isLong ? "rgba(8,153,129,0.25)" : "rgba(242,54,69,0.25)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700, color: dirColor
        }}>{isLong ? "L" : "S"}</span>
        <strong style={{ fontSize: 15 }}>{symbol}</strong>
        <span style={{ fontSize: 11, background: "#1c1c2e", padding: "2px 8px", borderRadius: 4, color: "#999" }}>Vĩnh cửu</span>
        <span style={{ fontSize: 11, background: "#1c1c2e", padding: "2px 8px", borderRadius: 4, color: "#999" }}>{capType} {lev}X</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "flex-end", gap: 2 }}>
          {[5, 8, 11, 14].map((h, i) => (
            <div key={i} style={{ width: 3, height: h, background: pnl >= 0 ? "var(--color-positive)" : "var(--color-negative)", borderRadius: 1 }} />
          ))}
        </div>
        {onClose && (
          <button
            onClick={() => onClose(symbol)}
            title="Đóng vị thế ngay"
            style={{
              background: "rgba(255,50,80,0.15)",
              border: "1px solid rgba(255,50,80,0.5)",
              borderRadius: 6,
              color: "#ff3250",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              padding: "4px 12px",
              letterSpacing: "0.04em",
              transition: "all 0.15s"
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,50,80,0.30)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,50,80,0.15)")}
          >
            ĐÓNG LỆNH
          </button>
        )}
      </div>

      {/* PNL + ROI */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: 4 }}>
        <div>
          {lbl("PNL (USDT)")}
          <strong style={{ fontSize: 22, color: pnlColor }}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(4)}</strong>
        </div>
        <div style={{ textAlign: "right" }}>
          {lbl("ROI")}
          <strong style={{ fontSize: 22, color: pnlColor }}>{roi >= 0 ? "+" : ""}{roi.toFixed(2)}%</strong>
        </div>
      </div>

      {sep}

      {/* Kích thước | Margin | Tỉ lệ ký quỹ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 4 }}>
        <div>{lbl("Kích thước(USDT) ⇌")}<strong style={{ fontSize: 15 }}>{notional.toFixed(3)}</strong></div>
        <div>{lbl("Margin (USDT)")}<strong style={{ fontSize: 15 }}>{margin.toFixed(2)}</strong></div>
        <div>{lbl("Tỉ lệ ký quỹ")}<strong style={{ fontSize: 15 }}>{(100 / lev).toFixed(2)}%</strong></div>
      </div>

      {sep}

      {/* Giá vào | Giá đánh dấu | Giá thanh lý */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
        <div>{lbl("Giá vào lệnh (USDT)")}<strong style={{ fontSize: 15 }}>{fmt(entry)}</strong></div>
        <div>{lbl("Giá đánh dấu (USDT)")}<strong style={{ fontSize: 15 }}>{fmt(mark)}</strong></div>
        <div>{lbl("Giá thanh lý (USDT)")}<strong style={{ fontSize: 15, color: "var(--color-negative)" }}>{fmt(liq)}</strong></div>
      </div>

      {/* TP/SL */}
      {(tpPrice > 0 || slPrice > 0) && (
        <>
          {sep}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <span style={{ color: "#888", fontSize: 12 }}>TP/SL vị thế</span>
            <span style={{ color: "var(--color-positive)", fontWeight: 600 }}>{tpPrice > 0 ? fmt(tpPrice) : "–"}</span>
            <span style={{ color: "#444" }}>/</span>
            <span style={{ color: "var(--color-negative)", fontWeight: 600 }}>{slPrice > 0 ? fmt(slPrice) : "–"}</span>
            <Pencil size={12} style={{ marginLeft: 4, color: "#666" }} />
          </div>
        </>
      )}
    </div>
  );
}

function PositionsPage({
  positions,
  openOrders,
  manualSymbol,
  setManualSymbol,
  onClose,
  onLoad
}: {
  positions: Row[];
  openOrders: Row[];
  manualSymbol: string;
  setManualSymbol: (value: string) => void;
  onClose: (symbol?: string) => void;
  onLoad: () => void;
}) {
  const active = positions.filter((row) => Math.abs(Number(row.positionAmt ?? 0)) > 0);
  return (
    <section className="panel full">
      <div className="panelHeader">
        <h2>Vị thế đang mở</h2>
        <button onClick={onLoad}><RefreshCw size={16} /> Làm mới</button>
      </div>

      {active.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          {active.map((row, i) => (
            <PositionCard key={i} row={row} openOrders={openOrders} onClose={(sym) => onClose(sym)} />
          ))}
        </div>
      ) : (
        <div className="empty" style={{ marginTop: 32 }}>Không có vị thế nào đang mở.</div>
      )}

      <div className="manualClose" style={{ marginTop: 16 }}>
        <input
          value={manualSymbol}
          onChange={(event) => setManualSymbol(event.target.value.toUpperCase())}
          placeholder="VD: ETHUSDT"
          aria-label="Cặp giao dịch cần đóng"
        />
        <button className="dangerButton" onClick={() => onClose(manualSymbol)}>
          <CircleStop size={16} /> Đóng vị thế thủ công
        </button>
      </div>
    </section>
  );
}

function TextField({
  label,
  value,
  onChange,
  technicalKey,
  hint,
  disabled
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  technicalKey?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`field ${disabled ? "disabled" : ""}`} title={technicalKey}>
      <span>
        {label}
        {technicalKey ? <Info size={12} /> : null}
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  technicalKey
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  technicalKey?: string;
}) {
  return (
    <label className="field" title={technicalKey}>
      <span>
        {label}
        {technicalKey ? <Info size={12} /> : null}
      </span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
    </label>
  );
}

function DataTable({ rows }: { rows: Row[] }) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 10);
  if (rows.length === 0) return <div className="empty">Chưa có dữ liệu.</div>;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>{columnLabel(key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {keys.map((key) => (
                <td key={key}>{valueText(row[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface MarketSignal {
  symbol: string;
  interval: string;
  signal: string;
  confidence: number;
  reason: string;
  price: number;
  rsi?: number;
  volumeChange?: number;
  fundingRate?: number;
  openInterest?: number;
  longShortRatio?: number;
  createdAt: string;
}

function SignalsPage() {
  const [signals,     setSignals]     = useState<MarketSignal[]>([]);
  const [sfpSignals,  setSfpSignals]  = useState<SFPSignalRecord[]>([]);
  const [watchSymbols,setWatchSymbols]= useState<string[]>([]);
  const [activeSignalFrames, setActiveSignalFrames] = useState<string[]>([]);
  const [visibleSignalRows, setVisibleSignalRows] = useState(10);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState("");

  // Convert latest SFP signals → radar blips format
  const radarBlips = sfpSignals.slice(0, 30).map(s => ({
    symbol:    s.symbol,
    direction: s.direction,
    score:     s.decisionScore ?? 0,
    decision:  s.decision ?? null
  }));

  const loadAll = async (resetVisibleRows = false) => {
    try {
      const [mktData, sfpData, cfg] = await Promise.all([
        api<MarketSignal[]>("/api/market/signals?limit=50"),
        api<SFPSignalRecord[]>("/api/sfp/signals?limit=60"),
        api<RuntimeSettings>("/api/config").catch(() => null)
      ]);
      const activeSymbols = new Set(cfg?.sfpWatchSymbols?.length ? cfg.sfpWatchSymbols : []);
      const activeFrames = cfg?.strategyMode === "smc" && cfg.smcAutoTimeframes
        ? ["15m"]
        : cfg?.sfpTimeframes?.length
          ? cfg.sfpTimeframes
          : [];
      const frameSet = new Set(activeFrames);
      const filteredMarketSignals = cfg
        ? mktData.filter(sig =>
            (activeSymbols.size === 0 || activeSymbols.has(sig.symbol)) &&
            (frameSet.size === 0 || frameSet.has(sig.interval))
          )
        : mktData;
      const filteredSfpSignals = cfg
        ? sfpData.filter(sig =>
            (activeSymbols.size === 0 || activeSymbols.has(sig.symbol)) &&
            (frameSet.size === 0 || frameSet.has(sig.timeframe))
          )
        : sfpData;
      setSignals(filteredMarketSignals);
      setSfpSignals(filteredSfpSignals);
      setActiveSignalFrames(activeFrames);
      if (resetVisibleRows) setVisibleSignalRows(10);
      if (cfg?.sfpWatchSymbols?.length) setWatchSymbols(cfg.sfpWatchSymbols);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll(true);
    const iv = setInterval(() => void loadAll(), 8_000);
    return () => clearInterval(iv);
  }, []);

  const visibleSignals = signals.slice(0, visibleSignalRows);

  // SSE: push new signals to radar immediately without waiting for poll
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data ?? "{}") as { type?: string; data?: Record<string, unknown> };
        if (p.type === "sfp.signal" && p.data) {
          const d = p.data;
          setSfpSignals(prev => {
            const fresh: SFPSignalRecord = {
              id:           Number(d.id ?? 0),
              symbol:       String(d.symbol ?? ""),
              timeframe:    String(d.timeframe ?? ""),
              direction:    (d.direction as "BULLISH"|"BEARISH") ?? "BULLISH",
              confirmed:    Boolean(d.confirmed),
              swingPrice:   Number(d.swingPrice ?? 0),
              oppositeLevel:Number(d.oppositeLevel ?? 0),
              sfpCandleHigh:Number(d.sfpCandleHigh ?? 0),
              sfpCandleLow: Number(d.sfpCandleLow ?? 0),
              entryPrice:   Number(d.entryPrice ?? 0),
              slPrice:      Number(d.slPrice ?? 0),
              tpPrice:      Number(d.tpPrice ?? 0),
              leverage:     Number(d.leverage ?? 1),
              marginUsdt:   Number(d.marginUsdt ?? 0),
              status:       (d.status as SFPSignalRecord["status"]) ?? "pending",
              message:      String(d.message ?? ""),
              decision:     (d.decision as "TRADE"|"SKIP"|undefined) ?? undefined,
              decisionScore:Number(d.decisionScore ?? 0),
              createdAt:    String(d.createdAt ?? new Date().toISOString()),
              strategy:     (d.strategy as SFPSignalRecord["strategy"]) ?? undefined,
              patternName:  d.patternName ? String(d.patternName) : undefined,
            };
            return [fresh, ...prev.slice(0, 59)];
          });
        }
      } catch { /* ignore */ }
    };
    return () => source.close();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── MILITARY RADAR ───────────────────────────────────────── */}
      <section className="panel full" style={{ padding: 0, overflow: "hidden" }}>
        <div className="panelHeader" style={{
          background: "rgba(0,20,5,0.9)",
          borderBottom: "1px solid rgba(0,255,65,0.2)",
          padding: "10px 16px",
          fontFamily: "'JetBrains Mono',monospace",
          color: "#00ff41",
          letterSpacing: "0.1em",
          fontSize: 12
        }}>
          ◈ COMBAT SCAN RADAR — SFP &amp; CANDLESTICK DETECTION SYSTEM
        </div>
        <MilitaryRadar
          watchSymbols={watchSymbols.length > 0 ? watchSymbols : ["BTCUSDT","ETHUSDT","SOLUSDT"]}
          latestSignals={radarBlips}
        />
      </section>

      {/* ── MARKET SIGNALS TABLE ─────────────────────────────────── */}
      <section className="panel full">
        <div className="panelHeader">
          <h2>Tín hiệu chiến lược mới nhất</h2>
          <button onClick={() => void loadAll(true)}>
            <RefreshCw size={16} /> Làm mới
          </button>
        </div>
        {loading && <div className="notice">Đang tải tín hiệu...</div>}
        {error   && <div className="notice error">{error}</div>}
        {!loading && !error && activeSignalFrames.length > 0 && (
          <div style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 12, fontFamily: "var(--font-mono)" }}>
            Đang lọc theo khung: {activeSignalFrames.join(", ")} · hiển thị {Math.min(visibleSignalRows, signals.length)}/{signals.length}
          </div>
        )}
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Thời gian</th><th>Cặp</th><th>Khung</th><th>Tín hiệu</th>
                <th>Tin cậy</th><th>Giá</th><th>Lý do</th>
              </tr>
            </thead>
            <tbody>
              {visibleSignals.map((sig, idx) => (
                <tr key={idx}>
                  <td style={{ fontSize: "0.72rem" }}>{new Date(sig.createdAt).toLocaleTimeString("vi-VN")}</td>
                  <td><strong>{sig.symbol}</strong></td>
                  <td><span className="badge info">{sig.interval}</span></td>
                  <td>
                    <span className={`pill ${sig.signal === "LONG" ? "positive" : sig.signal === "SHORT" ? "negative" : "neutral"}`}>
                      {sig.signal}
                    </span>
                  </td>
                  <td>
                    <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                      <span>{sig.confidence}%</span>
                      <div className="confidence" style={{ margin:0, width:70, height:3 }}>
                        <span style={{ width:`${sig.confidence}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>{sig.price.toFixed(4)}</td>
                  <td style={{ maxWidth:280, fontSize:"0.72rem", whiteSpace:"normal" }}>{sig.reason}</td>
                </tr>
              ))}
              {!loading && signals.length === 0 && (
                <tr><td colSpan={7} className="empty" style={{ textAlign:"center" }}>Chưa có tín hiệu.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {!loading && signals.length > visibleSignalRows && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
            <button onClick={() => setVisibleSignalRows((count) => Math.min(count + 10, signals.length))}>
              Xem thêm 10 dòng ({Math.min(visibleSignalRows, signals.length)}/{signals.length})
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// OrderRow is defined at the top of the file

function OrderHistoryPage() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOrders = async () => {
    try {
      const data = await api<OrderRow[]>("/api/orders/history?limit=100");
      setOrders(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOrders();
    const intervalVal = setInterval(() => void loadOrders(), 10_000);
    return () => clearInterval(intervalVal);
  }, []);

  if (loading) return <div className="notice">Đang tải lịch sử lệnh...</div>;
  if (error) return <div className="notice error">{error}</div>;

  return (
    <section className="panel full">
      <div className="panelHeader">
        <h2>Lịch sử lệnh giao dịch</h2>
        <button onClick={() => void loadOrders()}>
          <RefreshCw size={16} /> Làm mới
        </button>
      </div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Cặp giao dịch</th>
              <th>Phía</th>
              <th>Loại lệnh</th>
              <th>Khối lượng</th>
              <th>Giá vào</th>
              <th>Giá SL/TP</th>
              <th>Trạng thái</th>
              <th>Chế độ</th>
              <th>Nguồn</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((ord) => (
              <tr key={ord.id}>
                <td>{new Date(ord.created_at).toLocaleString("vi-VN")}</td>
                <td><strong>{ord.symbol}</strong></td>
                <td>
                  <span className={`pill ${ord.side === "BUY" ? "positive" : "negative"}`}>
                    {ord.side === "BUY" ? "MUA/LONG" : "BÁN/SHORT"}
                  </span>
                </td>
                <td>{ord.type}</td>
                <td>{ord.quantity}</td>
                <td>{ord.price ? `${Number(ord.price).toFixed(2)} USDT` : "-"}</td>
                <td>{ord.stop_price ? `${Number(ord.stop_price).toFixed(2)} USDT` : "-"}</td>
                <td>
                  <span className={`badge ${ord.status === "FILLED" || ord.status === "NEW" ? "safe" : ord.status === "CANCELED" ? "warn" : "danger"}`}>
                    {ord.status}
                  </span>
                </td>
                <td>
                  <span className={`badge ${ord.dry_run ? "info" : "danger"}`}>
                    {ord.dry_run ? "MÔ PHỎNG" : "LỆNH THẬT"}
                  </span>
                </td>
                <td>{ord.source}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={10} className="empty" style={{ textAlign: "center" }}>
                  Chưa có lịch sử giao dịch nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface SystemLog {
  id: number;
  level: string;
  message: string;
  context: string | null;
  created_at: string;
}

function LogsPage() {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadLogs = async () => {
    try {
      const data = await api<SystemLog[]>("/api/logs?limit=200");
      setLogs(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
    const intervalVal = setInterval(() => void loadLogs(), 5_000);
    return () => clearInterval(intervalVal);
  }, []);

  if (loading) return <div className="notice">Đang tải nhật ký...</div>;
  if (error) return <div className="notice error">{error}</div>;

  return (
    <section className="panel full">
      <div className="panelHeader">
        <h2>Nhật ký hoạt động của hệ thống</h2>
        <button onClick={() => void loadLogs()}>
          <RefreshCw size={16} /> Làm mới
        </button>
      </div>
      <div className="logTerminal">
        {logs.map((log) => {
          let contextObj = null;
          if (log.context) {
            try {
              contextObj = JSON.parse(log.context);
            } catch {
              // ignore
            }
          }
          return (
            <div className="logRow" key={log.id}>
              <span className="logTime">
                {new Date(log.created_at).toLocaleTimeString("vi-VN", { hour12: false })}
              </span>
              <span className={`logLevel ${log.level.toLowerCase()}`}>
                [{log.level}]
              </span>
              <span className="logMessage">
                {log.message}
                {contextObj && (
                  <span className="logContext">
                    {" "}- Context: {JSON.stringify(contextObj)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {logs.length === 0 && <div className="empty">Chưa có nhật ký hoạt động.</div>}
      </div>
    </section>
  );
}

