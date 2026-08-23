import { beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-ctx-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";

let db: import("bun:sqlite").Database;

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
  db.query("INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at) VALUES ('p1',1,'decision','Use UV not pip','We standardised on uv.','[\"uv add\"]','[]',?)").run(now());
  db.query("INSERT INTO digests(project_id, period_start, period_end, content, source_count, created_at) VALUES ('p1',1,2,'digest body',5,?)").run(now());
});

test("buildSessionContext renders the hook text and has no side effects", async () => {
  const { buildSessionContext } = await import("../src/context");
  const { loadSettings } = await import("../src/settings");
  const { estimateTokens } = await import("../src/retrieve");
  const before = db.query<{ beta: number }, []>("SELECT beta FROM observations").get()!.beta;
  const r = await buildSessionContext(db, { projectId: "p1", projectName: "demo", branch: "main", query: "uv", settings: loadSettings() });
  expect(r.text.startsWith('<recall project="demo" branch="main">')).toBe(true);
  expect(r.text).toContain("## Project digest");
  expect(r.text).toContain("## Relevant recent memory");
  expect(r.text).toContain("#1 Use UV not pip");
  expect(r.text.trimEnd().endsWith("</recall>")).toBe(true);
  expect(r.tokens).toBe(estimateTokens(r.text));
  expect(r.items.map((i) => i.id)).toEqual([1]);
  expect(r.digest).toBe("digest body");
  await buildSessionContext(db, { projectId: "p1", projectName: "demo", branch: null, query: "", settings: loadSettings() });
  expect(db.query<{ beta: number }, []>("SELECT beta FROM observations").get()!.beta).toBe(before);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM context_log").get()!.n).toBe(0);
});

test("empty project yields empty text", async () => {
  const { buildSessionContext } = await import("../src/context");
  const { loadSettings } = await import("../src/settings");
  const r = await buildSessionContext(db, { projectId: "nope", projectName: "x", branch: null, query: "", settings: loadSettings() });
  expect(r.text).toBe("");
  expect(r.items).toEqual([]);
});

test("recentFilesQuery joins branch and recent file tokens", async () => {
  const { recentFilesQuery } = await import("../src/project");
  const { writeFileSync } = await import("node:fs");
  const root = join(dir, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "mcp-launch.ts"), "x");
  const q = recentFilesQuery(root, "feature/x");
  expect(q.startsWith("feature/x ")).toBe(true);
  expect(q).toContain("src mcp launch ts");
});
