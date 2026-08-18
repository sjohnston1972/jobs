import { FIELD_VALIDATORS, isSettableKey } from './settings-schema';
import type { FieldResult } from './settings-schema';
import type { Criteria } from './types';

/**
 * Sparse overrides over config/criteria.json.
 *
 * Only fields actually changed in the portal have a row. A field never touched
 * still tracks the bundled file, so editing criteria.json and redeploying —
 * the process CLAUDE.md documents — keeps working for everything else. Reset
 * deletes the row rather than writing the current default into it, so a field
 * can always be handed back to the file.
 */

interface SettingRow {
  key: string;
  value: string;
}

export async function readOverrides(db: D1Database): Promise<Record<string, unknown>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<SettingRow>();
  const out: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // A row that is not JSON is skipped rather than thrown. mergeCriteria
      // would drop it anyway; this keeps the failure to one field.
      console.log(`settings: ignoring unparseable value for ${row.key}`);
    }
  }
  return out;
}

export async function setOverride(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

export async function clearOverride(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

/**
 * Pure, and exported separately from loadCriteria so the precedence rules can
 * be tested without a database. An invalid stored value is logged and dropped,
 * never thrown: a setting must not be able to stop a run.
 */
export function mergeCriteria(defaults: Criteria, rows: Record<string, unknown>): Criteria {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, raw] of Object.entries(rows)) {
    if (!isSettableKey(key)) {
      console.log(`settings: ignoring unknown key ${key}`);
      continue;
    }
    let result: FieldResult;
    try {
      result = FIELD_VALIDATORS[key](raw);
    } catch (err) {
      // A validator must not discard all overrides if it throws.
      console.log(`settings: validator threw for ${key} (${String(err)}), using default`);
      continue;
    }
    if (!result.ok) {
      console.log(`settings: ignoring invalid ${key} (${result.error}), using default`);
      continue;
    }
    merged[key] = result.value;
  }
  return merged as unknown as Criteria;
}
