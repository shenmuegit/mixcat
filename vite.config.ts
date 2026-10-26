import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  cacheDir: '.runtime/client/vite-cache',
  build: { outDir: 'dist/client/renderer', emptyOutDir: true, license: true },
});
