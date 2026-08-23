# Memory Manager — design

**Date:** 2026-08-22 · **Status:** approved in chat (Terry); build all phases in one delivery.

## Goal

Turn `recall ui` from a read-mostly viewer into an application for managing memory by hand: create, edit, delete, pin, exclude, triage, merge, preview what the next session will see, drive background jobs, and move memory in/out as markdown.

## Constraints

- Zero build step and no new runtime dependencies. The plugin installs as a bare git checkout run by a pinned Bun; the UI must keep working from that state.
- Vanilla JS served by the existing Bun server (`src/ui/server.ts`). Static assets live in `src/ui/static/` and are read at startup.
- Theme-aware: `prefers-color-scheme` with dark as the primary target.
- Local only (`127.0.0.1`), no auth; destructive actions confirm in-UI, never with `window.confirm`.
- One retrieval code path: the UI's preview must call the same function the SessionStart hook calls.

## Architecture

```
src/ui/server.ts      JSON API (thin; validation + SQL). GET / -> static/index.html
src/ui/static/
  index.html          shell: sidebar | list | detail pane | command bar | toasts
  app.css             tokens, layout, components
  app.js              state store, hash router, api(), render, toasts
  views/*.js          list, detail, preview, jobs, health (ES modules)
  keys.js             keyboard map
src/context.ts        NEW: buildSessionContext(...) extracted from hooks/session-start.ts;
                      the hook and /api/preview both call it
src/retrieve.ts       pinned items always rank first; `why` rank breakdown on ScoredItem
src/db.ts             migration: observations.pinned, observations.source, meta.ui_last_seen_at
```

### Data model changes

| table | change | purpose |
|---|---|---|
| observations | `pinned INTEGER NOT NULL DEFAULT 0` | hand-set priority; pinned never drops out of retrieval while within budget |
| observations | `source TEXT NOT NULL DEFAULT 'auto'` (`auto` / `manual` / `merged` / `import`) | provenance shown in UI |
| meta | key `ui_last_seen_at` | inbox boundary |

Migration runs in `openDb()` via `PRAGMA table_info`, idempotent; `meta.schema_version` bumped.

### Retrieval changes (`retrieve.ts`)

- After scoring, pinned, non-archived observations for the project are prepended (newest first); the rest fill the remaining token budget. Pinned items are exempt from `limit` but not from the token budget; a pinned item that cannot fit is skipped and reported by the preview as over budget.
- `ScoredItem` gains `pinned: boolean` and `why: { fts?: number; vec?: number; recent?: number; recency: number; confidence: number }` (rank each list gave it). The ranks map already exists, so this is cheap.

### Shared context builder (`context.ts`)

`buildSessionContext(db, { projectId, projectName, branch, query, settings })` returns `{ text, items, digest, tokens, pending }`. `session-start.ts` becomes: derive query → call builder → `markShown` → write `context_log` → print. `recentFiles` moves to `project.ts` as `recentFilesQuery(root)` so the preview derives the query identically. `/api/preview` calls the builder and does **not** call `markShown` or write `context_log`.

## API

All JSON. Errors `{ error }` with 4xx/5xx. Ids are integers. Bodies validated as today.

| method & path | body / query | notes |
|---|---|---|
| GET `/api/projects` | | adds `pinned`, `inbox` counts |
| GET `/api/observations` | existing filters + `pinned=1`, `since=<ms>`, `sort=created\|confidence` | |
| POST `/api/observations` | `{project_id,type,title,narrative,facts[],files[]}` | manual create; `source='manual'`; enqueues embed job |
| PATCH `/api/observations/:id` | any of `title,narrative,facts,files,type,project_id,pinned,archived` | supersedes `/api/edit` and `/api/archive` (kept as aliases) |
| DELETE `/api/observations/:id` | | hard delete; FTS trigger maintains index |
| POST `/api/observations/bulk` | `{ids[], op: archive\|unarchive\|delete\|pin\|unpin\|move, project_id?}` | one transaction |
| POST `/api/observations/merge` | `{ids[], title?, narrative?}` | new obs `source='merged'`; facts/files union; type = most common; sources archived |
| POST `/api/feedback` | unchanged | |
| PATCH/DELETE `/api/summaries/:id` | `request,completed,learned,next_steps` | |
| PATCH/DELETE `/api/digests/:id` | `content` | |
| GET `/api/preview?project=` | | `{ text, tokens, budget, items:[{kind,id,title,score,why,pinned,overBudget}], digest }` |
| GET `/api/jobs?status=` | | last 200 |
| POST `/api/jobs/:id/retry` · `/cancel` | | retry resets attempts and status; cancel → `failed`, error "cancelled" |
| POST `/api/actions/consolidate` · `/relink` · `/reembed` | `{project?}` | runs existing command logic in-process; `{ ok, message }` |
| GET `/api/health` | | db path, size, per-table counts, embedding coverage, model status, settings |
| GET `/api/export?project=&format=md\|json` | | download |
| POST `/api/import` | `{project_id, format, content, dryRun?}` | md: `## title` sections, paragraph narrative, `- fact` bullets; json: array; `source='import'` |
| POST `/api/seen` | | sets `ui_last_seen_at = now` |

