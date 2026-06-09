/**
 * Live monitor tín hiệu auto-trade
 * Chạy: node watch-signals.mjs
 * Chỉ hiển thị signal đủ điều kiện (decision=TRADE)
 */
import Database from "better-sqlite3";
import { createReadStream } from "fs";
import readline from "readline";

const DB_PATH = "./data/trader.sqlite";
const POLL_MS  = 3000; // poll DB mỗi 3 giây

// ─── màu terminal ───────────────────────────────────────────────
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const MAGENTA = "\x1b[35m";

function clr(text, color) { return color + text + R; }

// ─── helpers ────────────────────────────────────────────────────
function dirColor(d) { return d === "BULLISH" ? GREEN : RED; }
function statusColor(s) {
  if (s === "executed" || s === "tp_hit")  return GREEN;
  if (s === "sl_hit"   || s === "rejected") return RED;
  if (s === "pending"  || s === "limit_placed") return YELLOW;
  return GRAY;
}
function fmtTime(iso) {
  if (!iso) return "–";
  return iso.slice(11, 19); // HH:MM:SS
}
function fmtPnl(v) {
  if (v == null) return "";
  const n = parseFloat(v);
  if (!isFinite(n)) return "";
  return (n >= 0 ? clr("+" + n.toFixed(3), GREEN) : clr(n.toFixed(3), RED)) + " USDT";
}
function bar(score, w = 20) {
  const filled = Math.round((score / 100) * w);
  const b = "█".repeat(filled) + "░".repeat(w - filled);
  const col = score >= 80 ? GREEN : score >= 72 ? YELLOW : RED;
  return clr(b, col) + " " + score;
}

// ─── DB ─────────────────────────────────────────────────────────
let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error("Không mở được DB:", e.message);
  process.exit(1);
}

const qTrade = db.prepare(`
  SELECT id, strategy, pattern_name, symbol, timeframe, direction,
         status, decision, decision_score, message,
         entry_price, sl_price, tp_price, leverage, margin_usdt,
         has_sfp, chart_url,
         execute_after, created_at, closed_at, realized_pnl_usdt
  FROM sfp_signals
  WHERE decision = 'TRADE'
    AND id > ?
  ORDER BY id ASC
  LIMIT 50
`);

const qStats = db.prepare(`
  SELECT
    COUNT(*) FILTER (WHERE status='tp_hit')  AS wins,
    COUNT(*) FILTER (WHERE status='sl_hit')  AS losses,
    COUNT(*) FILTER (WHERE status='pending') AS pending,
    COUNT(*) FILTER (WHERE status='executed' OR status='limit_placed') AS open,
    ROUND(SUM(realized_pnl_usdt) FILTER (WHERE status IN ('tp_hit','sl_hit')), 3) AS net_pnl
  FROM sfp_signals
`);

const qRecent = db.prepare(`
  SELECT id, strategy, pattern_name, symbol, timeframe, direction,
         status, decision_score, entry_price, sl_price, tp_price,
         created_at, realized_pnl_usdt
  FROM sfp_signals
  WHERE status IN ('tp_hit','sl_hit','executed','pending','limit_placed')
  ORDER BY id DESC LIMIT 8
`);

// ─── render ─────────────────────────────────────────────────────
let lastId = 0;
let seenIds = new Set();

// khởi tạo lastId từ max hiện tại
try {
  const row = db.prepare("SELECT MAX(id) as m FROM sfp_signals WHERE decision='TRADE'").get();
  lastId = row?.m ?? 0;
} catch {}

function renderHeader() {
  const now = new Date().toLocaleTimeString("vi-VN");
  console.clear();
  console.log(BOLD + CYAN + "═══════════════════════════════════════════════════════════════" + R);
  console.log(BOLD + "  🤖  LIVE SIGNAL MONITOR  " + GRAY + now + R);
  console.log(CYAN + "═══════════════════════════════════════════════════════════════" + R);
}

function renderStats() {
  const s = qStats.get();
  const total = (s.wins || 0) + (s.losses || 0);
  const wr = total > 0 ? ((s.wins / total) * 100).toFixed(1) : "–";
  console.log(
    BOLD + "  Thống kê: " + R +
    clr("✓ " + (s.wins||0) + " TP", GREEN) + "  " +
    clr("✗ " + (s.losses||0) + " SL", RED) + "  " +
    clr("WR " + wr + "%", YELLOW) + "  " +
    "Net: " + fmtPnl(s.net_pnl) + "  " +
    clr("⏳ " + (s.pending||0) + " pending", YELLOW) + "  " +
    clr("🔵 " + (s.open||0) + " open", CYAN)
  );
  console.log(GRAY + "  ─────────────────────────────────────────────────────────────" + R);
}

