import { defineConfig } from 'vite';

// node:sqlite is reached via createRequire at runtime (see sqliteAdapter.ts),
// so it never appears as a static specifier here. Electron and Node builtins
// stay external because the main process runs in Node, not a browser.
export default defineConfig({
  build: {
    outDir: '.vite/build',
    lib: { entry: 'src/main/index.ts', formats: ['es'], fileName: () => 'main.js' },
    rollupOptions: { external: ['electron', /^node:/] },
    minify: false,
  },
});
