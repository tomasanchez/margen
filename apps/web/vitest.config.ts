import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Vitest configuration for the Margen web app (ADR-008).
 *
 * Kept separate from vite.config.ts so the production build (tsc -b + vite
 * build, typed against Vite 8) stays free of Vitest's config types. Runs in a
 * jsdom environment with global test APIs and jest-dom matchers loaded via the
 * setup file.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    server: {
      deps: {
        // MUI's Tooltip/transition code imports react-transition-group via a
        // subpath that Vitest's default ESM resolver rejects as a directory
        // import. Inlining lets Vite transform it so the suite resolves cleanly.
        inline: [/@mui\/material/, /react-transition-group/],
      },
    },
  },
})
