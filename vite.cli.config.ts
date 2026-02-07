import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/cli/standalone.ts',
      formats: ['es'],
      fileName: () => 'cli.js',
    },
    rollupOptions: {
      external: ['ws', 'http', 'stream'],
    },
    minify: false,
    target: 'node18',
    outDir: 'dist',
    emptyOutDir: false,
  },
});
