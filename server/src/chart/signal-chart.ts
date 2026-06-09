import fs from "node:fs/promises";
import path from "node:path";
import { staticConfig } from "../config.js";
import type { Kline, SFPSignalRecord } from "../types.js";
import {
  analyzeWyckoff,
  type WyckoffSignalType,
  type OBZone
} from "../strategy/wyckoff.js";
import {
  LuxAlgoSmcEngine,
  type Bias,
  type OrderBlockSnapshot,
  type FairValueGapSnapshot,
  type SmcEvent,
  type SmcOutput
} from "../strategy/luxalgo-smc-engine.js";

export interface SignalChartFile {
  chartPath: string;
  chartUrl: string;
}

const WIDTH = 1280;
const HEIGHT = 980;
const PAD_L = 76;
const PAD_R = 168;
const PAD_T = 92;
const PAD_B = 290;   // large bottom: time axis + volume + analysis panel
const VOL_H = 55;    // height of volume sub-chart
const VOL_GAP = 10;  // gap between price chart and volume chart

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(5);
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(Math.abs(right) * 0.000001, 1e-12);
}

function renderLine(
  label: string, price: number, color: string, y: number,
  glowId?: string, usdtAmount?: number, labelY = y
): string {
  const glow = glowId ? `filter="url(#${glowId})"` : "";
  const usdtStr = usdtAmount !== undefined
    ? (usdtAmount >= 0 ? `+$${usdtAmount.toFixed(2)}` : `-$${Math.abs(usdtAmount).toFixed(2)}`)
    : "";
  // Badge is wider when we have USDT amount
  const badgeW = usdtStr ? 188 : 148;
  const badgeH = usdtStr ? 36 : 28;
  const connector = Math.abs(labelY - y) > 2
    ? `<line x1="${WIDTH - PAD_R}" y1="${y}" x2="${WIDTH - PAD_R + 8}" y2="${labelY}" stroke="${color}" stroke-width="1" stroke-opacity="0.55"/>`
    : "";
  return `
    <line x1="${PAD_L}" y1="${y}" x2="${WIDTH - PAD_R}" y2="${y}"
          stroke="${color}" stroke-width="1.5" stroke-dasharray="10 5" ${glow} opacity="0.85"/>
    <line x1="${PAD_L}" y1="${y}" x2="${WIDTH - PAD_R}" y2="${y}"
          stroke="${color}" stroke-width="3" stroke-dasharray="10 5" opacity="0.18"/>
    ${connector}
    <rect x="${WIDTH - PAD_R + 8}" y="${labelY - 18}" width="${badgeW}" height="${badgeH}" rx="6"
          fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-opacity="0.8" stroke-width="1.5"/>
    <rect x="${WIDTH - PAD_R + 8}" y="${labelY - 18}" width="${badgeW}" height="${badgeH}" rx="6"
          fill="${color}" fill-opacity="0.06"/>
    <text x="${WIDTH - PAD_R + 19}" y="${labelY - 3}"
          fill="${color}" font-size="13" font-weight="800"
          font-family="monospace">${escapeXml(label)}  ${escapeXml(fmtPrice(price))}</text>
    ${usdtStr ? `<text x="${WIDTH - PAD_R + 19}" y="${labelY + 14}"
          fill="${color}" font-size="12" font-weight="700" font-family="monospace"
          fill-opacity="0.85">${escapeXml(usdtStr)}</text>` : ""}`;
}

// SVG filter defs for glow effects on TP/SL lines
const GLOW_DEFS = `
  <defs>
    <style>
      @keyframes rejectPulse {
        0%, 100% { opacity: 0.86; }
        50% { opacity: 1; }
      }
      @keyframes rejectGlow {
        0%, 100% { opacity: 0.22; }
        50% { opacity: 0.44; }
      }
      .reject-pulse { animation: rejectPulse 1.1s ease-in-out infinite; }
      .reject-glow { animation: rejectGlow 1.1s ease-in-out infinite; }
    </style>
    <filter id="glowGreen" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glowRed" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glowBlue" x="-20%" y="-100%" width="140%" height="300%">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="glowGold" x="-30%" y="-120%" width="160%" height="340%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

// Wrap long text into multiple tspan lines
function wrapText(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  fontSize = 12,
  maxLines = 3
): string {
  const approxCharWidth = fontSize * 0.6;
  const charsPerLine = Math.floor(maxWidth / approxCharWidth);
  const words = text.split(/;\s*/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur}; ${word}` : word;
    if (next.length > charsPerLine && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
    if (lines.length >= maxLines - 1) { cur = `${cur}…`; break; }
  }
  if (cur) lines.push(cur);

  const tspans = lines
    .slice(0, maxLines)
    .map((line, i) =>
      `<tspan x="${x}" dy="${i === 0 ? 0 : fontSize + 3}">${escapeXml(line)}</tspan>`
    )
    .join("");
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${fontSize}">${tspans}</text>`;
}

function compactRejectReason(signal: SFPSignalRecord): string {
  const raw = (signal.message || signal.decisionSummary || "Khong ro ly do").trim();
  if (/SL qu[aá]\s*xa|SL xa|hit SL|m[aấ]t .*k[yý]\s*qu[yỹ]|mat .*ky quy|risk distance/i.test(raw)) {
    return "SL qua xa - rui ro lo vuot gioi han";
  }
  if (/tu choi boi nguoi dung|từ chối bởi người dùng|bo qua|bỏ qua/i.test(raw)) {
    return "Bị bỏ qua hoặc từ chối thủ công";
  }
  if (/khong khop|không khớp|LIMIT order/i.test(raw)) {
    return "LIMIT chưa khớp, bot đã hủy - không có vị thế thật";
  }
  if (/khong du|không đủ|so du|số dư|available/i.test(raw)) {
    return "Số dư không đủ margin/buffer phí";
  }
  if (/MAX_OPEN_POSITIONS|slot|so vi the mo|s[oố] v[iị] th[eế] m[oở]|max open positions/i.test(raw)) {
    return "Đã đủ số slot lệnh đang chạy";
  }
  if (/trung setup|trùng setup|trung symbol|trùng symbol|da co vi the|đã có vị thế/i.test(raw)) {
    return "Đã có vị thế/setup trùng, không mở thêm";
  }
  if (/notional|no smaller than 5/i.test(raw)) {
    return "Notional nhỏ hơn mức tối thiểu Binance";
  }
  if (/RR|Risk\/Reward|SL xa/i.test(raw)) {
    return "RR/SL không đạt điều kiện rủi ro";
  }
  if (/TP\/SL|TAKE_PROFIT_MARKET|STOP_MARKET/i.test(raw)) {
    return "TP/SL không hợp lệ tại thời điểm đặt lệnh";
  }
  if (/-4120|Order type not supported|Algo Order API|algoOrder/i.test(raw)) {
    return "Trailing stop cần Binance Algo Order API";
  }
  return raw.replace(/\s+/g, " ").slice(0, 96);
}

function isRelaxedSmcSignal(signal: SFPSignalRecord): boolean {
  if (signal.strategy !== "smc") return false;
  const details = JSON.stringify(signal.decisionDetails ?? "");
  const text = `${signal.message ?? ""}; ${signal.decisionSummary ?? ""}; ${details}`;
  return /Relaxed RR\/TP|TP trigger ROI|SMC relaxed|Relaxed RRTP/i.test(text);
}

function wrapRejectReason(reason: string): string[] {
  const words = reason.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > 54 && cur) {
      lines.push(cur);
      cur = word;
      if (lines.length >= 1) break;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2);
}

function stackTradeLineLabels(
  items: Array<{ key: "entry" | "tp" | "sl"; y: number }>,
  top: number,
  bottom: number
): Record<"entry" | "tp" | "sl", number> {
  const gap = 42;
  const sorted = [...items].sort((left, right) => left.y - right.y);
  const labelTop = top + 18;
  const labelBottom = bottom - 18;
  let prev = labelTop - gap;
  for (const item of sorted) {
    item.y = Math.min(labelBottom, Math.max(labelTop, item.y, prev + gap));
    prev = item.y;
  }
  for (let i = sorted.length - 2; i >= 0; i -= 1) {
    sorted[i].y = Math.min(sorted[i].y, sorted[i + 1].y - gap);
    sorted[i].y = Math.max(labelTop, sorted[i].y);
  }
  return Object.fromEntries(sorted.map(item => [item.key, item.y])) as Record<"entry" | "tp" | "sl", number>;
}

