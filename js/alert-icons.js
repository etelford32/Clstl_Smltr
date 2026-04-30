/**
 * alert-icons.js — Procedural canvas textures for weather-alert markers.
 *
 * Each ALERT_KIND ('tornado' | 'hurricane' | 'thunder' | 'flood' | 'wind' |
 * 'winter' | 'heat' | 'fire' | 'fog' | 'marine' | 'generic') is drawn on a
 * 256×256 canvas as a white emblem on transparent black, then handed to
 * Three.js as a cached texture. Sprite material .color tints them to the
 * alert's severity at render time, so one texture serves every alert of
 * that kind regardless of severity.
 *
 * Design notes:
 *   - All icons are drawn with a soft bloom underlay so they read against
 *     the globe at low pixel sizes without looking aliased.
 *   - Geometry stays within the centre 220 px so clamped scale changes
 *     don't clip to the canvas edge.
 *   - Contrast: 90–100% white core, ~40% halo.
 *   - No antialias-dependent tricks (hair-line strokes, sub-pixel rounding);
 *     they hold up at all zoom levels, including aggressive zoom-in where a
 *     sprite's texture footprint goes past 1:1.
 *
 * Public API:
 *   getAlertIconTexture(THREE, kind)  →  THREE.Texture   (cached)
 *   precomputeAlertIcons(THREE)       →  void            (optional warm-up)
 */

const CANVAS_SIZE = 256;
const CENTER      = CANVAS_SIZE / 2;
const _cache = new Map();  // kind → THREE.Texture

