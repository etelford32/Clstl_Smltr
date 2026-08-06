import { test, expect } from '@playwright/test';

const weatherPayload = {
    ls_deg: 168.4,
    message: 'Ls 168° · clear skies · τ < 0.4',
    mission: {
        perseverance: {
            status: 'operational',
            latest_drive: { sol: 1940, distance_km: 44.14, checked_at: '2026-08-05' },
            position: { sol: 1726, lat_deg: 18.427755, lon_deg: 77.235291 },
            meda_archive: { latest_verified_sol: 1726 },
        },
    },
    rovers: {
        perseverance: {
            active: true,
            sol: 1133,
            terrestrial_date: '2024-04-27',
            min_temp_C: -79.3,
            max_temp_C: -24.7,
            pressure_pa: 778.9,
            wind_speed_mps: null,
            ls_deg: 249,
            season: 'Month 9',
            observation_status: 'historical',
            observation_age_days: 830,
            source: 'NASA Mars 2020 MEDA via mars.nasa.gov',
        },
    },
};

const skyRows = {
    '10':  [100.8, -5.2, 1.486, 2.0],
    '399': [78.9, -26.7, 1.978, -7.6],
    '301': [78.8, -26.8, 1.980, -7.5],
    '1;':  [212.4, 31.2, 2.214, 8.1],
    '4;':  [301.7, 12.8, 3.441, -3.4],
};

function horizonsObserverResult(command) {
    const [azimuth, elevation, range, rate] = skyRows[command];
    return `$$SOE
 2026-Aug-05 20:00:00.000, , , ${azimuth}, ${elevation}, ${range}, ${rate},
 2026-Aug-05 21:00:00.000, , , ${azimuth + 10}, ${elevation + 5}, ${range + 0.001}, ${rate + 0.1},
$$EOE`;
}

test('Real-Time Mars boots, preserves provenance, and exposes working layers', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/api/mars/weather', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(weatherPayload),
    }));
    await page.route('**/api/horizons?**', route => {
        const command = new URL(route.request().url()).searchParams.get('COMMAND').replaceAll("'", '');
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ result: horizonsObserverResult(command) }),
        });
    });

    await page.goto('/mars.html');
    await expect(page.locator('#loading-screen')).toHaveClass(/done/, { timeout: 20_000 });
    await expect(page.locator('#mars-canvas')).toBeVisible();
    await expect(page.locator('#drive-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#fix-sol')).toHaveText('Sol 1940');
    await expect(page.locator('#pds-sol')).toHaveText('Sol 1726');
    await expect(page.locator('#route-sol')).toBeEnabled();
    await expect(page.locator('#route-sol-output')).toContainText('Sol 1940');
    await expect(page.locator('#feed-state')).toContainText('Historical MEDA summary');
    await expect(page.locator('#weather-warning')).toContainText('not live telemetry');
    await expect(page.locator('#weather-temp')).toHaveText('-79.3 → -24.7 °C');
    await expect(page.locator('#weather-wind')).toHaveText('—');
    await expect(page.locator('#sky-feed-title')).toContainText('live 5/5');
    await expect(page.locator('#sky-earth-status')).toContainText('Az');
    await expect(page.locator('#terminator-source')).toContainText('JPL Sun direction');

    const relief = page.locator('[data-layer="relief"]');
    await expect(relief).toBeChecked();
    await relief.uncheck({ force: true });
    await expect(relief).not.toBeChecked();

    const terminator = page.locator('[data-layer="terminator"]');
    await expect(terminator).toBeChecked();
    await terminator.uncheck({ force: true });
    await expect(terminator).not.toBeChecked();

    const earthSky = page.locator('[data-layer="sky-earth"]');
    await expect(earthSky).toBeChecked();
    await earthSky.uncheck({ force: true });
    await expect(earthSky).not.toBeChecked();

    const layersPanel = page.locator('.layers-panel');
    await layersPanel.locator('.panel-toggle').click();
    await expect(layersPanel).toHaveClass(/collapsed/);
    await expect(layersPanel.locator('.panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
});