function buildRejectedNarrative(signal: SFPSignalRecord): string[] {
  const raw = (signal.message || signal.decisionSummary || "Khong ro ly do").replace(/\s+/g, " ").trim();
  const setup = signal.patternName ?? signal.strategy ?? "signal";
  const side = signal.direction === "BULLISH" ? "LONG" : "SHORT";
  const lines = [
    `1. KET QUA: KHONG VAO LENH. Setup ${setup}; huong ${side}; score ${signal.decisionScore ?? "-"}/100.`,
    `2. LY DO CHINH: ${compactRejectReason(signal)}.`,
    `3. THONG BAO GOC: ${raw.slice(0, 190)}${raw.length > 190 ? "..." : ""}.`
  ];
  if (signal.entryPrice > 0 && signal.slPrice > 0 && signal.tpPrice > 0) {
    const riskPct = Math.abs(signal.entryPrice - signal.slPrice) / signal.entryPrice * 100;
    const targetPct = Math.abs(signal.tpPrice - signal.entryPrice) / signal.entryPrice * 100;
    lines.push(
      `4. Tham chieu: entry ${fmtPrice(signal.entryPrice)}, SL ${fmtPrice(signal.slPrice)}, TP/trigger ${fmtPrice(signal.tpPrice)}; risk ${riskPct.toFixed(2)}%, target ${targetPct.toFixed(2)}%.`
    );
  }
  lines.push("5. Hanh dong: xem ly do vang tren chart; cho setup moi hoac sua cau hinh/rui ro neu can.");
  return lines;
}

// Blocked signal: explain clearly WHY the trade couldn't be entered
function buildBlockedNarrative(signal: SFPSignalRecord): string[] {
  // Use message field too — RiskManager blocks write to message, not decisionSummary
  const summary = (signal.decisionSummary ?? "") + " " + (signal.message ?? "");
  const lines: string[] = [];
  const bullish = signal.direction === "BULLISH";
  const side = bullish ? "LONG" : "SHORT";

  // Parse blocking reason
  const riskMatch  = summary.match(/Risk distance ([\d.]+)% vượt giới hạn ([\d.]+)%/);
  const slMatch    = summary.match(/SL ([\d.]+)% × (\d+)x = mất ([\d.]+)%/);
  const liqMatch   = summary.match(/gần\/vượt vùng thanh lý/);
  const confMatch  = summary.match(/Confidence (\d+)\/100 chưa đạt ngưỡng (\d+)/);
  const rrMatch    = summary.match(/RR ([\d.]+) < ([\d.]+)/);
  const marginMatch = summary.match(/hit SL lỗ khoảng ([\d.]+) USDT/);
  const noTrigger  = summary.includes("chưa breakout") || summary.includes("chưa breakdown");
  const noEvents   = summary.includes("thiếu SC") || summary.includes("thiếu BC") || summary.includes("thiếu ST");
  const htfBlock   = summary.includes("HTF BLOCK") || summary.includes("bias");

  lines.push(`Setup: Wyckoff ${side} — Điểm ${signal.decisionScore ?? 0}/100`);

  if (rrMatch || marginMatch) {
    const rr = rrMatch ? parseFloat(rrMatch[1]) : 0;
    const loss = marginMatch ? parseFloat(marginMatch[1]) : 0;
    const slDist = signal.entryPrice > 0 && signal.slPrice > 0
      ? Math.abs(signal.slPrice - signal.entryPrice) / signal.entryPrice * 100 : 0;
    const tpDist = signal.entryPrice > 0 && signal.tpPrice > 0
      ? Math.abs(signal.tpPrice - signal.entryPrice) / signal.entryPrice * 100 : 0;
    lines.push(`❌ Lý do chặn: Risk/Reward không đạt — RR ${rr.toFixed(2)} < 1.0 tối thiểu.`);
    lines.push(`   SL cách entry ${slDist.toFixed(2)}% (mất ~$${loss.toFixed(2)}) nhưng TP chỉ cách ${tpDist.toFixed(2)}% — SL xa hơn TP.`);
    lines.push(`✅ Giải pháp: TP cần xa hơn SL. Chờ setup có OB TP ở vùng giá thuận lợi hơn.`);
  } else if (riskMatch) {
    lines.push(`❌ Lý do chặn: SL cách entry ${riskMatch[1]}% — vượt giới hạn an toàn ${riskMatch[2]}%`);
    lines.push(`   Box quá rộng. Với 20x đòn bẩy: hit SL = mất ${(parseFloat(riskMatch[1]) * 20).toFixed(0)}% margin → nguy cơ thanh lý.`);
    lines.push(`✅ Giải pháp: Chờ SPRING — giá chọc xuống box.low rồi đóng lại → SL ngắn hơn nhiều.`);
  } else if (slMatch) {
    lines.push(`❌ Lý do chặn: SL ${slMatch[1]}% × ${slMatch[2]}x = mất ${slMatch[3]}% margin — vượt ngưỡng cho phép.`);
    lines.push(`✅ Giải pháp: Chờ entry RETEST (giá về vùng box.high) để SL ngắn lại.`);
  } else if (liqMatch) {
    lines.push(`❌ Lý do chặn: SL quá gần vùng thanh lý ước tính.`);
    lines.push(`✅ Giải pháp: Giảm leverage hoặc chờ box hẹp hơn.`);
  } else if (confMatch) {
    lines.push(`❌ Lý do chặn: Điểm ${confMatch[1]}/100 chưa đạt ngưỡng tối thiểu ${confMatch[2]}/100.`);
    lines.push(`✅ Giải pháp: Chờ thêm ST/AR xác nhận để tăng điểm.`);
  } else if (noTrigger) {
    lines.push(`⏳ Lý do chờ: Cấu trúc đầy đủ nhưng giá chưa phá vỡ box để tạo trigger.`);
    lines.push(`✅ Giải pháp: Khi giá phá ${bullish ? "trên box.high" : "dưới box.low"} → bot tự vào lệnh.`);
  } else if (noEvents) {
    lines.push(`⏳ Lý do chờ: Box ${bullish ? "Accumulation" : "Distribution"} đã xác nhận nhưng thiếu events (SC/AR/ST hoặc BC/AR/ST).`);
    lines.push(`✅ Giải pháp: Chờ đủ cấu trúc SC→AR→ST trong box.`);
  } else if (htfBlock) {
    const biasMatch = summary.match(/bias="?(\w+)"?/);
    const bias = biasMatch ? biasMatch[1] : "ngược chiều";
    lines.push(`❌ Lý do chặn: H1/H4 trend đang ${bias === "bearish" ? "GIẢM" : "TĂNG"} — không vào ${side} ngược trend lớn.`);
    lines.push(`✅ Giải pháp: Chờ H4 đổi bias hoặc vào khi H4 cùng hướng.`);
  } else {
    // Fallback — parse from message field
    const msgReasons = (signal.message ?? "").split(/[;,]/).filter(Boolean).slice(0, 3);
    if (msgReasons.length > 0) lines.push(...msgReasons.map(r => `❌ ${r.trim()}`));
  }

  // Show estimated risk
  if (signal.entryPrice > 0 && signal.slPrice > 0) {
    const riskPct = Math.abs(signal.entryPrice - signal.slPrice) / signal.entryPrice * 100;
    lines.push(`📐 Entry ước tính: ${fmtPrice(signal.entryPrice)} | SL: ${fmtPrice(signal.slPrice)} | Risk: ${riskPct.toFixed(2)}% × 20x = ${(riskPct*20).toFixed(0)}% margin`);
  }

  return lines;
}

