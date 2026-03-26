// @ts-check
const { defineConfig } = require('@playwright/test');

/**
 * Playwright configuration for idle-time feature E2E tests.
 * Runs against the Forge Custom UI tunnel (forge tunnel --debug).
 */
module.exports = defineConfig({
  testDir: './idle-time',
  timeout: 60_000,
  retries: 1,
  use: {
    // Set via FORGE_TUNNEL_URL env var or default to local tunnel
    baseURL: process.env.FORGE_TUNNEL_URL || 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
