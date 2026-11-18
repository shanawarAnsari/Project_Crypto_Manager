import { AnimatePresence, motion } from "framer-motion";
import { lazy, Suspense, useEffect, useRef } from "react";
import { useStore } from "./store/useStore";
import { connectLive, loadCandles } from "./lib/live";
import { useLenis } from "./lib/useLenis";
import { TopBar } from "./components/TopBar";
import { Dock } from "./components/Dock";
import { Footer } from "./components/Footer";
import { Toasts } from "./components/Toasts";
import { Confetti } from "./components/Confetti";
import { CommandPalette } from "./components/CommandPalette";
import { Onboarding } from "./components/Onboarding";
import { Cursor } from "./components/Cursor";
import { AccountPanel } from "./components/AccountPanel";
import { WhyThisTrade } from "./components/WhyThisTrade";
import { OverviewView } from "./views/OverviewView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { ViewId } from "./lib/types";

const ChartView = lazy(() => import("./views/ChartView").then((m) => ({ default: m.ChartView })));
const SignalsView = lazy(() => import("./views/SignalsView").then((m) => ({ default: m.SignalsView })));
const BacktestView = lazy(() => import("./views/BacktestView").then((m) => ({ default: m.BacktestView })));
const JournalView = lazy(() => import("./views/JournalView").then((m) => ({ default: m.JournalView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));

function Banner() {
  const banner = useStore((s) => s.banner);
  const dataSource = useStore((s) => s.dataSource);
  const analyst = useStore((s) => s.analystMode);
  const wsConnected = useStore((s) => s.wsConnected);
  const text = !wsConnected
    ? "Connecting to the Crypto Manager backend…"
    : banner ?? (dataSource === "demo" ? `DEMO MODE · synthetic replay with planted sweeps · paper trading${analyst === "llm" ? " · Analyst: LLM" : " · Analyst: rule-based"} · switch to Delta India live data in Settings` : null);
  if (!text) return null;
  return (
    <div className={`flex h-7 items-center justify-center gap-2 border-b text-[11.5px] ${banner || !wsConnected ? "border-warn/30 bg-warn/10 text-amber-100" : "border-cyan-neon/15 bg-cyan-500/[0.06] text-cyan-100/90"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${banner || !wsConnected ? "bg-warn animate-pulse" : "bg-cyan-neon"}`} />
      {text}
    </div>
  );
}

function View({ id }: { id: ViewId }) {
  switch (id) {
    case "overview": return <OverviewView />;
    case "chart": return <ChartView />;
    case "signals": return <SignalsView />;
    case "backtest": return <BacktestView />;
    case "journal": return <JournalView />;
    case "settings": return <SettingsView />;
  }
}

function Desk() {
  const view = useStore((s) => s.view);
  const instrument = useStore((s) => s.instrument);
  const rail = useRef<HTMLDivElement>(null);
  useLenis(rail);
  useEffect(() => {
    loadCandles(instrument).catch(() => undefined);
  }, [instrument]);
  return (
    <motion.div className="flex h-full flex-col" initial={{ opacity: 0, scale: 1.04, filter: "blur(8px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}>
      <TopBar />
      <Banner />
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 pb-[112px] xl:grid-cols-[minmax(0,1fr)_400px] xl:overflow-hidden">
        <section className="relative min-h-[560px] xl:min-h-0">
          <AnimatePresence mode="wait">
            <motion.div key={view} className="h-full" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              transition={{ type: "spring", stiffness: 260, damping: 28 }}>
              <ErrorBoundary label={`the ${view} view`}>
                <Suspense fallback={<div className="skeleton h-full rounded-2xl" />}><View id={view} /></Suspense>
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </section>
        <aside ref={rail} className="min-h-0 overflow-y-auto pr-0.5">
          <div className="flex flex-col gap-3 pb-2">
            <ErrorBoundary label="the account panel"><AccountPanel /></ErrorBoundary>
            <ErrorBoundary label="the trade explainer"><WhyThisTrade compact={view === "overview"} /></ErrorBoundary>
          </div>
        </aside>
      </main>
      <Dock />
      <Footer />
    </motion.div>
  );
}

export default function App() {
  useEffect(() => connectLive(), []);
  return (
    <div className="h-full">
      <Desk />
      <Toasts />
      <Confetti />
      <CommandPalette />
      <Onboarding />
      <Cursor />
    </div>
  );
}