// Build rich Wyckoff trade narrative lines from signal data
function buildWyckoffNarrative(signal: SFPSignalRecord): string[] {
  const bullish  = signal.direction === "BULLISH";
  const summary  = signal.decisionSummary ?? signal.message ?? "";
  const isRetest = (signal.patternName ?? "").includes("RETEST");
  const rr       = Math.abs(signal.tpPrice - signal.entryPrice) /
                   Math.max(Math.abs(signal.entryPrice - signal.slPrice), 1e-12);
  const rsiMatch = summary.match(/RSI\s*([\d.]+)/);
  const rsi      = rsiMatch ? parseFloat(rsiMatch[1]) : null;
  const hasBC    = /BC\s*xác nhận|BC\s*có mặt/i.test(summary);
  const hasAR    = /AR_DIST|AR_ACC/i.test(summary);
  const hasST    = /ST_DIST\s*xác nhận|ST_ACC\s*xác nhận/i.test(summary);
  const volOk    = !/Volume chưa/i.test(summary);
  const lines: string[] = [];

  if (!bullish) {
    // --- SHORT / Distribution ---
    if (hasBC) lines.push(
      "① BC (Buying Climax): Giá tăng mạnh lên đỉnh kèm volume đột biến — bên bán tổ chức hấp thụ toàn bộ lực mua. Đây là tín hiệu phân phối bắt đầu."
    );
    if (hasAR) lines.push(
      "② AR_DIST (Automatic Reaction): Ngay sau BC giá rớt nhanh, xác nhận bên bán đang nắm kiểm soát và không có lực mua tiếp theo."
    );
    if (hasST) lines.push(
      "③ ST_DIST (Secondary Test): Giá hình thành 2–3 đỉnh thấp dần trong box. Mỗi lần test vùng BC đều thất bại → cấu trúc Distribution BC→AR→ST hoàn chỉnh."
    );
    if (isRetest) {
      lines.push(
        `④ RETEST: Giá đã phá xuống dưới box.low, sau đó quay lại kiểm tra vùng hỗ trợ cũ nay đã thành kháng cự tại ${fmtPrice(signal.entryPrice)}. Đây là điểm SHORT tối ưu theo Wyckoff — entry chất lượng cao, rủi ro thấp.`
      );
    } else {
      lines.push(
        `④ BREAKOUT: Giá phá xuống dưới box.low ${fmtPrice(signal.entryPrice)} với momentum rõ ràng → xác nhận xu hướng giảm đã bắt đầu. Vào SHORT ngay tại điểm phá vỡ.`
      );
    }
    const rsiLine = rsi !== null
      ? `RSI ${rsi.toFixed(1)} < 50 xác nhận momentum giảm.`
      : "RSI dưới trung bình xác nhận đà giảm.";
    const volLine = volOk ? "Volume xác nhận breakout." : "Volume chưa spike — cần theo dõi thêm.";
    lines.push(
      `⑤ Chỉ báo: ${rsiLine} ${volLine} ` +
      `→ SL trên box.high ${fmtPrice(signal.slPrice)} | TP ${fmtPrice(signal.tpPrice)} | RR ${rr.toFixed(2)}R`
    );
  } else {
    // --- LONG / Accumulation ---
    lines.push(
      "① SC (Selling Climax): Giá bán tháo xuống đáy với volume cực lớn — bên mua tổ chức hấp thụ toàn bộ lực bán. Tín hiệu tích lũy bắt đầu."
    );
    if (hasAR) lines.push(
      "② AR_ACC (Automatic Rally): Giá tăng vọt ngay sau SC, xác nhận lực mua đang chiếm ưu thế."
    );
    if (hasST) lines.push(
      "③ ST_ACC (Secondary Test): Giá test lại vùng SC nhưng không phá đáy — hình thành đáy cao hơn. Cấu trúc Accumulation SC→AR→ST hoàn chỉnh."
    );
    if (isRetest) {
      lines.push(
        `④ RETEST: Giá đã phá lên trên box.high, sau đó quay về kiểm tra vùng kháng cự cũ nay đã thành hỗ trợ tại ${fmtPrice(signal.entryPrice)}. Điểm LONG tối ưu theo Wyckoff.`
      );
    } else {
      lines.push(
        `④ BREAKOUT: Giá phá lên trên box.high ${fmtPrice(signal.entryPrice)} → xác nhận xu hướng tăng. Vào LONG tại điểm phá vỡ.`
      );
    }
    const rsiLine = rsi !== null
      ? `RSI ${rsi.toFixed(1)} > 50 xác nhận momentum tăng.`
      : "RSI trên trung bình xác nhận đà tăng.";
    const volLine = volOk ? "Volume xác nhận breakout." : "Volume chưa spike — cần theo dõi thêm.";
    lines.push(
      `⑤ Chỉ báo: ${rsiLine} ${volLine} ` +
      `→ SL dưới box.low ${fmtPrice(signal.slPrice)} | TP ${fmtPrice(signal.tpPrice)} | RR ${rr.toFixed(2)}R`
    );
  }
  return lines;
}

const ACC_COLOR = "#12d18e";
const DIST_COLOR = "#ff4f68";
const UNK_COLOR = "#7390a8";

const SPRING_COLOR   = "#ff9900";  // orange — matches TradingView chấm cam
const MARKER_LABEL: Partial<Record<WyckoffSignalType, string>> = {
  SC: "SC", AR_ACC: "AR", ST_ACC: "ST",
  BC: "BC", AR_DIST: "AR", ST_DIST: "ST",
  SPRING: "SP", UPTHRUST: "UT"
};
const MARKER_COLOR: Partial<Record<WyckoffSignalType, string>> = {
  SC: ACC_COLOR, AR_ACC: ACC_COLOR, ST_ACC: ACC_COLOR,
  BC: DIST_COLOR, AR_DIST: DIST_COLOR, ST_DIST: DIST_COLOR,
  SPRING: SPRING_COLOR, UPTHRUST: SPRING_COLOR
};
// LOW pivots → triangle UP (▲) below candle
const LOW_EVENTS  = new Set<WyckoffSignalType>(["SC", "ST_ACC", "AR_DIST", "SPRING"]);
// HIGH pivots → triangle DOWN (▽) above candle
const HIGH_EVENTS = new Set<WyckoffSignalType>(["AR_ACC", "BC", "ST_DIST", "UPTHRUST"]);

function renderOBZones(
  obs: OBZone[],
  rows: Kline[],
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  step: number,
  chartW: number
): string {
  let svg = "";
  const chartRight = xFn(rows.length - 1) + step * 0.5;

  for (const ob of obs) {
    if (ob.candleIndex < 0 || ob.candleIndex >= rows.length) continue;
    const xStart = xFn(ob.candleIndex) - step * 0.5;
    const yTop   = yFn(ob.bodyHigh);
    const yBot   = yFn(ob.bodyLow);
    const h      = Math.max(yBot - yTop, 2);
    const w      = Math.max(chartRight - xStart, 4);

    const isBull = ob.kind === "bullish";
    const baseColor = isBull ? "#00e5cc" : "#ff4f68";  // cyan for bullish, red for bearish
    const fillOp    = ob.mitigated ? 0.04 : 0.10;
    const strokeOp  = ob.mitigated ? 0.25 : 0.60;
    const label     = `${isBull ? "Bullish" : "Bearish"} OB${ob.mitigated ? " (used)" : ""}`;

    // Zone rectangle — extends to right edge of chart
    svg += `<rect x="${xStart.toFixed(1)}" y="${yTop.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
      fill="${baseColor}" fill-opacity="${fillOp}"
      stroke="${baseColor}" stroke-opacity="${strokeOp}" stroke-width="1" stroke-dasharray="4 2"/>`;

    // Body highlight — slightly brighter inner zone
    svg += `<rect x="${xStart.toFixed(1)}" y="${yTop.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"
      fill="${baseColor}" fill-opacity="${ob.mitigated ? 0.02 : 0.06}"/>`;

    // OB candle vertical marker
    svg += `<line x1="${xFn(ob.candleIndex)}" y1="${yFn(ob.high) - 2}" x2="${xFn(ob.candleIndex)}" y2="${yFn(ob.low) + 2}"
      stroke="${baseColor}" stroke-width="2" stroke-opacity="${ob.mitigated ? 0.3 : 0.8}"/>`;

    // Label on right edge
    const labelX = Math.min(chartRight - 4, xFn(rows.length - 1));
    const labelY = yTop - 4;
    svg += `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}"
      fill="${baseColor}" fill-opacity="${ob.mitigated ? 0.4 : 0.85}"
      font-size="10" font-weight="700" text-anchor="end"
      stroke="#000" stroke-width="2" paint-order="stroke">${escapeXml(label)}</text>`;
    svg += `<text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}"
      fill="${baseColor}" fill-opacity="${ob.mitigated ? 0.4 : 0.85}"
      font-size="10" font-weight="700" text-anchor="end">${escapeXml(label)}</text>`;
  }
  return svg;
}

