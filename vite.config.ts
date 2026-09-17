import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite.ts';
export default defineConfig({
  base: './',
  resolve: { alias: electrobunViteAliases(resolve('.hutch/devkit')) },
  plugins: [
    react(),
    {
      name: 'development-refresh-csp',
      transformIndexHtml: {
        order: 'pre',
        handler(html, context) {
          // React Fast Refresh injects an inline bootstrap in development only.
          return context.server
            ? html
                .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
                .replace("connect-src 'self';", "connect-src 'self' ws://127.0.0.1:*;")
            : html;
        },
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: false },
});
