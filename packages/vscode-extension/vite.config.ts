import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const NODE_EXTERNALS = ['vscode', ...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)];

export default defineConfig({
  build: {
    target: 'node22',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    ssr: true,
    rollupOptions: {
      input: {
        extension: resolve(__dirname, 'src/extension.ts'),
        mcpToolServer: resolve(__dirname, 'src/mcpToolServer.ts'),
      },
      external: NODE_EXTERNALS,
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
