/**
 * Cloudflare Access verification.
 *
 * Access enforces the policy at the edge, so an unauthenticated request should
 * never reach the Worker at all. This verifies the assertion anyway: the Worker
 * holds personal data and an Anthropic key, and "something upstream is supposed
 * to be handling it" is not an access control.
 *
 * The JWT is RS256, signed by the team's Access instance. Verifying it also
 * yields the authenticated email, which the portal displays.
 */

interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface AccessClaims {
  aud: string[] | string;
  email?: string;
  exp: number;
  iss: string;
}

/** Keys rotate rarely; caching them avoids a subrequest on every page view. */
let keyCache: { keys: JwkKey[]; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeSegment<T>(segment: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
  } catch {
    return null;
  }
}

async function fetchKeys(teamDomain: string): Promise<JwkKey[]> {
  if (keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS) return keyCache.keys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs — HTTP ${response.status}`);

  const data = (await response.json()) as { keys?: JwkKey[] };
  const keys = data.keys ?? [];
  keyCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function readToken(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;

  // Browsers carry the assertion as a cookie rather than a header.
  const cookies = request.headers.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'CF_Authorization') return rest.join('=');
  }
  return null;
}

/** Returns the authenticated email, or null when the request is not authorised. */
export async function verifyAccess(
  request: Request,
  teamDomain: string,
  audience: string,
): Promise<string | null> {
  // Each rejection says why in the log. A misconfigured AUD and an expired
  // assertion look identical from the browser, and `wrangler tail` is the only
  // place the difference is visible.
  const reject = (reason: string): null => {
    console.warn(`access denied: ${reason}`);
    return null;
  };

  const token = readToken(request);
  if (!token) return reject('no assertion header or CF_Authorization cookie');

  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) return reject('malformed token');

  const header = decodeSegment<{ kid?: string; alg?: string }>(headerB64);
  const claims = decodeSegment<AccessClaims>(payloadB64);
  if (!header?.kid || header.alg !== 'RS256' || !claims) {
    return reject(`unexpected header alg=${header?.alg} kid=${header?.kid}`);
  }

  if (claims.iss !== `https://${teamDomain}`) return reject(`issuer ${claims.iss}`);
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    return reject('assertion expired');
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return reject(`aud mismatch, got ${audiences.join(',')}`);

  let keys: JwkKey[];
  try {
    keys = await fetchKeys(teamDomain);
  } catch (err) {
    return reject(`certs fetch failed: ${String(err)}`);
  }

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return reject(`no signing key for kid ${header.kid}`);

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return reject('signature did not verify');

  return claims.email ?? 'authenticated';
}
