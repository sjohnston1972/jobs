import type { Env } from '../../lib/types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  receivedAt: Date;
  plainText: string | null;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

/**
 * Access tokens last an hour and a run takes seconds, so this is called once
 * per run and nothing is cached between them.
 */
export async function getAccessToken(env: Env): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    // A revoked token or an OAuth app left in "Testing" both land here.
    throw new Error(`Gmail token — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Gmail token — response carried no access_token');
  return data.access_token;
}

async function api<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Gmail ${path} — HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

export async function listMessageIds(token: string, query: string, max: number): Promise<string[]> {
  const data = await api<{ messages?: { id: string }[] }>(
    token,
    `messages?maxResults=${max}&q=${encodeURIComponent(query)}`,
  );
  return (data.messages ?? []).map((m) => m.id);
}

/** No Buffer in the Workers runtime, and the bodies contain £ signs, so the
 *  bytes must go through TextDecoder rather than being read as latin1. */
function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Alert emails are multipart; the plain text part is far easier to parse than
 *  the HTML, so it is the only part this reads. */
function plainTextPart(part: GmailPart): string | null {
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = plainTextPart(child);
    if (found) return found;
  }
  return null;
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  const msg = await api<{ payload: GmailPart; internalDate?: string }>(
    token,
    `messages/${id}?format=full`,
  );
  const header = (name: string) =>
    msg.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

  const dateHeader = header('date');
  const parsed = dateHeader ? Date.parse(dateHeader) : NaN;
  const receivedAt = Number.isNaN(parsed)
    ? new Date(Number(msg.internalDate ?? Date.now()))
    : new Date(parsed);

  return {
    id,
    from: header('from'),
    subject: header('subject'),
    receivedAt,
    plainText: plainTextPart(msg.payload),
  };
}
