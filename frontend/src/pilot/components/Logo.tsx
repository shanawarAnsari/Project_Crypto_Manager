/** Animated orbiting-ring product mark. */
export function LogoMark({ size = 36, spin = true }: { size?: number; spin?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="qp-g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <radialGradient id="qp-core">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.4" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="13" fill="url(#qp-core)" opacity="0.9" />
      <circle cx="32" cy="32" r="5" fill="#e0fbff" />
      {[0, 60, 120].map((rot, i) => (
        <g key={rot} transform={`rotate(${rot} 32 32)`}>
          <g
            style={{
              transformOrigin: "32px 32px", transformBox: "view-box",
              animation: spin ? `qp-spin ${9 + i * 3}s linear infinite${i === 1 ? " reverse" : ""}` : undefined,
            }}
          >
            <ellipse cx="32" cy="32" rx="27" ry="10" fill="none" stroke="url(#qp-g)" strokeWidth="2.2" opacity={0.9 - i * 0.2} />
            <circle cx="59" cy="32" r="2.6" fill={i === 1 ? "#10b981" : "#22d3ee"} />
          </g>
        </g>
      ))}
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <LogoMark size={compact ? 30 : 40} />
      <div className="leading-none">
        <div className={`font-display font-bold tracking-[0.18em] grad-text ${compact ? "text-[15px]" : "text-xl"}`}>CRYPTO MANAGER</div>
        <div className={`text-slate-400 ${compact ? "text-[9.5px] mt-1" : "text-xs mt-1.5"}`}>
          Delta Exchange India · Liquidity Sweep Desk
        </div>
      </div>
    </div>
  );
}
