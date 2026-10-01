// @ts-check
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { ITEMS_PATH, readItems, refKey } from './items.mjs';

/** @typedef {import('./items.mjs').TrackedRef} TrackedRef */
/** @typedef {{ iid: number, title: string, state: string, draft: boolean, webUrl: string }} MergeRequestSummary */
/** @typedef {{ key: string, name: string }} Status */
/**
 * @typedef {object} WorkItem
 * @property {string} project
 * @property {number} iid
 * @property {'gitlab' | 'drupalorg' | 'unknown'} source
 * @property {string} title
 * @property {'opened' | 'closed'} state
 * @property {Status | null} status
 * @property {string[]} tags
 * @property {string} webUrl
 * @property {string} updatedAt
 * @property {MergeRequestSummary[]} mergeRequests
 * @property {string | null} problem
 */
/** @typedef {{ generatedAt: string, itemsEditUrl: string | null, items: WorkItem[] }} Snapshot */

const SNAPSHOT_PATH = 'data.json';
const GITLAB_API = 'https://git.drupalcode.org/api/v4';
const DRUPALORG_API = 'https://www.drupal.org/api-d7';
const ISSUES_PER_REQUEST = 100;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_SECONDS = 60;

const STATUS = {
  active: { key: 'active', name: 'Active' },
  accepted: { key: 'accepted', name: 'Accepted' },
  needsWork: { key: 'needs-work', name: 'Needs work' },
  needsReview: { key: 'needs-review', name: 'Needs review' },
  rtbc: { key: 'rtbc', name: 'RTBC' },
  fixed: { key: 'fixed', name: 'Fixed' },
  postponed: { key: 'postponed', name: 'Postponed' },
  postponedNeedsInfo: { key: 'postponed', name: 'Postponed (needs info)' },
  toBePorted: { key: 'to-be-ported', name: 'To be ported' },
  closed: { key: 'closed', name: 'Closed' },
};

/** GitLab `state::` label values, normalized to lowercase without separators. */
/** @type {Record<string, Status>} */
const GITLAB_STATE_LABELS = {
  active: STATUS.active,
  accepted: STATUS.accepted,
  needswork: STATUS.needsWork,
  needsreview: STATUS.needsReview,
  rtbc: STATUS.rtbc,
  fixed: STATUS.fixed,
  postponed: STATUS.postponed,
  tobeported: STATUS.toBePorted,
  closed: STATUS.closed,
};

/** Drupal.org `field_issue_status` values. */
/** @type {Record<string, { status: Status, closed: boolean, why?: string }>} */
const DRUPALORG_STATUSES = {
  '1': { status: STATUS.active, closed: false },
  '2': { status: STATUS.fixed, closed: false },
  '3': { status: STATUS.closed, closed: true, why: 'duplicate' },
  '4': { status: STATUS.postponed, closed: false },
  '5': { status: STATUS.closed, closed: true, why: "won't fix" },
  '6': { status: STATUS.closed, closed: true, why: 'works as designed' },
  '7': { status: STATUS.closed, closed: true, why: 'fixed' },
  '8': { status: STATUS.needsReview, closed: false },
  '13': { status: STATUS.needsWork, closed: false },
  '14': { status: STATUS.rtbc, closed: false },
  '15': { status: STATUS.toBePorted, closed: false },
  '16': { status: STATUS.postponedNeedsInfo, closed: false },
  '17': { status: STATUS.closed, closed: true, why: 'outdated' },
  '18': { status: STATUS.closed, closed: true, why: 'cannot reproduce' },
};

/** @type {Record<string, string>} */
const DRUPALORG_PRIORITIES = { '400': 'critical', '300': 'major', '200': 'normal', '100': 'minor' };
/** @type {Record<string, string>} */
const DRUPALORG_CATEGORIES = { '1': 'bug', '2': 'task', '3': 'feature', '4': 'support', '5': 'plan' };

