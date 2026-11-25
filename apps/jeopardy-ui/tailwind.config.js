/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      keyframes: {
        'sse-flash': {
          '0%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0.55)' },
          '70%': { boxShadow: '0 0 0 8px rgba(59, 130, 246, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0)' },
        },
      },
      animation: {
        'sse-flash': 'sse-flash 1.1s ease-out',
      },
    },
  },
  plugins: [],
};
