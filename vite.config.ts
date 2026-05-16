import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/rhwp': 'http://localhost:8787',
    },
  },
  preview: {
    proxy: {
      '/api/rhwp': 'http://localhost:8787',
    },
  },
});
