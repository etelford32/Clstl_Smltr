/**
 * greeting.js — Personalized welcome messages + feature discovery nudges
 *
 * After sign-in, shows a greeting with the user's first name and suggests
 * a feature they haven't tried yet (based on their analytics_events history).
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   import { getGreeting } from './js/greeting.js';
 *
 *   const g = await getGreeting(userId, firstName, plan);
 *   // g = {
 *   //   message: "Good evening, Eric!",
 *   //   suggestion: { title: "Satellite Tracker", desc: "Track 4,500+ ...", href: "satellites.html", icon: "🛰️" },
 *   //   isNewUser: false,
 *   // }
 */

import { getSupabase, isConfigured } from './supabase-config.js';

// ── All features the app offers, grouped by tier ─────────────────────────────
// "page" is the event_name that analytics.page() logs when visiting.

const FEATURES = [
    // Public / free
    { page: 'space-weather',    title: 'Space Weather',         desc: 'Live NOAA solar wind, Kp index, and X-ray flux',             href: 'space-weather.html',    icon: '🌤️',  tier: 'free' },
    { page: 'earth',            title: 'Earth Simulation',      desc: 'Interactive magnetosphere with real-time solar wind',         href: 'earth.html',            icon: '🌍',  tier: 'free' },
    { page: 'moon',             title: 'Moon Explorer',         desc: 'Lunar phases, libration, and surface features',              href: 'moon.html',             icon: '🌙',  tier: 'free' },
    { page: 'sun',              title: 'The Sun',               desc: 'Solar structure, CMEs, and live X-ray monitoring',            href: 'sun.html',              icon: '☀️',   tier: 'free' },
    { page: 'solar-system',     title: 'Solar System',          desc: '3D orbital mechanics with all 8 planets',                    href: 'threejs.html',          icon: '🪐',  tier: 'free' },
    { page: 'satellites',       title: 'Satellite Tracker',     desc: 'Track 4,500+ satellites with real CelesTrak TLE data',       href: 'satellites.html',       icon: '🛰️',  tier: 'free' },
    { page: 'galactic-map',     title: 'Galaxy Map',            desc: 'Explore the Milky Way with 100,000+ stars',                  href: 'galactic-map.html',     icon: '🌌',  tier: 'free' },
    { page: 'sirius',           title: 'Sirius Binary',         desc: 'Sirius A/B binary star system simulation',                   href: 'sirius.html',           icon: '⭐',  tier: 'free' },
    { page: 'betelgeuse',       title: 'Betelgeuse',            desc: 'Red supergiant pulsation and dimming events',                href: 'betelgeuse.html',       icon: '🔴',  tier: 'free' },
    { page: 'vega',             title: 'Vega',                  desc: 'Rapid rotator with oblate geometry',                         href: 'vega.html',             icon: '💫',  tier: 'free' },
    { page: 'wr102',            title: 'WR-102',                desc: 'Hottest known Wolf-Rayet star',                              href: 'wr102.html',            icon: '🌟',  tier: 'free' },
    { page: 'solar-fluid',      title: 'Solar Fluid Sim',       desc: 'Navier-Stokes MHD fluid dynamics on the Sun',               href: 'solar-fluid.html',      icon: '🌊',  tier: 'free' },
    { page: 'stellar-wind',     title: 'Stellar Wind',          desc: 'Parker spiral and solar wind stream simulation',             href: 'stellar-wind.html',     icon: '💨',  tier: 'free' },
    { page: 'star2d',           title: '2D Stellar Modeler',    desc: 'HR diagram classification and stellar evolution',            href: 'star2d.html',           icon: '📊',  tier: 'free' },
    { page: 'star2d-advanced',  title: 'Advanced Solar 2D',     desc: 'CME propagation, Parker spirals, and MHD fluid',             href: 'star2d-advanced.html',  icon: '🔬',  tier: 'free' },
    { page: 'black-hole-fluid', title: 'Black Hole Accretion',  desc: 'Relativistic fluid dynamics around a black hole',            href: 'black-hole-fluid.html', icon: '🕳️',  tier: 'free' },
    { page: 'star3d',           title: 'Sirius Planetary',      desc: '3D stellar system with planetary orbits',                    href: 'star3d.html',           icon: '🪐',  tier: 'free' },
    { page: 'dashboard',        title: 'Your Dashboard',        desc: 'Personalized space weather, aurora, and ISS passes',         href: 'dashboard.html',        icon: '📋',  tier: 'free' },
];

