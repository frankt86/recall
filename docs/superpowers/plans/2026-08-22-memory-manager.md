# Memory Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `recall ui` into a full memory-management application: CRUD + pin/delete, keyboard/bulk triage, exact session preview, jobs/health, markdown import/export.

**Architecture:** Thin Bun JSON API in `src/ui/server.ts` (split into route modules) over the existing SQLite schema, serving a vanilla-JS ES-module SPA from `src/ui/static/`. Retrieval gains pinning and a `why` breakdown; the SessionStart hook's context assembly moves into `src/context.ts` so the preview is byte-identical to what Claude receives.

**Tech Stack:** Bun 1.4 (runtime, `bun:sqlite`, `Bun.serve`, `bun test`), TypeScript, vanilla JS/CSS (no bundler, no deps).

**Spec:** `docs/superpowers/specs/2026-08-22-memory-manager-design.md`

## Global Constraints

- No new runtime dependencies; no build step. Static files are read from disk at request time (dev-friendly) via `Bun.file`.
- Server binds `127.0.0.1` only. All JSON errors are `{ error }`.
- Theme tokens defined on `:root` with a `prefers-color-scheme: dark` override; dark is the primary target.
- Never `window.confirm`/`alert` in the UI.
- Every mutation route wrapped in `db.transaction`.
- Deviation from spec (approved by plan author): Jobs view actions are **consolidate / re-embed / run queue**; `relink` stays CLI-only because it needs CLI arguments.
- Tests: `bun test` from repo root; use `RECALL_DIR` temp dir and `RECALL_EMBEDDINGS=0` like `tests/ui.test.ts`.

---

## File map

| file | responsibility |
|---|---|
| `src/db.ts` | + `migrate(db)` adding `observations.pinned`, `observations.source`; + `JobKind "embed"`; `ObservationRow` gains `pinned`, `source` |
| `src/retrieve.ts` | pinned-first retrieval, `why` ranks on `ScoredItem` |
| `src/context.ts` | NEW `buildSessionContext` |
| `src/project.ts` | + `recentFilesQuery(root, branch)` (moved from hook) |
| `src/hooks/session-start.ts` | uses the two above |
| `src/processor.ts` | + `runEmbed` for job kind `embed` |
| `src/ui/server.ts` | router + static serving; delegates to route modules |
| `src/ui/routes/observations.ts` | list/create/patch/delete/bulk/merge/feedback |
| `src/ui/routes/other.ts` | summaries, digests, projects, preview, jobs, actions, health, seen |
| `src/ui/transfer.ts` | export/import md+json (pure functions, tested directly) |
| `src/ui/static/index.html`, `app.css`, `app.js`, `keys.js`, `views/{list,detail,preview,jobs,health,sessions}.js` | SPA |
| `src/ui/page.ts` | DELETED |
| `tests/ui.test.ts` | rewritten for new API; `tests/context.test.ts`, `tests/transfer.test.ts`, `tests/retrieve-pin.test.ts` new |

---

### Task 1: Schema migration (pinned, source, embed job kind)

**Files:** Modify `src/db.ts`. Test `tests/db.test.ts` (append).

**Produces:** `ObservationRow.pinned: number`, `ObservationRow.source: string`, `JobKind` includes `"embed"`, `openDb()` runs `migrate`.

- [ ] Test:
```ts
test("migration adds pinned/source and is idempotent", () => {
  const db = openDb(join(dir, "mig.db"));
  const cols = () => db.query<{ name: string }, []>("PRAGMA table_info(observations)").all().map((c) => c.name);
  expect(cols()).toContain("pinned"); expect(cols()).toContain("source");
  closeDb(); const db2 = openDb(join(dir, "mig.db")); // second open must not throw
  expect(db2.query("SELECT pinned, source FROM observations LIMIT 0").all()).toEqual([]);
  closeDb();
});
```
- [ ] Implement in `db.ts`:
```ts
export type JobKind = "observe" | "summarize" | "consolidate" | "embed";
// ObservationRow: pinned: number; source: string;
function migrate(db: Database): void {
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(observations)").all().map((c) => c.name));
  if (!cols.has("pinned")) db.exec("ALTER TABLE observations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("source")) db.exec("ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_obs_pinned ON observations(project_id, pinned) WHERE pinned = 1");
  setMeta(db, "schema_version", "2");
}
```
Call `migrate(db)` in `openDb` after `db.exec(SCHEMA)`. Add `pinned INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'auto'` to the CREATE TABLE too (fresh DBs).
- [ ] `bun test tests/db.test.ts` → PASS. Commit `feat(db): pinned/source columns, embed job kind`.

