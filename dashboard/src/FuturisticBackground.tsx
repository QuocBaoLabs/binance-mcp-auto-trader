import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  opacity: number;
}

export default function FuturisticBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;
    const context = canvasElement.getContext('2d');
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const ctx: CanvasRenderingContext2D = context;
    let animId = 0;

    const particles: Particle[] = [];
    const COUNT = 110;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < COUNT; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.32,
        vy: (Math.random() - 0.5) * 0.32,
        r: Math.random() * 1.6 + 0.3,
        opacity: Math.random() * 0.55 + 0.12,
      });
    }

    let time = 0;

    function frame() {
      time += 0.007;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Perspective grid
      const G = 72;
      ctx.lineWidth = 1;
      for (let x = 0; x <= canvas.width; x += G) {
        const alpha = 0.028 + 0.012 * Math.sin(time * 0.4 + x * 0.01);
        ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = 0; y <= canvas.height; y += G) {
        const alpha = 0.028 + 0.012 * Math.sin(time * 0.4 + y * 0.01);
        ctx.strokeStyle = `rgba(0,212,255,${alpha})`;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }

      // Particles + connections
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;
        if (p.y < -10) p.y = canvas.height + 10;
        if (p.y > canvas.height + 10) p.y = -10;

        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x, dy = p.y - p2.y;
          const d = Math.hypot(dx, dy);
          if (d < 115) {
            ctx.strokeStyle = `rgba(0,212,255,${(1 - d / 115) * 0.11})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
          }
        }

        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        g.addColorStop(0, `rgba(0,212,255,${p.opacity})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2); ctx.fill();
      }

      // Horizontal scan line
      const scanY = (time * 55) % (canvas.height + 80) - 40;
      const sg = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 40);
      sg.addColorStop(0, 'rgba(0,212,255,0)');
      sg.addColorStop(0.5, 'rgba(0,212,255,0.048)');
      sg.addColorStop(1, 'rgba(0,212,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(0, scanY - 40, canvas.width, 80);
      ctx.strokeStyle = 'rgba(0,212,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(canvas.width, scanY); ctx.stroke();

      // Corner accent glows
      const cg1 = ctx.createRadialGradient(0, 0, 0, 0, 0, 280);
      cg1.addColorStop(0, 'rgba(0,212,255,0.06)');
      cg1.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg1;
      ctx.fillRect(0, 0, 280, 280);

      const cg2 = ctx.createRadialGradient(canvas.width, canvas.height, 0, canvas.width, canvas.height, 320);
      cg2.addColorStop(0, 'rgba(0,255,136,0.04)');
      cg2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg2;
      ctx.fillRect(canvas.width - 320, canvas.height - 320, 320, 320);

      animId = requestAnimationFrame(frame);
    }

    frame();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
}
