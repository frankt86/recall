import { beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-pin-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";

let db: import("bun:sqlite").Database;
let pinnedId: number;
let hugeId: number;

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
  const ins = db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at) VALUES ('p1',1,?,?,?,'[]','[]',?)");
  for (let i = 0; i < 5; i++) ins.run("decision", `Item ${i}`, "short narrative", now() - i * 86400000);
  pinnedId = db.query<{ id: number }, []>("SELECT id FROM observations ORDER BY created_at ASC LIMIT 1").get()!.id; // the oldest
  db.query("UPDATE observations SET pinned = 1 WHERE id = ?").run(pinnedId);
  hugeId = Number(ins.run("config", "Huge pinned", "x".repeat(5000), now()).lastInsertRowid);
});

test("pinned observation ranks first regardless of age", async () => {
  const { retrieve } = await import("../src/retrieve");
  const items = await retrieve(db, { projectId: "p1", query: "", tokenBudget: 2000, limit: 3 });
  expect(items[0].id).toBe(pinnedId);
  expect(items[0].pinned).toBe(true);
  expect(items[0].why.recency).toBeGreaterThan(0);
  expect(items.filter((i) => i.pinned)).toHaveLength(1);
  expect(items).toHaveLength(4); // limit applies to unpinned only
  expect(items[1].why.recent).toBeDefined();
});

test("over-budget pinned item is skipped and reported", async () => {
  const { retrieveWithSkipped } = await import("../src/retrieve");
  db.query("UPDATE observations SET pinned = 1 WHERE id = ?").run(hugeId);
  const r = await retrieveWithSkipped(db, { projectId: "p1", query: "", tokenBudget: 600 });
  expect(r.skippedPinned).toEqual([hugeId]);
  expect(r.items.map((i) => i.id)).not.toContain(hugeId);
  expect(r.items[0].id).toBe(pinnedId);
});
