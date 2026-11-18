import { motion, useMotionValue, useSpring, useReducedMotion } from "framer-motion";
import { useRef, type ReactNode, type MouseEvent } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  tilt?: boolean;
  cursor?: string;
  title?: ReactNode;
  right?: ReactNode;
  tour?: string;
  glow?: "cyan" | "profit" | "loss" | "violet" | "none";
}

const GLOW: Record<string, string> = {
  cyan: "hover:shadow-glow", profit: "shadow-profit", loss: "shadow-loss", violet: "hover:shadow-violet", none: "",
};

/** Glassmorphism card with a cursor-following spotlight and optional spring 3D tilt. */
export function Glass({ children, className = "", tilt = false, cursor, title, right, tour, glow = "cyan" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const rx = useSpring(useMotionValue(0), { stiffness: 180, damping: 18 });
  const ry = useSpring(useMotionValue(0), { stiffness: 180, damping: 18 });

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    el.style.setProperty("--mx", `${x}px`);
    el.style.setProperty("--my", `${y}px`);
    if (tilt && !reduce) {
      ry.set(((x / r.width) - 0.5) * 7);
      rx.set(-((y / r.height) - 0.5) * 7);
    }
  };
  const onLeave = () => {
    rx.set(0);
    ry.set(0);
    ref.current?.style.setProperty("--mx", "-500px");
  };

  return (
    <motion.div
      ref={ref}
      data-cursor={cursor}
      data-tour={tour}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={tilt ? { rotateX: rx, rotateY: ry, transformPerspective: 900 } : undefined}
      className={`glass spotlight transition-shadow duration-300 ${GLOW[glow]} ${className}`}
    >
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
          <div className="label">{title}</div>
          {right}
        </div>
      )}
      {children}
    </motion.div>
  );
}
