import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; label?: string }
interface State { failed: boolean }

/** Contains a render failure to one panel and shows a friendly retry card (never a stack trace). */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[Crypto Manager] ${this.props.label ?? "panel"} recovered from a render error`, error.message, info.componentStack?.slice(0, 200));
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="glass flex flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="font-display text-sm font-semibold text-amber-200">This panel hit a snag</div>
        <p className="text-xs text-slate-400">The rest of the desk keeps running. Retry to reload {this.props.label ?? "it"}.</p>
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => this.setState({ failed: false })}>Retry</button>
      </div>
    );
  }
}
