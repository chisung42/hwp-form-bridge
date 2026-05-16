import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 프로덕션은 nginx 아래 경로(https://도메인/hwp-form/)로 서빙할 때 자산 경로가 맞도록 base 설정
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/hwp-form/' : '/',
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
    // nginx 역프록시 Host 허용 (미설정 시 403 Forbidden host)
    allowedHosts: ['crumblycake.kro.kr'],
    proxy: {
      '/api/rhwp': 'http://localhost:8787',
    },
  },
}));
