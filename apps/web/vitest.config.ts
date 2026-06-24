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
    // Dummy Supabase credentials so the client singleton (src/lib/supabase.ts)
    // instantiates under test/CI, where no real `.env` is present (it is
    // gitignored). `createClient` throws on an empty URL; tests mock the actual
    // auth/network behavior, so any syntactically-valid placeholder works.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    server: {
      deps: {
        // MUI's Tooltip/transition code imports react-transition-group via a
        // subpath that Vitest's default ESM resolver rejects as a directory
        // import. Inlining lets Vite transform it so the suite resolves cleanly.
        // Still required under Vitest 4 (verified: dropping it reintroduces the
        // react-transition-group directory-import failure).
        inline: [/@mui\/material/, /react-transition-group/],
      },
    },
  },
})