### Task 2: Pinned-first retrieval with `why`

**Files:** Modify `src/retrieve.ts`. Test `tests/retrieve-pin.test.ts`.

**Produces:** `ScoredItem.pinned: boolean`, `ScoredItem.why: Why`, `retrieve()` returns pinned first; `export interface Why { fts?: number; vec?: number; recent?: number; recency: number; confidence: number }`.

- [ ] Test: seed 5 obs, pin the oldest; `retrieve({projectId, query:"", tokenBudget: 400})` → `items[0].id === pinnedId`, `items[0].pinned === true`, `why.recent` defined. Pin one with 5000-char narrative and budget 300 → not returned.
- [ ] Implement: keep per-key rank record `{fts, vec, recent}` when pushing; after fused scoring set `item.why = {...ranks, recency, confidence}`; set `item.pinned = !!o.pinned`. Then:
```ts
const pinnedRows = db.query<ObservationRow,[string]>("SELECT * FROM observations WHERE project_id = ? AND pinned = 1 AND archived = 0 ORDER BY created_at DESC").all(opts.projectId);
const pinnedItems = pinnedRows.map(obsToItem).map(i => ({...i, pinned: true, score: Number.POSITIVE_INFINITY, why: {recency:1, confidence:i.confidence}}));
const rest = items.filter(i => !(i.kind === "observation" && pinnedRows.some(p => p.id === i.id)));
const ordered = [...pinnedItems, ...rest];
```
Budget loop: pinned items are not counted toward `limit`; over-budget pinned items are skipped. Export `retrieveWithSkipped` variant returning `{ items, skippedPinned: number[] }` (used by preview); `retrieve` = `.items`.
- [ ] Run test → PASS. Commit `feat(retrieve): pinned-first ranking and why breakdown`.

### Task 3: Shared session-context builder

**Files:** Create `src/context.ts`; modify `src/project.ts`, `src/hooks/session-start.ts`. Test `tests/context.test.ts`.

**Produces:**
```ts
export interface ContextResult { text: string; items: ScoredItem[]; skippedPinned: number[]; digest: string|null; tokens: number; pending: number }
export async function buildSessionContext(db, o: { projectId: string; projectName: string; branch: string|null; query: string; settings: Settings }): Promise<ContextResult>
export function recentFilesQuery(root: string, branch: string|null): string   // in project.ts
```
- [ ] Test: seed obs + digest; `buildSessionContext` text starts with `<recall project="demo"`, contains `## Project digest`, `## Relevant recent memory`, `#<id>`; `tokens === estimateTokens(text)`; calling it twice leaves `beta` unchanged (no markShown).
- [ ] Move `recentFiles` + query join from the hook into `project.ts` as `recentFilesQuery`. Move the `lines` assembly into `context.ts` verbatim (text must be identical). Hook becomes: `const ctx = await buildSessionContext(...)`; `markShown(...)`; write `context_log` using `ctx.items`; print `ctx.text`.
- [ ] Run `bun test` (all) → PASS. Commit `refactor: extract session context builder`.

### Task 4: Embed job for manual observations + re-embed

**Files:** Modify `src/processor.ts`. Test in `tests/pipeline.test.ts` (append).

**Produces:** job kind `embed` with `ref_id` = observation id: embeds `title\nnarrative\nfacts`, stores blob; no-op when embeddings unavailable. `export async function enqueueMissingEmbeddings(db, projectId?): number` enqueues `embed` for every non-archived obs with `embedding IS NULL`, returns count.

- [ ] Test: insert obs with null embedding, `enqueueMissingEmbeddings(db)` → 1 job of kind embed; `drain` with `RECALL_EMBEDDINGS=0` marks it done without error.
- [ ] Implement `runEmbed` and dispatch in `runJob`. Commit `feat(processor): embed job`.

### Task 5: Transfer (export/import) pure functions

**Files:** Create `src/ui/transfer.ts`. Test `tests/transfer.test.ts`.

