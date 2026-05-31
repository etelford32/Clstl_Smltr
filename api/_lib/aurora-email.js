/**
 * api/_lib/aurora-email.js
 *
 * Double opt-in confirmation email for anonymous aurora-alert capture.
 * Send block lifted from api/alerts/email.js. Lives under _lib/ so Vercel
 * treats it as private (not a route) — see api/_lib/responses.js.
 *
 * See AURORA_ALERT_CAPTURE_SPEC.md.
 */

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.AURORA_FROM_EMAIL || 'Parkers Physics <aurora@parkersphysics.com>';

export async function subscribeConfirmEmail(to, confirmUrl) {
    if (!RESEND_KEY) throw new Error('not_configured');
    const html = `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#03010e;color:#d6dee6;padding:32px;border-radius:12px;max-width:520px;margin:auto">
        <h1 style="color:#ffb066;font-size:20px;margin:0 0 12px">One tap from the next aurora.</h1>
        <p style="color:#b0c8d8;line-height:1.6">Confirm your email and we'll ping you the moment a geomagnetic storm puts the lights in reach — with a link to watch it hit Earth's magnetosphere live.</p>
        <p style="margin:24px 0">
          <a href="${confirmUrl}" style="background:#ffb066;color:#03010e;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block">Confirm my aurora alerts →</a>
        </p>
        <p style="color:#7a98a8;font-size:12px">If you didn't request this, ignore this email and you won't hear from us.</p>
      </div>`;
    const r = await fetch(RESEND_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM_EMAIL, to, subject: 'Confirm your aurora alerts', html }),
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`resend_failed_${r.status}`);
    return (await r.json())?.id;
}
