import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { prefersReducedMotion } from "../lib/format";

const COLORS = ["#22d3ee", "#8b5cf6", "#10b981", "#f472b6", "#facc15"];

/** Light confetti burst fired whenever a take-profit is hit. */
export function Confetti() {
  const key = useStore((s) => s.confettiKey);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!key || prefersReducedMotion()) return;
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    c.width = innerWidth;
    c.height = innerHeight;
    const parts = Array.from({ length: 90 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 11 - 4, r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3, c: COLORS[Math.floor(Math.random() * COLORS.length)], s: 4 + Math.random() * 5,
    }));
    let frame = 0;
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      parts.forEach((p) => {
        p.vy += 0.32;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - frame / 110);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c ?? "#22d3ee";
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (++frame < 110) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key]);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[90]" />;
}
