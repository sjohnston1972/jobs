#!/usr/bin/env node
/**
 * One-time Google OAuth consent, run locally. Not deployed, never imported by
 * the Worker.
 *
 * Mints the refresh token the Worker uses to read job alert emails, and writes
 * it straight into .env (gitignored) rather than printing it, so the token does
 * not end up in a terminal scrollback or an agent transcript.
 *
 *   node scripts/gmail-auth.mjs [path/to/client_secret_*.json]
 *
 * With no argument it looks for client_secret*.json in the project root and
 * then in ~/Downloads, which is where Google's console puts it.
 *
 * Google removed the out-of-band redirect in 2022, so this runs a throwaway
 * loopback server on 127.0.0.1 to catch the authorisation code. Desktop OAuth
 * clients are permitted any loopback port.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');
const PORT = 8123;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

/** Google names the download client_secret_<id>.apps.googleusercontent.com.json */
async function findClientJson(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) die(`No such file: ${explicit}`);
    return explicit;
  }
  for (const dir of [ROOT, path.join(homedir(), 'Downloads')]) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const hits = entries.filter((f) => f.startsWith('client_secret') && f.endsWith('.json')).sort();
    if (hits.length) return path.join(dir, hits.at(-1));
  }
  die(
    'Could not find client_secret*.json in the project root or ~/Downloads.\n' +
      '    Download it from the Google Cloud console (Credentials → your OAuth\n' +
      '    client → Download JSON), or pass its path as an argument.',
  );
}

async function readCredentials(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    die(`${file} is not readable JSON: ${err.message}`);
  }
  // Desktop clients nest under "installed"; web clients under "web".
  const creds = parsed.installed ?? parsed.web ?? parsed;
  if (!creds.client_id || !creds.client_secret) {
    die(`${file} has no client_id/client_secret. Is it an OAuth client download?`);
  }
  if (parsed.web) {
    console.warn(
      '\n  ! This looks like a Web application client. A Desktop client is\n' +
        '    expected; if the consent step rejects the redirect URI, create a\n' +
        '    Desktop client instead.',
    );
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

function openBrowser(url) {
  // Not `cmd /c start` on Windows: cmd reads & as a command separator, so an
  // OAuth URL arrives at the browser truncated at the first parameter and
  // Google rejects it for a missing response_type. rundll32 takes the URL as a
  // single argument with no shell in the way.
  const cmd =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Printing the URL is the real interface; opening it is a convenience.
  }
}

/** Serves one request, resolves with the ?code= it carried. */
function awaitCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8">
         <title>Job Monitor</title>
         <body style="font:16px/1.6 system-ui;margin:15vh auto;max-width:30rem;text-align:center">
         <h1 style="font-size:1.25rem">${code ? 'Authorised' : 'Authorisation failed'}</h1>
         <p style="color:#666">${code ? 'Close this tab and return to the terminal.' : String(error ?? 'No code returned.')}</p>`,
      );

      server.close();
      if (code) resolve(code);
      else reject(new Error(String(error ?? 'no code in redirect')));
    });

    server.on('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${PORT} is in use. Close whatever holds it and re-run.`)
          : err,
      );
    });
    server.listen(PORT, '127.0.0.1');
  });
}

async function exchange(code, clientId, clientSecret) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    die(`Token exchange failed — HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  if (!data.refresh_token) {
    die(
      'Google returned an access token but no refresh token.\n' +
        '    That happens when consent was previously granted. Revoke this app at\n' +
        '    https://myaccount.google.com/permissions and run this again.',
    );
  }
  return data.refresh_token;
}

/** Upserts keys in .env, preserving every other line and the file's newlines. */
async function writeEnv(values) {
  let existing = '';
  try {
    existing = await readFile(ENV_PATH, 'utf8');
  } catch {
    // A fresh .env is fine.
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  let lines = existing.length ? existing.split(/\r?\n/) : [];

  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  while (lines.length && lines.at(-1) === '') lines.pop();

  await writeFile(ENV_PATH, lines.join(eol) + eol, 'utf8');
}

const mask = (s) => `${'•'.repeat(8)}${s.slice(-6)} (${s.length} chars)`;

// ---------------------------------------------------------------------------

const clientFile = await findClientJson(process.argv[2]);
const { clientId, clientSecret } = await readCredentials(clientFile);
console.log(`\n  Using ${path.relative(process.cwd(), clientFile) || clientFile}`);

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // without this there is no refresh token at all
    prompt: 'consent', // force one even if consent was granted before
  });

console.log('\n  Opening the consent screen. If it does not appear, paste this:\n');
console.log(`  ${authUrl}\n`);
console.log('  Expect an "unverified app" warning — choose Advanced, then continue.');
console.log('  Waiting for the redirect…');
openBrowser(authUrl);

let refreshToken;
try {
  refreshToken = await exchange(await awaitCode(), clientId, clientSecret);
} catch (err) {
  die(err.message);
}

await writeEnv({
  GMAIL_CLIENT_ID: clientId,
  GMAIL_CLIENT_SECRET: clientSecret,
  GMAIL_REFRESH_TOKEN: refreshToken,
});

console.log(`\n  ✓ Written to .env (gitignored)`);
console.log(`    GMAIL_CLIENT_ID      ${mask(clientId)}`);
console.log(`    GMAIL_CLIENT_SECRET  ${mask(clientSecret)}`);
console.log(`    GMAIL_REFRESH_TOKEN  ${mask(refreshToken)}`);
console.log('\n  Next: push them to the Worker.\n');
console.log('    npm run secrets:gmail\n');
