/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#1D3A6B',
        'primary-hover': '#254880',
        accent: '#3B82F6',
        'bg-workspace': '#F5F7FA',
        surface: '#FFFFFF',
        'surface-soft': '#F9FAFB',
        border: '#E2E8F0',
        'text-primary': '#111827',
        'text-secondary': '#4B5563',
        'text-muted': '#9CA3AF',
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
      },
      boxShadow: {
        soft: '0 20px 70px rgba(17, 24, 39, 0.12)',
        subtle: '0 10px 30px rgba(17, 24, 39, 0.06)',
      },
      borderRadius: {
        xl: '18px',
      },
      spacing: {
        13: '3.25rem',
      },
    },
  },
  plugins: [],
}