// ── Time-aware greeting ──────────────────────────────────────────────────────

function timeGreeting() {
    const h = new Date().getHours();
    if (h < 5)  return 'Happy late night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good night';
}

// ── New user greetings ───────────────────────────────────────────────────────

const NEW_USER_MESSAGES = [
    name => `Welcome aboard, ${name}! Ready to explore the cosmos?`,
    name => `Hey ${name}! Your astrophysics journey starts now.`,
    name => `Welcome to Parker Physics, ${name}! Let's discover the universe together.`,
];

// ── Returning user greetings ─────────────────────────────────────────────────

const RETURN_MESSAGES = [
    name => `${timeGreeting()}, ${name}!`,
    name => `Welcome back, ${name}!`,
    name => `Hey ${name}, good to see you again!`,
    name => `${timeGreeting()}, ${name}! The cosmos awaits.`,
];

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ── Core: build greeting + suggestion ────────────────────────────────────────

/**
 * Generate a personalized greeting and feature suggestion.
 *
 * @param {string|null} userId - Supabase user ID (null = anonymous)
 * @param {string} firstName - User's first name
 * @param {string} plan - 'free' | 'basic' | 'advanced'
 * @returns {Promise<{ message: string, suggestion: object|null, isNewUser: boolean }>}
 */
export async function getGreeting(userId, firstName, plan = 'free') {
    const name = firstName || 'Explorer';
    const visitedPages = new Set();
    let isNewUser = true;

    // Fetch this user's page view history from Supabase
    if (userId && isConfigured()) {
        try {
            const supabase = await getSupabase();
            const { data } = await supabase
                .from('analytics_events')
                .select('event_name')
                .eq('user_id', userId)
                .eq('event_type', 'page_view')
                .order('created_at', { ascending: false })
                .limit(200);

            if (data && data.length > 0) {
                for (const row of data) visitedPages.add(row.event_name);
                isNewUser = data.length < 3;  // fewer than 3 page views = new user
            }
        } catch (_) {
            // If Supabase fails, fall back to local check
        }
    }

    // Also check localStorage for pages visited (works without Supabase)
    try {
        const local = JSON.parse(localStorage.getItem('pp_visited_pages') || '[]');
        for (const p of local) visitedPages.add(p);
        if (local.length > 3) isNewUser = false;
    } catch (_) {}

    // Build greeting message
    const message = isNewUser
        ? pick(NEW_USER_MESSAGES)(name)
        : pick(RETURN_MESSAGES)(name);

    // Find a feature they haven't tried yet
    const tierLevel = plan === 'advanced' ? 3 : plan === 'basic' ? 2 : 1;
    const available = FEATURES.filter(f => {
        // Don't suggest pages they've already visited
        if (visitedPages.has(f.page)) return false;
        // Don't suggest pages above their tier
        const fLevel = f.tier === 'advanced' ? 3 : f.tier === 'basic' ? 2 : 1;
        return fLevel <= tierLevel;
    });

    // Pick a random suggestion from unvisited features
    const suggestion = available.length > 0 ? pick(available) : null;

    return { message, suggestion, isNewUser };
}

/**
 * Record a page visit locally (for greeting engine, works without Supabase).
 * @param {string} pageName - The page identifier
 */
export function recordVisit(pageName) {
    try {
        const visited = JSON.parse(localStorage.getItem('pp_visited_pages') || '[]');
        if (!visited.includes(pageName)) {
            visited.push(pageName);
            localStorage.setItem('pp_visited_pages', JSON.stringify(visited));
        }
    } catch (_) {}
}