// SFP overlay: swing level line + wick bracket + SFP label (like TradingView)
function renderSfpOverlay(
  signal: SFPSignalRecord,
  rows: Kline[],
  signalIdx: number,
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  chartW: number
): string {
  const bullish = signal.direction === "BULLISH";
  const swingPrice     = signal.swingPrice;
  const oppositeLevel  = signal.oppositeLevel;
  const wickTip        = bullish ? signal.sfpCandleLow  : signal.sfpCandleHigh;
  if (!swingPrice || !wickTip || signalIdx < 0 || signalIdx >= rows.length) return "";

  const SFP_COLOR  = "#00e5cc";   // cyan — same as Bullish OB
  const SWING_COLOR = bullish ? "#00e5cc" : "#ff6f91";  // cyan for bullish, pink for bearish

  const swingY   = yFn(swingPrice);
  const wickY    = yFn(wickTip);
  const sweepCX  = xFn(signalIdx);
  const lineLeft = xFn(0);
  const lineRight = xFn(Math.min(signalIdx + 12, rows.length - 1));

  let svg = "";

  // 1. Swing level horizontal dashed line (the level that was swept)
  svg += `<line x1="${lineLeft}" y1="${swingY.toFixed(1)}" x2="${lineRight}" y2="${swingY.toFixed(1)}"
    stroke="${SWING_COLOR}" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.85"/>`;

  // 2. Swing level label on left
  svg += `<text x="${lineLeft + 4}" y="${swingY - 5}" fill="${SWING_COLOR}"
    font-size="10" font-weight="700" opacity="0.8">Swing ${bullish ? "Low" : "High"} ${fmtPrice(swingPrice)}</text>`;

  // 3. Opposite level (where price should go)
  if (oppositeLevel && Math.abs(oppositeLevel - swingPrice) > 0) {
    const oppY = yFn(oppositeLevel);
    svg += `<line x1="${lineLeft}" y1="${oppY.toFixed(1)}" x2="${lineRight}" y2="${oppY.toFixed(1)}"
      stroke="#7390a8" stroke-width="1" stroke-dasharray="3 5" opacity="0.5"/>`;
  }

  // 4. Vertical bracket: swingPrice → wick tip (the "sweep" distance)
  const bracketX = sweepCX + 10;
  svg += `<line x1="${bracketX}" y1="${swingY.toFixed(1)}" x2="${bracketX}" y2="${wickY.toFixed(1)}"
    stroke="${SWING_COLOR}" stroke-width="2" opacity="0.9"/>`;
  // Bracket caps
  svg += `<line x1="${bracketX - 5}" y1="${swingY.toFixed(1)}" x2="${bracketX + 5}" y2="${swingY.toFixed(1)}"
    stroke="${SWING_COLOR}" stroke-width="2" opacity="0.9"/>`;
  svg += `<line x1="${bracketX - 5}" y1="${wickY.toFixed(1)}" x2="${bracketX + 5}" y2="${wickY.toFixed(1)}"
    stroke="${SWING_COLOR}" stroke-width="2" opacity="0.9"/>`;

  // 5. Wick tip diamond marker
  const dY = wickY + (bullish ? 6 : -6);
  svg += `<polygon points="${sweepCX},${dY} ${sweepCX - 6},${wickY} ${sweepCX},${dY - 12} ${sweepCX + 6},${wickY}"
    fill="${SWING_COLOR}" opacity="0.95"/>`;

  // 6. "SFP" label at the wick tip
  const labelY = bullish ? wickY + 28 : wickY - 18;
  svg += `<text x="${sweepCX}" y="${labelY}"
    fill="${SWING_COLOR}" font-size="13" font-weight="900" text-anchor="middle"
    stroke="#000" stroke-width="3" paint-order="stroke" letter-spacing="1">SFP</text>`;
  svg += `<text x="${sweepCX}" y="${labelY}"
    fill="${SWING_COLOR}" font-size="13" font-weight="900" text-anchor="middle" letter-spacing="1">SFP</text>`;

  // 7. Sweep distance label
  const sweepPct = Math.abs(wickTip - swingPrice) / swingPrice * 100;
  const midY = (swingY + wickY) / 2;
  svg += `<text x="${bracketX + 8}" y="${(midY + 4).toFixed(1)}"
    fill="${SWING_COLOR}" font-size="10" opacity="0.8">${sweepPct.toFixed(3)}%</text>`;

  return svg;
}

function renderWyckoffOverlay(
  rows: Kline[],
  pivotLength: number,
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  step: number
): string {
  const candles = rows.map(k => ({
    time: k.openTime,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume
  }));

  const analysis = analyzeWyckoff(candles, { pivotLength, trendSensitivity: 20 });
  const chartW = xFn(rows.length - 1) - xFn(0);
  let svg = "";

  // --- Order Block zones (behind boxes and candles) ---
  svg += renderOBZones(analysis.orderBlocks, rows, xFn, yFn, step, chartW);

  // --- Boxes ---
  for (const box of analysis.boxes) {
    const si = Math.max(0, Math.min(rows.length - 1, box.startIndex));
    const ei = Math.max(0, Math.min(rows.length - 1, box.endIndex));
    const x1 = xFn(si) - step * 0.5;
    const x2 = xFn(ei) + step * 0.5;
    const y1 = yFn(box.high);
    const y2 = yFn(box.low);
    const bw = Math.max(x2 - x1, 4);
    const bh = Math.max(y2 - y1, 2);
    const color = box.type === "Accumulation" ? ACC_COLOR
      : box.type === "Distribution" ? DIST_COLOR
      : UNK_COLOR;
    const cx = x1 + bw / 2;
    const cy = y1 + bh / 2;
    svg += `<rect x="${x1.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" fill-opacity="0.07" stroke="${color}" stroke-opacity="0.4" stroke-width="1.5" stroke-dasharray="6 3"/>`;
    if (bh > 20) {
      svg += `<text x="${cx.toFixed(1)}" y="${(cy + 7).toFixed(1)}" fill="${color}" fill-opacity="0.20" font-size="17" font-weight="800" text-anchor="middle">${escapeXml(box.type)}</text>`;
    }
  }

  // --- Event markers ---
  for (const sig of analysis.signals) {
    const label = MARKER_LABEL[sig.type];
    if (!label) continue;
    const color = MARKER_COLOR[sig.type] ?? UNK_COLOR;
    const idx = sig.signalIndex;
    if (idx < 0 || idx >= rows.length) continue;
    const row = rows[idx];
    if (!row) continue;
    const cx = xFn(idx);

    const isSpring   = sig.type === "SPRING";
    const isUpthrust = sig.type === "UPTHRUST";

    if (isSpring) {
      // Spring: diamond shape AT the wick tip (actual low), then label below
      const py = yFn(sig.price) + 2;  // sig.price = actual spring low
      svg += `<polygon points="${cx},${py - 8} ${cx - 6},${py} ${cx},${py + 8} ${cx + 6},${py}"
               fill="${color}" opacity="0.95" stroke="#fff" stroke-width="0.5"/>`;
      svg += `<text x="${cx}" y="${(py + 22).toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
               text-anchor="middle" stroke="#000" stroke-width="3" paint-order="stroke">SP</text>`;
      svg += `<text x="${cx}" y="${(py + 22).toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
               text-anchor="middle">SP</text>`;
    } else if (isUpthrust) {
      // Upthrust: diamond AT wick tip (actual high)
      const py = yFn(sig.price) - 2;  // sig.price = actual upthrust high
      svg += `<polygon points="${cx},${py + 8} ${cx - 6},${py} ${cx},${py - 8} ${cx + 6},${py}"
               fill="${color}" opacity="0.95" stroke="#fff" stroke-width="0.5"/>`;
      svg += `<text x="${cx}" y="${(py - 12).toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
               text-anchor="middle" stroke="#000" stroke-width="3" paint-order="stroke">UT</text>`;
      svg += `<text x="${cx}" y="${(py - 12).toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
               text-anchor="middle">UT</text>`;
    } else if (LOW_EVENTS.has(sig.type)) {
      const py = yFn(row.low) + 5;
      // Triangle UP ▲
      svg += `<polygon points="${cx},${py} ${cx - 7},${py + 15} ${cx + 7},${py + 15}" fill="${color}" opacity="0.92"/>`;
      svg += `<text x="${cx}" y="${(py + 28).toFixed(1)}" fill="${color}" font-size="10" font-weight="700" text-anchor="middle">${escapeXml(label)}</text>`;
    } else if (HIGH_EVENTS.has(sig.type)) {
      const py = yFn(row.high) - 5;
      // Triangle DOWN ▽
      svg += `<polygon points="${cx},${py} ${cx - 7},${py - 15} ${cx + 7},${py - 15}" fill="${color}" opacity="0.92"/>`;
      svg += `<text x="${cx}" y="${(py - 19).toFixed(1)}" fill="${color}" font-size="10" font-weight="700" text-anchor="middle">${escapeXml(label)}</text>`;
    }
  }

  return svg;
}

