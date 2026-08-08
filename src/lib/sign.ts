/**
 * HMAC-SHA256 over the Web Crypto API.
 *
 * Every state-changing GET reachable from an email carries one of these. Without
 * it, /track is an open write to the database for anyone who guesses the URL.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(mac);
}

/** Constant-time comparison, so a wrong signature leaks nothing through timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const expected = await sign(secret, payload);
  return timingSafeEqual(expected, signature);
}

/** Build a signed absolute URL, e.g. /track?job=…&status=…&sig=… */
export async function signedUrl(
  base: string,
  path: string,
  params: Record<string, string>,
  secret: string,
): Promise<string> {
  const payload = Object.values(params).join('|');
  const sig = await sign(secret, payload);
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('sig', sig);
  return url.toString();
}

// Portal sign-in is handled by Cloudflare Access (see lib/access.ts), so there
// is no session token to issue here. HMAC remains for the links in the digest.
