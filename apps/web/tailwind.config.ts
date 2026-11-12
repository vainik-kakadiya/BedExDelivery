import type { Config } from 'tailwindcss';

/** Colours come from CSS variables in src/styles.css so the brand is set in one place (PRD §4). */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: token('brand-primary'),
          secondary: token('brand-secondary'),
          dark: token('brand-dark'),
        },
        surface: token('surface'),
        border: token('border'),
        ink: token('ink'),
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        info: token('info'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      minHeight: { tap: '48px' },
      minWidth: { tap: '48px' },
    },
  },
  plugins: [],
} satisfies Config;
