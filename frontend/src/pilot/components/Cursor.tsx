import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { prefersReducedMotion } from "../lib/format";

/**
 * Custom cursor: glowing dot + spring-trailing ring that grows over interactive
 * elements and shows contextual labels from [data-cursor], plus a soft particle trail.
 */
export function Cursor() {
  const [enabled] = useState(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const [label, setLabel] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const rx = useSpring(x, { stiffness: 380, damping: 30, mass: 0.6 });
  const ry = useSpring(y, { stiffness: 380, damping: 30, mass: 0.6 });
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    document.body.classList.add("qp-cursor");
    const reduce = prefersReducedMotion();
    const parts: { x: number; y: number; life: number; vx: number; vy: number }[] = [];
    const move = (e: PointerEvent) => {
      x.set(e.clientX);
      y.set(e.clientY);
      const t = (e.target as HTMLElement | null)?.closest?.("[data-cursor],button,a,input,select,textarea,[role=button]") as HTMLElement | null;
      setHover(!!t);
      setLabel(t?.getAttribute("data-cursor") || null);
      if (!reduce && parts.length < 60) parts.push({ x: e.clientX, y: e.clientY, life: 1, vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6 });
    };
    const dn = () => setDown(true);
    const up = () => setDown(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerdown", dn);
    window.addEventListener("pointerup", up);

    let raf = 0;
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    const resize = () => {
      if (!c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const tick = () => {
      if (ctx && c) {
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]!;
          p.life -= 0.035;
          p.x += p.vx;
          p.y += p.vy;
          if (p.life <= 0) {
            parts.splice(i, 1);
            continue;
          }
          ctx.beginPath();
          ctx.fillStyle = `rgba(34,211,238,${p.life * 0.35})`;
          ctx.arc(p.x, p.y, 1.6 * p.life + 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      document.body.classList.remove("qp-cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", dn);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [enabled, x, y]);

  if (!enabled) return null;
  const size = label ? 74 : hover ? 46 : 30;
  return (
    <>
      <canvas ref={canvas} className="pointer-events-none fixed inset-0 z-[9997]" style={{ width: "100vw", height: "100vh" }} />
      <motion.div className="pointer-events-none fixed left-0 top-0 z-[9999]" style={{ x, y }}>
        <div className="-translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_12px_3px_rgba(34,211,238,.8)]" />
      </motion.div>
      <motion.div className="pointer-events-none fixed left-0 top-0 z-[9998]" style={{ x: rx, y: ry }}>
        <motion.div
          animate={{ width: size, height: size, scale: down ? 0.85 : 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
          className="-translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full border border-cyan-300/60 bg-cyan-300/[0.04] backdrop-blur-[1px]"
        >
          {label && <span className="whitespace-nowrap text-[9.5px] font-semibold uppercase tracking-wider text-cyan-100">{label}</span>}
        </motion.div>
      </motion.div>
    </>
  );
}