**Produces:**
```ts
export interface ObsIn { type: string; title: string; narrative: string; facts: string[]; files: string[]; pinned?: boolean }
export function toMarkdown(items: ObsOutLike[]): string   // "## [type] title\n\nnarrative\n\n- fact\n\nfiles: a, b\n\n"
export function fromMarkdown(md: string): ObsIn[]
export function toJson(items): string; export function fromJson(s: string): ObsIn[]
```
Markdown format: each item is `## [type] title` (type optional → `other`), then paragraphs = narrative, `- ` lines = facts, a line `files: a, b` = files, `pinned: yes` = pinned.
- [ ] Test: round-trip `fromMarkdown(toMarkdown(items))` equals items (type/title/narrative/facts/files); malformed input → `[]`; json round-trip.
- [ ] Implement; commit `feat(ui): markdown/json transfer`.

### Task 6: API — observations routes

**Files:** Create `src/ui/routes/observations.ts`; modify `src/ui/server.ts` to a small router. Test `tests/ui.test.ts` (rewrite).

**Produces:** router helper in `server.ts`:
```ts
export type Handler = (ctx: { db: Database; req: Request; url: URL; params: Record<string,string>; body: Record<string,unknown>|null }) => Promise<Response>|Response;
export function route(method: string, pattern: string, h: Handler): void   // pattern like "/api/observations/:id"
export const json, bad, readJson, parseList, obsOut   // obsOut adds pinned:boolean, source:string
```
Routes: `GET /api/observations` (+`pinned=1`, `since`, `sort`), `POST /api/observations`, `PATCH /api/observations/:id`, `DELETE /api/observations/:id`, `POST /api/observations/bulk`, `POST /api/observations/merge`, `POST /api/feedback`, aliases `POST /api/edit`, `POST /api/archive`.
- [ ] Tests (each its own `test`): create returns 201 with `source:"manual"` and enqueues `embed` job; patch pinned→`pinned:true`; patch `project_id` to unknown project → 400; delete → 200 then GET list excludes it and FTS search for its title returns nothing; bulk archive 3 ids → all archived; merge 2 → new obs `source:"merged"`, facts union, sources archived, new obs type = most common; bad id → 404; bad body → 400.
- [ ] Implement. Validation: `type` must be one of `decision|bugfix|feature|change|discovery|refactor|config|other|manual`; `project_id` must exist. Commit `feat(api): observation CRUD, bulk, merge`.

### Task 7: API — summaries, digests, projects, seen, preview, jobs, actions, health, transfer

**Files:** Create `src/ui/routes/other.ts`. Tests append to `tests/ui.test.ts`.

