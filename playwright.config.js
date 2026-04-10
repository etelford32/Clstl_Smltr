// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    retries: 1,
    use: {
        baseURL: process.env.TEST_BASE_URL || 'http://localhost:8000',
        headless: true,
        screenshot: 'only-on-failure',
        trace: 'on-first-retry',
        viewport: { width: 1280, height: 720 },
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
    ],
    webServer: process.env.CI ? undefined : {
        command: 'node dev-server.mjs',
        port: 8000,
        reuseExistingServer: true,
        timeout: 15_000,
    },
});
