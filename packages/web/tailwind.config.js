/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Paddock palette: warm, earthy, easy on the eyes.
        paddock: {
          50: "#f6f5f0",
          100: "#e9e6da",
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
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