/** @param {unknown} error */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Caps how many requests run at once. A finished task hands its slot straight
 * to the next waiting one.
 * @param {number} maxConcurrent
 */
function createLimiter(maxConcurrent) {
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  return async (task) => {
    if (active < maxConcurrent) {
      active++;
    } else {
      await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const limit = createLimiter(MAX_CONCURRENT_REQUESTS);

const userAgent = process.env.GITHUB_REPOSITORY
  ? `rosetta-tracker (+${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY})`
  : 'rosetta-tracker';

/** @type {Record<string, string>} */
const gitlabAuthHeaders = process.env.DRUPALCODE_TOKEN ? { 'PRIVATE-TOKEN': process.env.DRUPALCODE_TOKEN } : {};

/** @param {Response} response */
function retryDelaySeconds(response) {
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_SECONDS;
}

/**
 * @param {string} url
 * @param {string} service
 * @param {Record<string, string>} headers
 * @returns {Promise<any>}
 */
async function getJson(url, service, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = await limit(async () => {
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent, ...headers } });
      if (response.status === 429) return { retryAfter: retryDelaySeconds(response) };
      if (response.status === 404) return { body: null };
      if (!response.ok) throw new Error(`${service} responded ${response.status}`);
      return { body: await response.json() };
    });
    if (!('retryAfter' in result)) return result.body;
    if (attempt === MAX_ATTEMPTS) throw new Error(`${service} rate limit hit ${MAX_ATTEMPTS} times in a row.`);
    console.warn(`${service} rate limit hit. Waiting ${result.retryAfter} s before retrying ${url}`);
    await sleep(result.retryAfter * 1000);
  }
}

/** @param {string} path */
const gitlabGet = (path) => getJson(`${GITLAB_API}${path}`, 'GitLab', gitlabAuthHeaders);

/** @param {string} project */
const gitlabProjectPath = (project) => encodeURIComponent(`project/${project}`);

/**
 * @param {any} row
 * @returns {MergeRequestSummary}
 */
function summarizeMergeRequest(row) {
  return {
    iid: row.iid,
    title: row.title,
    state: row.state,
    draft: Boolean(row.draft),
    webUrl: row.web_url,
  };
}

/**
 * @param {string} project
 * @param {number} iid
 * @returns {Promise<MergeRequestSummary[]>}
 */
async function fetchWorkItemMergeRequests(project, iid) {
  const rows = await gitlabGet(`/projects/${gitlabProjectPath(project)}/issues/${iid}/related_merge_requests`);
  return Array.isArray(rows) ? rows.map(summarizeMergeRequest) : [];
}

/**
 * Merge requests for a Drupal.org issue live on the issue fork `issue/<project>-<nid>`.
 * @param {string} project
 * @param {number} nid
 * @returns {Promise<MergeRequestSummary[]>}
 */
async function fetchIssueForkMergeRequests(project, nid) {
  const fork = await gitlabGet(`/projects/${encodeURIComponent(`issue/${project}-${nid}`)}`);
  if (!fork) return [];
  const rows = await gitlabGet(
    `/projects/${gitlabProjectPath(project)}/merge_requests?source_project_id=${fork.id}&state=all&per_page=50`,
  );
  return Array.isArray(rows) ? rows.map(summarizeMergeRequest) : [];
}

/**
 * @param {string} project
 * @param {number[]} iids
 * @returns {Promise<Map<number, any>>}
 */
async function fetchGitlabIssues(project, iids) {
  const found = new Map();
  for (let start = 0; start < iids.length; start += ISSUES_PER_REQUEST) {
    const chunk = iids.slice(start, start + ISSUES_PER_REQUEST);
    const query = chunk.map((iid) => `iids[]=${iid}`).join('&');
    const rows = await gitlabGet(`/projects/${gitlabProjectPath(project)}/issues?per_page=${ISSUES_PER_REQUEST}&${query}`);
    for (const row of rows ?? []) found.set(row.iid, row);
  }
  return found;
}

/**
 * @param {string[]} labels
 * @param {string} prefix
 */
