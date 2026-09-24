import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: '../wrangler.jsonc' },
    miniflare: {
      d1Databases: ['DB'],
      bindings: {
        // Non-production test-only value; deployment secrets live in
        // Cloudflare secret bindings and .dev.vars is git-ignored.
        JWT_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}Aa1!`,
        FRONTEND_ORIGINS: 'http://localhost:5173',
      },
    },
  })],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