## UI

**Layout:** sidebar (projects with counts; views: Inbox, All, Pinned, Archived, Sessions, Digests, Preview, Jobs, Health) · center list · right detail pane (toggleable) · toasts · top command bar with search (`/`), type filter, sort, "New memory".

**List rows:** type badge, pin icon, title, date, confidence bar, source chip; checkbox visible on hover or when any selection exists; keyboard cursor outlined.

**Detail pane:** narrative, facts (one per line when editing), files, project dropdown (move), type, pinned toggle, archived toggle, 👍/👎, "Why recalled" (when opened from Preview), Delete with inline confirm (button becomes "Really delete?" for 4 s). In-place edit: `e` or Edit button; `Ctrl+Enter` saves, `Esc` cancels.

**Inbox:** observations with `created_at > ui_last_seen_at`; "Mark all seen" calls `/api/seen`.

**Keyboard** (focus not in an input): `j/k` move · `Enter`/`o` open · `x` select · `Shift+X` select all visible · `e` edit · `a` archive toggle · `d` delete (confirm) · `p` pin toggle · `m` merge selected (≥2) · `f`/`F` feedback useful/not · `n` new · `/` search · `g` then `i/a/p/v/j/h` jump views · `?` help · `Esc` close/clear. A bulk bar appears when selection ≥1.

**Preview:** project picker, injected text verbatim (monospace), token meter vs budget, contributing items with score and why; pin/exclude/edit inline then refetch. Over-budget pinned items shown in amber.

**Jobs:** table (id, kind, ref, status, attempts, error, age), status filter, retry/cancel per row, Run consolidate/relink/re-embed buttons with result toast.

**Health:** DB path and size, table counts, embedding coverage, model status, settings (read-only), export/import panel with dry-run count before import.

**Sessions / Digests:** list with inline edit and delete.

## Error handling

- Server: mutations in transactions; unknown id → 404; bad body → 400 naming the field; unknown route → 404; exceptions → 500 with message.
- Client: single `api()` helper; failures → red toast; optimistic updates only for pin/archive/select; everything else re-renders from the response.

## Testing

`bun test` against a temp DB (pattern from `tests/ui.test.ts`):
- migration idempotent on an already-migrated DB and on a DB without the new columns
- create / patch / delete / bulk / merge (merge unions facts, archives sources)
- pinned item ranks first in `retrieve`; skipped when over budget
- `buildSessionContext` output equals what `session-start` prints for the same inputs
- preview does not mutate `beta` or write `context_log`
- import md round-trips export md
- jobs retry resets attempts; cancel marks failed
- unknown routes 404, bad bodies 400
- smoke: `/` and every static asset return 200 with the right content-type

## Out of scope

Auth, remote access, live updates (refetch after mutations), undo history, native packaging.

## Addendum (2026-08-23): context rot and knowledge graph

- `maintain` job (`src/maintain.ts`): retire / dedupe / cap / prune / housekeeping, scheduled every `maintainEveryHours`, protected set = pinned or source in (manual, import). Stats stored in `meta.last_maintenance`, shown in Health, `POST /api/actions/maintain`.
- Knowledge graph (`src/graph.ts`): tables `entities`, `observation_entities`, `edges`; `linkObservation` on observe/embed; deterministic + LLM extraction; `graph()` view computed over active observations only; `graphHits` feeds a fourth RRF list in `retrieve`. UI view `graph` (force layout), `GET /api/graph`, `GET /api/graph/entity/:id`, `POST /api/actions/regraph`.
