import { describe, expect, it } from 'vitest';
import { fetchWithRetry } from '../src/lib/http';

/** A fetch stub that replays a queue of responses and records every call. */
function stubFetch(statuses: Array<number | { status: number; retryAfter: string }>) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    calls.push(url);
    const next = statuses[calls.length - 1] ?? 200;
    const status = typeof next === 'number' ? next : next.status;
    const headers = new Headers();
    if (typeof next !== 'number') headers.set('retry-after', next.retryAfter);
    return new Response('body', { status, headers });
  };
  return { fn, calls };
}

describe('fetchWithRetry', () => {
  it('returns the first success without retrying', async () => {
    const { fn, calls } = stubFetch([200]);
    const response = await fetchWithRetry('https://example.test/a', {}, { fetchImpl: fn });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  it('retries a 503 and returns the eventual success', async () => {
    const { fn, calls } = stubFetch([503, 503, 200]);
    const response = await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 0 },
    );
    expect(response.status).toBe(200);
    expect(calls.length).toBe(3);
  });

  it('retries a 429', async () => {
    const { fn, calls } = stubFetch([429, 200]);
    await fetchWithRetry('https://example.test/a', {}, { fetchImpl: fn, baseDelayMs: 0 });
    expect(calls.length).toBe(2);
  });

  it('gives up after the attempt limit and returns the last failing response', async () => {
    const { fn, calls } = stubFetch([503, 503, 503]);
    const response = await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 0, attempts: 3 },
    );
    expect(response.status).toBe(503);
    expect(calls.length).toBe(3);
  });

  it('does not retry a 400 — a bad request will never succeed by repeating it', async () => {
    const { fn, calls } = stubFetch([400, 200]);
    const response = await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 0 },
    );
    expect(response.status).toBe(400);
    expect(calls.length).toBe(1);
  });

  it('does not retry a 401 — bad credentials are not transient', async () => {
    const { fn, calls } = stubFetch([401, 200]);
    await fetchWithRetry('https://example.test/a', {}, { fetchImpl: fn, baseDelayMs: 0 });
    expect(calls.length).toBe(1);
  });

  it('honours a retry-after header in preference to its own backoff', async () => {
    const waits: number[] = [];
    const { fn } = stubFetch([{ status: 503, retryAfter: '2' }, 200]);
    await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 500, sleepImpl: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([2000]);
  });

  it('backs off exponentially when no retry-after is given', async () => {
    const waits: number[] = [];
    const { fn } = stubFetch([503, 503, 200]);
    await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 500, sleepImpl: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([500, 1000]);
  });

  it('retries a thrown network error', async () => {
    let calls = 0;
    const fn = async (): Promise<Response> => {
      calls++;
      if (calls < 3) throw new TypeError('network failure');
      return new Response('ok', { status: 200 });
    };
    const response = await fetchWithRetry(
      'https://example.test/a',
      {},
      { fetchImpl: fn, baseDelayMs: 0 },
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('rethrows a network error that never resolves', async () => {
    const fn = async (): Promise<Response> => {
      throw new TypeError('network failure');
    };
    await expect(
      fetchWithRetry('https://example.test/a', {}, { fetchImpl: fn, baseDelayMs: 0, attempts: 2 }),
    ).rejects.toThrow('network failure');
  });
});
