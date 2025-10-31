/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        'brand-dark': '#0F172A',
        'brand-component': '#1E293B',
        'brand-border': '#334155',
        'brand-text-light': '#F8FAFC',
        'brand-text-dim': '#94A3B8',
        'brand-accent': '#3B82F6',
        'brand-accent-hover': '#2563EB',
        'brand-green': '#10B981',
        'brand-red': '#EF4444',
      }
    },
  },
  plugins: [],
}