function labelValue(labels, prefix) {
  const label = labels.find((name) => name.startsWith(prefix));
  return label ? label.slice(prefix.length) : null;
}

/**
 * @param {string[]} labels
 * @returns {Status | null}
 */
function statusFromLabels(labels) {
  const raw = labelValue(labels, 'state::');
  if (raw === null) return null;
  const key = raw.toLowerCase().replace(/[\s_-]/g, '');
  return GITLAB_STATE_LABELS[key] ?? { key: 'other', name: raw };
}

/**
 * @param {string} project
 * @param {any} row
 * @param {MergeRequestSummary[]} mergeRequests
 * @param {string | null} problem
 * @returns {WorkItem}
 */
function workItemFromGitlab(project, row, mergeRequests, problem) {
  const labels = Array.isArray(row.labels) ? row.labels : [];
  return {
    project,
    iid: row.iid,
    source: 'gitlab',
    title: row.title,
    state: row.state === 'closed' ? 'closed' : 'opened',
    status: statusFromLabels(labels),
    tags: [labelValue(labels, 'why::'), labelValue(labels, 'category::'), labelValue(labels, 'priority::')]
      .filter((tag) => tag !== null),
    webUrl: row.web_url,
    updatedAt: row.updated_at,
    mergeRequests,
    problem,
  };
}

/**
 * @param {string} project
 * @param {any} node
 * @param {MergeRequestSummary[]} mergeRequests
 * @param {string | null} problem
 * @returns {WorkItem}
 */
function workItemFromDrupalorg(project, node, mergeRequests, problem) {
  const statusInfo = DRUPALORG_STATUSES[String(node.field_issue_status)];
  return {
    project,
    iid: Number(node.nid),
    source: 'drupalorg',
    title: node.title,
    state: statusInfo?.closed ? 'closed' : 'opened',
    status: statusInfo?.status ?? null,
    tags: [
      statusInfo?.why ?? null,
      DRUPALORG_CATEGORIES[String(node.field_issue_category)] ?? null,
      DRUPALORG_PRIORITIES[String(node.field_issue_priority)] ?? null,
    ].filter((tag) => tag !== null),
    webUrl: node.url,
    updatedAt: new Date(Number(node.changed) * 1000).toISOString(),
    mergeRequests,
    problem,
  };
}

/**
 * @param {TrackedRef} ref
 * @param {string} problem
 * @param {WorkItem | undefined} previous
 * @returns {WorkItem}
 */
function problemItem(ref, problem, previous) {
  return previous
    ? { ...previous, problem }
    : {
        project: ref.project,
        iid: ref.iid,
        source: 'unknown',
        title: '',
        state: 'opened',
        status: null,
        tags: [],
        webUrl: ref.source === 'gitlab'
          ? `https://git.drupalcode.org/project/${ref.project}/-/work_items/${ref.iid}`
          : `https://www.drupal.org/project/${ref.project}/issues/${ref.iid}`,
        updatedAt: '',
        mergeRequests: [],
        problem,
      };
}

/**
 * @param {TrackedRef} ref
 * @param {WorkItem | undefined} previous
 * @returns {Promise<WorkItem>}
 */
async function fetchDrupalorgIssue(ref, previous) {
  const node = await getJson(`${DRUPALORG_API}/node/${ref.iid}.json`, 'Drupal.org');
  if (!node || node.type !== 'project_issue') {
    return problemItem(ref, 'Not found on git.drupalcode.org or drupal.org.', previous);
  }
  const owner = node.field_project?.machine_name;
  if (owner && owner !== ref.project) {
    return problemItem(ref, `This issue belongs to ${owner}, not ${ref.project}. Track it as ${owner}#${ref.iid}.`, previous);
  }
  try {
    return workItemFromDrupalorg(ref.project, node, await fetchIssueForkMergeRequests(ref.project, ref.iid), null);
  } catch (error) {
    return workItemFromDrupalorg(
      ref.project,
      node,
      previous?.mergeRequests ?? [],
      `Could not load merge requests: ${errorMessage(error)}`,
    );
  }
}

