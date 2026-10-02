import { defineConfig } from 'vite';

/* GitHub Pages serves the game under /<repo>/, so the deploy workflow sets
   this; locally it stays at the root. */
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  server: { port: 5180, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  optimizeDeps: { exclude: [] },
  worker: { format: 'es' },
});
