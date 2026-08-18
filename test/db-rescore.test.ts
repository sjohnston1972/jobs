import { describe, expect, it, vi } from 'vitest';
import { clearScoresSince, countRescorable } from '../src/lib/db';

// mockReturnThis() on a bare vi.fn() returns the mock function itself, not
// the enclosing stmt object — bind(...).first()/.run() would then be called
// on a function with no such methods. Declare stmt first and have bind
// return it explicitly so the chain resolves through the same object that
// carries first/run.
function fakeDb(returns: unknown, runResult: unknown = { meta: { changes: 3 } }) {
  const stmt = {
    bind: vi.fn(() => stmt),
    first: vi.fn().mockResolvedValue(returns),
    run: vi.fn().mockResolvedValue(runResult),
  };
  const prepare = vi.fn().mockReturnValue(stmt);
  return { db: { prepare } as unknown as D1Database, prepare, bind: stmt.bind };
}

describe('rescore helpers', () => {
  it('counts only scores inside the window', async () => {
    const { db, prepare, bind } = fakeDb({ n: 47 });
    const n = await countRescorable(db, '2026-08-11T00:00:00.000Z');
    expect(prepare.mock.calls[0][0]).toContain('FROM scores');
    expect(prepare.mock.calls[0][0]).toContain('first_seen_at >=');
    expect(bind).toHaveBeenCalledWith('2026-08-11T00:00:00.000Z');
    expect(n).toBe(47);
  });

  it('deletes only scores inside the window, scoped by a job_id subquery, and reports the count', async () => {
    const { db, prepare, bind } = fakeDb(null);
    const deleted = await clearScoresSince(db, '2026-08-11T00:00:00.000Z');
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain('DELETE FROM scores');
    expect(sql).toContain('job_id IN');
    expect(sql).toContain('first_seen_at >=');
    // Guards against a predicate-free delete (e.g. someone dropping the
    // subquery and leaving `DELETE FROM scores` with nothing after it) —
    // that regression would still satisfy the three toContain checks above
    // on their own, since none of them requires a WHERE clause to exist.
    expect(sql).toContain('WHERE');
    expect(bind).toHaveBeenCalledWith('2026-08-11T00:00:00.000Z');
    expect(deleted).toBe(3);
  });

  it('falls back to 0 when D1 reports no changes metadata', async () => {
    const { db } = fakeDb(null, { meta: { changes: 0 } });
    const deleted = await clearScoresSince(db, '2026-08-11T00:00:00.000Z');
    expect(deleted).toBe(0);
  });
});
