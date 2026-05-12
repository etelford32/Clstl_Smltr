/**
 * api/_lib/r2-client.js — minimal Cloudflare R2 (S3-compatible) client.
 *
 * Hand-rolled AWS SigV4 over Web Crypto. Works in Vercel's edge runtime
 * (no node:crypto, no dependencies) and Node 18+ (Web Crypto is global).
 *
 * Why not @aws-sdk/client-s3 or aws4fetch?
 *   - We have zero runtime deps in package.json and want to keep it that
 *     way. aws-sdk ships hundreds of KB even at v3; aws4fetch would be
 *     fine (~5 KB) but pulling it in for one PUT + one presign isn't
 *     pulling its weight when the signer is ~80 lines of crypto.subtle.
 *
 * What's exposed:
 *   R2_CONFIGURED       — boolean: all four required env vars set?
 *   putObject(key, body, opts)
 *   getSignedUrl(key, opts)
 *   headObject(key)
 *
 * Required env vars (Vercel project settings):
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET
 * Optional:
 *   R2_ENDPOINT    — override host; defaults to https://<account>.r2.cloudflarestorage.com
 *
 * R2 uses the S3 SigV4 dialect with region literal "auto" and service "s3".
 * Path-style addressing (bucket in URL path, not vhost) — keeps the host
 * stable across buckets without DNS surprises.
 */

const R2_ACCOUNT_ID        = process.env.R2_ACCOUNT_ID        || '';
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID     || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET            = process.env.R2_BUCKET            || '';
const R2_ENDPOINT          = process.env.R2_ENDPOINT
    || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');

const R2_REGION  = 'auto';
const R2_SERVICE = 's3';

export const R2_CONFIGURED =
    !!R2_ACCOUNT_ID && !!R2_ACCESS_KEY_ID && !!R2_SECRET_ACCESS_KEY && !!R2_BUCKET;

// ── SigV4 primitives ───────────────────────────────────────────────

const enc = new TextEncoder();

async function sha256Hex(data) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const buf   = await crypto.subtle.digest('SHA-256', bytes);
    return bufToHex(buf);
}

async function hmacSha256(keyBytes, data) {
    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign(
        'HMAC', key, typeof data === 'string' ? enc.encode(data) : data,
    );
    return new Uint8Array(sig);
}

function bufToHex(buf) {
    const view = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < view.length; i++) {
        out += view[i].toString(16).padStart(2, '0');
    }
    return out;
}

// AWS-style URI escape: only unreserved chars (A-Z a-z 0-9 - _ . ~)
// pass through; everything else is %-encoded uppercase.
function awsUriEncode(str, encodeSlash = true) {
    let out = '';
    for (const ch of String(str)) {
        const code = ch.charCodeAt(0);
        const unreserved =
            (code >= 0x30 && code <= 0x39) ||   // 0-9
            (code >= 0x41 && code <= 0x5A) ||   // A-Z
            (code >= 0x61 && code <= 0x7A) ||   // a-z
            ch === '-' || ch === '_' || ch === '.' || ch === '~';
        if (unreserved)            out += ch;
        else if (ch === '/' && !encodeSlash) out += ch;
        else {
            // Multi-byte → UTF-8 bytes, each %-encoded
            const bytes = enc.encode(ch);
            for (const b of bytes) {
                out += '%' + b.toString(16).padStart(2, '0').toUpperCase();
            }
        }
    }
    return out;
}

function isoBasicNow(now = new Date()) {
    // YYYYMMDDTHHMMSSZ — SigV4 X-Amz-Date format.
    const pad = n => String(n).padStart(2, '0');
    return ''
        + now.getUTCFullYear()
        + pad(now.getUTCMonth() + 1)
        + pad(now.getUTCDate())
        + 'T'
        + pad(now.getUTCHours())
        + pad(now.getUTCMinutes())
        + pad(now.getUTCSeconds())
        + 'Z';
}

async function deriveSigningKey(secret, dateStamp) {
    let k = enc.encode('AWS4' + secret);
    k = await hmacSha256(k, dateStamp);
    k = await hmacSha256(k, R2_REGION);
    k = await hmacSha256(k, R2_SERVICE);
    k = await hmacSha256(k, 'aws4_request');
    return k;
}

// ── Canonical-request builders ─────────────────────────────────────

function canonicalPath(key) {
    // Bucket is part of the path (path-style addressing). Each segment is
    // URI-encoded; the slash separators stay as slashes.
    return '/' + awsUriEncode(R2_BUCKET, false)
        + '/' + awsUriEncode(key, false);
}

