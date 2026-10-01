// @ts-check
import { readFile } from 'node:fs/promises';

/** @typedef {{ project: string, iid: number, source?: 'gitlab' }} TrackedRef */

export const ITEMS_PATH = 'items.json';

/**
 * A git.drupalcode.org URL can only be a GitLab work item. A drupal.org URL or
 * shorthand may be either: drupal.org keeps a stub node for migrated issues.
 * @type {{ pattern: RegExp, source?: 'gitlab' }[]}
 */
const REF_PATTERNS = [
  { pattern: /git\.drupalcode\.org\/project\/([a-z0-9_]+)\/-\/(?:work_items|issues)\/(\d+)/i, source: 'gitlab' },
  { pattern: /drupal\.org\/project\/([a-z0-9_]+)\/issues\/(\d+)/i },
  { pattern: /^(?:project\/)?([a-z0-9_]+)#(\d+)$/i },
];

/** @param {TrackedRef} ref */
export const refKey = (ref) => `${ref.project}#${ref.iid}`;

/**
 * @param {string} entry
 * @returns {TrackedRef | null}
 */
export function parseRef(entry) {
  for (const { pattern, source } of REF_PATTERNS) {
    const match = entry.trim().match(pattern);
    if (match) {
      /** @type {TrackedRef} */
      const ref = { project: match[1].toLowerCase(), iid: Number(match[2]) };
      if (source) ref.source = source;
      return ref;
    }
  }
  return null;
}

/**
 * Reads the contributed list of work items. Unreadable and duplicate entries
 * are reported as problems instead of thrown, so one bad line cannot stop the
 * board from publishing.
 * @param {string} path
 * @returns {Promise<{ refs: TrackedRef[], problems: string[] }>}
 */
export async function readItems(path = ITEMS_PATH) {
  const raw = await readFile(path, 'utf8');
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON array of work item URLs or project#id strings.`);
  }

  /** @type {TrackedRef[]} */
  const refs = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const entry of parsed) {
    const ref = typeof entry === 'string' ? parseRef(entry) : null;
    if (!ref) {
      problems.push(`Could not read ${JSON.stringify(entry)}. Use a work item URL or project#id.`);
      continue;
    }
    const key = refKey(ref);
    const firstEntry = seen.get(key);
    if (firstEntry !== undefined) {
      problems.push(`${JSON.stringify(entry)} is the same work item as ${JSON.stringify(firstEntry)}.`);
      continue;
    }
    seen.set(key, String(entry));
    refs.push(ref);
  }
  return { refs, problems };
}
