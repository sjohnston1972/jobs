import { describe, expect, it } from 'vitest';
import { capsScore } from '../src/pipeline/score';
import type { Attendance } from '../src/lib/types';

const ALL: Attendance[] = ['none', 'occasional', 'fixed', 'onsite', 'unstated'];

describe('capsScore', () => {
  it('strict caps every stated attendance requirement', () => {
    expect(capsScore('strict', 'occasional')).toBe(true);
    expect(capsScore('strict', 'fixed')).toBe(true);
    expect(capsScore('strict', 'onsite')).toBe(true);
  });

  it('mostly tolerates occasional travel but not fixed days', () => {
    expect(capsScore('mostly', 'occasional')).toBe(false);
    expect(capsScore('mostly', 'fixed')).toBe(true);
    expect(capsScore('mostly', 'onsite')).toBe(true);
  });

  it('any never caps', () => {
    for (const a of ALL) expect(capsScore('any', a)).toBe(false);
  });

  it('never caps a fully remote posting', () => {
    expect(capsScore('strict', 'none')).toBe(false);
    expect(capsScore('mostly', 'none')).toBe(false);
  });

  it('never caps an unstated posting at any level', () => {
    expect(capsScore('strict', 'unstated')).toBe(false);
    expect(capsScore('mostly', 'unstated')).toBe(false);
  });

  it('never caps when the model returned nothing', () => {
    expect(capsScore('strict', null)).toBe(false);
  });
});
