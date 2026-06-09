import { useEffect, useRef } from 'react';

export default function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);
  const target = useRef({ x: -999, y: -999 });
  const current = useRef({ x: -999, y: -999 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      target.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMove, { passive: true });

    let raf: number;
    const LERP = 0.09;
    const tick = () => {
      current.current.x += (target.current.x - current.current.x) * LERP;
      current.current.y += (target.current.y - current.current.y) * LERP;
      el.style.transform = `translate(${current.current.x - 350}px, ${current.current.y - 350}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: 700,
        height: 700,
        borderRadius: '50%',
        pointerEvents: 'none',
        zIndex: 2,
        background: 'radial-gradient(circle at center, rgba(0,212,255,0.045) 0%, rgba(0,212,255,0.012) 35%, transparent 65%)',
        willChange: 'transform',
      }}
    />
  );
}
