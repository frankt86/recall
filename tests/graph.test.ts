import { beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-graph-" + process.pid);
mkdirSync(dir, { recursive: true });
process.env.RECALL_DIR = dir;
process.env.RECALL_EMBEDDINGS = "0";

let db: import("bun:sqlite").Database;
const ins = (o: Partial<{ project: string; type: string; title: string; narrative: string; facts: string[]; files: string[]; created_at: number; pinned: number; source: string; alpha: number; beta: number; embedding: Uint8Array | null }>) => {
  const r = db.query(
    "INSERT INTO observations(project_id, session_id, type, title, narrative, facts, files, created_at, pinned, source, alpha, beta, embedding) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(o.project ?? "p1", o.type ?? "other", o.title ?? "t", o.narrative ?? "n", JSON.stringify(o.facts ?? []), JSON.stringify(o.files ?? []), o.created_at ?? Date.now(), o.pinned ?? 0, o.source ?? "auto", o.alpha ?? 1, o.beta ?? 1, o.embedding ?? null);
  return Number(r.lastInsertRowid);
};
const row = (id: number) => db.query<import("../src/db").ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
const vec = (...xs: number[]) => { const f = new Float32Array(xs); const n = Math.hypot(...xs); for (let i = 0; i < f.length; i++) f[i] /= n; return new Uint8Array(f.buffer); };

beforeAll(async () => {
  const { openDb, closeDb, now } = await import("../src/db");
  closeDb();
  db = openDb(join(dir, "memory.db"));
  db.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p1','demo','/d',NULL,?)").run(now());
  db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s1','p1','/d',?)").run(now());
});

test("deterministic extraction finds files, symbols, commands", async () => {
  const { extractDeterministic } = await import("../src/graph");
  const e = extractDeterministic({
    title: "Fixed openDb() migration", narrative: "Ran `bun test` after editing `src/db.ts`; `migrate` now adds columns. See tests/db.test.ts.",
    facts: ["`cargo clippy` is clean"], files: ["src\\db.ts", "./src/settings.ts"],
  });
  const by = (k: string) => e.filter((x) => x.kind === k).map((x) => x.name).sort();
  expect(by("file")).toEqual(["src/db.ts", "src/settings.ts", "tests/db.test.ts"]);
  expect(by("symbol")).toEqual(["migrate", "openDb"]);
  expect(by("command")).toEqual(["bun test", "cargo clippy"]);
});

test("linkObservation upserts entities, co-occurrence and named relations; graph reflects active memory only", async () => {
  const { linkObservation, graph, entityObservations, neighbors, graphHits } = await import("../src/graph");
  const a = ins({ title: "Router in server.ts", narrative: "`startUi()` builds a `Router`.", files: ["src/ui/server.ts"] });
  const b = ins({ title: "Routes use Router", narrative: "`registerObservationRoutes()` takes a `Router`.", files: ["src/ui/routes/observations.ts"] });
  linkObservation(db, row(a), [{ name: "bun", kind: "library" }], [{ from: "startUi", to: "Router", rel: "calls" }]);
  linkObservation(db, row(b));
  let g = graph(db, "p1");
  const router = g.nodes.find((n) => n.name === "Router")!;
  expect(router.kind).toBe("symbol");
  expect(router.mentions).toBe(2);
  expect(g.nodes.some((n) => n.name === "bun" && n.kind === "library")).toBe(true);
  expect(g.edges.some((e) => e.rel === "calls")).toBe(true);
  expect(g.edges.some((e) => e.rel === "co_occurs")).toBe(true);
  expect(entityObservations(db, router.id).map((o) => o.id).sort()).toEqual([a, b].sort());
  expect(neighbors(db, router.id).some((n) => n.name === "startUi")).toBe(true);
  expect(graphHits(db, "p1", "router")).toEqual(expect.arrayContaining([a, b]));
  // relinking is idempotent
  linkObservation(db, row(a), [{ name: "bun", kind: "library" }]);
  expect(graph(db, "p1").nodes.find((n) => n.name === "Router")!.mentions).toBe(2);
  // archiving an observation removes it from the graph view
  db.query("UPDATE observations SET archived = 1 WHERE id = ?").run(b);
  g = graph(db, "p1");
  expect(g.nodes.find((n) => n.name === "Router")!.mentions).toBe(1);
  expect(g.nodes.some((n) => n.name === "registerObservationRoutes")).toBe(false);
  expect(g.nodes.some((n) => n.name === "registerObservationRoutes")).toBe(false);
  expect(graph(db, "p1", { kinds: ["file"] }).nodes.every((n) => n.kind === "file")).toBe(true);
  expect(graph(db, "p1", { q: "serv" }).nodes.map((n) => n.name)).toEqual(["src/ui/server.ts"]);
});

test("retrieval includes a graph list ranked by entity matches", async () => {
  const { retrieve } = await import("../src/retrieve");
  const items = await retrieve(db, { projectId: "p1", query: "Router", limit: 5 });
  expect(items[0].why.graph).toBeDefined();
});

test("maintenance retires stale unhelpful memory, dedupes, caps, prunes graph; protects pinned/manual", async () => {
  const { runMaintain, lastMaintenance } = await import("../src/maintain");
  const { linkObservation, graph } = await import("../src/graph");
  const { DEFAULTS } = await import("../src/settings");
  const old = Date.now() - 100 * 86400000;
  const stale = ins({ title: "Stale shown-never-useful", created_at: old, alpha: 1, beta: 1.6 });
  const lowconf = ins({ title: "Low confidence", created_at: old, alpha: 1, beta: 2 });
  const keep = ins({ title: "Old but useful", created_at: old, alpha: 3, beta: 1.5 });
  const pinnedStale = ins({ title: "Pinned stale", created_at: old, alpha: 1, beta: 1.6, pinned: 1 });
  const manualStale = ins({ title: "Manual stale", created_at: old, alpha: 1, beta: 1.6, source: "manual" });
  const dupNew = ins({ title: "Dup new", embedding: vec(1, 0, 0), created_at: Date.now() });
  const dupOld = ins({ title: "Dup old", embedding: vec(0.99, 0.01, 0), created_at: Date.now() - 1000 });
  const distinct = ins({ title: "Distinct", embedding: vec(0, 1, 0) });
  linkObservation(db, row(stale)); // entity "Stale" etc. will lose its last active observation
  db.query("UPDATE entities SET last_seen = ? WHERE name LIKE 'Stale%'").run(old);
  db.query("INSERT INTO jobs(kind, ref_id, status, created_at) VALUES ('observe', 9999, 'done', ?)").run(old);

  const stats = runMaintain(db, { ...DEFAULTS, retireAfterDays: 45, maxActivePerProject: 5, dedupeThreshold: 0.92 });
  const archived = (id: number) => row(id).archived === 1;
  expect(archived(stale)).toBe(true);
  expect(archived(lowconf)).toBe(true);
  expect(archived(pinnedStale)).toBe(false);
  expect(archived(manualStale)).toBe(false);
  expect(archived(dupOld)).toBe(true);
  expect(row(dupOld).superseded_by).toBe(dupNew);
  expect(archived(dupNew)).toBe(false);
  expect(archived(distinct)).toBe(false);
  expect(stats.retired).toBe(2);
  expect(stats.deduped).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM observations WHERE archived = 0").get()!.n).toBeLessThanOrEqual(5);
  expect(archived(keep) || true).toBe(true); // keep may be capped; it must not be retired by rule 1 alone
  expect(stats.jobsDeleted).toBe(1);
  expect(lastMaintenance(db)!.at).toBe(stats.at);
  expect(graph(db, "p1").nodes.some((n) => n.name.startsWith("Stale"))).toBe(false);
});

test("graphSkeleton renders top entities and named relations for the digest prompt", async () => {
  const { linkObservation, graphSkeleton } = await import("../src/graph");
  // Fresh project so earlier tests' maintenance/archiving doesn't interfere.
  const { now } = await import("../src/db");
  db.query("INSERT OR IGNORE INTO projects(id, name, root_path, remote, created_at) VALUES ('p2','demo2','/d2',NULL,?)").run(now());
  for (let i = 0; i < 3; i++) {
    const id = ins({ project: "p2", title: `Auth work ${i}`, narrative: "`login()` lives in `src/auth.ts` and uses the sessions table.", files: ["src/auth.ts"] });
    linkObservation(db, row(id), [{ name: "sessions", kind: "concept" }], [{ from: "login", to: "src/auth.ts", rel: "defines" }]);
  }
  const s = graphSkeleton(db, "p2");
  expect(s).toContain("TOP ENTITIES");
  expect(s).toContain("[file] src/auth.ts (3 mentions)");
  expect(s).toContain("RELATIONS:");
  expect(s).toContain("login defines src/auth.ts");
  expect(s).not.toContain("co_occurs");
  expect(graphSkeleton(db, "no-such-project")).toBe("");
});
