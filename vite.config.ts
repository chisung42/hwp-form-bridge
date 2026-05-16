import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // ARM Linux(예: Raspberry Pi)에서 lightningcss 네이티브 바이너리가 없을 때 빌드 실패 방지
    cssMinify: 'esbuild',
  },
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
