/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      copyDtsFiles: true,
      exclude: ['src/tests', '**/*.spec.ts', '**/*.test.ts'],
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        browser: 'src/browser/index.ts',
        vite: 'src/vite/index.ts',
      },
      name: 'TWDRelay',
      fileName: (format, entryName) => `${entryName}.${format}.js`,
    },
    rollupOptions: {
      external: ['ws', 'http', 'stream', 'vite', 'twd-js', 'twd-js/runner'],
      output: {
        exports: 'named',
        compact: true,
      },
    },
    minify: 'esbuild',
    target: 'es2020',
  },
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist'],
    coverage: {
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts', '!src/tests/**'],
      exclude: ['src/tests/**', '**/*.spec.ts'],
    },
  },
});
