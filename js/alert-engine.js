/**
 * alert-engine.js — Client-side alert trigger engine
 *
 * Evaluates live space weather + local weather data against user alert
 * preferences and fires in-app notifications when thresholds are crossed.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *  1. Listens to 'swpc-update' events (solar wind, Kp, flares, CMEs)
 *  2. Listens to 'cme-propagation-update' events (DBM physics predictions)
 *  3. Polls Open-Meteo every 30 min for user-location weather (temp, cloud, sun)
 *  4. Checks each alert type against user preferences from auth.getAlertPrefs()
 *  5. Applies cooldown to prevent re-firing the same alert type repeatedly
 *  6. Plan-gates: basic tier gets Tier 1 alerts, advanced gets all
 *  7. Writes to Supabase alert_history table (if connected)
 *  8. Dispatches 'user-alert' CustomEvent for the notification bell
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  import { AlertEngine } from './js/alert-engine.js';
 *  const engine = new AlertEngine().start();
 *  window.addEventListener('user-alert', e => showBell(e.detail));
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';
import { loadUserLocation } from './user-location.js';
import { ConjunctionMonitor } from './conjunction-alert.js';

// ── Open-Meteo point forecast ────────────────────────────────────────────────

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const WEATHER_POLL_MS = 30 * 60_000;  // 30 minutes

/**
 * Fetch point forecast for a lat/lon from Open-Meteo (free, no API key).
 * Returns current conditions + today/tomorrow high/low + cloud cover + sunrise/sunset.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|null>}
 */
