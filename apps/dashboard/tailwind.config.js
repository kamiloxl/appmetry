/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f8f6f3',
        ink: '#1c1917',
        installs: '#8dbdf0',
        installsSoft: '#e4f0fc',
        revenue: '#e07b5f',
        revenueSoft: '#fadbd1',
      },
      boxShadow: { card: '0 1px 2px rgba(28,25,23,0.04), 0 1px 1px rgba(28,25,23,0.02)' },
    },
  },
  plugins: [],
};
