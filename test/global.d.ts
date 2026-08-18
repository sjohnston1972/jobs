// Test files run under Node, not the Workers runtime, so they need a couple
// of ambient declarations the main tsconfig deliberately doesn't provide
// (its "types" is restricted to @cloudflare/workers-types so src/ code can't
// accidentally rely on Node globals). Pulling in the full @types/node package
// here instead would re-declare the global URL class and conflict with the
// one workers-types provides, so this is kept to exactly what the tests use.

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: string): string;
}

interface ImportMeta {
  url: string;
}
