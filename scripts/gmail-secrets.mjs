#!/usr/bin/env node
/**
 * Pushes the three Gmail secrets from .env to the Worker.
 *
 * `wrangler secret put` reads the value from stdin, which keeps it off the
 * command line and out of shell history. Doing it here rather than in a shell
 * one-liner also keeps it working on both PowerShell and bash.
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

let env;
try {
  env = await readFile(path.join(ROOT, '.env'), 'utf8');
} catch {
  console.error('\n  ✗ No .env. Run `node scripts/gmail-auth.mjs` first.\n');
  process.exit(1);
}

const values = Object.fromEntries(
  env
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const missing = KEYS.filter((k) => !values[k]);
if (missing.length) {
  console.error(`\n  ✗ .env is missing ${missing.join(', ')}.`);
  console.error('    Run `node scripts/gmail-auth.mjs` first.\n');
  process.exit(1);
}

function put(key, value) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', key], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`wrangler exited ${code} for ${key}`)),
    );
    child.stdin.end(value);
  });
}

for (const key of KEYS) {
  console.log(`\n  → ${key}`);
  try {
    await put(key, values[key]);
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n`);
    process.exit(1);
  }
}

console.log('\n  ✓ All three pushed.\n');
