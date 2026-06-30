import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ocean: {
          50:  "#caf0f8",
          100: "#ade8f4",
          200: "#90e0ef",
          300: "#48cae4",
          400: "#00b4d8",
          500: "#0096c7",
          600: "#0077b6",
          700: "#023e8a",
          800: "#03045e",
          900: "#020038",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "pulse-slow":  "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "slide-up":    "slideUp 0.3s ease-out",
        "fade-in":     "fadeIn 0.4s ease-out",
        "wave":        "wave 8s ease-in-out infinite",
      },
      keyframes: {
        slideUp: {
          "0%":   { transform: "translateY(16px)", opacity: "0" },
          "100%": { transform: "translateY(0)",    opacity: "1" },
        },
        fadeIn: {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        wave: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%":       { backgroundPosition: "100% 50%" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
