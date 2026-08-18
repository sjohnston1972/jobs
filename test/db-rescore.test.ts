import { describe, expect, it, vi } from 'vitest';
import { clearScoresSince, countRescorable } from '../src/lib/db';

// mockReturnThis() on a bare vi.fn() returns the mock function itself, not
// the enclosing stmt object — bind(...).first()/.run() would then be called
// on a function with no such methods. Declare stmt first and have bind
// return it explicitly so the chain resolves through the same object that
// carries first/run.
function fakeDb(returns: unknown) {
  const stmt = {
    bind: vi.fn(() => stmt),
    first: vi.fn().mockResolvedValue(returns),
    run: vi.fn().mockResolvedValue({ meta: { changes: 3 } }),
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

  it('deletes only scores inside the window and reports the count', async () => {
    const { db, prepare, bind } = fakeDb(null);
    const deleted = await clearScoresSince(db, '2026-08-11T00:00:00.000Z');
    expect(prepare.mock.calls[0][0]).toContain('DELETE FROM scores');
    expect(bind).toHaveBeenCalledWith('2026-08-11T00:00:00.000Z');
    expect(deleted).toBe(3);
  });
});
