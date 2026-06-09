import { useCallback, useEffect, useRef, useState } from 'react';

const BOOT_LINES = [
  'INITIALIZING MCP SERVER...',
  'CONNECTING TO BINANCE USD-M FUTURES...',
  'LOADING STRATEGY ENGINE...',
  'CALIBRATING RISK MANAGEMENT...',
  'STARTING SIGNAL PROCESSORS...',
  'ALL SYSTEMS ONLINE',
];

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const [lineIdx, setLineIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [fading, setFading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const finish = useCallback(() => {
    setFading(true);
    setTimeout(onDone, 680);
  }, [onDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    canvas.width = 280; canvas.height = 280;
    let animId: number;
    let t = 0;

    function draw() {
      t += 0.022;
      ctx.clearRect(0, 0, 280, 280);
      const cx = 140, cy = 140;

      const rings = [
        { r: 118, speed: 0.22,  color: 'rgba(0,212,255,0.10)', dash: [] as number[] },
        { r: 98,  speed: -0.45, color: 'rgba(0,255,136,0.16)', dash: [10, 5] },
        { r: 76,  speed: 0.72,  color: 'rgba(0,212,255,0.28)', dash: [5, 8] },
        { r: 54,  speed: -1.1,  color: 'rgba(0,255,136,0.35)', dash: [3, 7] },
        { r: 34,  speed: 1.8,   color: 'rgba(0,212,255,0.5)',  dash: [2, 4] },
      ];

      rings.forEach(ring => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * ring.speed);
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = 1.5;
        if (ring.dash.length) ctx.setLineDash(ring.dash);
        ctx.beginPath(); ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      });

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.6);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(0,212,255,0.8)' : 'rgba(0,255,136,0.35)';
        ctx.lineWidth = i % 3 === 0 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 108, Math.sin(a) * 108);
        ctx.lineTo(Math.cos(a) * 118, Math.sin(a) * 118);
        ctx.stroke();
      }
      ctx.restore();

      const gOuter = ctx.createRadialGradient(cx, cy, 0, cx, cy, 28);
      gOuter.addColorStop(0, 'rgba(0,212,255,0.75)');
      gOuter.addColorStop(0.45, 'rgba(0,212,255,0.22)');
      gOuter.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gOuter;
      ctx.beginPath(); ctx.arc(cx, cy, 28, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = '#00d4ff';
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = 'rgba(0,212,255,0.9)';
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,212,255,0.6)'; ctx.shadowBlur = 8;
      ctx.fillText('BM', cx, cy + 22);
      ctx.shadowBlur = 0;

      animId = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(animId);
  }, []);

  useEffect(() => {
    let done = false;
    const lineTimer = setInterval(() => {
      setLineIdx(i => {
        const next = i + 1;
        if (next >= BOOT_LINES.length) {
          clearInterval(lineTimer);
          if (!done) { done = true; setTimeout(finish, 480); }
          return i;
        }
        return next;
      });
    }, 360);
    const progTimer = setInterval(() => {
      setProgress(p => { if (p >= 100) { clearInterval(progTimer); return 100; } return Math.min(p + 1.9, 100); });
    }, 36);
    return () => { clearInterval(lineTimer); clearInterval(progTimer); };
  }, [finish]);

  return (
    <div className={`splashScreen${fading ? ' splashFade' : ''}`}>
      <canvas ref={canvasRef} />
      <div className="splashTitle">BINANCE MCP<br />AUTO TRADER</div>
      <div className="splashConsole">
        {BOOT_LINES.slice(0, lineIdx + 1).map((line, i) => (
          <div key={i} className={`cLine${i === lineIdx ? ' cActive' : ' cDone'}`}>
            <span className="cPrefix">&gt;&nbsp;</span>{line}
          </div>
        ))}
      </div>
      <div className="splashProgressWrap">
        <div className="splashBar">
          <div className="splashFill" style={{ width: `${Math.min(progress, 100)}%` }} />
          <div className="splashGlow" style={{ left: `${Math.min(progress, 100)}%` }} />
        </div>
        <span className="splashPct">{Math.round(Math.min(progress, 100))}%</span>
      </div>
    </div>
  );
}
