import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const target = `http://127.0.0.1:${env.PORT || 3000}`;
  return {
    base: './',
    envDir: root,
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': target, '/ws': { target, ws: true }, '/health': target },
    },
  };
});
