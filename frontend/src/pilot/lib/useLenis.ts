import { useEffect, type RefObject } from "react";
import Lenis from "lenis";
import { prefersReducedMotion } from "./format";

/** Attach Lenis smooth scrolling to a scroll container (skipped under prefers-reduced-motion). */
export function useLenis(ref: RefObject<HTMLElement | null>, deps: unknown[] = []): void {
  useEffect(() => {
    const wrapper = ref.current;
    const content = wrapper?.firstElementChild as HTMLElement | null;
    if (!wrapper || !content || prefersReducedMotion()) return;
    const lenis = new Lenis({ wrapper, content, smoothWheel: true, lerp: 0.12 });
    let raf = 0;
    const loop = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, deps);
}
