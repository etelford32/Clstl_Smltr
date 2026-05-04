/**
 * tier-config.js — Single source of truth for the user-facing plan tiers.
 *
 * Anything that needs to know:
 *   - the human label for a plan ("Basic", "Advanced", …)
 *   - the seat count, monthly price, or saved-location quota
 *   - whether a plan unlocks PRO features, alerts, embed, or custom branding
 * should import from this module rather than hard-coding strings or sets.
 *
 * Mirrors the canonical server-side definitions in:
 *   - supabase-tier-expansion-migration.sql  (price + seats + plan ids)
 *   - public.plan_location_limit()           (saved-location quota)
 *
 * If those SQL definitions change, update this file in the same commit.
 *
 * The TIER.* feed-bucket constants in js/config.js (FREE / PRO) are a
 * coarser projection of this table — see proBucket below.
 */

export const PLAN_IDS = Object.freeze({
    FREE:        'free',
    TESTER:      'tester',
    BASIC:       'basic',
    EDUCATOR:    'educator',
    ADVANCED:    'advanced',
    INSTITUTION: 'institution',
    ENTERPRISE:  'enterprise',
});

// Ordered low → high so admin tier breakdowns and pricing pages render
// in their natural progression.
export const TIERS = Object.freeze([
    Object.freeze({
        id: 'free',
        label: 'Free Trial',
        priceUsd: 0,
        seats: 1,
        locationLimit: 0,
        badgeClass: 'plan-free',
        proBucket: false,
        paid: false,
        alerts: false,
        advancedAlerts: false,
        embed: false,
        customBranding: false,
    }),
    Object.freeze({
        id: 'tester',
        label: 'Tester',
        priceUsd: null,
        seats: 1,
        locationLimit: 25,
        badgeClass: 'plan-tester',
        proBucket: true,
        paid: false,
        alerts: true,
        advancedAlerts: true,
        embed: true,
        customBranding: false,
    }),
    Object.freeze({
        id: 'basic',
        label: 'Basic',
        priceUsd: 10,
        seats: 1,
        locationLimit: 5,
        badgeClass: 'plan-basic',
        proBucket: false,
        paid: true,
        alerts: true,
        advancedAlerts: false,
        embed: false,
        customBranding: false,
    }),
    Object.freeze({
        id: 'educator',
        label: 'Educator',
        priceUsd: 25,
        seats: 30,
        locationLimit: 5,
        badgeClass: 'plan-educator',
        proBucket: false,
        paid: true,
        alerts: true,
        advancedAlerts: false,
        embed: true,
        customBranding: false,
    }),
    Object.freeze({
        id: 'advanced',
        label: 'Advanced',
        priceUsd: 100,
        seats: 1,
        locationLimit: 25,
        badgeClass: 'plan-advanced',
        proBucket: true,
        paid: true,
        alerts: true,
        advancedAlerts: true,
        embed: false,
        customBranding: false,
    }),
    Object.freeze({
        id: 'institution',
        label: 'Institution',
        priceUsd: 500,
        seats: 200,
        locationLimit: 25,
        badgeClass: 'plan-institution',
        proBucket: true,
        paid: true,
        alerts: true,
        advancedAlerts: true,
        embed: true,
        customBranding: true,
    }),
    Object.freeze({
        id: 'enterprise',
        label: 'Enterprise',
        priceUsd: null,
        seats: null,
        locationLimit: 100,
        badgeClass: 'plan-enterprise',
        proBucket: true,
        paid: true,
        alerts: true,
        advancedAlerts: true,
        embed: true,
        customBranding: true,
    }),
]);

const _byId = Object.freeze(Object.fromEntries(TIERS.map(t => [t.id, t])));

const _normalize = (plan) => {
    const p = String(plan || '').toLowerCase();
    // Legacy alias: some older invite codes used 'intro' for what is now 'basic'.
    if (p === 'intro') return 'basic';
    return p;
};

export function getTier(plan) {
    return _byId[_normalize(plan)] || _byId.free;
}

export function tierLabel(plan) {
    return getTier(plan).label;
}

export function tierBadgeClass(plan) {
    return getTier(plan).badgeClass;
}

export function locationLimit(plan) {
    return getTier(plan).locationLimit;
}

export function seatLimit(plan) {
    return getTier(plan).seats;
}

/**
 * Numeric tier level for >= comparisons in nav and feature gates.
 *   1   → free
 *   2   → basic / educator
 *   3   → advanced / institution / enterprise
 *   98  → tester (comp account; treated as PRO without paying)
 *   99  → admin / superadmin (override; full access regardless of plan)
 */
export function tierLevel(plan, role) {
    const r = String(role || '').toLowerCase();
    if (r === 'admin' || r === 'superadmin') return 99;
    if (r === 'tester') return 98;
    const p = _normalize(plan);
    if (p === 'tester') return 98;
    if (p === 'enterprise' || p === 'institution' || p === 'advanced') return 3;
    if (p === 'educator' || p === 'basic') return 2;
    return 1;
}

/** Canonical PRO gate: advanced, institution, enterprise, tester, admin. */
export function isPro(plan, role) {
    return tierLevel(plan, role) >= 3;
}

export function isPaid(plan) {
    return getTier(plan).paid;
}

export function canUseAlerts(plan, role) {
    const r = String(role || '').toLowerCase();
    if (r === 'admin' || r === 'superadmin' || r === 'tester') return true;
    return getTier(plan).alerts;
}

export function canUseAdvancedAlerts(plan, role) {
    const r = String(role || '').toLowerCase();
    if (r === 'admin' || r === 'superadmin' || r === 'tester') return true;
    return getTier(plan).advancedAlerts;
}

export function canUseEmbed(plan, role) {
    const r = String(role || '').toLowerCase();
    if (r === 'admin' || r === 'superadmin' || r === 'tester') return true;
    return getTier(plan).embed;
}

export function hasCustomBranding(plan) {
    return getTier(plan).customBranding;
}

/** Stable plan-id sets for analytics filters and quick membership checks. */
export const PAID_PLAN_IDS = Object.freeze(new Set(TIERS.filter(t => t.paid).map(t => t.id)));
export const PRO_PLAN_IDS  = Object.freeze(new Set(TIERS.filter(t => t.proBucket).map(t => t.id)));
export const ALL_PLAN_IDS  = Object.freeze(new Set(TIERS.map(t => t.id)));
