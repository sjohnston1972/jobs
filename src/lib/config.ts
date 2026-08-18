import criteriaJson from '../../config/criteria.json';
import profileMd from '../../config/profile.md';
import { mergeCriteria, readOverrides } from './settings';
import type { Criteria } from './types';

/**
 * Both files are bundled into the Worker at build time. `criteria` is the
 * defaults; the settings table overrides individual fields at runtime. Use
 * loadCriteria wherever behaviour depends on tuning — `criteria` alone is only
 * correct for showing the user what "default" means.
 */
export const criteria = criteriaJson as unknown as Criteria;
export const profile: string = profileMd;

export async function loadCriteria(db: D1Database): Promise<Criteria> {
  try {
    return mergeCriteria(criteria, await readOverrides(db));
  } catch (err) {
    // A dead settings table must not take the run with it.
    console.log(`settings: read failed, using file defaults — ${String(err)}`);
    return criteria;
  }
}