interface SmcChartAnalysis {
  outputs: SmcOutput[];
  visibleEvents: SmcEvent[];
  lastOutput: SmcOutput | null;
  rowOffset: number;
}

function analyzeSmcForChart(allRows: Kline[], visibleRows: Kline[]): SmcChartAnalysis {
  const engine = new LuxAlgoSmcEngine({
    showInternals: true,
    showStructure: true,
    showInternalOrderBlocks: true,
    showSwingOrderBlocks: true,
    showEqualHighsLows: true,
    showFairValueGaps: true,
    orderBlockFilter: "Atr",
    orderBlockMitigation: "High/Low",
    atrLength: 200
  });
  const outputs = allRows.map((row) => engine.update({
    time: row.openTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close
  }));
  const rowOffset = Math.max(0, allRows.length - visibleRows.length);
  const visibleEvents = outputs
    .flatMap((output) => output.events)
    .filter((event) => event.index >= rowOffset);

  return {
    outputs,
    visibleEvents,
    lastOutput: outputs.at(-1) ?? null,
    rowOffset
  };
}

function trendVi(value: Bias | 0): string {
  if (value === 1) return "tăng";
  if (value === -1) return "giảm";
  return "trung lập";
}

function renderSmcOverlay(
  analysis: SmcChartAnalysis,
  rows: Kline[],
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  step: number
): string {
  const chartRight = xFn(rows.length - 1) + step * 0.5;
  let svg = "";

  if (analysis.lastOutput) {
    svg += renderSmcOrderBlocks(analysis.lastOutput.internalOrderBlocks, analysis.rowOffset, rows, xFn, yFn, step, chartRight);
    svg += renderSmcOrderBlocks(analysis.lastOutput.swingOrderBlocks, analysis.rowOffset, rows, xFn, yFn, step, chartRight);
    svg += renderSmcFvgs(analysis.lastOutput.fairValueGaps, analysis.rowOffset, rows, xFn, yFn, step, chartRight);
  }

  for (const event of analysis.visibleEvents) {
    const idx = event.index - analysis.rowOffset;
    if (idx < 0 || idx >= rows.length) continue;
    const cx = xFn(idx);

    if (event.kind === "structure") {
      const pivotIdx = Math.max(0, event.pivotIndex - analysis.rowOffset);
      const x1 = xFn(Math.min(pivotIdx, rows.length - 1));
      const y = yFn(event.level);
      const bullish = event.direction === "bullish";
      const internal = event.scope === "internal";
      const color = bullish ? "#00e5cc" : "#ff4f68";
      const strokeWidth = internal ? 1.4 : 2.2;
      const dash = internal ? "6 4" : "";
      const label = `${internal ? "Internal" : "Swing"} ${event.tag}`;
      const labelY = bullish ? y - 8 : y + 16;
      svg += `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y.toFixed(1)}"
        stroke="${color}" stroke-width="${strokeWidth}" ${dash ? `stroke-dasharray="${dash}"` : ""} opacity="${internal ? 0.85 : 0.95}"/>`;
      svg += `<text x="${((x1 + cx) / 2).toFixed(1)}" y="${labelY.toFixed(1)}"
        fill="${color}" font-size="${internal ? 10 : 12}" font-weight="800" text-anchor="middle"
        stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(label)}</text>`;
      svg += `<text x="${((x1 + cx) / 2).toFixed(1)}" y="${labelY.toFixed(1)}"
        fill="${color}" font-size="${internal ? 10 : 12}" font-weight="800" text-anchor="middle">${escapeXml(label)}</text>`;
    } else if (event.kind === "equalHighLow") {
      const color = event.type === "EQH" ? "#f5c84b" : "#00e5cc";
      const y = yFn(event.level);
      const prevIdx = Math.max(0, event.previousPivotIndex - analysis.rowOffset);
      const x1 = xFn(Math.min(prevIdx, rows.length - 1));
      svg += `<line x1="${x1.toFixed(1)}" y1="${y.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y.toFixed(1)}"
        stroke="${color}" stroke-width="1.5" stroke-dasharray="3 4" opacity="0.9"/>`;
      svg += `<text x="${cx.toFixed(1)}" y="${(event.type === "EQH" ? y - 8 : y + 16).toFixed(1)}"
        fill="${color}" font-size="10" font-weight="900" text-anchor="middle"
        stroke="#000" stroke-width="3" paint-order="stroke">${event.type}</text>`;
      svg += `<text x="${cx.toFixed(1)}" y="${(event.type === "EQH" ? y - 8 : y + 16).toFixed(1)}"
        fill="${color}" font-size="10" font-weight="900" text-anchor="middle">${event.type}</text>`;
    } else if (event.kind === "swingPoint") {
      const color = event.label === "HH" || event.label === "HL" ? "#00e5cc" : "#ff4f68";
      const y = yFn(event.level);
      const labelY = event.label === "HH" || event.label === "LH" ? y - 10 : y + 18;
      svg += `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}" opacity="0.9"/>`;
      svg += `<text x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" fill="${color}" font-size="10" font-weight="800" text-anchor="middle">${event.label}</text>`;
    } else if (event.kind === "orderBlockMitigated") {
      const color = event.bias === 1 ? "#ff4f68" : "#00e5cc";
      const y = yFn(event.bias === 1 ? event.barLow : event.barHigh);
      svg += `<text x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" fill="${color}" font-size="10" font-weight="900"
        text-anchor="middle" stroke="#000" stroke-width="3" paint-order="stroke">OB BREAK</text>`;
      svg += `<text x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" fill="${color}" font-size="10" font-weight="900"
        text-anchor="middle">OB BREAK</text>`;
    } else if (event.kind === "fairValueGap") {
      const color = event.direction === "bullish" ? "#00e5cc" : "#ff4f68";
      const y = yFn(event.middle);
      svg += `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
        text-anchor="middle" stroke="#000" stroke-width="3" paint-order="stroke">FVG</text>`;
      svg += `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" font-size="10" font-weight="800"
        text-anchor="middle">FVG</text>`;
    }
  }

  return svg;
}

