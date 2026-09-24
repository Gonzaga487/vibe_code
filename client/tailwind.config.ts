import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#effcf5',
          100: '#d9f8e7',
          200: '#b6efd2',
          300: '#84dfb7',
          400: '#4bc796',
          500: '#27aa79',
          600: '#198a62',
          700: '#166e51',
          800: '#155841',
          900: '#124936',
          950: '#082a1f'
        },
        energy: {
          50: '#fff8ed',
          100: '#ffefd4',
          200: '#fedbaa',
          300: '#fdbf73',
          400: '#fb963c',
          500: '#f57618',
          600: '#e95c0c',
          700: '#c3430b',
          800: '#9b3510',
          900: '#7d2d11'
        }
      },
      boxShadow: {
        panel: '0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 30px rgba(15, 23, 42, 0.05)',
        lift: '0 12px 35px rgba(15, 23, 42, 0.12)'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif']
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out'
      }
    }
  },
  plugins: []
} satisfies Config;
