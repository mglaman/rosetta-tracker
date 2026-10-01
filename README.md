# Rosetta tracker

The shared board for Rosetta, the initiative around the Tool API and exposing Drupal's capabilities to agents. It tracks issues across Drupal.org projects, whether the project uses GitLab work items on `git.drupalcode.org` or the classic issue queue on `drupal.org`, and sorts them into **Open**, **Has MR**, and **Closed**.

## Add a work item

Add a line to `items.json` and open a pull request. The **Suggest an item** button on the board opens the GitHub editor for that file.

```json
[
  "https://git.drupalcode.org/project/gin/-/work_items/3593543",
  "https://www.drupal.org/project/simple_oauth/issues/3616124",
  "mcp_server#3585931"
]
```

Each entry is a work item URL, a drupal.org issue URL, or `project#id` shorthand. The **Check items** workflow fails the pull request if an entry cannot be read or duplicates another.

A `git.drupalcode.org` URL is always a GitLab work item. A `drupal.org` URL or `project#id` shorthand is resolved during refresh: GitLab first, then drupal.org. Work item iids match the old Drupal.org node IDs, and drupal.org keeps a stub node for migrated issues, so the drupal.org URL alone cannot tell which queue is live.

## How it works

Two files split the list from its details:

| File | Written by | Committed |
|------|------------|-----------|
| `items.json` | Contributors, through pull requests | Yes |
| `data.json` | `scripts/refresh.mjs` | No |

The **Publish board** workflow runs on every push to `main`, every 30 minutes, and on demand. It downloads the live `data.json`, runs `scripts/refresh.mjs`, and deploys `index.html` and the new `data.json` to GitHub Pages. Viewers load `data.json` and make no API calls.

The previous snapshot matters when a request fails: the item keeps its last known details and shows the error on its card.

Per refresh:

1. One GitLab request per project, per 100 items, fetches tracked work items by `iids[]`.
2. One GitLab request per work item with `merge_requests_count > 0` fetches its related merge requests.
3. For each id GitLab does not know, one drupal.org request fetches `node/<nid>.json`.
4. For each drupal.org issue, one GitLab request looks up the issue fork `issue/<project>-<nid>`, and one more lists the project's merge requests filtered by that fork's `source_project_id`.

The script runs four requests at a time. On a `429` response, it waits for `Retry-After` (or 60 seconds) and retries up to four times. Unauthenticated GitLab requests are limited to 180 per minute per IP, and GitHub runners share IPs. For hundreds of items, add a `git.drupalcode.org` personal access token with `read_api` scope as the `DRUPALCODE_TOKEN` repository secret.

The board columns:

| Column | Rule |
|--------|------|
| Open | Work item is open and has no merge request |
| Has MR | Work item is open and has at least one related merge request |
| Closed | Work item is closed |

Drupal.org status IDs map to the same names and colors as the GitLab `state::` labels. Statuses 3, 5, 6, 7, 17, and 18 count as closed. Fixed counts as open on both, matching GitLab where `state::fixed` items stay open until the bot closes them.

The project filter and search box write to the URL, so `?project=gin&q=needs+review` is a shareable link.

## Set up hosting

1. Push this repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Optional: add the `DRUPALCODE_TOKEN` secret.
4. Run **Publish board** from the **Actions** tab, or push to `main`.

GitHub disables scheduled workflows in public repositories after 60 days without repository activity. New items keep the schedule alive; otherwise re-enable it from the **Actions** tab.

## Local development

Requires Node 22 or later.

```
npm install
npm run refresh
npm run dev
```

Then open `http://localhost:8765`. `npm run check` runs the same validation as the pull request workflow.