function canonicalQuery(params) {
    // params: object → sorted key=value joined by &. Keys + values are
    // AWS-URI-encoded individually (no '=' or '&' inside values needs
    // special handling because awsUriEncode escapes both).
    const pairs = Object.entries(params)
        .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v == null ? '' : v)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`);
    return pairs.join('&');
}

// ── PUT / HEAD (signed via Authorization header) ───────────────────

/**
 * PUT an object to R2.
 * @param {string} key
 * @param {ArrayBuffer | Uint8Array | string} body
 * @param {{ contentType?: string, contentEncoding?: string, cacheControl?: string,
 *           metadata?: Record<string,string> }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, key: string, etag?: string, size: number }>}
 */
export async function putObject(key, body, opts = {}) {
    if (!R2_CONFIGURED) throw new Error('r2_not_configured');

    const bodyBytes =
        typeof body === 'string' ? enc.encode(body)
      : body instanceof Uint8Array ? body
      : new Uint8Array(body);
    const payloadHash = await sha256Hex(bodyBytes);

    const now       = new Date();
    const amzDate   = isoBasicNow(now);
    const dateStamp = amzDate.slice(0, 8);   // YYYYMMDD
    const scope     = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

    const url = new URL(canonicalPath(key), R2_ENDPOINT);
    const host = url.host;

    const headers = {
        'host':                  host,
        'x-amz-content-sha256':  payloadHash,
        'x-amz-date':            amzDate,
    };
    if (opts.contentType)     headers['content-type']      = opts.contentType;
    if (opts.contentEncoding) headers['content-encoding']  = opts.contentEncoding;
    if (opts.cacheControl)    headers['cache-control']     = opts.cacheControl;
    if (opts.metadata) {
        for (const [k, v] of Object.entries(opts.metadata)) {
            // R2 / S3 user-metadata: x-amz-meta-<key>. Keys must be lowercase
            // when computing the canonical headers; we'll lowercase here.
            headers[`x-amz-meta-${k.toLowerCase()}`] = String(v);
        }
    }

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders  = signedHeaderNames
        .map(h => `${h}:${headers[h].toString().trim().replace(/\s+/g, ' ')}\n`)
        .join('');
    const signedHeaders     = signedHeaderNames.join(';');

    const canonicalRequest = [
        'PUT',
        url.pathname,
        '',                 // no query string for PUT
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = await deriveSigningKey(R2_SECRET_ACCESS_KEY, dateStamp);
    const signature  = bufToHex(await hmacSha256(signingKey, stringToSign));

    headers['authorization'] =
        `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, {
        method:  'PUT',
        headers,
        body:    bodyBytes,
        // Edge runtime ignores AbortSignal.timeout on body upload; that's fine
        // for our use case (the archive cron handles overall timeout itself).
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`r2_put ${res.status}: ${text.slice(0, 300)}`);
    }
    return {
        ok:     true,
        status: res.status,
        key,
        etag:   res.headers.get('etag') || undefined,
        size:   bodyBytes.byteLength,
    };
}

/**
 * HEAD an object — returns null if absent, else { etag, size, lastModified }.
 * Used by the archive cron to check whether today's archive already exists
 * before re-uploading (idempotent retries).
 */
export async function headObject(key) {
    if (!R2_CONFIGURED) throw new Error('r2_not_configured');

    const now       = new Date();
    const amzDate   = isoBasicNow(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope     = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
    const payloadHash = await sha256Hex('');

    const url  = new URL(canonicalPath(key), R2_ENDPOINT);
    const host = url.host;
    const headers = {
        'host':                 host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date':           amzDate,
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders  = signedHeaderNames
        .map(h => `${h}:${headers[h].toString().trim()}\n`)
        .join('');
    const signedHeaders     = signedHeaderNames.join(';');

    const canonicalRequest = ['HEAD', url.pathname, '', canonicalHeaders,
                              signedHeaders, payloadHash].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
                          await sha256Hex(canonicalRequest)].join('\n');
    const signingKey = await deriveSigningKey(R2_SECRET_ACCESS_KEY, dateStamp);
    const signature  = bufToHex(await hmacSha256(signingKey, stringToSign));

    headers['authorization'] =
        `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, { method: 'HEAD', headers });
    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`r2_head ${res.status}`);
    }
    return {
        etag:         res.headers.get('etag')          || null,
        size:         Number(res.headers.get('content-length') || 0),
        lastModified: res.headers.get('last-modified') || null,
    };
}

// ── GET presigned URL (signed via query string) ────────────────────

/**
 * Build a presigned GET URL — anyone with this URL can read the object
 * until X-Amz-Expires seconds elapse. Used by /api/forecast/replay to
 * hand R2 reads back to the browser without proxying bytes through
 * Vercel.
 *
 * @param {string} key
 * @param {{ expiresIn?: number }} [opts] — seconds; default 3600 (1h)
 * @returns {Promise<string>} full URL with auth in query string
 */
export async function getSignedUrl(key, opts = {}) {
    if (!R2_CONFIGURED) throw new Error('r2_not_configured');
    const expiresIn = Math.max(1, Math.min(7 * 24 * 3600, opts.expiresIn || 3600));

    const now       = new Date();
    const amzDate   = isoBasicNow(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope     = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

    const url  = new URL(canonicalPath(key), R2_ENDPOINT);
    const host = url.host;

    // For presigned URLs, the only "signed header" must be host (so the
    // signature is portable across User-Agents).
    const signedHeaders = 'host';
    const credential    = `${R2_ACCESS_KEY_ID}/${scope}`;

    const query = {
        'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
        'X-Amz-Credential':    credential,
        'X-Amz-Date':          amzDate,
        'X-Amz-Expires':       String(expiresIn),
        'X-Amz-SignedHeaders': signedHeaders,
    };

    const canonicalQueryStr = canonicalQuery(query);
    const canonicalHeaders  = `host:${host}\n`;
    // UNSIGNED-PAYLOAD is the SigV4 sentinel meaning "the payload hash
    // wasn't computed at signing time" — required for presigned GETs
    // where the client may stream the response without us knowing the
    // body in advance.
    const canonicalRequest  = [
        'GET',
        url.pathname,
        canonicalQueryStr,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = await deriveSigningKey(R2_SECRET_ACCESS_KEY, dateStamp);
    const signature  = bufToHex(await hmacSha256(signingKey, stringToSign));

    return `${R2_ENDPOINT}${url.pathname}?${canonicalQueryStr}&X-Amz-Signature=${signature}`;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * SHA-256 helper exposed so the archive cron can compute the hash it
 * writes into forecast_archive_pointer.sha256 without duplicating the
 * crypto.subtle dance.
 */
export async function sha256HexOf(data) {
    return sha256Hex(data);
}
