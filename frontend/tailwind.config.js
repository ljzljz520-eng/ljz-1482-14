/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#165DFF",
        accent: "#FF7D00"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"]
      },
      boxShadow: {
        card: "0 10px 40px rgba(15, 23, 42, 0.08)"
      },
      backgroundImage: {
        "hero-gradient": "linear-gradient(120deg, rgba(22, 93, 255, 0.16), rgba(255, 125, 0, 0.18))"
      }
    }
  },
  plugins: []
};
