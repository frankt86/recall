import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { acquireLock, claimNextJob, enqueue, finishJob, releaseLock } from "../src/db";
import { normalizeRemote } from "../src/project";

process.env.RECALL_DIR = "/tmp/recall-test-" + process.pid;
const { openDb } = await import("../src/db");

test("jobs claim atomically and dedupe", () => {
  const db = openDb();
  enqueue(db, "observe", 1);
  enqueue(db, "observe", 1);
  enqueue(db, "observe", 2);
  const a = claimNextJob(db)!;
  const b = claimNextJob(db)!;
  expect(a.ref_id).toBe(1);
  expect(b.ref_id).toBe(2);
  expect(claimNextJob(db)).toBeNull();
  finishJob(db, a.id, false, "boom");
  const again = claimNextJob(db)!;
  expect(again.id).toBe(a.id);
  expect(again.attempts).toBe(2);
});

test("lock is exclusive until released or expired", () => {
  const db = openDb();
  expect(acquireLock(db, "t", "A", 60000)).toBe(true);
  expect(acquireLock(db, "t", "B", 60000)).toBe(false);
  expect(acquireLock(db, "t", "A", 60000)).toBe(true);
  releaseLock(db, "t", "A");
  expect(acquireLock(db, "t", "B", 60000)).toBe(true);
  expect(acquireLock(db, "t", "C", 60000)).toBe(false);
});

test("remote normalization", () => {
  const a = normalizeRemote("git@github.com:Acme/API.git");
  const b = normalizeRemote("https://github.com/acme/api");
  const c = normalizeRemote("ssh://git@github.com/acme/api.git");
  expect(a).toBe(b);
  expect(b).toBe(c);
});

test("migration adds pinned/source to a pre-existing DB and is idempotent", async () => {
  const { closeDb, getMeta } = await import("../src/db");
  const path = "/tmp/recall-test-mig-" + process.pid + ".db";
  const legacy = new Database(path, { create: true });
  legacy.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, session_id INTEGER NOT NULL, prompt_id INTEGER,
      type TEXT NOT NULL, title TEXT NOT NULL, narrative TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, alpha REAL NOT NULL DEFAULT 1.0, beta REAL NOT NULL DEFAULT 1.0, archived INTEGER NOT NULL DEFAULT 0, embedding BLOB);`);
  legacy.query("INSERT INTO observations(project_id, session_id, type, title, narrative, created_at) VALUES ('p',1,'other','t','n',1)").run();
  legacy.close();
  closeDb();
  const cols = (d: Database) => d.query<{ name: string }, []>("PRAGMA table_info(observations)").all().map((c) => c.name);
  const db = openDb(path);
  expect(cols(db)).toContain("pinned");
  expect(cols(db)).toContain("source");
  expect(db.query<{ pinned: number; source: string }, []>("SELECT pinned, source FROM observations").get()).toEqual({ pinned: 0, source: "auto" });
  expect(getMeta(db, "schema_version")).toBe("4");
  closeDb();
  const db2 = openDb(path);
  expect(cols(db2).filter((c) => c === "pinned")).toHaveLength(1);
  closeDb();
});
