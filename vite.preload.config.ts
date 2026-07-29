import { defineConfig } from 'vite';

// CommonJS on purpose: a sandboxed preload script cannot be an ES module.
export default defineConfig({
  build: {
    outDir: '.vite/build/preload',
    lib: { entry: 'src/preload/index.ts', formats: ['cjs'], fileName: () => 'index.cjs' },
    rollupOptions: { external: ['electron'] },
    minify: false,
  },
});
