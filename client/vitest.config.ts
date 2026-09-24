import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(currentDirectory, 'src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/vitest.setup.ts',
    include: ['src/**/*.vitest.ts'],
    globals: true,
    restoreMocks: true,
  },
});
