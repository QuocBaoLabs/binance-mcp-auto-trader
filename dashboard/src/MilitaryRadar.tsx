import { useEffect, useRef, useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RadarBlip {
  symbol:    string;
  angle:     number;
  radius:    number;
  direction: "BULLISH" | "BEARISH" | null;
  score:     number;
  decision:  "TRADE" | "SKIP" | null;
  pingAt:    number;   // ms timestamp of last signal (0 = never)
  phaseOffset: number; // 0-1, unique per coin for async twinkling
}

export interface RadarSignal {
  symbol:    string;
  direction: "BULLISH" | "BEARISH";
  score:     number;
  decision:  "TRADE" | "SKIP" | null;
}

interface MilitaryRadarProps {
  watchSymbols:   string[];
  latestSignals:  RadarSignal[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SWEEP_PERIOD   = 4000;    // ms for one full revolution
const TRAIL_ARC      = Math.PI * 0.7;
const PING_DURATION  = 5000;    // ms blip stays "fresh" after ping
const RING_COUNT     = 4;
const SPOKE_COUNT    = 12;

// Dashboard-native colour palette (matches --cyan, --gold, --green, --red)
const C_PRIMARY  = "#00d4ff";   // cyan — matches var(--cyan)
const C_DIM      = "rgba(0,180,220,0.14)";
const C_TRADE    = "#ffb938";   // gold  — matches var(--gold)
const C_LONG     = "#00ff9d";   // green — matches var(--green)
const C_SHORT    = "#ff2d5a";   // red   — matches var(--red)
const C_BG       = "#00060a";   // near-black with teal tint
const C_IDLE     = "rgba(0,170,200,0.35)";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h;
}

function blipPos(symbol: string): { angle: number; radius: number; phaseOffset: number } {
  const h = hashStr(symbol);
  return {
    angle:       ((h & 0xffff) / 0xffff) * Math.PI * 2,
    radius:      0.22 + ((h >>> 16 & 0xffff) / 0xffff) * 0.60,
    phaseOffset: ((h >>> 8 & 0xff) / 0xff),
  };
}

// ─── Canvas renderer ──────────────────────────────────────────────────────────

function drawFrame(
  ctx:        CanvasRenderingContext2D,
  cx:         number,
  cy:         number,
  maxR:       number,
  sweepAngle: number,
  blips:      RadarBlip[],
  now:        number,
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);

  // ── clip circle ──
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, maxR + 1, 0, Math.PI * 2);
  ctx.clip();

  // ── background radial gradient ──
  const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  bgGrad.addColorStop(0,   "rgba(0,18,28,0.97)");
  bgGrad.addColorStop(0.7, "rgba(0,9,14,0.98)");
  bgGrad.addColorStop(1,   C_BG);
  ctx.fillStyle = bgGrad;
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.fill();

  // ── range rings ──
  for (let i = 1; i <= RING_COUNT; i++) {
    const r = (i / RING_COUNT) * maxR;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = C_DIM; ctx.lineWidth = 0.8; ctx.stroke();
    // subtle range label
    ctx.fillStyle = "rgba(0,180,220,0.22)";
    ctx.font = `${Math.round(maxR * 0.044)}px 'JetBrains Mono',monospace`;
    ctx.textAlign = "left";
    ctx.fillText(`${i * 25}`, cx + r + 3, cy - 3);
  }

  // ── spokes ──
  ctx.strokeStyle = C_DIM; ctx.lineWidth = 0.5;
  for (let i = 0; i < SPOKE_COUNT; i++) {
    const a = (i / SPOKE_COUNT) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
    ctx.stroke();
  }

  // ── cardinal labels ──
  const cardinals: Array<[string, number]> = [["N",-90],["E",0],["S",90],["W",180]];
  ctx.fillStyle = "rgba(0,180,220,0.45)";
  ctx.font = `bold ${Math.round(maxR * 0.062)}px 'JetBrains Mono',monospace`;
  ctx.textAlign = "center";
  for (const [lbl, deg] of cardinals) {
    const a = deg * (Math.PI / 180);
    ctx.fillText(lbl, cx + Math.cos(a) * (maxR + 14), cy + Math.sin(a) * (maxR + 14) + 5);
  }

  // ── sweep phosphor trail ──
  const TRAIL_STEPS = 48;
  for (let t = 0; t < TRAIL_STEPS; t++) {
    const frac  = t / TRAIL_STEPS;
    const start = sweepAngle - TRAIL_ARC * frac - TRAIL_ARC / TRAIL_STEPS;
    const end   = sweepAngle - TRAIL_ARC * frac;
    const alpha = (1 - frac) * 0.22;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, start, end); ctx.closePath();
    ctx.fillStyle = `rgba(0,180,220,${alpha.toFixed(3)})`; ctx.fill();
  }

  // ── sweep arm ──
  const ax = cx + Math.cos(sweepAngle) * maxR;
  const ay = cy + Math.sin(sweepAngle) * maxR;
  const armGrad = ctx.createLinearGradient(cx, cy, ax, ay);
  armGrad.addColorStop(0,   "rgba(0,200,240,0.0)");
  armGrad.addColorStop(0.6, "rgba(0,200,240,0.35)");
  armGrad.addColorStop(1,   "rgba(0,200,240,1.0)");
  ctx.strokeStyle = armGrad; ctx.lineWidth = 2;
  ctx.shadowColor = C_PRIMARY; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay); ctx.stroke();
  ctx.shadowBlur = 0;

  // ── centre dot ──
  ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = C_PRIMARY; ctx.shadowColor = C_PRIMARY; ctx.shadowBlur = 12;
  ctx.fill(); ctx.shadowBlur = 0;

  // ── blips ──
  for (const blip of blips) {
    const bx = cx + Math.cos(blip.angle) * blip.radius * maxR;
    const by = cy + Math.sin(blip.angle) * blip.radius * maxR;

    // Age-based ping fade
    const age      = blip.pingAt > 0 ? now - blip.pingAt : Infinity;
    const pingFrac  = Math.max(0, 1 - age / PING_DURATION);

    // Continuous idle twinkle — different phase and speed per coin
    const speed     = 1200 + blip.phaseOffset * 800;
    const idlePulse = 0.28 + 0.22 * Math.sin((now / speed + blip.phaseOffset * Math.PI * 2));

    // Sweep ping (brief highlight as arm passes)
    let diff = ((sweepAngle - blip.angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const sweepPing = diff < 0.18 ? (1 - diff / 0.18) * 0.55 : 0;

    const totalGlow = Math.max(pingFrac * 0.95, sweepPing, idlePulse);

    // Colour
    let blipColor: string;
    if (blip.decision === "TRADE")         blipColor = C_TRADE;
    else if (blip.direction === "BULLISH")  blipColor = C_LONG;
    else if (blip.direction === "BEARISH")  blipColor = C_SHORT;
    else                                    blipColor = C_IDLE;

    const dotR = blip.decision === "TRADE"
      ? 5 + pingFrac * 3.5 + idlePulse * 1.5
      : 3.5 + idlePulse * 1.2 + pingFrac * 2;

    // Shadow glow intensity
    const glowRadius = 5 + totalGlow * 24;
    ctx.shadowColor = blipColor;
    ctx.shadowBlur  = glowRadius;
    ctx.beginPath(); ctx.arc(bx, by, dotR, 0, Math.PI * 2);
    ctx.fillStyle   = blip.pingAt > 0 || blip.decision === "TRADE"
      ? blipColor
      : C_IDLE;
    ctx.globalAlpha = 0.5 + totalGlow * 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;

    // TRADE: expanding concentric rings
    if (blip.decision === "TRADE") {
      for (let ring = 1; ring <= 4; ring++) {
        const ringPhase = ((now / 900 + blip.phaseOffset) % 1);
        const ringR     = dotR + ring * 9 * ringPhase;
        const ringAlpha = (1 - ringPhase) * (0.55 / ring);
        ctx.beginPath(); ctx.arc(bx, by, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,185,56,${ringAlpha.toFixed(3)})`;
        ctx.lineWidth   = 1.2;
        ctx.stroke();
      }
    }

    // Ping rings (brief burst on new signal)
    if (pingFrac > 0.05) {
      for (let ring = 1; ring <= 3; ring++) {
        const ringR     = dotR + ring * 7 * (1 - pingFrac);
        const ringAlpha = pingFrac * (0.5 / ring);
        ctx.beginPath(); ctx.arc(bx, by, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,212,255,${ringAlpha.toFixed(3)})`;
        ctx.lineWidth   = 0.9;
        ctx.stroke();
      }
    }

    // Label
    const fontSize    = Math.round(maxR * 0.056);
    const label       = blip.symbol.replace(/USDT$/i, "");
    const labelOffset = dotR + 7;
    const labelX      = bx + Math.cos(blip.angle) * labelOffset;
    const labelY      = by + Math.sin(blip.angle) * labelOffset;

    const labelAlpha  = 0.35 + totalGlow * 0.65;
    ctx.globalAlpha   = labelAlpha;
    ctx.font          = `${pingFrac > 0.1 || blip.decision === "TRADE" ? "bold " : ""}${fontSize}px 'JetBrains Mono',monospace`;
    ctx.textAlign     = bx < cx ? "right" : "left";
    ctx.fillStyle     = blipColor;
    ctx.shadowColor   = blipColor;
    ctx.shadowBlur    = pingFrac > 0.15 ? 8 : 3;
    ctx.fillText(label, labelX, labelY + fontSize * 0.38);

    if (blip.decision === "TRADE" && blip.score > 0) {
      ctx.font      = `${Math.round(fontSize * 0.82)}px 'JetBrains Mono',monospace`;
      ctx.fillStyle = C_TRADE;
      ctx.fillText(`${blip.score}`, labelX, labelY + fontSize * 1.45);
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  ctx.restore();

  // ── outer ring border ──
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,190,220,0.45)"; ctx.lineWidth = 1.5; ctx.stroke();

  // ── corner brackets (tactical style) ──
  const bOff = maxR * 0.045;
  const bLen = maxR * 0.10;
  const corners: Array<[number, number, number, number]> = [
    [cx - maxR - bOff, cy - maxR - bOff,  1,  1],
    [cx + maxR + bOff, cy - maxR - bOff, -1,  1],
    [cx - maxR - bOff, cy + maxR + bOff,  1, -1],
    [cx + maxR + bOff, cy + maxR + bOff, -1, -1],
  ];
  ctx.strokeStyle = "rgba(0,190,220,0.65)"; ctx.lineWidth = 1.6;
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x + dx * bLen, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * bLen);
    ctx.stroke();
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MilitaryRadar({ watchSymbols, latestSignals }: MilitaryRadarProps) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const blipsRef    = useRef(new Map<string, RadarBlip>());
  const sweepRef    = useRef(0);
  const rafRef      = useRef<number | null>(null);
  const prevTRef    = useRef<number | null>(null);
  const [, forceRender] = useState(0);

  // Init / sync blips from watchSymbols
  useEffect(() => {
    const map = blipsRef.current;
    for (const sym of watchSymbols) {
      if (!map.has(sym)) {
        const { angle, radius, phaseOffset } = blipPos(sym);
        map.set(sym, { symbol: sym, angle, radius, phaseOffset,
          direction: null, score: 0, decision: null, pingAt: 0 });
      }
    }
    for (const sym of [...map.keys()]) {
      if (!watchSymbols.includes(sym)) map.delete(sym);
    }
  }, [watchSymbols]);

  // Push incoming signals to blips
  useEffect(() => {
    if (!latestSignals.length) return;
    const now = Date.now();
    const map = blipsRef.current;
    for (const sig of latestSignals) {
      const existing = map.get(sig.symbol) ?? { ...blipPos(sig.symbol), symbol: sig.symbol, pingAt: 0, direction: null, score: 0, decision: null };
      map.set(sig.symbol, { ...existing, direction: sig.direction, score: sig.score, decision: sig.decision, pingAt: now });
    }
    forceRender(n => n + 1); // trigger re-render for target list
  }, [latestSignals]);

  // RAF loop
  const animate = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dt = prevTRef.current !== null ? ts - prevTRef.current : 16;
    prevTRef.current = ts;
    sweepRef.current = (sweepRef.current + (Math.PI * 2 * dt) / SWEEP_PERIOD) % (Math.PI * 2);

    const S    = canvas.width;
    const maxR = S * 0.41;
    drawFrame(ctx, S / 2, S / 2, maxR, sweepRef.current, [...blipsRef.current.values()], Date.now());

    rafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [animate]);

  // Resize observer — keep canvas square
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      canvas.width = w; canvas.height = w;
    });
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  }, []);

  const now   = Date.now();
  const blips = [...blipsRef.current.values()];
  const activeCount = blips.filter(b => b.pingAt > 0 && now - b.pingAt < PING_DURATION).length;
  const tradeCount  = blips.filter(b => b.decision === "TRADE" && b.pingAt > 0 && now - b.pingAt < PING_DURATION * 2).length;

  return (
    <div className="radar-shell">

      {/* ── HUD header ── */}
      <div className="radar-hud-top">
        {[
          ["SYS",     "ONLINE",                  tradeCount > 0 ? C_TRADE : C_PRIMARY],
          ["SCAN",    `${watchSymbols.length}`,   C_PRIMARY],
          ["ACTIVE",  `${activeCount}`,           activeCount > 0 ? C_LONG  : "inherit"],
          ["TRADE▲",  `${tradeCount}`,            tradeCount > 0 ? C_TRADE : "inherit"],
        ].map(([label, value, color]) => (
          <div key={String(label)} className="radar-hud-cell">
            <span className="radar-hud-label">{label}</span>
            <span className="radar-hud-value" style={{ color: String(color) }}>{value}</span>
          </div>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 9, color: "rgba(0,180,220,0.4)", letterSpacing: "0.08em" }}>
          {new Date().toLocaleTimeString("vi-VN", { hour12: false })}
        </div>
      </div>

      {/* ── main body (canvas + target list side by side) ── */}
      <div className="radar-body">
        <div className="radar-canvas-wrap">
          <canvas ref={canvasRef} className="radar-canvas" />
        </div>

        <div className="radar-targets">
          <div className="radar-targets-header">▶ TARGET LOG</div>
          <TargetList blips={blips} now={now} />
        </div>
      </div>

      {/* ── legend ── */}
      <div className="radar-legend">
        {[
          [C_LONG,  "LONG"],
          [C_SHORT, "SHORT"],
          [C_TRADE, "TRADE ◆"],
          [C_IDLE,  "WATCH"],
        ].map(([color, lbl]) => (
          <span key={lbl} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}`, display: "inline-block" }} />
            {lbl}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Target list ──────────────────────────────────────────────────────────────

function TargetList({ blips, now }: { blips: RadarBlip[]; now: number }) {
  const sorted = [...blips]
    .filter(b => b.pingAt > 0)
    .sort((a, b) => b.pingAt - a.pingAt)
    .slice(0, 14);

  if (sorted.length === 0) {
    return <div className="radar-targets-empty">— NO CONTACTS —</div>;
  }

  return (
    <>
      {sorted.map(b => {
        const age    = now - b.pingAt;
        const fresh  = age < PING_DURATION;
        const dirCol = b.direction === "BULLISH" ? C_LONG
                     : b.direction === "BEARISH" ? C_SHORT : "#667";
        return (
          <div key={b.symbol}
               className={`radar-target-row${fresh ? " radar-target-fresh" : ""}`}>
            <span className="radar-target-sym">{b.symbol.replace(/USDT$/i, "")}</span>
            <span className="radar-target-dir" style={{ color: dirCol }}>
              {b.direction === "BULLISH" ? "▲" : b.direction === "BEARISH" ? "▼" : "—"}
            </span>
            <span className="radar-target-score">{b.score > 0 ? b.score : "—"}</span>
            <span className="radar-target-decision"
                  style={{ color: b.decision === "TRADE" ? C_TRADE : "#445" }}>
              {b.decision === "TRADE" ? "◆TRADE" : "skip"}
            </span>
            <span className="radar-target-age" style={{ opacity: fresh ? 0.9 : 0.35 }}>
              {age < 60_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)}m`}
            </span>
          </div>
        );
      })}
    </>
  );
}
