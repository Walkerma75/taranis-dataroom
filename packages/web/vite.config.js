import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build identifier — injected at compile time
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;
const buildId = `DR-0.1.0-b${buildStamp}`;

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://api:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
