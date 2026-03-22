import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import istanbul from 'vite-plugin-istanbul';
import { twdRemote } from 'twd-relay/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    twdRemote(),
    // configure istanbul plugin
    istanbul({
      include: 'src/**/*',
      exclude: ['node_modules', 'dist', 'twd-tests/**'],
      extension: ['.ts', '.tsx'],
      requireEnv: process.env.CI ? true : false,
    }),
  ],
})