function renderSmcOrderBlocks(
  blocks: OrderBlockSnapshot[],
  rowOffset: number,
  rows: Kline[],
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  step: number,
  chartRight: number
): string {
  let svg = "";
  for (const block of blocks.slice(0, 8)) {
    if (block.barIndex < rowOffset) continue;
    const idx = block.barIndex - rowOffset;
    if (idx < 0 || idx >= rows.length) continue;
    const x1 = xFn(idx) - step * 0.5;
    const yTop = yFn(block.barHigh);
    const yBot = yFn(block.barLow);
    const color = block.bias === 1 ? "#00e5cc" : "#ff4f68";
    const h = Math.max(yBot - yTop, 2);
    const label = `${block.scope === "internal" ? "I" : "S"} ${block.bias === 1 ? "Bullish" : "Bearish"} OB`;
    svg += `<rect x="${x1.toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(chartRight - x1, 4).toFixed(1)}" height="${h.toFixed(1)}"
      fill="${color}" fill-opacity="${block.scope === "internal" ? 0.07 : 0.11}"
      stroke="${color}" stroke-opacity="${block.scope === "internal" ? 0.45 : 0.7}" stroke-width="1" stroke-dasharray="${block.scope === "internal" ? "4 3" : ""}"/>`;
    svg += `<text x="${(chartRight - 6).toFixed(1)}" y="${(yTop - 4).toFixed(1)}"
      fill="${color}" font-size="10" font-weight="800" text-anchor="end"
      stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(label)}</text>`;
    svg += `<text x="${(chartRight - 6).toFixed(1)}" y="${(yTop - 4).toFixed(1)}"
      fill="${color}" font-size="10" font-weight="800" text-anchor="end">${escapeXml(label)}</text>`;
  }
  return svg;
}

function renderSmcFvgs(
  fvgs: FairValueGapSnapshot[],
  rowOffset: number,
  rows: Kline[],
  xFn: (i: number) => number,
  yFn: (p: number) => number,
  step: number,
  chartRight: number
): string {
  let svg = "";
  for (const fvg of fvgs.slice(0, 8)) {
    if (fvg.detectedIndex < rowOffset) continue;
    const idx = fvg.detectedIndex - rowOffset;
    if (idx < 0 || idx >= rows.length) continue;
    const x1 = xFn(idx) - step * 0.5;
    const yTop = yFn(fvg.top);
    const yBot = yFn(fvg.bottom);
    const color = fvg.bias === 1 ? "#38bdf8" : "#ff8aa3";
    svg += `<rect x="${x1.toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(chartRight - x1, 4).toFixed(1)}" height="${Math.max(yBot - yTop, 2).toFixed(1)}"
      fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="8 4"/>`;
    svg += `<line x1="${x1.toFixed(1)}" y1="${yFn(fvg.middle).toFixed(1)}" x2="${chartRight.toFixed(1)}" y2="${yFn(fvg.middle).toFixed(1)}"
      stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>`;
    svg += `<text x="${(chartRight - 6).toFixed(1)}" y="${(yTop + 12).toFixed(1)}"
      fill="${color}" font-size="10" font-weight="800" text-anchor="end">FVG</text>`;
  }
  return svg;
}

function buildSmcNarrative(signal: SFPSignalRecord): string[] {
  const summary = `${signal.decisionSummary ?? ""}; ${signal.message ?? ""}`;
  const bullish = signal.direction === "BULLISH";
  const side = bullish ? "LONG" : "SHORT";
  const relaxed = isRelaxedSmcSignal(signal);
  const alert = (summary.match(/mappedAlert=([^;]+)/)?.[1] ?? signal.patternName ?? "SMC alert").trim();
  const activeAlerts = (summary.match(/activeAlerts=([^;]+)/)?.[1] ?? "").trim();
  const internalTrend = (summary.match(/internalTrend=([^;]+)/)?.[1] ?? "neutral").trim();
  const swingTrend = (summary.match(/swingTrend=([^;]+)/)?.[1] ?? "neutral").trim();
  const rr = Math.abs(signal.tpPrice - signal.entryPrice) /
    Math.max(Math.abs(signal.entryPrice - signal.slPrice), 1e-12);
  const riskPct = signal.entryPrice > 0
    ? Math.abs(signal.entryPrice - signal.slPrice) / signal.entryPrice * 100
    : 0;
  const tpPct = signal.entryPrice > 0
    ? Math.abs(signal.tpPrice - signal.entryPrice) / signal.entryPrice * 100
    : 0;

  return [
    `1. Tín hiệu vào lệnh: ${alert}. Hướng bot chọn: ${side}. Điểm setup: ${signal.decisionScore ?? 0}/100.`,
    `2. Điều kiện nến: chỉ dùng nến đã đóng. Entry = giá đóng của nến xác nhận: ${fmtPrice(signal.entryPrice)}.`,
    bullish
      ? `3. Stop Loss: đặt dưới pivot/structure gần nhất tại ${fmtPrice(signal.slPrice)} để tránh nhiễu sau khi phá cấu trúc.`
      : `3. Stop Loss: đặt trên pivot/structure gần nhất tại ${fmtPrice(signal.slPrice)} để tránh nhiễu sau khi phá cấu trúc.`,
    relaxed
      ? `4. Take Profit: TP trigger theo ROI tại ${fmtPrice(signal.tpPrice)}. RR chỉ là tham chiếu ${rr.toFixed(2)}R. Risk ${riskPct.toFixed(2)}%, target ${tpPct.toFixed(2)}%.`
      : `4. Take Profit: TP theo RR ${rr.toFixed(2)}R tại ${fmtPrice(signal.tpPrice)}. Risk ${riskPct.toFixed(2)}%, target ${tpPct.toFixed(2)}%.`,
    `5. Xu hướng SMC: internal=${internalTrend}, swing=${swingTrend}. Alert đang bật: ${activeAlerts || "không có"}.`,
    "6. Cách đọc chart: đường BOS/CHoCH là điểm phá cấu trúc; hộp OB là vùng supply/demand; EQH/EQL là thanh khoản; FVG là imbalance."
  ];
}