/** Soft radial glow, used as an underlay so icons bloom on additive blending. */
function _drawGlow(ctx, radius, alpha = 0.55) {
    const g = ctx.createRadialGradient(CENTER, CENTER, 0, CENTER, CENTER, radius);
    g.addColorStop(0,   `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.5, `rgba(255,255,255,${alpha * 0.35})`);
    g.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
}

function _setStroke(ctx, alpha = 1, width = 10) {
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth   = width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
}

function _setFill(ctx, alpha = 1) {
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
}

// ─── Glyph draw routines ────────────────────────────────────────────────────

function drawTornado(ctx) {
    _drawGlow(ctx, 110, 0.40);

    // Funnel — wide at top, narrow at bottom, with a curl
    _setFill(ctx, 0.95);
    ctx.beginPath();
    ctx.moveTo(60,  60);
    ctx.lineTo(196, 60);
    ctx.lineTo(176, 96);
    ctx.lineTo(172, 128);
    ctx.lineTo(160, 154);
    ctx.lineTo(148, 176);
    ctx.lineTo(138, 196);
    ctx.lineTo(128, 210);
    ctx.lineTo(118, 196);
    ctx.lineTo(108, 176);
    ctx.lineTo(96,  154);
    ctx.lineTo(84,  128);
    ctx.lineTo(80,  96);
    ctx.closePath();
    ctx.fill();

    // Rotation striations
    _setStroke(ctx, 0.75, 3.5);
    for (let y = 74; y < 200; y += 12) {
        const half = Math.max(8, 72 - (y - 74) * 0.5);
        ctx.beginPath();
        ctx.moveTo(CENTER - half, y);
        ctx.quadraticCurveTo(CENTER, y + 4, CENTER + half, y);
        ctx.stroke();
    }

    // Debris cloud base
    _setFill(ctx, 0.60);
    ctx.beginPath();
    ctx.ellipse(CENTER, 216, 46, 10, 0, 0, Math.PI * 2);
    ctx.fill();
}

function drawHurricane(ctx) {
    _drawGlow(ctx, 120, 0.40);

    // Classic two-arm spiral with a clean eye
    _setStroke(ctx, 0.95, 18);
    const armR0 = 22, armR1 = 104;
    for (let arm = 0; arm < 2; arm++) {
        const rot = arm * Math.PI;
        ctx.beginPath();
        for (let t = 0; t <= 1; t += 0.02) {
            const theta = rot + t * Math.PI * 1.4;
            const r     = armR0 + (armR1 - armR0) * t;
            const x = CENTER + r * Math.cos(theta);
            const y = CENTER + r * Math.sin(theta);
            if (t === 0) ctx.moveTo(x, y);
            else         ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Eye — dark clear centre
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Eye rim
    _setStroke(ctx, 0.85, 6);
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 22, 0, Math.PI * 2);
    ctx.stroke();
}

function drawThunder(ctx) {
    _drawGlow(ctx, 100, 0.50);

    // Cloud
    _setFill(ctx, 0.85);
    ctx.beginPath();
    ctx.arc(CENTER - 40, 106, 34, 0, Math.PI * 2);
    ctx.arc(CENTER,      90, 44, 0, Math.PI * 2);
    ctx.arc(CENTER + 44, 108, 32, 0, Math.PI * 2);
    ctx.rect(CENTER - 72, 108, 148, 28);
    ctx.fill();

    // Lightning bolt
    _setFill(ctx, 1);
    ctx.beginPath();
    ctx.moveTo(CENTER + 8,  128);
    ctx.lineTo(CENTER - 18, 176);
    ctx.lineTo(CENTER + 4,  176);
    ctx.lineTo(CENTER - 14, 218);
    ctx.lineTo(CENTER + 30, 164);
    ctx.lineTo(CENTER + 8,  164);
    ctx.lineTo(CENTER + 26, 128);
    ctx.closePath();
    ctx.fill();
}

function drawFlood(ctx) {
    _drawGlow(ctx, 110, 0.35);

    // Three stacked waves, parallel lines
    _setStroke(ctx, 0.95, 14);
    for (let i = 0; i < 3; i++) {
        const y = 100 + i * 34;
        ctx.beginPath();
        ctx.moveTo(52, y);
        ctx.bezierCurveTo(92, y - 26, 124, y + 26, 164, y);
        ctx.bezierCurveTo(184, y - 14, 196, y + 14, 208, y);
        ctx.stroke();
    }

    // Raindrop accent above
    _setFill(ctx, 0.95);
    ctx.beginPath();
    ctx.moveTo(CENTER, 38);
    ctx.bezierCurveTo(CENTER + 20, 68, CENTER + 14, 94, CENTER, 94);
    ctx.bezierCurveTo(CENTER - 14, 94, CENTER - 20, 68, CENTER, 38);
    ctx.closePath();
    ctx.fill();
}

function drawWind(ctx) {
    _drawGlow(ctx, 110, 0.35);

    // Curved streamlines, each terminating in a small hook
    _setStroke(ctx, 0.95, 12);
    const rows = [
        { y: 88,  len: 160, hook: 18 },
        { y: 134, len: 184, hook: 22 },
        { y: 180, len: 150, hook: 18 },
    ];
    for (const { y, len, hook } of rows) {
        const x0 = CENTER - len / 2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.bezierCurveTo(x0 + len * 0.25, y - 18, x0 + len * 0.75, y + 18, x0 + len, y);
        ctx.stroke();
        // Tail hook
        ctx.beginPath();
        ctx.moveTo(x0 + len, y);
        ctx.lineTo(x0 + len - hook, y - hook * 0.7);
        ctx.stroke();
    }
}

function drawWinter(ctx) {
    _drawGlow(ctx, 110, 0.40);

    // 6-pointed snowflake with barbs
    _setStroke(ctx, 0.95, 10);
    const R = 90;
    for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        const x1 = CENTER + Math.cos(a) * R;
        const y1 = CENTER + Math.sin(a) * R;
        ctx.beginPath();
        ctx.moveTo(CENTER, CENTER);
        ctx.lineTo(x1, y1);
        ctx.stroke();

        // Barbs
        for (const t of [0.45, 0.7]) {
            const bx = CENTER + Math.cos(a) * R * t;
            const by = CENTER + Math.sin(a) * R * t;
            const n  = 18;
            ctx.beginPath();
            ctx.moveTo(bx + Math.cos(a + 2.1) * n, by + Math.sin(a + 2.1) * n);
            ctx.lineTo(bx, by);
            ctx.lineTo(bx + Math.cos(a - 2.1) * n, by + Math.sin(a - 2.1) * n);
            ctx.stroke();
        }
    }

    // Central knot
    _setFill(ctx, 1);
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 8, 0, Math.PI * 2);
    ctx.fill();
}

function drawHeat(ctx) {
    _drawGlow(ctx, 120, 0.55);

    // Sun disk
    _setFill(ctx, 1);
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, 36, 0, Math.PI * 2);
    ctx.fill();

    // Rays — alternating lengths
    _setStroke(ctx, 0.9, 10);
    const R0 = 48, R1long = 96, R1short = 78;
    for (let i = 0; i < 12; i++) {
        const a  = i * Math.PI / 6;
        const R1 = (i % 2 === 0) ? R1long : R1short;
        ctx.beginPath();
        ctx.moveTo(CENTER + Math.cos(a) * R0, CENTER + Math.sin(a) * R0);
        ctx.lineTo(CENTER + Math.cos(a) * R1, CENTER + Math.sin(a) * R1);
        ctx.stroke();
    }
}

function drawFire(ctx) {
    _drawGlow(ctx, 100, 0.55);

    // Flame — bezier teardrop with inner curl
    _setFill(ctx, 1);
    ctx.beginPath();
    ctx.moveTo(CENTER, 40);
    ctx.bezierCurveTo(CENTER + 70, 80,  CENTER + 60, 190, CENTER, 220);
    ctx.bezierCurveTo(CENTER - 60, 190, CENTER - 70, 80,  CENTER, 40);
    ctx.closePath();
    ctx.fill();

    // Inner flame curl (darker cutout)
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(CENTER, 96);
    ctx.bezierCurveTo(CENTER + 30, 118, CENTER + 22, 180, CENTER, 200);
    ctx.bezierCurveTo(CENTER - 22, 180, CENTER - 30, 118, CENTER, 96);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
}

function drawFog(ctx) {
    _drawGlow(ctx, 100, 0.30);

    _setStroke(ctx, 0.85, 16);
    const ys = [88, 124, 160, 196];
    for (let i = 0; i < ys.length; i++) {
        const y = ys[i];
        const len = 150 + Math.sin(i * 1.3) * 14;
        const xs = CENTER - len / 2;
        ctx.beginPath();
        ctx.moveTo(xs, y);
        ctx.lineTo(xs + len, y);
        ctx.stroke();
    }
}

function drawMarine(ctx) {
    _drawGlow(ctx, 110, 0.35);

    // Anchor — shank, crown, flukes
    _setStroke(ctx, 0.95, 12);
    _setFill(ctx, 1);

    // Ring
    ctx.beginPath();
    ctx.arc(CENTER, 62, 14, 0, Math.PI * 2);
    ctx.stroke();
    // Shank
    ctx.beginPath();
    ctx.moveTo(CENTER, 78);
    ctx.lineTo(CENTER, 200);
    ctx.stroke();
    // Crossbar
    ctx.beginPath();
    ctx.moveTo(CENTER - 36, 96);
    ctx.lineTo(CENTER + 36, 96);
    ctx.stroke();
    // Flukes
    ctx.beginPath();
    ctx.arc(CENTER, 200, 60, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    // Tips
    ctx.beginPath();
    ctx.moveTo(CENTER - 60, 212);
    ctx.lineTo(CENTER - 82, 192);
    ctx.moveTo(CENTER + 60, 212);
    ctx.lineTo(CENTER + 82, 192);
    ctx.stroke();
}

function drawGeneric(ctx) {
    _drawGlow(ctx, 100, 0.45);

    // Warning triangle
    _setFill(ctx, 0.95);
    ctx.beginPath();
    ctx.moveTo(CENTER, 48);
    ctx.lineTo(CENTER + 96, 210);
    ctx.lineTo(CENTER - 96, 210);
    ctx.closePath();
    ctx.fill();

    // Exclamation cutout
    ctx.globalCompositeOperation = 'destination-out';
    _setFill(ctx, 1);
    ctx.beginPath();
    ctx.rect(CENTER - 9, 100, 18, 62);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(CENTER, 184, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
}

const DRAWERS = {
    tornado:   drawTornado,
    hurricane: drawHurricane,
    thunder:   drawThunder,
    flood:     drawFlood,
    wind:      drawWind,
    winter:    drawWinter,
    heat:      drawHeat,
    fire:      drawFire,
    fog:       drawFog,
    marine:    drawMarine,
    generic:   drawGeneric,
};

function _makeCanvas() {
    const c  = document.createElement('canvas');
    c.width  = CANVAS_SIZE;
    c.height = CANVAS_SIZE;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    return { canvas: c, ctx };
}

/**
 * Return a cached THREE.Texture for the given alert kind.
 * First call per kind draws to canvas; subsequent calls are free.
 */
export function getAlertIconTexture(THREE, kind) {
    if (_cache.has(kind)) return _cache.get(kind);
    const drawer = DRAWERS[kind] ?? DRAWERS.generic;
    const { canvas, ctx } = _makeCanvas();
    drawer(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 8;
    tex.minFilter  = THREE.LinearMipMapLinearFilter;
    tex.magFilter  = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    _cache.set(kind, tex);
    return tex;
}

/** Optional: warm up all textures during page load to avoid first-render hitch. */
export function precomputeAlertIcons(THREE) {
    for (const kind of Object.keys(DRAWERS)) getAlertIconTexture(THREE, kind);
}

/** For testing: clear the cache (e.g. after switching colour spaces). */
export function clearAlertIconCache() {
    for (const tex of _cache.values()) tex.dispose();
    _cache.clear();
}
