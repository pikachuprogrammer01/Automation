import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 构建产物直接落到 ../public，由 manager/server.mjs 静态托管（运行时不需要 dev server）。
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 4760,
    proxy: { '/api': { target: 'http://127.0.0.1:4765' } },
  },
});