async function fetchPointWeather(lat, lon) {
    const params = new URLSearchParams({
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        current: 'temperature_2m,cloud_cover,is_day,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,sunrise,sunset',
        temperature_unit: 'fahrenheit',
        timezone: 'auto',
        forecast_days: '2',
    });
    try {
        const res = await fetch(`${OPEN_METEO_URL}?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;
        return {
            temp_f:      data.current?.temperature_2m,
            cloud_cover: data.current?.cloud_cover,        // 0-100%
            is_day:      data.current?.is_day,              // 1 = day, 0 = night
            // Today's forecast
            today_high:  data.daily?.temperature_2m_max?.[0],
            today_low:   data.daily?.temperature_2m_min?.[0],
            sunrise:     data.daily?.sunrise?.[0],          // ISO string
            sunset:      data.daily?.sunset?.[0],
            // Tomorrow's forecast
            tomorrow_high: data.daily?.temperature_2m_max?.[1],
            tomorrow_low:  data.daily?.temperature_2m_min?.[1],
            fetched_at:  Date.now(),
        };
    } catch (e) {
        console.warn('[AlertEngine] Weather fetch failed:', e.message);
        return null;
    }
}

// ── Flare class helpers ──────────────────────────────────────────────────────

const FLARE_ORDER = { A: 0, B: 1, C: 2, M: 3, X: 4 };

function flareClassToLetter(flux) {
    if (flux >= 1e-4) return 'X';
    if (flux >= 1e-5) return 'M';
    if (flux >= 1e-6) return 'C';
    if (flux >= 1e-7) return 'B';
    return 'A';
}

function flareAtOrAbove(currentFlux, threshold) {
    const cur = FLARE_ORDER[flareClassToLetter(currentFlux)] ?? 0;
    const thr = FLARE_ORDER[threshold?.charAt?.(0)?.toUpperCase()] ?? 3;
    return cur >= thr;
}

// ── G-scale from Kp ──────────────────────────────────────────────────────────

function kpToGScale(kp) {
    if (kp >= 9) return 5;
    if (kp >= 8) return 4;
    if (kp >= 7) return 3;
    if (kp >= 6) return 2;
    if (kp >= 5) return 1;
    return 0;
}

// ── R-scale from X-ray flux ──────────────────────────────────────────────────

function fluxToRScale(flux) {
    if (flux >= 2e-3) return 5;
    if (flux >= 1e-3) return 4;
    if (flux >= 1e-4) return 3;
    if (flux >= 5e-5) return 2;
    if (flux >= 1e-5) return 1;
    return 0;
}

function gScaleSeverity(g) {
    if (g >= 4) return 'critical';
    if (g >= 2) return 'warning';
    return 'info';
}

// ── Alert definitions ────────────────────────────────────────────────────────

/**
 * Each alert type has:
 *   key       — matches the notify_* preference field
 *   type      — alert_type enum in alert_history table
 *   tier      — 'basic' or 'advanced' plan requirement
 *   source    — 'swpc' (evaluated on swpc-update) or 'weather' (evaluated on weather poll)
 *   evaluate  — fn(state, prefs, ctx) → { fire, title, body, severity, metadata } | null
 *               ctx = { weather, cmeEvents } — extra data from weather/CME sources
 */
const ALERT_DEFS = [
    // ── Temperature (first alert users configure) ────────────────────────────
    {
        key: 'notify_temperature',
        type: 'storm',  // reuse type; alert_history only has: conjunction|aurora|storm|flare|pass
        tier: 'basic',
        source: 'weather',
        evaluate(_state, prefs, ctx) {
            const w = ctx.weather;
            if (!w) return null;
            const hi = prefs.temp_high_f;
            const lo = prefs.temp_low_f;
            // Check tomorrow's forecast high/low against thresholds
            const forecastHi = w.tomorrow_high ?? w.today_high;
            const forecastLo = w.tomorrow_low  ?? w.today_low;
            const city = loadUserLocation()?.city ?? 'your location';

            if (hi != null && forecastHi != null && forecastHi >= hi) {
                return {
                    fire: true,
                    title: 'High Temperature Alert',
                    body: `Forecast high of ${Math.round(forecastHi)}°F at ${city} exceeds your ${Math.round(hi)}°F threshold.`,
                    severity: forecastHi >= hi + 10 ? 'critical' : 'warning',
                    metadata: { forecast_high: forecastHi, threshold: hi, city },
                };
            }
            if (lo != null && forecastLo != null && forecastLo <= lo) {
                return {
                    fire: true,
                    title: 'Low Temperature Alert',
                    body: `Forecast low of ${Math.round(forecastLo)}°F at ${city} is below your ${Math.round(lo)}°F threshold.`,
                    severity: forecastLo <= lo - 10 ? 'critical' : 'warning',
                    metadata: { forecast_low: forecastLo, threshold: lo, city },
                };
            }
            return null;
        },
    },

    // ── Aurora — multi-factor (Kp + location + cloud cover + darkness) ───────
    {
        key: 'notify_aurora',
        type: 'aurora',
        tier: 'basic',
        source: 'swpc',
        evaluate(state, prefs, ctx) {
            const kp = state.kp ?? 0;
            const threshold = prefs.aurora_kp_threshold ?? 5;
            if (kp < threshold) return null;

            const loc = loadUserLocation() ?? auth.getUser()?.location;
            if (!loc) {
                // No location — fire generic alert
                return {
                    fire: true,
                    title: 'Aurora Alert',
                    body: `Kp ${kp.toFixed(1)} — aurora activity elevated. Set your location for personalized forecasts.`,
                    severity: kp >= 7 ? 'critical' : 'warning',
                    metadata: { kp },
                };
            }

            // Check if aurora oval reaches user's latitude
            const magLat = Math.abs(loc.lat) + 3;  // rough geomagnetic offset
            const boundary = 72 - kp * (17 / 9);
            if (magLat < boundary) return null;

            // Multi-factor scoring
            const factors = [];
            let score = 60;  // base: Kp above threshold + oval reaches location

            // Cloud cover factor (from weather data)
            const w = ctx.weather;
            if (w && w.cloud_cover != null) {
                if (w.cloud_cover <= 25) {
                    score += 20;
                    factors.push('clear skies');
                } else if (w.cloud_cover <= 50) {
                    score += 10;
                    factors.push('partly cloudy');
                } else if (w.cloud_cover <= 75) {
                    factors.push('mostly cloudy');
                } else {
                    score -= 15;
                    factors.push('overcast — viewing unlikely');
                }
            }

            // Darkness factor
            if (w && w.is_day != null) {
                if (w.is_day === 0) {
                    score += 15;
                    factors.push('dark sky');
                } else {
                    // Check if sunset is within 2 hours
                    if (w.sunset) {
                        const sunsetMs = new Date(w.sunset).getTime();
                        const hoursToSunset = (sunsetMs - Date.now()) / 3.6e6;
                        if (hoursToSunset > 0 && hoursToSunset <= 2) {
                            score += 5;
                            factors.push(`sunset in ${Math.round(hoursToSunset * 60)}min`);
                        } else {
                            score -= 10;
                            factors.push('still daylight');
                        }
                    }
                }
            }

            // Kp strength bonus
            if (kp >= 7) score += 10;
            if (kp >= 8) score += 10;

            score = Math.max(0, Math.min(100, score));

            const city = loc.city ?? 'your location';
            const factorStr = factors.length ? ` (${factors.join(', ')})` : '';

            return {
                fire: true,
                title: `Aurora Alert — ${score}% visibility`,
                body: `Kp ${kp.toFixed(1)} — aurora likely visible from ${city}${factorStr}. Look ${loc.lat >= 0 ? 'north' : 'south'} for green/purple curtains.`,
                severity: score >= 75 ? 'critical' : 'warning',
                metadata: { kp, score, cloud_cover: w?.cloud_cover, is_day: w?.is_day, city },
            };
        },
    },

    // ── Geomagnetic Storm ────────────────────────────────────────────────────
    {
        key: 'notify_storm',
        type: 'storm',
        tier: 'basic',
        source: 'swpc',
        evaluate(state, prefs) {
            const kp = state.kp ?? 0;
            const g = kpToGScale(kp);
            const threshold = prefs.storm_g_threshold ?? 1;
            if (g < threshold) return null;
            return {
                fire: true,
                title: `G${g} Geomagnetic Storm`,
                body: `Kp index reached ${kp.toFixed(1)} — G${g} ${g >= 4 ? 'Severe' : g >= 3 ? 'Strong' : g >= 2 ? 'Moderate' : 'Minor'} geomagnetic storm conditions.`,
                severity: gScaleSeverity(g),
                metadata: { kp, g_scale: g },
            };
        },
    },

    // ── Solar Flare ──────────────────────────────────────────────────────────
    {
        key: 'notify_flare',
        type: 'flare',
        tier: 'basic',
        source: 'swpc',
        evaluate(state, prefs) {
            const flux = state.xray_flux ?? 0;
            const threshold = prefs.flare_class_threshold ?? 'M';
            if (!flareAtOrAbove(flux, threshold)) return null;
            const cls = flareClassToLetter(flux);
            return {
                fire: true,
                title: `${cls}-Class Solar Flare`,
                body: `GOES X-ray flux reached ${cls}-class level (${flux.toExponential(1)} W/m²).`,
                severity: cls === 'X' ? 'critical' : cls === 'M' ? 'warning' : 'info',
                metadata: { flux, class: cls },
            };
        },
    },

    // ── CME Earth-Directed (enhanced with DBM propagation) ───────────────────
    {
        key: 'notify_cme',
        type: 'storm',
        tier: 'basic',
        source: 'swpc',
        evaluate(state, _prefs, ctx) {
            const cme = state.earth_directed_cme;
            if (!cme) return null;

            // Try to get enhanced data from CmePropagator (DBM physics)
            const cmeEvents = ctx.cmeEvents ?? [];
            const dbmEvent = cmeEvents.find(e => e.earthDirected && e.hoursUntilArrival() > -6);

            let etaStr, impactStr = '', severity = 'warning';

            if (dbmEvent) {
                // Use physics-based prediction
                const etaH = dbmEvent.hoursUntilArrival();
                etaStr = etaH > 24 ? `${(etaH / 24).toFixed(1)} days` : `${Math.round(etaH)} hours`;
                const impact = dbmEvent.impact;
                if (impact) {
                    impactStr = ` Predicted impact: G${impact.g_scale} ${impact.severity}, Kp ${impact.kp_max?.toFixed(1)}, Dst ${impact.dst_min} nT.`;
                    if (impact.g_scale >= 3) severity = 'critical';
                }
                if (dbmEvent.sheath?.isShock) {
                    impactStr += ` Mach ${dbmEvent.sheath.mach.toFixed(1)} shock.`;
                }
            } else {
                // Fallback to basic ballistic estimate from SWPC feed
                const eta = state.cme_eta_hours;
                etaStr = eta != null
                    ? (eta > 24 ? `${(eta / 24).toFixed(1)} days` : `${Math.round(eta)} hours`)
                    : 'unknown';
                if ((cme.speed ?? 400) > 1000) severity = 'critical';
            }

            return {
                fire: true,
                title: 'Earth-Directed CME',
                body: `A coronal mass ejection is heading toward Earth. Speed: ${cme.speed ?? '?'} km/s. ETA: ${etaStr}.${impactStr}`,
                severity,
                metadata: {
                    speed: cme.speed,
                    eta: etaStr,
                    dbm: !!dbmEvent,
                    g_scale: dbmEvent?.impact?.g_scale,
                },
            };
        },
    },

    // ── Satellite Pass (ISS by default) ──────────────────────────────────────
    {
        key: 'notify_sat_pass',
        type: 'pass',
        tier: 'basic',
        source: 'weather',  // evaluated on weather poll cycle (not every 60s swpc tick)
        evaluate(_state, _prefs, ctx) {
            // Satellite pass prediction requires TLE data + SGP4 propagation.
            // For Phase 2, we provide a stub that will be wired to the Rust SGP4
            // module in a future phase. The architecture is ready; the evaluate
            // function will be filled in when the pass prediction service is built.
            // For now, this returns null (no-op).
            return null;
        },
    },

    // ── Radio Blackout (advanced) ────────────────────────────────────────────
    {
        key: 'notify_radio_blackout',
        type: 'flare',
        tier: 'advanced',
        source: 'earth-forecast',
        evaluate(_state, prefs, ctx) {
            const ef = ctx.earthForecast;
            if (!ef) return null;
            const r = ef.radio?.r_scale ?? 0;
            const threshold = prefs.radio_r_threshold ?? 2;
            if (r < threshold) return null;
            return {
                fire: true,
                title: `R${r} Radio Blackout`,
                body: `${ef.radio.desc} X-ray: ${ef.radio.xray_class}-class.`,
                severity: r >= 4 ? 'critical' : r >= 3 ? 'critical' : 'warning',
                metadata: { r_scale: r, xray_class: ef.radio.xray_class, threshold },
            };
        },
    },

    // ── GPS Degradation (advanced) ───────────────────────────────────────────
    {
        key: 'notify_gps',
        type: 'storm',
        tier: 'advanced',
        source: 'earth-forecast',
        evaluate(_state, prefs, ctx) {
            const ef = ctx.earthForecast;
            if (!ef) return null;
            const gnss = ef.gnss;
            const threshold = prefs.gnss_risk_threshold ?? 2;
            if (gnss.level < threshold) return null;
            const loc = loadUserLocation() ?? auth.getUser()?.location;
            const city = loc?.city;
            return {
                fire: true,
                title: `GNSS Risk: ${gnss.label}`,
                body: `${gnss.desc} L1 range delay: ${gnss.range_delay_m} m.${city ? ' (' + city + ')' : ''}`,
                severity: gnss.level >= 3 ? 'critical' : 'warning',
                metadata: { level: gnss.level, range_delay_m: gnss.range_delay_m, threshold },
            };
        },
    },

    // ── Power Grid Risk (advanced) ───────────────────────────────────────────
    {
        key: 'notify_power_grid',
        type: 'storm',
        tier: 'advanced',
        source: 'earth-forecast',
        evaluate(_state, prefs, ctx) {
            const ef = ctx.earthForecast;
            if (!ef) return null;
            const grid = ef.infrastructure?.powerGrid;
            const sat  = ef.infrastructure?.satellite;
            const g    = ef.timing?.current_g ?? 0;
            const threshold = prefs.power_grid_g_threshold ?? 4;
            if (g < threshold && grid.level < 2) return null;
            const loc = loadUserLocation() ?? auth.getUser()?.location;
            const lat = Math.abs(loc?.lat ?? 45);
            return {
                fire: true,
                title: `G${g} Power Grid Risk`,
                body: `${grid.desc}${sat.level >= 2 ? ' Satellite environment: ' + sat.desc : ''}`,
                severity: g >= 4 ? 'critical' : 'warning',
                metadata: { g_scale: g, grid_level: grid.level, sat_level: sat.level, lat, threshold },
            };
        },
    },

    // ── Ionospheric Disturbance (advanced) ──────────────────────────────────
    {
        key: 'notify_iono_disturbance',
        type: 'storm',
        tier: 'advanced',
        source: 'earth-forecast',
        evaluate(_state, _prefs, ctx) {
            const ef = ctx.earthForecast;
            if (!ef) return null;
            const iono = ef.ionosphere;
            if (!iono?.disturbed) return null;

            // Build a detailed body from layer statuses
            const parts = [];
            const dl = iono.layers?.dLayer;
            if (dl && dl.status !== 'NORMAL') parts.push(`D-layer: ${dl.desc}`);
            const el = iono.layers?.eLayer;
            if (el && el.status !== 'NORMAL') parts.push(`E-layer: ${el.desc}`);
            const f2 = iono.layers?.f2Layer;
            if (f2 && f2.status !== 'NORMAL') parts.push(`F2-layer: ${f2.desc}`);
            const tec = iono.layers?.tec;
            if (tec && tec.status !== 'NORMAL') parts.push(`TEC: ${tec.desc}`);

            const isBlackout = dl?.status === 'BLACKOUT';

            return {
                fire: true,
                title: isBlackout ? 'Ionospheric Blackout' : 'Ionospheric Disturbance',
                body: parts.length
                    ? parts.join(' ')
                    : iono.summary,
                severity: isBlackout ? 'critical' : 'warning',
                metadata: {
                    d_layer: dl?.status,
                    e_layer: el?.status,
                    f2_layer: f2?.status,
                    tec: tec?.value,
                },
            };
        },
    },

    // ── 27-Day Carrington Recurrence (advanced) ──────────────────────────────
    {
        key: 'notify_recurrence',
        type: 'storm',
        tier: 'advanced',
        source: 'swpc',
        _lastSignal: 'none',
        evaluate(state, _prefs, ctx) {
            // Uses the ImpactScoreEngine's recurrence data if available
            // Listens for impact-score-update events cached by the alert engine
            const recurrence = ctx.recurrence;
            if (!recurrence || recurrence.signal === 'none') {
                this._lastSignal = 'none';
                return null;
            }
            // Only fire when signal strengthens (not on every tick)
            if (recurrence.signal === this._lastSignal) return null;
            const wasWeaker = this._lastSignal === 'none' ||
                (this._lastSignal === 'weak' && recurrence.signal !== 'weak') ||
                (this._lastSignal === 'moderate' && recurrence.signal === 'strong');
            this._lastSignal = recurrence.signal;
            if (!wasWeaker) return null;

            return {
                fire: true,
                title: '27-Day Recurrence Detected',
                body: `${recurrence.signal.charAt(0).toUpperCase() + recurrence.signal.slice(1)} 27-day Carrington recurrence signal detected (r=${recurrence.corr27}). Active region may return to Earth-facing position within 3–5 days — elevated storm risk.`,
                severity: recurrence.signal === 'strong' ? 'warning' : 'info',
                metadata: { corr27: recurrence.corr27, corr54: recurrence.corr54, signal: recurrence.signal },
            };
        },
    },

    // ── Satellite Collision (advanced) ───────────────────────────────────────
    // This alert is triggered by 'conjunction-alert' events from ConjunctionMonitor,
    // not by swpc-update. It's handled specially in AlertEngine._onConjunction().
    {
        key: 'notify_collision',
        type: 'conjunction',
        tier: 'advanced',
        source: 'conjunction',  // special source — handled by separate listener
        evaluate() { return null; },  // no-op — _onConjunction() handles it directly
    },
];

// ─────────────────────────────────────────────────────────────────────────────
//  AlertEngine
// ─────────────────────────────────────────────────────────────────────────────

export class AlertEngine {
    constructor() {
        /** @type {Map<string, number>} alert type key → last fire timestamp (ms) */
        this._cooldowns = new Map();

        /** @type {Array<object>} recent alerts (in-memory for bell UI, newest first) */
        this.recent = [];

        /** Max recent alerts to keep in memory */
        this._maxRecent = 50;

        /** Supabase client (lazy) */
        this._sb = null;

        /** Cached weather data for user's location */
        this._weather = null;

        /** Cached CME propagation events */
        this._cmeEvents = [];

        /** Weather polling timer */
        this._weatherTimer = null;

        /** Last SWPC state (for weather-triggered re-evaluation) */
        this._lastSwpcState = null;

        /** Cached recurrence data from impact-score-update */
        this._recurrence = null;

        /** Cached earth-forecast data from earth-forecast-update */
        this._earthForecast = null;

        /** Conjunction monitor (advanced tier only) */
        this._conjMonitor = null;

        this._onSwpc          = this._onSwpc.bind(this);
        this._onCme           = this._onCme.bind(this);
        this._onImpactScore   = this._onImpactScore.bind(this);
        this._onConjunction   = this._onConjunction.bind(this);
        this._onEarthForecast = this._onEarthForecast.bind(this);
    }

    /** Start listening to events and polling weather. */
    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        window.addEventListener('cme-propagation-update', this._onCme);
        window.addEventListener('impact-score-update', this._onImpactScore);
        window.addEventListener('conjunction-alert', this._onConjunction);
        window.addEventListener('earth-forecast-update', this._onEarthForecast);
        this._loadRecentFromDB();
        this._pollWeather();
        this._weatherTimer = setInterval(() => this._pollWeather(), WEATHER_POLL_MS);

        // Start conjunction monitor for advanced users
        if (auth.canUseAdvancedAlerts()) {
            this._conjMonitor = new ConjunctionMonitor().start();
        }

        return this;
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
        window.removeEventListener('cme-propagation-update', this._onCme);
        window.removeEventListener('impact-score-update', this._onImpactScore);
        window.removeEventListener('conjunction-alert', this._onConjunction);
        window.removeEventListener('earth-forecast-update', this._onEarthForecast);
        clearInterval(this._weatherTimer);
        this._conjMonitor?.stop();
    }

    /** Get unread count. */
    getUnreadCount() {
        return this.recent.filter(a => !a.read).length;
    }

    /** Mark an alert as read by id. */
    markRead(alertId) {
        const alert = this.recent.find(a => a.id === alertId);
        if (alert) alert.read = true;
        this._markReadInDB(alertId);
        this._dispatch();
    }

    /** Mark all as read. */
    markAllRead() {
        this.recent.forEach(a => { a.read = true; });
        this._markAllReadInDB();
        this._dispatch();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onCme(ev) {
        this._cmeEvents = ev.detail?.events ?? [];
    }

    _onImpactScore(ev) {
        // Cache recurrence data for the 27-day recurrence alert
        this._recurrence = ev.detail?.d7?.recurrence ?? null;
    }

    _onEarthForecast(ev) {
        this._earthForecast = ev.detail ?? null;
        // Evaluate earth-forecast-source alerts whenever the forecast updates
        if (auth.isSignedIn() && auth.canUseAlerts()) {
            this._evaluateAlerts(this._lastSwpcState ?? {}, 'earth-forecast');
        }
    }

    _onConjunction(ev) {
        // Conjunction alert — fired by ConjunctionMonitor
        if (!auth.isSignedIn() || !auth.canUseAdvancedAlerts()) return;
        const prefs = auth.getAlertPrefs();
        if (!prefs.notify_collision) return;

        const c = ev.detail;
        if (!c) return;

        const riskLevel = c.dist_km < 1 ? 'critical' : c.dist_km < 5 ? 'critical' : c.dist_km < 10 ? 'warning' : 'info';
        const etaStr = c.hours_ahead < 1
            ? `${Math.round(c.hours_ahead * 60)} minutes`
            : c.hours_ahead < 24
                ? `${c.hours_ahead.toFixed(1)} hours`
                : `${(c.hours_ahead / 24).toFixed(1)} days`;

        const alert = {
            id: `notify_collision_${Date.now()}`,
            alert_type: 'conjunction',
            severity: riskLevel,
            title: 'Satellite Close Approach',
            body: `${c.target_name} — ${c.dist_km.toFixed(1)} km miss distance with ${c.chaser_name} in ${etaStr}. Threshold: ${c.threshold_km} km.`,
            metadata: {
                target: c.target_name,
                target_norad: c.target_norad,
                chaser: c.chaser_name,
                chaser_norad: c.chaser_norad,
                dist_km: c.dist_km,
                hours_ahead: c.hours_ahead,
            },
            read: false,
            created_at: new Date().toISOString(),
            _key: 'notify_collision',
        };

        this.recent.unshift(alert);
        if (this.recent.length > this._maxRecent) this.recent.pop();
        this._writeAlertToDB(alert);
        this._sendEmail(alert);
        this._dispatch(alert);
        console.info(`[AlertEngine] Fired: ${alert.title} — ${c.dist_km.toFixed(1)} km`);
    }

    _onSwpc(ev) {
        if (!auth.isSignedIn() || !auth.canUseAlerts()) return;
        this._lastSwpcState = ev.detail;
        this._evaluateAlerts(ev.detail, 'swpc');
    }

    /** Fetch weather for user's location and evaluate weather-triggered alerts. */
    async _pollWeather() {
        if (!auth.isSignedIn() || !auth.canUseAlerts()) return;

        const loc = loadUserLocation() ?? auth.getUser()?.location;
        if (!loc?.lat || !loc?.lon) return;

        const w = await fetchPointWeather(loc.lat, loc.lon);
        if (w) {
            this._weather = w;
            console.debug('[AlertEngine] Weather updated:', Math.round(w.temp_f) + '°F, cloud ' + w.cloud_cover + '%');
            // Evaluate weather-triggered alerts
            this._evaluateAlerts(this._lastSwpcState ?? {}, 'weather');
        }
    }

    /** Run all alert definitions of the given source type. */
    _evaluateAlerts(state, source) {
        const prefs = auth.getAlertPrefs();
        const cooldownMs = (prefs.alert_cooldown_min ?? 60) * 60_000;
        const isAdvanced = auth.canUseAdvancedAlerts();
        const now = Date.now();
        const ctx = { weather: this._weather, cmeEvents: this._cmeEvents, recurrence: this._recurrence, earthForecast: this._earthForecast };

        for (const def of ALERT_DEFS) {
            // Source filter: only evaluate defs matching the current trigger source
            if (def.source && def.source !== source) continue;

            // Plan gate
            if (def.tier === 'advanced' && !isAdvanced) continue;

            // Preference check
            if (!prefs[def.key]) continue;

            // Cooldown check
            const lastFire = this._cooldowns.get(def.key) ?? 0;
            if (now - lastFire < cooldownMs) continue;

            // Evaluate
            let result;
            try {
                result = def.evaluate(state, prefs, ctx);
            } catch (e) {
                console.warn(`[AlertEngine] Error evaluating ${def.key}:`, e.message);
                continue;
            }

            if (!result?.fire) continue;

            // Fire!
            const alert = {
                id: `${def.key}_${now}`,
                alert_type: def.type,
                severity: result.severity ?? 'info',
                title: result.title,
                body: result.body,
                metadata: result.metadata ?? {},
                read: false,
                created_at: new Date().toISOString(),
                _key: def.key,
            };

            this._cooldowns.set(def.key, now);
            this.recent.unshift(alert);
            if (this.recent.length > this._maxRecent) this.recent.pop();

            this._writeAlertToDB(alert);
            this._sendEmail(alert);
            this._dispatch(alert);

            console.info(`[AlertEngine] Fired: ${alert.title}`);
        }
    }

    _dispatch(newAlert = null) {
        window.dispatchEvent(new CustomEvent('user-alert', {
            detail: {
                alert: newAlert,
                recent: this.recent,
                unread: this.getUnreadCount(),
            },
        }));
    }

    async _getSb() {
        if (this._sb) return this._sb;
        if (!isConfigured()) return null;
        try { this._sb = await getSupabase(); } catch (_) {}
        return this._sb;
    }

    async _writeAlertToDB(alert) {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            await sb.from('alert_history').insert({
                user_id: userId,
                alert_type: alert.alert_type,
                severity: alert.severity,
                title: alert.title,
                body: alert.body,
                metadata: alert.metadata,
                read: false,
            });
        } catch (e) {
            console.warn('[AlertEngine] DB write failed:', e.message);
        }
    }

    /**
     * Send alert email via /api/alerts/email edge function.
     * Only sends if user has email_alerts enabled and severity meets minimum.
     */
    async _sendEmail(alert) {
        const prefs = auth.getAlertPrefs();
        if (!prefs.email_alerts) return;

        // Check minimum severity filter
        const minSev = prefs.email_min_severity ?? 'warning';
        const sevOrder = { info: 0, warning: 1, critical: 2 };
        if ((sevOrder[alert.severity] ?? 0) < (sevOrder[minSev] ?? 1)) return;

        // Get Supabase JWT for authentication
        const sb = await this._getSb();
        if (!sb) return;
        let token;
        try {
            const { data } = await sb.auth.getSession();
            token = data?.session?.access_token;
        } catch { return; }
        if (!token) return;

        try {
            const res = await fetch('/api/alerts/email', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    title:      alert.title,
                    body:       alert.body,
                    severity:   alert.severity,
                    alert_type: alert.alert_type,
                }),
            });
            if (res.ok) {
                console.debug('[AlertEngine] Email sent for:', alert.title);
            } else {
                const err = await res.json().catch(() => ({}));
                if (err.error !== 'not_configured') {
                    console.warn('[AlertEngine] Email failed:', err.error, err.detail);
                }
            }
        } catch (e) {
            console.debug('[AlertEngine] Email send error:', e.message);
        }
    }

    async _loadRecentFromDB() {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            const { data } = await sb
                .from('alert_history')
                .select('id, alert_type, severity, title, body, metadata, read, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(this._maxRecent);
            if (data?.length) {
                this.recent = data;
                this._dispatch();
            }
        } catch (e) {
            console.warn('[AlertEngine] DB load failed:', e.message);
        }
    }

    async _markReadInDB(alertId) {
        const sb = await this._getSb();
        if (!sb) return;
        try {
            if (alertId?.length === 36 && alertId.includes('-')) {
                await sb.from('alert_history').update({ read: true }).eq('id', alertId);
            }
        } catch (_) {}
    }

    async _markAllReadInDB() {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            await sb.from('alert_history').update({ read: true }).eq('user_id', userId).eq('read', false);
        } catch (_) {}
    }
}