Routes and behaviours:
- `PATCH|DELETE /api/summaries/:id`, `PATCH|DELETE /api/digests/:id`.
- `GET /api/projects` → adds `pinned` and `inbox` (count where `created_at > ui_last_seen_at`) per project. `POST /api/seen` sets meta.
- `GET /api/preview?project=` → `{ text, tokens, budget: settings.contextTokenBudget, items:[{kind,id,title,type,score,why,pinned,created_at}], skippedPinned:[{id,title}], digest }`. Query derived with `recentFilesQuery(projects.root_path, null)`.
- `GET /api/jobs?status=` (last 200, newest first); `POST /api/jobs/:id/retry` (`status='pending', attempts=0, error=NULL, claimed_at=NULL`); `POST /api/jobs/:id/cancel` (`status='failed', error='cancelled'`).
- `POST /api/actions/consolidate` → `enqueue(db,"consolidate",Math.floor(now()/1000))`; `/reembed` → `enqueueMissingEmbeddings`; `/process` → `drain(db,{quiet:true})` returns `{ ok, message: "processed N job(s)" }`.
- `GET /api/health` → `{ dbPath, dbBytes, counts:{observations,summaries,digests,jobs,sessions}, embedded, embeddable, embeddingsEnabled, settings }` (settings minus nothing — it's local).
- `GET /api/export?project=&format=md|json` → body with `content-disposition: attachment; filename="recall-<name>.<ext>"`.
- `POST /api/import` `{project_id, format, content, dryRun}` → `{ count }`; when not dry run inserts with `source:'import'`, `session_id` = a synthetic session row (`claude_session_id='import:<ts>'`), enqueues `embed` per item.
- [ ] Tests: preview text equals `buildSessionContext` text and does not write `context_log` or change `beta`; jobs retry/cancel; import dryRun inserts nothing, real import inserts N and export md contains titles; health counts match.
- [ ] Commit `feat(api): preview, jobs, actions, health, transfer`.

### Task 8: Static serving + SPA shell + list/detail views

**Files:** Create `src/ui/static/index.html`, `app.css`, `app.js`, `views/list.js`, `views/detail.js`; delete `src/ui/page.ts`; server `GET /` → `index.html`, `GET /static/*` → file with content-type by extension (`.js` → `text/javascript`, `.css` → `text/css`), 404 on traversal (`..`).

**App state (app.js):**
```js
export const S = { view:"all", project:"", q:"", type:"", sort:"created", page:1, items:[], total:0, cursor:0, selected:new Set(), open:null, projects:[], queue:{}, types:[], editing:false };
export const api = async (path, opts={}) => { ... throws Error(j.error) ... }
export function toast(msg, kind="ok")  // 3.5 s
export async function load()           // fetch list for current view; views: inbox|all|pinned|archived use /api/observations
export function render()               // sidebar + list + pane
export function go(view, extra)        // updates location.hash "#/<view>?project=&q=..."
```
Views module contract: each `views/*.js` exports `render(root, S)` and optionally `keys` (extra bindings).
- [ ] Smoke test: `/`, `/static/app.js`, `/static/app.css`, `/static/views/list.js` return 200 with right content-type; `/static/../package.json` → 404.
- [ ] Build shell per spec layout; list rows with checkbox/badge/pin/title/date/confidence/source; detail pane with in-place edit (title input, narrative textarea, facts textarea one-per-line, files textarea, type select, project select, pinned + archived toggles, 👍/👎, Delete→"Really delete?" 4 s). New-memory = detail pane in create mode.
- [ ] Commit `feat(ui): app shell, list, detail`.

### Task 9: Keyboard, selection, bulk bar, inbox, merge

**Files:** Create `src/ui/static/keys.js`; modify `app.js`, `views/list.js`.

Bindings (ignored when `e.target` is input/textarea/select or a modifier other than Shift is held): `j k Enter o x X e a d p m f F n / ? Esc` and `g` prefix (`i a p v j h s d` → inbox/all/pinned/preview/jobs/health/sessions/digests; 800 ms window). Help overlay `?` lists them. Bulk bar (visible when `S.selected.size>0`): Archive, Unarchive, Pin, Unpin, Move to ▾, Merge (≥2), Delete (inline confirm), Clear. Inbox view: `since = meta ui_last_seen_at` (served by `/api/projects` as `seenAt`), "Mark all seen" button.
- [ ] Commit `feat(ui): keyboard triage, bulk ops, inbox, merge`.

### Task 10: Preview, Jobs, Health, Sessions/Digests views

**Files:** Create `views/preview.js`, `views/jobs.js`, `views/health.js`, `views/sessions.js`.

- Preview: project select (defaults to S.project or first), `<pre>` with text, token meter (`tokens/budget`, amber ≥90 %), items table (kind, title, score, why chips `fts#3 vec#1 recent#2`, pinned toggle, exclude = archive) → actions refetch preview; `skippedPinned` list in amber.
- Jobs: filter select, table, Retry/Cancel buttons, action buttons Consolidate / Re-embed / Run queue (disabled while running, toast result), auto-refresh every 5 s while view open.
- Health: stats grid, settings `<dl>`, export (project select, format select, Download button → `/api/export` link), import (textarea or file input, Dry run → "would import N", Import).
- Sessions/Digests: list cards with Edit (inline fields) / Delete (inline confirm).
- [ ] Commit `feat(ui): preview, jobs, health, sessions views`.

### Task 11: Docs, README, version

**Files:** `README.md` (UI section: features + keyboard table), `package.json` version → `0.2.0`, `src/commands/ui.ts` summary "memory manager (local web app)".
- [ ] `bun test` all green; `bun run src/cli.ts ui --open` manual smoke in browser (dark mode). Commit `docs: memory manager`.

## Self-review

- Spec coverage: data model (T1), retrieval (T2), context builder (T3), embed for manual/import (T4 — implied by "enqueues embed job"), API table (T6, T7), UI sections (T8–T10), testing list (T1–T8), docs (T11). Relink dropped and recorded in Global Constraints.
- Types: `ScoredItem.why`/`pinned` (T2) used by preview (T7, T10); `recentFilesQuery` (T3) used by preview (T7); `enqueueMissingEmbeddings` (T4) used by `/api/actions/reembed` (T7); `obsOut` (T6) used by T7 import response; `toMarkdown/fromMarkdown` (T5) used by T7.
