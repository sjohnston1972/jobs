/**
 * One outbound call, retried on the failures worth retrying.
 *
 * The board collectors had no retry at all, so a single blip lost that query's
 * entire contribution for the day — and a failed seed query is invisible in the
 * digest, which reports only what it found. The policy mirrors `callClaude` in
 * `lib/claude.ts` rather than inventing a second one: 429 and 5xx are transient,
 * a 4xx other than 429 will never succeed by repeating it, and a stated
 * `retry-after` beats our own guess.
 *
 * An exhausted HTTP failure is RETURNED, not thrown, because the collectors
 * already build their own error messages from the status and body. A network
 * error has no response to return, so that one rethrows.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injected for tests, so the suite does not spend the backoff in real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const {
    attempts = 3,
    baseDelayMs = 800,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) throw err;
      await sleepImpl(baseDelayMs * attempt);
      continue;
    }

    if (!isRetryable(response.status) || attempt === attempts) return response;

    // A server that tells us when to come back knows better than our backoff.
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleepImpl(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * attempt,
    );
  }

  // Unreachable: the loop either returns a response or throws on the last attempt.
  throw lastError ?? new Error(`fetchWithRetry exhausted ${attempts} attempt(s) for ${url}`);
}
