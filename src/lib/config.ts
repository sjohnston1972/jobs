import criteriaJson from '../../config/criteria.json';
import profileMd from '../../config/profile.md';
import type { Criteria } from './types';

/**
 * Both files are bundled into the Worker at build time, so editing them and
 * redeploying is the whole change process — no database migration, no restart.
 */
export const criteria = criteriaJson as Criteria;
export const profile: string = profileMd;
