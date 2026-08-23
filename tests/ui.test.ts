import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-ui-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";

let server: { port: number; stop: () => void };
let base: string;
let db: import("bun:sqlite").Database;

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  closeDb(); // other test files share this process and may already hold the singleton on another path
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p2','other','/o',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
  const ins = db.query("INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at) VALUES (?,?,NULL,?,?,?,?,?,?)");
  for (let i = 0; i < 60; i++) ins.run("p1", 1, i % 2 ? "bugfix" : "decision", `Observation ${i} about ${i === 7 ? "kangaroo" : "stuff"}`, "narrative", '["a"]', '["src/x.ts"]', now() - i * 1000);
  ins.run("p2", 1, "config", "Other project item", "n", "[]", "[]", now());
  db.query("INSERT INTO summaries(project_id, session_id, request, completed, learned, next_steps, created_at) VALUES ('p1',1,'req','done','learned','next',?)").run(now());
  db.query("INSERT INTO digests(project_id, period_start, period_end, content, source_count, created_at) VALUES ('p1',1,2,'digest body',5,?)").run(now());
  const { startUi } = await import("../src/ui/server");
  server = startUi(db, 0);
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop());

const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;

test("index html is served and dark-mode aware", async () => {
  const r = await fetch(base + "/");
  expect(r.headers.get("content-type")).toContain("text/html");
  const t = await r.text();
  expect(t).toContain('<link rel="stylesheet" href="/static/app.css">');
  expect(t).not.toContain("<script src=\"http");
});

test("projects endpoint", async () => {
  const j = await get("/api/projects");
  expect(j.projects.map((p: any) => p.name).sort()).toEqual(["demo", "other"]);
  expect(j.projects.find((p: any) => p.id === "p1").observations).toBe(60);
  expect(j.queue).toBeDefined();
});

test("observations paginate and filter", async () => {
  const a = await get("/api/observations?project=p1&page=1");
  expect(a.items.length).toBe(50);
  expect(a.total).toBe(60);
  const b = await get("/api/observations?project=p1&page=2");
  expect(b.items.length).toBe(10);
  const t = await get("/api/observations?project=p1&type=bugfix");
  expect(t.items.every((i: any) => i.type === "bugfix")).toBe(true);
  const all = await get("/api/observations");
  expect(all.total).toBe(61);
});

test("search uses hybrid retrieve", async () => {
  const j = await get("/api/observations?project=p1&q=kangaroo");
  expect(j.items[0].title).toContain("kangaroo");
});

test("summaries and digests", async () => {
  expect((await get("/api/summaries?project=p1")).items[0].request).toBe("req");
  expect((await get("/api/digests?project=p1")).items[0].content).toBe("digest body");
});

test("feedback and archive mutate confidence/archived", async () => {
  const id = (await get("/api/observations?project=p1")).items[0].id;
  const r = await fetch(base + "/api/feedback", { method: "POST", body: JSON.stringify({ id, useful: true }), headers: { "content-type": "application/json" } });
  expect(r.status).toBe(200);
  const row = db.query<{ alpha: number }, [number]>("SELECT alpha FROM observations WHERE id = ?").get(id)!;
  expect(row.alpha).toBeGreaterThan(1);
  await fetch(base + "/api/archive", { method: "POST", body: JSON.stringify({ id, archived: true }), headers: { "content-type": "application/json" } });
  expect(db.query<{ archived: number }, [number]>("SELECT archived FROM observations WHERE id = ?").get(id)!.archived).toBe(1);
  expect((await get("/api/observations?project=p1")).total).toBe(59);
  expect((await get("/api/observations?project=p1&archived=1")).total).toBe(60);
  const bad = await fetch(base + "/api/feedback", { method: "POST", body: "{bad", headers: { "content-type": "application/json" } });
  expect(bad.status).toBe(400);
  expect((await fetch(base + "/api/nope")).status).toBe(404);
});

test("context log endpoint lists what was injected", async () => {
  const { now } = await import("../src/db");
  db.query("INSERT INTO context_log(session_id, project_id, query, items, tokens, created_at) VALUES (1,'p1','feature x auth', ?, 312, ?)").run(JSON.stringify([{ kind: "observation", id: 1, title: "Observation 1 about stuff" }, { kind: "summary", id: 1, title: "req" }]), now());
  const j = await get("/api/context?project=p1");
  expect(j.items.length).toBe(1);
  expect(j.items[0].tokens).toBe(312);
  expect(j.items[0].items[0].title).toContain("Observation 1");
  expect(j.items[0].session).toBe("s1");
});

test("edit observation title/narrative/facts and reindex fts", async () => {
  const id = (await get("/api/observations?project=p1&type=bugfix")).items[0].id;
  const r = await fetch(base + "/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: "Wombat fix", narrative: "new narrative", facts: ["f1", "f2"] }) });
  expect(r.status).toBe(200);
  const o = await r.json();
  expect(o.title).toBe("Wombat fix");
  expect(o.facts).toEqual(["f1", "f2"]);
  expect((await get("/api/observations?project=p1&q=wombat")).items[0].id).toBe(id);
  const bad = await fetch(base + "/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: "" }) });
  expect(bad.status).toBe(400);
});


test("static SPA assets are served with correct types; traversal is refused", async () => {
  const html = await fetch(base + "/");
  expect(html.headers.get("content-type")).toContain("text/html");
  const t = await html.text();
  expect(t).toContain('<script type="module" src="/static/app.js">');
  for (const [p, ct] of [["/static/app.js", "text/javascript"], ["/static/app.css", "text/css"], ["/static/keys.js", "text/javascript"], ["/static/views/preview.js", "text/javascript"], ["/static/views/jobs.js", "text/javascript"], ["/static/views/health.js", "text/javascript"], ["/static/views/sessions.js", "text/javascript"]]) {
    const r = await fetch(base + p);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain(ct);
  }
  const css = await (await fetch(base + "/static/app.css")).text();
  expect(css).toContain("prefers-color-scheme: dark");
  expect((await fetch(base + "/static/../package.json")).status).toBe(404);
  expect((await fetch(base + "/static/views/../../package.json")).status).toBe(404);
  expect((await fetch(base + "/static/nope.js")).status).toBe(404);
});

test("every static module parses as JS", async () => {
  for (const p of ["app.js", "keys.js", "views/preview.js", "views/jobs.js", "views/health.js", "views/sessions.js"]) {
    const src = await (await fetch(base + "/static/" + p)).text();
    const t = Bun.Transpiler ? new Bun.Transpiler({ loader: "js" }) : null;
    expect(() => t!.transformSync(src)).not.toThrow();
  }
});
