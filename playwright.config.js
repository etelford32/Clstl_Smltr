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
        // Chromium runs the full suite (unchanged baseline).
        { name: 'chromium', use: { browserName: 'chromium' } },
        // Firefox + WebKit run ONLY the cross-browser auth E2E suite, so the
        // heavy WASM/simulator specs don't balloon the matrix while the auth
        // flows still get true three-engine coverage. See tests/auth-e2e.spec.js.
        { name: 'firefox-auth', use: { browserName: 'firefox' }, testMatch: /auth-e2e\.spec\.js/ },
        { name: 'webkit-auth',  use: { browserName: 'webkit'  }, testMatch: /auth-e2e\.spec\.js/ },
    ],
    webServer: {
        command: 'PORT=8000 node dev-server.mjs',
        port: 8000,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
