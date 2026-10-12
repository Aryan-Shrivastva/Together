import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  const port = Number(environment.CLIENT_PORT ?? 5173);
  const proxyTarget = environment.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';
  const allowedHosts = (environment.VITE_ALLOWED_HOSTS ?? 'localhost')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        {
          find: /^monaco-editor\/esm\/vs\/editor\/editor\.api\.js$/,
          replacement: fileURLToPath(
            new URL('../node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
          ),
        },
      ],
    },
    optimizeDeps: {
      exclude: ['y-monaco'],
    },
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      allowedHosts,
      proxy: {
        '/health': proxyTarget,
        '/auth': proxyTarget,
        '/api': proxyTarget,
        '/socket.io': {
          target: proxyTarget,
          ws: true,
        },
        '/yjs': {
          target: proxyTarget,
          ws: true,
        },
      },
    },
  };
});
