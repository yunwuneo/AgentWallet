import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Vite server (5173) proxies API and MCP calls to the AgentWallet server.
// In production the built files in dist/ are served by that server on its single port.
const target = process.env.AGENTWALLET_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target },
      '/mcp': { target },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
  },
});
