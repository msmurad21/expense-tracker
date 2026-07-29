import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  // Relative so the bundle loads under the custom app:// scheme.
  base: './',
  plugins: [react()],
  build: { outDir: '../../.vite/build/renderer', emptyOutDir: true },
});
