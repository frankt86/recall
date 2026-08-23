import { beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-recon-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";
process.env.RECALL_LLM = "fake";

let db: import("bun:sqlite").Database;
const vec = (...xs: number[]) => { const f = new Float32Array(xs); const n = Math.hypot(...xs); for (let i = 0; i < f.length; i++) f[i] /= n; return new Uint8Array(f.buffer); };
const ins = (title: string, o: Partial<{ narrative: string; files: string[]; created_at: number; pinned: number; source: string; embedding: Uint8Array | null }> = {}) =>
  Number(db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at, pinned, source, embedding) VALUES ('p1',1,'change',?,?,'[]',?,?,?,?,?)")
    .run(title, o.narrative ?? "n", JSON.stringify(o.files ?? []), o.created_at ?? Date.now(), o.pinned ?? 0, o.source ?? "auto", o.embedding ?? null).lastInsertRowid);
const row = (id: number) => db.query<{ archived: number; superseded_by: number | null; alpha: number }, [number]>("SELECT archived, superseded_by, alpha FROM observations WHERE id = ?").get(id)!;

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  const { resetSettings } = await import("../src/settings");
  resetSettings();
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
});

test("new observation supersedes the stale fact it replaces (found via vector)", async () => {
  const { reconcile } = await import("../src/processor");
  const stale = ins(".mcp.json points to src/mcp.ts [stale]", { embedding: vec(1, 0.1, 0), created_at: Date.now() - 5000 });
  const unrelated = ins("Totally different topic", { embedding: vec(0, 0, 1), created_at: Date.now() - 5000 });
  const fresh = ins(".mcp.json now points to src/mcp-launch.ts", { embedding: vec(1, 0.12, 0) });
  const r = await reconcile(db, fresh);
  expect(r.superseded).toEqual([stale]);
  expect(row(stale)).toMatchObject({ archived: 1, superseded_by: fresh });
  expect(row(unrelated).archived).toBe(0);
  expect(row(fresh).archived).toBe(0);
});

test("candidates are also found through shared graph entities; pinned facts are never superseded", async () => {
  const { reconcile } = await import("../src/processor");
  const { linkObservation } = await import("../src/graph");
  const get = (id: number) => db.query<import("../src/db").ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
  const oldA = ins("Router lives in server.ts [stale]", { files: ["src/ui/server.ts", "src/ui/http.ts"], created_at: Date.now() - 5000 });
  const pinnedOld = ins("Pinned truth [stale]", { files: ["src/ui/server.ts", "src/ui/http.ts"], created_at: Date.now() - 5000, pinned: 1 });
  const fresh = ins("Router moved to http.ts", { files: ["src/ui/server.ts", "src/ui/http.ts"] });
  for (const id of [oldA, pinnedOld, fresh]) linkObservation(db, get(id));
  const r = await reconcile(db, fresh);
  expect(r.superseded).toEqual([oldA]);
  expect(row(pinnedOld).archived).toBe(0);
});

test("a redundant new observation is folded into the existing one, which gains confidence", async () => {
  const { reconcile } = await import("../src/processor");
  const established = ins("We use uv [dup]", { embedding: vec(0, 1, 0.1), created_at: Date.now() - 5000 });
  const before = row(established).alpha;
  const newcomer = ins("Project uses uv for python", { embedding: vec(0, 1, 0.12) });
  const r = await reconcile(db, newcomer);
  expect(r.duplicateOf).toBe(established);
  expect(row(newcomer)).toMatchObject({ archived: 1, superseded_by: established });
  expect(row(established).alpha).toBeGreaterThan(before);
  // a hand-written duplicate is kept (the user meant it) and nothing is archived
  const manual = ins("We use uv, hand-written", { embedding: vec(0, 1, 0.11), source: "manual" });
  const r2 = await reconcile(db, manual);
  expect(r2.duplicateOf).toBeNull();
  expect(row(manual).archived).toBe(0);
});

test("relevance gate: recency-only filler is capped when there is a query", async () => {
  const { retrieve } = await import("../src/retrieve");
  for (let i = 0; i < 10; i++) ins(`Filler ${i}`, { narrative: "nothing to do with the topic" });
  ins("Kangaroo handling", { narrative: "kangaroo kangaroo" });
  const withQuery = await retrieve(db, { projectId: "p1", query: "kangaroo", limit: 12 });
  const recentOnly = withQuery.filter((i) => i.kind === "observation" && !i.pinned && !i.why.fts && !i.why.vec && !i.why.graph);
  expect(withQuery.filter((i) => !i.pinned)[0].title).toBe("Kangaroo handling");
  expect(recentOnly.length).toBeLessThanOrEqual(3);
  const noQuery = await retrieve(db, { projectId: "p1", query: "", limit: 12 });
  expect(noQuery.length).toBeGreaterThan(withQuery.length); // empty query still gives the latest work
});
