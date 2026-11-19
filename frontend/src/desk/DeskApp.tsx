import { useEffect, useState } from "react";
import { AgentFeed, Pipeline, SignalDetails } from "./components/Analysis";
import { Banner, KpiStrip, TopBar } from "./components/Header";
import { BacktestLab, Journal } from "./components/Lab";
import { Settings, Toasts } from "./components/Settings";
import { SweepChart } from "./components/SweepChart";
import { DeltaStatus, ExecutionLog, Positions, SignalFeed, TradeHistory } from "./components/Trading";
import { connectLive } from "./store";

const TABS = ["Delta India", "Backtest", "Journal", "Settings"] as const;
type Tab = (typeof TABS)[number];

export default function DeskApp() {
  const [tab, setTab] = useState<Tab>("Delta India");
  useEffect(() => connectLive(), []);
  return (
    <div className="min-h-screen bg-terminal-base text-terminal-text">
      <TopBar />
      <main className="mx-auto max-w-[1800px] space-y-4 p-4">
        <Banner />
        <KpiStrip />
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2"><SweepChart /></div>
          <SignalDetails />
        </div>
        <Pipeline />
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2"><Positions /></div>
          <SignalFeed />
        </div>
        <TradeHistory />
        <AgentFeed />
        <section className="panel">
          <header className="panel-head">
            <div className="flex flex-wrap gap-1" role="tablist">
              {TABS.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "tab-on" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
            </div>
          </header>
          {tab === "Delta India" && <div className="grid gap-4 p-4 xl:grid-cols-2"><DeltaStatus /><ExecutionLog /></div>}
          {tab === "Backtest" && <BacktestLab />}
          {tab === "Journal" && <Journal />}
          {tab === "Settings" && <Settings />}
        </section>
        <footer className="pb-6 text-center text-[11px] text-terminal-muted">
          Educational use only. Not financial advice. Trading crypto derivatives involves substantial risk of loss.
        </footer>
      </main>
      <Toasts />
    </div>
  );
}
