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
      },
    },
  },
  plugins: [forms],
} satisfies Config;
