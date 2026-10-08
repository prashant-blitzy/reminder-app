/**
 * Vite configuration for the reminder app's client workspace.
 *
 * One configuration serves the three consumers of this workspace:
 *
 *   - `vite build` (`npm run build`, or `npm run build --workspace client`)
 *     emits the production bundle to Vite's default output directory,
 *     `client/dist`, which `server/src/app.ts` serves statically from the same
 *     Express process. The output directory is therefore left at its default on
 *     purpose: it is a contract with the server, so moving it breaks `npm start`
 *     and the single-origin arrangement the app is built around.
 *
 *   - `vite` (`npm run dev --workspace client`, or the root `npm run dev`) serves
 *     the app in development and proxies `/api` to the Express server, so the
 *     client reaches the API through one origin in development exactly as it does
 *     in production. That is why no client module carries a base URL or an
 *     environment switch: every request is a relative `/api/...` path.
 *
 *   - `vitest run` (`npm test`, or `npm run test --workspace client`) reads the
 *     `test` block below, which is why the config helper is imported from
 *     `vitest/config` rather than from `vite`: only Vitest's helper types the
 *     `test` key.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The React transform is the only plugin this app needs. No service-worker or
  // PWA plugin is registered, and none may be: notifications are delivered only
  // while the app is open in a browser.
  plugins: [react()],

  server: {
    proxy: {
      // `/api` is the server's mount point for the reminder routes, and 3001 is
      // its default port (`PORT`). Development requests to `/api/...` are
      // forwarded to the Express process, so the browser sees a single origin.
      // Nothing else is proxied, so there is exactly one data path here as in
      // production.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
    // The dev server port is deliberately not set. Vite's default (5173) is the
    // port the documented `npm run dev` and the README instructions describe,
    // and this workspace has no Node type definitions, so the configuration
    // reads no environment variables. A caller that needs a different port
    // passes it on the command line: `vite --port <port> --strictPort`.
  },

  test: {
    // The client suite renders real components, so it needs a DOM environment.
    environment: 'jsdom',
    // `describe`, `it`, `expect` and `vi` are available in every test file
    // without an import; this matches the `vitest/globals` type entry in the
    // workspace's TypeScript configuration.
    globals: true,
    // Registers `@testing-library/jest-dom`'s matchers (`toBeInTheDocument` and
    // the rest) once for the whole suite. The path is relative to this
    // workspace's root, `client/`.
    setupFiles: ['./src/setupTests.ts'],
  },
});
