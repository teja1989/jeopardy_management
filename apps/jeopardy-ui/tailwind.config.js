/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', '-apple-system', 'sans-serif'],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      keyframes: {
        'sse-flash': {
          '0%': { boxShadow: '0 0 0 0 rgba(26, 115, 232, 0.5)' },
          '70%': { boxShadow: '0 0 0 10px rgba(26, 115, 232, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(26, 115, 232, 0)' },
        },
      },
      animation: {
        'sse-flash': 'sse-flash 1.1s ease-out',
      },
    },
  },
  plugins: [],
};
