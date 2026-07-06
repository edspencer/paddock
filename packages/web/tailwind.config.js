/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Paddock palette: warm, earthy neutrals — easy on the eyes.
        paddock: {
          50: "#f7f6f1",
          100: "#eceadf",
          200: "#d4cdb6",
          300: "#bbae8c",
          400: "#a4926a",
          500: "#8f7c54",
          600: "#736244",
          700: "#5b4d39",
          800: "#3e3528",
          900: "#28221a",
          950: "#171410",
        },
        // Accent: the single "action" color. Runtime-configurable per instance
        // (issue #34) — the channels come from CSS custom properties (defaults
        // in index.css, overridable via a server-injected style). The
        // `rgb(var(--x) / <alpha-value>)` form preserves opacity modifiers
        // (bg-accent/15, ring-accent/20, …).
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          600: "rgb(var(--accent-600) / <alpha-value>)",
          700: "rgb(var(--accent-700) / <alpha-value>)",
        },
        // Semantic surface + text tokens (drive base body styling).
        canvas: {
          DEFAULT: "#f7f6f1",
          dark: "#141210",
        },
        ink: {
          DEFAULT: "#28221a",
          dark: "#ece9e0",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "scale-in": "scale-in 0.18s ease-out",
      },
    },
  },
  plugins: [],
};
