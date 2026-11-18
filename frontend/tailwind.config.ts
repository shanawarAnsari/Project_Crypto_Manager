import type { Config } from "tailwindcss";
import forms from "@tailwindcss/forms";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        terminal: {
          base: "#090d12",
          panel: "#10161e",
          border: "#202a36",
          muted: "#8794a5",
          text: "#e5edf5",
          green: "#35d39a",
          red: "#f07178",
          blue: "#60a5fa",
          amber: "#f0b968",
        },
        space: { 950: "#03040b", 900: "#05060f", 800: "#0a0c1c", 700: "#11142b" },
        cyan: { neon: "#22d3ee" },
        violet: { neon: "#8b5cf6" },
        profit: "#10b981",
        loss: "#f43f5e",
        warn: "#f59e0b",
      },
      fontFamily: {
        display: ['"Space Grotesk"', "Inter", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(34,211,238,.35)",
        violet: "0 0 24px rgba(139,92,246,.35)",
        profit: "0 0 24px rgba(16,185,129,.4)",
        loss: "0 0 24px rgba(244,63,94,.45)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        shake: {
          "0%,100%": { transform: "translateX(0)" },
          "20%,60%": { transform: "translateX(-4px)" },
          "40%,80%": { transform: "translateX(4px)" },
        },
        pulseRing: { "0%": { transform: "scale(.8)", opacity: ".8" }, "100%": { transform: "scale(2.2)", opacity: "0" } },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        shake: "shake .45s ease-in-out",
        pulseRing: "pulseRing 1.8s ease-out infinite",
      },
    },
  },
  plugins: [forms],
} satisfies Config;
