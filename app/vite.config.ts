import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The engine worker and contracts.ts live above this package in the workspace.
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  worker: { format: 'es' },
});