/**
 * @param {string} project
 * @param {any} row
 * @param {WorkItem | undefined} previous
 * @returns {Promise<WorkItem>}
 */
async function fetchGitlabWorkItem(project, row, previous) {
  if (row.merge_requests_count === 0) {
    return workItemFromGitlab(project, row, [], null);
  }
  try {
    return workItemFromGitlab(project, row, await fetchWorkItemMergeRequests(project, row.iid), null);
  } catch (error) {
    return workItemFromGitlab(
      project,
      row,
      previous?.mergeRequests ?? [],
      `Could not load merge requests: ${errorMessage(error)}`,
    );
  }
}

/**
 * @param {TrackedRef[]} refs
 * @param {Record<string, WorkItem>} previousItems
 * @returns {Promise<Record<string, WorkItem>>}
 */
async function fetchWorkItems(refs, previousItems) {
  /** @type {Map<string, TrackedRef[]>} */
  const byProject = new Map();
  for (const ref of refs) {
    byProject.set(ref.project, [...(byProject.get(ref.project) ?? []), ref]);
  }

  /** @type {Record<string, WorkItem>} */
  const items = {};
  await Promise.all([...byProject].map(async ([project, projectRefs]) => {
    let gitlabRows = new Map();
    let gitlabProblem = null;
    try {
      gitlabRows = await fetchGitlabIssues(project, projectRefs.map((ref) => ref.iid));
    } catch (error) {
      gitlabProblem = errorMessage(error);
    }

    await Promise.all(projectRefs.map(async (ref) => {
      const key = refKey(ref);
      const previous = previousItems[key];
      const row = gitlabRows.get(ref.iid);
      if (row) {
        items[key] = await fetchGitlabWorkItem(project, row, previous);
        return;
      }
      const gitlabOnly = ref.source === 'gitlab' || previous?.source === 'gitlab';
      if (gitlabProblem !== null && gitlabOnly) {
        items[key] = problemItem(ref, gitlabProblem, previous);
        return;
      }
      if (ref.source === 'gitlab') {
        items[key] = problemItem(ref, 'Not found on git.drupalcode.org.', previous);
        return;
      }
      try {
        items[key] = await fetchDrupalorgIssue(ref, previous);
      } catch (error) {
        items[key] = problemItem(ref, errorMessage(error), previous);
      }
    }));
  }));
  return items;
}

/**
 * The last published snapshot lets an item keep its details when a fetch fails.
 * @returns {Promise<Record<string, WorkItem>>}
 */
async function readPreviousItems() {
  let raw;
  try {
    raw = await readFile(SNAPSHOT_PATH, 'utf8');
  } catch {
    return {};
  }
  try {
    /** @type {Snapshot} */
    const snapshot = JSON.parse(raw);
    return Object.fromEntries(snapshot.items.map((item) => [refKey(item), item]));
  } catch (error) {
    console.warn(`Ignoring the previous ${SNAPSHOT_PATH}: ${errorMessage(error)}`);
    return {};
  }
}

/** Links the board's "Suggest an item" button to GitHub's editor when running in Actions. */
function itemsEditUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_REF_NAME } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_REF_NAME) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/edit/${GITHUB_REF_NAME}/${ITEMS_PATH}`;
}

const { refs, problems } = await readItems();
for (const problem of problems) console.warn(`Skipped: ${problem}`);

const items = await fetchWorkItems(refs, await readPreviousItems());
/** @type {Snapshot} */
const snapshot = {
  generatedAt: new Date().toISOString(),
  itemsEditUrl: itemsEditUrl(),
  items: refs.map((ref) => items[refKey(ref)]),
};
await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);

const withProblems = snapshot.items.filter((item) => item.problem !== null).length;
console.log(`Wrote ${snapshot.items.length} work items to ${SNAPSHOT_PATH}, ${withProblems} with problems.`);
