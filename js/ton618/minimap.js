// God-mode mini-map: a tiny 2D canvas showing where the observer is in the
// (r, theta, phi) coordinate system relative to the key BH landmarks
// (horizon r=2M, photon sphere r=3M, ISCO r=6M). Drawn from a fixed
// "god view" — equatorial slice, with a side stripe showing polar angle.

import { observerCartesian, forwardCartesian } from './camera.js';
import {
    R_HORIZON_GEOM, R_PHOTON_SPHERE,
} from './units.js';
import { R_ISCO_GEOM } from './physics.js';

export function createMinimap(canvas) {
    const ctx = canvas.getContext('2d');
    return {
        draw(cam) {
            draw(ctx, canvas, cam);
        },
    };
}

function draw(ctx, canvas, cam) {
    const W = canvas.width  = canvas.clientWidth  * window.devicePixelRatio;
    const H = canvas.height = canvas.clientHeight * window.devicePixelRatio;
    ctx.clearRect(0, 0, W, H);

    // Two panels side-by-side: left = top-down equatorial slice, right = polar slice.
    const pad = 6 * window.devicePixelRatio;
    const halfW = (W - 3 * pad) * 0.5;
    drawTopDown(ctx, pad, pad, halfW, H - 2 * pad, cam);
    drawSide(ctx, pad * 2 + halfW, pad, halfW, H - 2 * pad, cam);
}

// Top-down equatorial view (looking down +y, x-right is +x_world, x-down is +z_world).
function drawTopDown(ctx, x0, y0, w, h, cam) {
    ctx.save();
    ctx.translate(x0 + w / 2, y0 + h / 2);
    const R = Math.min(w, h) * 0.45;

    // Determine plot scale: fit camera + a margin, but never crop the rings.
    const r_cam = cam.r;
    const r_max = Math.max(r_cam * 1.2, 8 * R_HORIZON_GEOM);
    const s = R / r_max;

    // Background.
    ctx.fillStyle = 'rgba(10,4,20,0.85)';
    drawRoundRect(ctx, -w / 2, -h / 2, w, h, 4);
    ctx.fill();

    // Coordinate compass
    ctx.strokeStyle = 'rgba(80,80,100,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -R); ctx.lineTo(0, R);
    ctx.stroke();

    // Photon sphere (orange dashed).
    drawCircle(ctx, R_PHOTON_SPHERE * s, 'rgba(255,140,0,0.55)', [3, 3]);

    // ISCO (cyan dashed).
    drawCircle(ctx, R_ISCO_GEOM * s, 'rgba(120,210,255,0.45)', [4, 4]);

    // Horizon (filled).
    ctx.beginPath();
    ctx.fillStyle = 'rgba(0,0,0,0.95)';
    ctx.strokeStyle = 'rgba(255,140,0,0.85)';
    ctx.lineWidth = 1.5;
    ctx.arc(0, 0, R_HORIZON_GEOM * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Camera position projected to equatorial plane.
    const [cx, cy, cz] = observerCartesian(cam);
    const px = cx * s;
    const py = cz * s;   // map (x_world, z_world) -> (px, py)
    ctx.fillStyle = '#ffcc55';
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Forward arrow.
    const [fx, fy, fz] = forwardCartesian(cam);
    const len = R * 0.12;
    ctx.strokeStyle = 'rgba(255,200,80,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + fx * len, py + fz * len);
    ctx.stroke();

    // Label.
    ctx.fillStyle = '#7c6';
    ctx.font = `${10 * window.devicePixelRatio}px monospace`;
    ctx.fillText('top', -R, -R - 2);
    ctx.restore();
}

// Side view: vertical slice showing camera height vs equatorial distance.
function drawSide(ctx, x0, y0, w, h, cam) {
    ctx.save();
    ctx.translate(x0 + w / 2, y0 + h / 2);
    const R = Math.min(w, h) * 0.45;

    const r_cam = cam.r;
    const r_max = Math.max(r_cam * 1.2, 8 * R_HORIZON_GEOM);
    const s = R / r_max;

    ctx.fillStyle = 'rgba(10,4,20,0.85)';
    drawRoundRect(ctx, -w / 2, -h / 2, w, h, 4);
    ctx.fill();

    // Equatorial axis & polar axis.
    ctx.strokeStyle = 'rgba(80,80,100,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -R); ctx.lineTo(0, R);
    ctx.stroke();

    // Photon sphere & ISCO as faint circles in (rho, z) plane.
    drawCircle(ctx, R_PHOTON_SPHERE * s, 'rgba(255,140,0,0.4)', [3, 3]);
    drawCircle(ctx, R_ISCO_GEOM * s, 'rgba(120,210,255,0.35)', [4, 4]);

    // Horizon ellipse (sphere → circle in any slice through origin).
    ctx.beginPath();
    ctx.fillStyle = 'rgba(0,0,0,0.95)';
    ctx.strokeStyle = 'rgba(255,140,0,0.85)';
    ctx.lineWidth = 1.5;
    ctx.arc(0, 0, R_HORIZON_GEOM * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Camera position projected to (rho, z) where rho = sqrt(x^2+z^2).
    const [cx, cy, cz] = observerCartesian(cam);
    const rho = Math.sqrt(cx * cx + cz * cz);
    const px = rho * s;
    const py = -cy * s;     // y up
    ctx.fillStyle = '#ffcc55';
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Forward arrow projected.
    const [fx, fy, fz] = forwardCartesian(cam);
    const f_rho_dir = (rho > 1e-6) ? (cx * fx + cz * fz) / rho : 0;
    const f_y       = -fy;
    const len = R * 0.12;
    ctx.strokeStyle = 'rgba(255,200,80,0.9)';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + f_rho_dir * len, py + f_y * len);
    ctx.stroke();

    ctx.fillStyle = '#7c6';
    ctx.font = `${10 * window.devicePixelRatio}px monospace`;
    ctx.fillText('side', -R, -R - 2);
    ctx.restore();
}

function drawCircle(ctx, r, color, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function drawRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
