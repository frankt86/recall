import { beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-lessons-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";
process.env.RECALL_LLM = "fake";

let db: import("bun:sqlite").Database;
const get = (id: number) => db.query<import("../src/db").ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
const bugfix = (session: number, title: string, files: string[]) =>
  Number(db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at) VALUES ('p1',?,'bugfix',?,?, '[]', ?, ?)")
    .run(session, title, `Fixed ${title} again.`, JSON.stringify(files), Date.now() - session * 1000).lastInsertRowid);

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  const { resetSettings } = await import("../src/settings");
  resetSettings();
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  for (let i = 1; i <= 4; i++) db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES (?, 'p1','/d',?)").run(`s${i}`, now());
});

test("the same fix across three sessions produces one pinned lesson; it updates, never duplicates", async () => {
  const { checkRecurring } = await import("../src/processor");
  const { linkObservation } = await import("../src/graph");
  const { retrieve } = await import("../src/retrieve");
  const a = bugfix(1, "Console window appears on Windows", ["src/hook-io.ts"]);
  const b = bugfix(2, "Console window flashes again", ["src/hook-io.ts"]);
  for (const id of [a, b]) linkObservation(db, get(id));
  expect(await checkRecurring(db, b)).toEqual([]); // two sessions: not yet recurring

  const c = bugfix(3, "Console window back after refactor", ["src/hook-io.ts"]);
  linkObservation(db, get(c));
  const made = await checkRecurring(db, c);
  expect(made).toHaveLength(1);
  const lesson = get(made[0]);
  expect(lesson.type).toBe("lesson");
  expect(lesson.pinned).toBe(1);
  expect(lesson.importance).toBe(5);
  expect(lesson.title).toContain("src/hook-io.ts");
  expect(JSON.parse(lesson.facts)).toEqual(["Check memory first", "Apply the established fix"]);
  expect(JSON.parse(lesson.files)).toEqual(["src/hook-io.ts"]);

  // it is injected first, regardless of query
  const items = await retrieve(db, { projectId: "p1", query: "something unrelated", limit: 5, tokenBudget: 2000 });
  expect(items[0].id).toBe(lesson.id);
  expect(items[0].pinned).toBe(true);

  // same session count again -> no rewrite; a fourth session -> the same lesson row is updated, not duplicated
  expect(await checkRecurring(db, c)).toEqual([]);
  const d = bugfix(4, "Console window, fourth time", ["src/hook-io.ts"]);
  linkObservation(db, get(d));
  const again = await checkRecurring(db, d);
  expect(again).toEqual([lesson.id]);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM observations WHERE type = 'lesson'").get()!.n).toBe(1);
});

test("importance scales the score and survives the pipeline", async () => {
  const { retrieve } = await import("../src/retrieve");
  const lo = Number(db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, created_at, importance) VALUES ('p1',1,'other','Zebra trivia','zebra',?,1)").run(Date.now()).lastInsertRowid);
  const hi = Number(db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, created_at, importance) VALUES ('p1',1,'decision','Zebra architecture','zebra',?,5)").run(Date.now() - 500).lastInsertRowid);
  const items = (await retrieve(db, { projectId: "p1", query: "zebra", limit: 10 })).filter((i) => !i.pinned);
  expect(items.findIndex((i) => i.id === hi)).toBeLessThan(items.findIndex((i) => i.id === lo));
  expect(items.find((i) => i.id === hi)!.why.importance).toBe(5);
});

test("maintenance sweep also creates lessons and never retires them", async () => {
  const { sweepRecurring } = await import("../src/processor");
  const { runMaintain } = await import("../src/maintain");
  const { DEFAULTS } = await import("../src/settings");
  const { linkObservation } = await import("../src/graph");
  for (let s = 1; s <= 3; s++) linkObservation(db, get(bugfix(s, `Flaky embed job ${s}`, ["src/embed.ts"])));
  expect(await sweepRecurring(db)).toBeGreaterThanOrEqual(1);
  const lessons = db.query<{ id: number; created_at: number }, []>("SELECT id, created_at FROM observations WHERE type = 'lesson'").all();
  expect(lessons.length).toBe(2);
  db.query("UPDATE observations SET created_at = ?, alpha = 1, beta = 3 WHERE type = 'lesson'").run(Date.now() - 400 * 86400000);
  runMaintain(db, { ...DEFAULTS, retireAfterDays: 1, maxActivePerProject: 1 });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM observations WHERE type = 'lesson' AND archived = 0").get()!.n).toBe(2);
});
