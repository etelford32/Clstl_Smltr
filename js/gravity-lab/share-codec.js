/**
 * share-codec.js — scenario ⇄ URL-fragment codec (P2.4).
 *
 * A scenario is a small plain object: {systemId or full sandbox state,
 * epoch, warp, camera preset, view toggles}. Encoded as deflate-raw
 * (native CompressionStream — zero dependencies) in base64url with a 'z:'
 * prefix; environments without CompressionStream fall back to plain
 * base64url JSON with a 'j:' prefix. Decode accepts both. Typical sandbox
 * payloads land well under 2 KB.
 *
 * Numbers are quantized to 9 significant digits for URL size (~float32-
 * class relative precision, flagged in the payload as q:9). That is a
 * SHARING approximation, honestly declared — the receiving lab integrates
 * the reconstructed state in full double precision.
 */

const B64_ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const B64_DEC = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function _toB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function _fromB64url(s) {
    const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function _pipe(bytes, TransformCtor, kind) {
    const stream = new Blob([bytes]).stream().pipeThrough(new TransformCtor(kind));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Quantize every number in a JSON-able structure to 9 significant digits. */
export function quantize(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Number(value.toPrecision(9)) : value;
    }
    if (Array.isArray(value)) return value.map(quantize);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = quantize(v);
        return out;
    }
    return value;
}

export async function encodeScenario(scenario) {
    const json = JSON.stringify(quantize(scenario));
    const bytes = B64_ENC.encode(json);
    if (typeof CompressionStream === 'function') {
        return 'z:' + _toB64url(await _pipe(bytes, CompressionStream, 'deflate-raw'));
    }
    return 'j:' + _toB64url(bytes);
}

export async function decodeScenario(fragment) {
    if (!fragment || fragment.length < 3 || fragment[1] !== ':') return null;
    const kind = fragment[0];
    const bytes = _fromB64url(fragment.slice(2));
    let json;
    if (kind === 'z') {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('This browser cannot decompress the shared link.');
        }
        json = B64_DEC.decode(await _pipe(bytes, DecompressionStream, 'deflate-raw'));
    } else if (kind === 'j') {
        json = B64_DEC.decode(bytes);
    } else {
        return null;
    }
    const obj = JSON.parse(json);
    if (!obj || obj.v !== 1) return null;
    return obj;
}
