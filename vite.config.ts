import { defineConfig } from 'vitest/config';

// the live colony's server (npm run live), reached through the same origin as the page; /live itself is the
// page that watches it, so only what is under /live/ goes through
const live = { '/live/': { target: 'http://127.0.0.1:5198' } };

export default defineConfig({
  server: { port: 5199, proxy: live },
  preview: { proxy: live },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
