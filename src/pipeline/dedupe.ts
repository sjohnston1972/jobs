import { daysAgoIso, getExistingIds, getRecentHashes, getRecentRoleHashes } from '../lib/db';
import type { NormalisedJob } from '../lib/types';
import { UNSCORED_SOURCES } from '../lib/types';

export interface DedupeResult {
  fresh: NormalisedJob[];
  bySourceId: number;
  byContentHash: number;
  byRoleHash: number;
  withinBatch: number;
}

/**
 * Three levels, for the same reason a switch keeps both a MAC table and an ARP
 * cache:
 *   1. `id` stops the same posting from the same source reappearing.
 *   2. `content_hash` catches one role listed on both boards under different IDs.
 *   3. `role_hash` catches one role listed by three different agencies, where
 *      the employer field differs and so levels 1 and 2 both miss it. This is
 *      the common case in contract recruitment and was the largest single
 *      source of repeats in the first live run.
 */
export async function dedupe(
  db: D1Database,
  incoming: NormalisedJob[],
  hashWindowDays = 30,
  roleWindowDays = 14,
): Promise<DedupeResult> {
  if (!incoming.length) {
    return { fresh: [], bySourceId: 0, byContentHash: 0, byRoleHash: 0, withinBatch: 0 };
  }

  const knownIds = await getExistingIds(db, incoming.map((j) => j.id));
  const knownHashes = await getRecentHashes(db, daysAgoIso(hashWindowDays));
  // A shorter window than content_hash: role_hash is the looser key, so it is
  // given less time to collapse two things that only look alike.
  const knownRoleHashes = await getRecentRoleHashes(db, daysAgoIso(roleWindowDays));

  const fresh: NormalisedJob[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const seenRoleHashes = new Set<string>();

  let bySourceId = 0;
  let byContentHash = 0;
  let byRoleHash = 0;
  let withinBatch = 0;

  for (const job of incoming) {
    if (knownIds.has(job.id)) {
      bySourceId++;
      continue;
    }
    if (seenIds.has(job.id)) {
      withinBatch++;
      continue;
    }
    if (knownHashes.has(job.content_hash) || seenHashes.has(job.content_hash)) {
      byContentHash++;
      continue;
    }
    if (job.role_hash && (knownRoleHashes.has(job.role_hash) || seenRoleHashes.has(job.role_hash))) {
      byRoleHash++;
      continue;
    }

    seenIds.add(job.id);
    // A row that can never be scored must not suppress one that can. A
    // LinkedIn lead has no salary, and normaliseForHash buckets a null salary
    // to 0 — so it hashes identically to any board posting for the same role
    // that states no salary, which is the common case. The alert email lands
    // minutes before the daily cron, so without this the lead wins the window
    // and the Reed posting with a full description is dropped as its
    // duplicate. Since the lead is never scored, the role would then be
    // absent from the digest entirely. getRecentHashes applies the same rule
    // to what is already stored.
    if (!UNSCORED_SOURCES.includes(job.source)) {
      seenHashes.add(job.content_hash);
      if (job.role_hash) seenRoleHashes.add(job.role_hash);
    }
    fresh.push(job);
  }

  return { fresh, bySourceId, byContentHash, byRoleHash, withinBatch };
}