export async function createSignalChart(
  signal: SFPSignalRecord,
  klines: Kline[]
): Promise<SignalChartFile> {
  if (!signal.id) throw new Error("Signal chart requires a saved signal id");
  const rows = klines.slice(-100);
  if (rows.length < 2) throw new Error("Not enough klines to render signal chart");

  const isWyckoff = signal.strategy === "wyckoff";
  const isSmc = signal.strategy === "smc";
  const isSfp    = signal.strategy === "sfp" || signal.hasSfp === true;
  const relaxedSmc = isRelaxedSmcSignal(signal);
  const bullish = signal.direction === "BULLISH";
  const sideColor = bullish ? ACC_COLOR : DIST_COLOR;
  const smcAnalysis = isSmc ? analyzeSmcForChart(klines, rows) : null;

  const priceValues = [
    ...rows.flatMap(row => [row.high, row.low]),
    signal.entryPrice,
    signal.slPrice,
    signal.tpPrice,
    signal.swingPrice,
    signal.oppositeLevel
  ].filter(v => Number.isFinite(v) && v > 0);
  const rawMin = Math.min(...priceValues);
  const rawMax = Math.max(...priceValues);
  const span = Math.max(rawMax - rawMin, rawMax * 0.002, 1e-12);
  const minPrice = rawMin - span * 0.10;
  const maxPrice = rawMax + span * 0.10;

  const chartW = WIDTH - PAD_L - PAD_R;
  const chartH = HEIGHT - PAD_T - PAD_B;
  const step = chartW / Math.max(rows.length - 1, 1);
  const candleW = Math.max(4, Math.min(10, step * 0.55));
  const yFn = (price: number) => PAD_T + ((maxPrice - price) / (maxPrice - minPrice)) * chartH;
  const xFn = (index: number) => PAD_L + index * step;

  // Locate signal candle index
  let signalIndex = rows.length - 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (closeEnough(row.high, signal.sfpCandleHigh) && closeEnough(row.low, signal.sfpCandleLow)) {
      signalIndex = i;
      break;
    }
  }
  const highlightStart = signal.strategy === "candlestick"
    ? Math.max(0, signalIndex - 2)
    : signalIndex;

  // Grid
  const grid = Array.from({ length: 6 }, (_, i) => {
    const gy = PAD_T + (i / 5) * chartH;
    const gp = maxPrice - (i / 5) * (maxPrice - minPrice);
    return `
      <line x1="${PAD_L}" y1="${gy}" x2="${WIDTH - PAD_R}" y2="${gy}" stroke="#1a2e40" stroke-width="1"/>
      <text x="14" y="${gy + 5}" fill="#6a8aa0" font-size="11">${escapeXml(fmtPrice(gp))}</text>`;
  }).join("");

  // Candles
  const candles = rows.map((row, i) => {
    const cx = xFn(i);
    const openY = yFn(row.open);
    const closeY = yFn(row.close);
    const highY = yFn(row.high);
    const lowY = yFn(row.low);
    const up = row.close >= row.open;
    const color = up ? ACC_COLOR : DIST_COLOR;
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(Math.abs(closeY - openY), 2);
    const selected = i >= highlightStart && i <= signalIndex;
    return `
      ${selected ? `<rect x="${(cx - candleW).toFixed(1)}" y="${(highY - 8).toFixed(1)}" width="${(candleW * 2).toFixed(1)}" height="${Math.max(lowY - highY + 16, 10).toFixed(1)}" rx="4" fill="#f5c84b" fill-opacity="0.10" stroke="#f5c84b" stroke-opacity="0.5"/>` : ""}
      <line x1="${cx}" y1="${highY.toFixed(1)}" x2="${cx}" y2="${lowY.toFixed(1)}" stroke="${color}" stroke-width="1.5"/>
      <rect x="${(cx - candleW / 2).toFixed(1)}" y="${bodyY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" rx="1.5" fill="${color}" fill-opacity="0.88"/>`;
  }).join("");

  // Time labels (placed between price chart and volume chart)
  const timeAxisY = HEIGHT - PAD_B + 18;
  const timeLabels = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const i = Math.min(rows.length - 1, Math.round((rows.length - 1) * ratio));
    const row = rows[i];
    const label = new Date(row.openTime).toLocaleString("en-GB", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    });
    return `<text x="${xFn(i)}" y="${timeAxisY}" fill="#6a8aa0" font-size="11" text-anchor="middle">${escapeXml(label)}</text>`;
  }).join("");

  // Volume sub-chart
  const volTop = HEIGHT - PAD_B + VOL_GAP + 26;   // below time axis
  const volMaxRaw = Math.max(...rows.map(r => r.volume), 1);
  const volumeBars = rows.map((row, i) => {
    const cx = xFn(i);
    const bh = Math.max(2, (row.volume / volMaxRaw) * VOL_H);
    const by = volTop + VOL_H - bh;
    const color = row.close >= row.open ? ACC_COLOR : DIST_COLOR;
    return `<rect x="${(cx - candleW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" fill-opacity="0.65"/>`;
  }).join("");

  // Volume MA line (20-period) over the sub-chart
  const volMaLen = 20;
  const volMaPoints = rows.map((_, i) => {
    if (i < volMaLen - 1) return null;
    const slice = rows.slice(i - volMaLen + 1, i + 1);
    const avg = slice.reduce((s, r) => s + r.volume, 0) / volMaLen;
    const py = volTop + VOL_H - (avg / volMaxRaw) * VOL_H;
    return `${xFn(i).toFixed(1)},${py.toFixed(1)}`;
  }).filter(Boolean).join(" ");

  const volMaLine = volMaPoints
    ? `<polyline points="${volMaPoints}" fill="none" stroke="#f5c84b" stroke-width="1.2" stroke-opacity="0.8"/>`
    : "";

  const volLabel = `<text x="${PAD_L + 4}" y="${volTop - 4}" fill="#6a8aa0" font-size="10" font-weight="600">VOL</text>`;

  // Detect blocked/rejected signal:
  // 1. Wyckoff-level block: patternName has "[BỊ CHẶN]" and decision=SKIP
  // 2. RiskManager block: status=rejected and message has "Kiểm tra rủi ro thất bại"
  const isWyckoffBlock   = signal.status === "rejected" && signal.decision === "SKIP" &&
                           (signal.patternName ?? "").includes("BỊ CHẶN");
  const isRiskMgrBlock   = signal.status === "rejected" &&
                           (signal.message ?? "").includes("Kiểm tra rủi ro thất bại");
  const isImmediateTriggerBlock = signal.status === "rejected" &&
                           (signal.message ?? "").includes("TP/SL") &&
                           /TAKE_PROFIT_MARKET|STOP_MARKET/i.test(signal.message ?? "");
  const isBlocked =
    signal.status === "rejected" ||
    signal.status === "ignored" ||
    isWyckoffBlock ||
    isRiskMgrBlock ||
    isImmediateTriggerBlock;

  // Entry / TP / SL lines — distinct colors with glow + USDT PnL
  // Blocked signals: use dimmed colors, no glow
  const TP_COLOR    = isBlocked ? "#006644" : "#00ffb3";
  const SL_COLOR    = isBlocked ? "#660022" : "#ff3860";
  const ENTRY_COLOR = isBlocked ? "#1a4a60" : "#38bdf8";

  // Calculate USDT profit/loss at TP and SL
  const qty = signal.marginUsdt > 0 && signal.leverage > 0 && signal.entryPrice > 0
    ? (signal.marginUsdt * signal.leverage) / signal.entryPrice
    : 0;
  const dir = bullish ? 1 : -1;
  const tpUsdt = qty > 0 ? dir * qty * (signal.tpPrice - signal.entryPrice) : undefined;
  const slUsdt = qty > 0 ? dir * qty * (signal.slPrice - signal.entryPrice) : undefined;

  const entryY = yFn(signal.entryPrice);
  const tpY = yFn(signal.tpPrice);
  const slY = yFn(signal.slPrice);
  const labelYs = stackTradeLineLabels(
    [
      { key: "entry", y: entryY },
      { key: "tp", y: tpY },
      { key: "sl", y: slY }
    ],
    PAD_T,
    PAD_T + chartH
  );
  const lines = [
    renderLine("ENTRY", signal.entryPrice, ENTRY_COLOR, entryY, "glowBlue", undefined, labelYs.entry),
    renderLine(relaxedSmc ? "TP ROI" : "TP ✓", signal.tpPrice, TP_COLOR, tpY, "glowGreen", tpUsdt, labelYs.tp),
    renderLine("SL ✗",  signal.slPrice,    SL_COLOR,    slY,    "glowRed",   slUsdt, labelYs.sl)
  ].join("");

  // Wyckoff overlay (boxes + SC/AR/ST markers)
  const wyckoffOverlay = isWyckoff
    ? renderWyckoffOverlay(rows, 3, xFn, yFn, step)
    : "";

  const smcOverlay = smcAnalysis
    ? renderSmcOverlay(smcAnalysis, rows, xFn, yFn, step)
    : "";

  // SFP overlay (swing level + bracket + label)
  const sfpOverlay = isSfp
    ? renderSfpOverlay(signal, rows, signalIndex, xFn, yFn, chartW)
    : "";

  // Header info
  const sideText = bullish ? "LONG / BULLISH" : "SHORT / BEARISH";
  const entryTypeText = isWyckoff ? (signal.patternName ?? "Wyckoff")
    : isSmc ? (signal.patternName ?? "SMC")
    : (signal.patternName ?? "");
  const rr = Math.abs(signal.tpPrice - signal.entryPrice) /
    Math.max(Math.abs(signal.entryPrice - signal.slPrice), 1e-12);
  const title = `${signal.symbol} · ${signal.timeframe} · ${sideText}`;
  const sub1 = `${entryTypeText} · Score: ${signal.decisionScore ?? "-"} · ${relaxedSmc ? "RR ref" : "RR"}: ${rr.toFixed(2)}R`;
  const dateStr = new Date(signal.createdAt).toLocaleString("en-GB");

  // --- Analysis panel (below volume) ---
  const panelY  = volTop + VOL_H + 12;
  const panelH  = HEIGHT - panelY - 16;
  const panelW  = WIDTH - PAD_L - 16;

  const narrativeLines = isBlocked
    ? buildRejectedNarrative(signal)
    : isSmc
      ? buildSmcNarrative(signal)
      : isWyckoff
      ? buildWyckoffNarrative(signal)
      : (signal.decisionSummary ?? signal.message ?? "").split(/;\s*/);

  const LINE_H = 21;
  const FONT   = 13;
  const narrativeSvg = narrativeLines.map((line, i) =>
    `<text x="${PAD_L + 12}" y="${panelY + 38 + i * LINE_H}" fill="#c8dff0" font-size="${FONT}" font-family="monospace">${escapeXml(line)}</text>`
  ).join("\n  ");

  // Legend row at very bottom
  const legendY = HEIGHT - 20;
  const legend = isSmc ? `
    <text x="${PAD_L}" y="${legendY}" fill="#506070" font-size="11">
      <tspan fill="#00e5cc" font-weight="700">Bullish BOS/CHoCH/OB</tspan>
      <tspan dx="14" fill="#ff4f68" font-weight="700">Bearish BOS/CHoCH/OB</tspan>
      <tspan dx="14" fill="#f5c84b" font-weight="700">EQH/EQL</tspan>
      <tspan dx="14" fill="#38bdf8">FVG</tspan>
      <tspan dx="14">Dashed = internal or active zone</tspan>
    </text>` : isWyckoff ? `
    <text x="${PAD_L}" y="${legendY}" fill="#506070" font-size="11">
      <tspan fill="${ACC_COLOR}" font-weight="700">▲ SC/AR/ST</tspan><tspan dx="4">Accumulation</tspan>
      <tspan dx="14" fill="${DIST_COLOR}" font-weight="700">▽ BC/AR/ST</tspan><tspan dx="4">Distribution</tspan>
      <tspan dx="14" fill="#f5c84b">── VOL MA20</tspan>
      <tspan dx="14" fill="#00e5cc" font-weight="700">▬ Bullish OB</tspan>
      <tspan dx="14" fill="#ff4f68" font-weight="700">▬ Bearish OB</tspan>
      <tspan dx="14">Dashed = Wyckoff box</tspan>
    </text>` : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${GLOW_DEFS}
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#03070c"/>
  <rect x="10" y="10" width="${WIDTH - 20}" height="${HEIGHT - 20}" rx="12" fill="#071018" stroke="#172840"/>

  <!-- Header -->
  <text x="32" y="44" fill="#e9f4ff" font-size="24" font-weight="800">${escapeXml(title)}</text>
  <text x="32" y="68" fill="${isBlocked ? "#ff6622" : sideColor}" font-size="13" font-weight="600">${escapeXml(isBlocked ? `[BLOCKED] ${sub1}` : sub1)}</text>
  <text x="${WIDTH - 24}" y="44" fill="#6a8aa0" font-size="12" text-anchor="end">${escapeXml(dateStr)}</text>

  <!-- Chart area -->
  <rect x="${PAD_L}" y="${PAD_T}" width="${chartW}" height="${chartH}" fill="#060f18" stroke="#1a2e40" rx="2"/>
  ${grid}

  <!-- Wyckoff boxes (behind candles) -->
  ${wyckoffOverlay}

  <!-- Smart Money Concepts structure, OB, EQH/EQL and FVG overlay -->
  ${smcOverlay}

  <!-- SFP swing level + bracket (behind candles) -->
  ${sfpOverlay}

  <!-- Candles -->
  ${candles}

  <!-- Wyckoff event markers (in front of candles, but behind lines) -->

  <!-- Price lines -->
  ${lines}

  <!-- Time axis -->
  ${timeLabels}

  <!-- Volume sub-chart -->
  <rect x="${PAD_L}" y="${volTop}" width="${chartW}" height="${VOL_H}" fill="#060f18" stroke="#1a2e40" rx="1"/>
  ${volumeBars}
  ${volMaLine}
  ${volLabel}

  <!-- Blocked: large golden annotation floating in upper chart area -->
  ${isBlocked ? (() => {
    // Parse short rejection reason for the big text
    const msg = signal.message ?? signal.decisionSummary ?? "";
    const isRR      = msg.includes("RR") && msg.includes("< 1");
    const isMargin  = msg.includes("margin") || msg.includes("Margin");
    const isLeverage= msg.includes("not valid") || msg.includes("leverage");
    const isRisk    = msg.includes("Risk distance") || msg.includes("quá rộng");
    const isSlMargin= msg.includes("mất") && msg.includes("margin");
    let shortReason = "RR / SL / TP không đạt yêu cầu";
    if (isRR)       shortReason = `RR ${(msg.match(/RR ([\d.]+)/) ?? ["","?"])[1]} < 1.0 — SL xa hơn TP`;
    else if (isMargin)  shortReason = "Số dư không đủ margin cho lệnh này";
    else if (isLeverage) shortReason = "Đòn bẩy vượt giới hạn của coin này";
    else if (isRisk)    shortReason = "Risk distance vượt giới hạn 2%";
    else if (isSlMargin) shortReason = "SL quá xa — nguy cơ thanh lý margin";

    if (msg.includes("TP/SL") && /TAKE_PROFIT_MARKET|STOP_MARKET/i.test(msg)) {
      shortReason = "Gia da chay qua TP truoc khi entry khop";
    }
    shortReason = compactRejectReason(signal) || shortReason;

    const cx = PAD_L + chartW / 2;
    const cy = PAD_T + Math.round(chartH * 0.22); // 22% from top of chart area
    const reasonLines = wrapRejectReason(`LY DO: ${shortReason}`);
    const reasonSvg = reasonLines.map((line, index) => `
  <text x="${cx}" y="${cy + 82 + index * 30}"
        stroke="#000" stroke-width="4" paint-order="stroke"
        fill="#ffea70" font-size="26" font-weight="900"
        text-anchor="middle" font-family="monospace"
        filter="url(#glowGold)" class="reject-pulse">${escapeXml(line)}</text>`).join("");

    return `
  <text x="${cx}" y="${cy - 8}"
        fill="#f5c84b" fill-opacity="0.15"
        font-size="82" font-weight="900" text-anchor="middle"
        filter="url(#glowGold)" class="reject-glow"
        font-family="monospace">TU CHOI</text>

  <text x="${cx}" y="${cy + 44}"
        stroke="#000" stroke-width="5" paint-order="stroke"
        fill="#ffd21a" font-size="42" font-weight="900"
        text-anchor="middle" letter-spacing="2" font-family="monospace"
        filter="url(#glowGold)" class="reject-pulse">
    ⚠ KHÔNG VÀO LỆNH
  </text>

  ${reasonSvg}`;
  })() : ""}

  <!-- Analysis panel -->
  <rect x="${PAD_L}" y="${panelY}" width="${panelW}" height="${panelH}" rx="6" fill="#060f18" stroke="#1e3346"/>
  <text x="${PAD_L + 12}" y="${panelY + 16}" fill="${isBlocked ? "#ff6622" : "#4a7a9b"}" font-size="11" font-weight="700" letter-spacing="1">${isBlocked ? "LY DO BI CHAN" : isSmc ? "PHAN TICH SMC" : "PHAN TICH WYCKOFF"}</text>
  ${narrativeSvg}

  <!-- Legend -->
  ${legend}
</svg>`;

  await fs.mkdir(staticConfig.signalChartDir, { recursive: true });
  const filename = `${signal.id}-${signal.symbol}-${signal.timeframe}.svg`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const chartPath = path.join(staticConfig.signalChartDir, filename);
  await fs.writeFile(chartPath, svg, "utf8");
  const chartUrl = `${staticConfig.publicBaseUrl}/charts/signals/${encodeURIComponent(filename)}`;
  return { chartPath, chartUrl };
}
