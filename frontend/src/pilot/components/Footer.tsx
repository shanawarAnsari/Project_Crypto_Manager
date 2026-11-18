import { LogoMark } from "./Logo";

/** Footer on every screen with the product name and trading disclaimer. */
export function Footer() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 flex h-8 items-center gap-3 border-t border-white/[0.06] bg-space-950/85 px-4 text-[11px] text-slate-400 backdrop-blur-xl">
      <LogoMark size={16} spin={false} />
      <span className="font-display font-semibold tracking-widest grad-text">CRYPTO MANAGER</span>
      <span className="hidden sm:inline">Delta Exchange India</span>
      <span className="mx-auto font-medium text-amber-200/90">Educational use only. Not financial advice. Trading involves risk of loss.</span>
    </footer>
  );
}