function renderRecentClosed() {
  const rows = qRecent.all();
  if (rows.length === 0) return;
  console.log(BOLD + "\n  📋  Lệnh gần nhất:" + R);
  for (const r of rows) {
    const name = (r.pattern_name || r.strategy).padEnd(24);
    const sym  = r.symbol.padEnd(12);
    const dir  = clr(r.direction.padEnd(8), dirColor(r.direction));
    const st   = clr(r.status.padEnd(13), statusColor(r.status));
    const sc   = String(r.decision_score || 0).padStart(3);
    const pnl  = fmtPnl(r.realized_pnl_usdt);
    const t    = GRAY + fmtTime(r.created_at) + R;
    console.log(`  [#${r.id}] ${name} ${sym} ${dir} ${st} s=${sc}  ${pnl}  ${t}`);
  }
}

function renderNewSignals(signals) {
  if (signals.length === 0) return;
  console.log(BOLD + "\n  🆕  TÍN HIỆU MỚI ĐỦ ĐIỀU KIỆN:" + R);
  for (const s of signals) {
    const name = (s.pattern_name || s.strategy);
    const dir  = clr("● " + s.direction, dirColor(s.direction));
    const st   = clr(s.status, statusColor(s.status));
    const score = s.decision_score || 0;
    const rr   = s.tp_price && s.sl_price && s.entry_price
      ? (Math.abs(s.tp_price - s.entry_price) / Math.abs(s.sl_price - s.entry_price)).toFixed(2) + "R"
      : "–";

    console.log("\n  " + BOLD + clr("▶ #" + s.id + " " + s.symbol + " " + s.timeframe, CYAN) + R +
      "  " + dir + "  " + st);
    console.log("    " + BOLD + name + R + "  score: " + bar(score) + "  RR: " + rr);
    console.log("    SFP: " + (s.has_sfp ? clr("CO", GREEN) : clr("KHONG", YELLOW)) +
      "  chart: " + (s.chart_url ? clr(s.chart_url, CYAN) : clr("chua co", GRAY)));
    console.log("    entry: " + s.entry_price + "  SL: " + clr(s.sl_price, RED) +
      "  TP: " + clr(s.tp_price, GREEN) + "  lev: " + s.leverage + "x  margin: " + s.margin_usdt + "u");
    if (s.message) {
      console.log("    " + GRAY + s.message.slice(0, 100) + R);
    }
    if (s.execute_after) {
      const ea = new Date(s.execute_after);
      const diff = Math.max(0, Math.round((ea - Date.now()) / 1000));
      console.log("    ⏰ execute_after: " + fmtTime(s.execute_after) +
        (diff > 0 ? clr("  (còn " + diff + "s)", YELLOW) : clr("  (sẵn sàng!)", GREEN)));
    }
    console.log("    " + GRAY + fmtTime(s.created_at) + R);
  }
}

function renderNoSignal() {
  console.log("\n  " + GRAY + "⏳  Đang quét... chưa có tín hiệu mới đủ điều kiện." + R);
  console.log("  " + GRAY + "   (Bot chạy fallback scan mỗi 30s)" + R);
}

// ─── vòng lặp chính ─────────────────────────────────────────────
let newSignalBuffer = []; // giữ signal mới trong 60s để hiển thị
const KEEP_MS = 60_000;

function tick() {
  try {
    const rows = qTrade.all(lastId);
    const now = Date.now();

    for (const r of rows) {
      if (r.id > lastId) lastId = r.id;
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        newSignalBuffer.push({ ...r, addedAt: now });
      }
    }

    // Xóa signal cũ hơn 60s khỏi buffer hiển thị
    newSignalBuffer = newSignalBuffer.filter(s => now - s.addedAt < KEEP_MS);

    renderHeader();
    renderStats();
    renderRecentClosed();
    renderNewSignals(newSignalBuffer);
    if (newSignalBuffer.length === 0) renderNoSignal();

    console.log("\n" + GRAY + "  Ctrl+C để thoát  •  cập nhật mỗi " + (POLL_MS/1000) + "s" + R);
  } catch (e) {
    console.error("Lỗi poll:", e.message);
  }
}

// ─── start ──────────────────────────────────────────────────────
tick();
const interval = setInterval(tick, POLL_MS);

process.on("SIGINT", () => {
  clearInterval(interval);
  db.close();
  console.log("\n" + GRAY + "Monitor đã dừng." + R);
  process.exit(0);
});
