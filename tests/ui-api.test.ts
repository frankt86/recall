import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-uiapi-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";

let server: { port: number; stop: () => void };
let base: string;
let db: import("bun:sqlite").Database;

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p2','other','/o',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
  const ins = db.query("INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at) VALUES (?,?,NULL,?,?,?,?,?,?)");
  for (let i = 0; i < 20; i++) ins.run("p1", 1, i % 2 ? "bugfix" : "decision", `Observation ${i}`, "narrative", '["a"]', '["src/x.ts"]', now() - i * 1000);
  db.query("INSERT INTO summaries(project_id, session_id, request, completed, learned, next_steps, created_at) VALUES ('p1',1,'req','done','learned','next',?)").run(now());
  db.query("INSERT INTO digests(project_id, period_start, period_end, content, source_count, created_at) VALUES ('p1',1,2,'digest body',5,?)").run(now());
  const { startUi } = await import("../src/ui/server");
  server = startUi(db, 0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop());

const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
const post = (p: string, body: unknown, method = "POST") =>
  fetch(base + p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const count = (sql: string, ...args: (string | number)[]) => db.query<{ n: number }, (string | number)[]>(sql).get(...args)!.n;

test("create manual observation enqueues embed job; validation", async () => {
  const r = await post("/api/observations", { project_id: "p1", type: "manual", title: "Hand-written", narrative: "Remember this.", facts: ["a", " ", "b"], files: ["x.ts"] });
  expect(r.status).toBe(201);
  const o = await r.json();
  expect(o.source).toBe("manual");
  expect(o.pinned).toBe(false);
  expect(o.facts).toEqual(["a", "b"]);
  expect(count("SELECT COUNT(*) n FROM jobs WHERE kind='embed' AND ref_id=?", o.id)).toBe(1);
  expect((await post("/api/observations", { project_id: "zz", type: "manual", title: "t", narrative: "n" })).status).toBe(400);
  expect((await post("/api/observations", { project_id: "p1", type: "bogus", title: "t", narrative: "n" })).status).toBe(400);
  expect((await post("/api/observations", { project_id: "p1", type: "manual", title: "", narrative: "n" })).status).toBe(400);
});

test("patch pinned/type/project; delete removes row and fts entry", async () => {
  const id = (await get("/api/observations?project=p1&type=decision")).items[0].id;
  const r = await post(`/api/observations/${id}`, { pinned: true, type: "config" }, "PATCH");
  expect(r.status).toBe(200);
  const o = await r.json();
  expect(o.pinned).toBe(true);
  expect(o.type).toBe("config");
  expect((await post(`/api/observations/${id}`, { project_id: "nope" }, "PATCH")).status).toBe(400);
  expect((await post(`/api/observations/${id}`, { project_id: "p2" }, "PATCH")).status).toBe(200);
  expect((await get("/api/observations?project=p1&pinned=1")).total).toBe(0);
  expect((await get("/api/observations?project=p2&pinned=1")).total).toBe(1);
  const del = await fetch(base + `/api/observations/${id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(count("SELECT COUNT(*) n FROM observations WHERE id=?", id)).toBe(0);
  expect(count("SELECT COUNT(*) n FROM observations_fts WHERE rowid=?", id)).toBe(0);
  expect((await fetch(base + `/api/observations/${id}`, { method: "DELETE" })).status).toBe(404);
  expect((await post("/api/observations/abc", { pinned: true }, "PATCH")).status).toBe(400);
});

test("bulk ops run in one transaction", async () => {
  const ids: number[] = (await get("/api/observations?project=p1&type=bugfix")).items.slice(0, 3).map((i: any) => i.id);
  expect((await post("/api/observations/bulk", { ids, op: "archive" })).status).toBe(200);
  expect(count("SELECT COUNT(*) n FROM observations WHERE archived=1 AND id IN (?,?,?)", ...ids)).toBe(3);
  await post("/api/observations/bulk", { ids, op: "unarchive" });
  await post("/api/observations/bulk", { ids, op: "pin" });
  expect(count("SELECT COUNT(*) n FROM observations WHERE pinned=1 AND id IN (?,?,?)", ...ids)).toBe(3);
  await post("/api/observations/bulk", { ids, op: "unpin" });
  expect((await post("/api/observations/bulk", { ids, op: "move", project_id: "p2" })).status).toBe(200);
  expect(count("SELECT COUNT(*) n FROM observations WHERE project_id='p2' AND id IN (?,?,?)", ...ids)).toBe(3);
  expect((await post("/api/observations/bulk", { ids: [ids[0], 999999], op: "delete" })).status).toBe(404);
  expect(count("SELECT COUNT(*) n FROM observations WHERE id=?", ids[0])).toBe(1); // rolled back
  expect((await post("/api/observations/bulk", { ids, op: "explode" })).status).toBe(400);
  expect((await post("/api/observations/bulk", { ids, op: "delete" })).status).toBe(200);
  expect(count("SELECT COUNT(*) n FROM observations WHERE id IN (?,?,?)", ...ids)).toBe(0);
});

test("merge unions facts/files, picks majority type, archives sources", async () => {
  const { now } = await import("../src/db");
  const ins = db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at) VALUES ('p1',1,?,?,?,?,?,?)");
  const a = Number(ins.run("bugfix", "A", "na", '["f1","f2"]', '["a.ts"]', now()).lastInsertRowid);
  const b = Number(ins.run("bugfix", "B", "nb", '["f2","f3"]', '["b.ts"]', now()).lastInsertRowid);
  const c = Number(ins.run("decision", "C", "nc", "[]", '["a.ts"]', now()).lastInsertRowid);
  const r = await post("/api/observations/merge", { ids: [a, b, c], title: "ABC" });
  expect(r.status).toBe(201);
  const m = await r.json();
  expect(m.source).toBe("merged");
  expect(m.type).toBe("bugfix");
  expect(m.title).toBe("ABC");
  expect(m.facts).toEqual(["f1", "f2", "f3"]);
  expect(m.files).toEqual(["a.ts", "b.ts"]);
  expect(m.narrative).toContain("na");
  expect(m.narrative).toContain("nc");
  expect(count("SELECT COUNT(*) n FROM observations WHERE archived=1 AND id IN (?,?,?)", a, b, c)).toBe(3);
  expect((await post("/api/observations/merge", { ids: [a] })).status).toBe(400);
});

test("summaries and digests can be edited and deleted", async () => {
  const sid = (await get("/api/summaries?project=p1")).items[0].id;
  const r = await post(`/api/summaries/${sid}`, { learned: "more" }, "PATCH");
  expect(r.status).toBe(200);
  expect((await r.json()).learned).toBe("more");
  const did = (await get("/api/digests?project=p1")).items[0].id;
  expect((await post(`/api/digests/${did}`, { content: "edited" }, "PATCH")).status).toBe(200);
  expect((await get("/api/digests?project=p1")).items[0].content).toBe("edited");
  expect((await fetch(base + `/api/digests/${did}`, { method: "DELETE" })).status).toBe(200);
  expect((await get("/api/digests?project=p1")).items).toEqual([]);
  expect((await fetch(base + `/api/summaries/${sid}`, { method: "DELETE" })).status).toBe(200);
  expect((await fetch(base + `/api/summaries/${sid}`, { method: "DELETE" })).status).toBe(404);
});

test("inbox counts and seen marker", async () => {
  let j = await get("/api/projects");
  expect(j.projects.find((p: any) => p.id === "p1").inbox).toBeGreaterThan(0);
  expect(j.seenAt).toBe(0);
  expect((await post("/api/seen", {})).status).toBe(200);
  j = await get("/api/projects");
  expect(j.seenAt).toBeGreaterThan(0);
  expect(j.projects.find((p: any) => p.id === "p1").inbox).toBe(0);
  expect((await get(`/api/observations?project=p1&since=${j.seenAt}`)).total).toBe(0);
});

test("preview matches the context builder and has no side effects", async () => {
  const { buildSessionContext } = await import("../src/context");
  const { loadSettings } = await import("../src/settings");
  const { recentFilesQuery } = await import("../src/project");
  const before = db.query<{ s: number }, []>("SELECT SUM(beta) s FROM observations").get()!.s;
  const logs = count("SELECT COUNT(*) n FROM context_log");
  const j = await get("/api/preview?project=p1");
  const expected = await buildSessionContext(db, { projectId: "p1", projectName: "demo", branch: null, query: recentFilesQuery("/d", null), settings: loadSettings() });
  expect(j.text).toBe(expected.text);
  expect(j.tokens).toBe(expected.tokens);
  expect(j.budget).toBe(loadSettings().contextTokenBudget);
  expect(j.items[0].why).toBeDefined();
  expect(Array.isArray(j.skippedPinned)).toBe(true);
  expect(db.query<{ s: number }, []>("SELECT SUM(beta) s FROM observations").get()!.s).toBe(before);
  expect(count("SELECT COUNT(*) n FROM context_log")).toBe(logs);
  expect((await fetch(base + "/api/preview?project=nope")).status).toBe(404);
});

test("jobs list, retry, cancel, actions", async () => {
  const { enqueue } = await import("../src/db");
  enqueue(db, "observe", 4242);
  const jid = db.query<{ id: number }, []>("SELECT id FROM jobs WHERE ref_id=4242").get()!.id;
  db.query("UPDATE jobs SET status='failed', attempts=3, error='x' WHERE id=?").run(jid);
  expect((await get("/api/jobs?status=failed")).items.some((j: any) => j.id === jid)).toBe(true);
  expect((await post(`/api/jobs/${jid}/retry`, {})).status).toBe(200);
  expect(db.query("SELECT status, attempts, error FROM jobs WHERE id=?").get(jid)).toEqual({ status: "pending", attempts: 0, error: null });
  expect((await post(`/api/jobs/${jid}/cancel`, {})).status).toBe(200);
  expect(db.query("SELECT status, error FROM jobs WHERE id=?").get(jid)).toEqual({ status: "failed", error: "cancelled" });
  expect((await post("/api/jobs/999999/retry", {})).status).toBe(404);
  expect((await post("/api/actions/consolidate", {})).status).toBe(200);
  expect(count("SELECT COUNT(*) n FROM jobs WHERE kind='consolidate'")).toBe(1);
  const re = await (await post("/api/actions/reembed", {})).json();
  expect(re.ok).toBe(true);
  expect(re.message).toMatch(/queued \d+/);
  expect((await post("/api/actions/nope", {})).status).toBe(404);
});

test("health reports counts and settings", async () => {
  const h = await get("/api/health");
  expect(h.counts.observations).toBe(count("SELECT COUNT(*) n FROM observations"));
  expect(typeof h.dbBytes).toBe("number");
  expect(h.settings.contextTokenBudget).toBeDefined();
  expect(typeof h.embeddingsEnabled).toBe("boolean");
});

test("export and import round-trip via markdown, dry run inserts nothing", async () => {
  const before = count("SELECT COUNT(*) n FROM observations WHERE project_id='p2'");
  const md = "## [decision] Imported one\n\nBody text.\n\n- fact one\n\nfiles: a.ts\n\n## Imported two\n\nMore.\n";
  const dry = await (await post("/api/import", { project_id: "p2", format: "md", content: md, dryRun: true })).json();
  expect(dry.count).toBe(2);
  expect(count("SELECT COUNT(*) n FROM observations WHERE project_id='p2'")).toBe(before);
  const real = await (await post("/api/import", { project_id: "p2", format: "md", content: md })).json();
  expect(real.count).toBe(2);
  expect(count("SELECT COUNT(*) n FROM observations WHERE project_id='p2' AND source='import'")).toBe(2);
  const r = await fetch(base + "/api/export?project=p2&format=md");
  expect(r.headers.get("content-disposition")).toContain("recall-other.md");
  const text = await r.text();
  expect(text).toContain("## [decision] Imported one");
  expect(text).toContain("- fact one");
  const js = await (await fetch(base + "/api/export?project=p2&format=json")).json();
  expect(js.some((o: any) => o.title === "Imported two")).toBe(true);
  expect((await post("/api/import", { project_id: "zz", format: "md", content: md })).status).toBe(400);
  expect((await post("/api/import", { project_id: "p2", format: "xml", content: md })).status).toBe(400);
});
