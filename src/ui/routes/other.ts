import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { enqueue, getMeta, now, setMeta, type ObservationRow, type SummaryRow } from "../../db";
import { buildSessionContext } from "../../context";
import { embeddingsAvailable } from "../../embed";
import { lastError } from "../../log";
import { recentFilesQuery } from "../../project";
import { dbPath, loadSettings } from "../../settings";
import { fail, intParam, json, obsOut, parseList, projectExists, type Router } from "../http";
import { fromJson, fromMarkdown, toJson, toMarkdown, type ObsIn } from "../transfer";
import { insertObservation } from "./observations";

const parseJson = (s: string | null): unknown[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};

interface ProjectRow { id: string; name: string; root_path: string; observations: number; pinned: number; inbox: number; last: number | null }

function projects(db: Database) {
  const seenAt = Number(getMeta(db, "ui_last_seen_at") ?? 0);
  const rows = db
    .query<ProjectRow, [number]>(
      `SELECT p.id, p.name, p.root_path, COUNT(o.id) observations, COALESCE(SUM(o.pinned), 0) pinned,
              COALESCE(SUM(o.created_at > ?), 0) inbox, MAX(o.created_at) last
       FROM projects p LEFT JOIN observations o ON o.project_id = p.id AND o.archived = 0
       GROUP BY p.id ORDER BY last DESC, p.name`,
    )
    .all(seenAt);
  const queue: Record<string, number> = {};
  for (const j of db.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all()) queue[j.status] = j.n;
  const types = db.query<{ type: string; n: number }, []>("SELECT type, COUNT(*) n FROM observations GROUP BY type ORDER BY n DESC").all();
  return { projects: rows, queue, types, seenAt, lastError: lastError() };
}

export function registerOtherRoutes(r: Router): void {
  r.get("/api/projects", ({ db }) => json(projects(db)));
  r.post("/api/seen", ({ db }) => { const t = now(); setMeta(db, "ui_last_seen_at", String(t)); return json({ ok: true, seenAt: t }); });

  r.get("/api/context", ({ db, url }) => {
    const project = url.searchParams.get("project") || "";
    const sql = `SELECT c.id, c.session_id, s.claude_session_id session, c.project_id, c.query, c.items, c.tokens, c.created_at
                 FROM context_log c JOIN sessions s ON s.id = c.session_id ${project ? "WHERE c.project_id = ?" : ""} ORDER BY c.created_at DESC LIMIT 100`;
    type Row = { id: number; session_id: number; session: string; project_id: string; query: string; items: string; tokens: number; created_at: number };
    const rows = project ? db.query<Row, [string]>(sql).all(project) : db.query<Row, []>(sql).all();
    return json({ items: rows.map((x) => ({ ...x, items: parseJson(x.items) })) });
  });

  for (const table of ["summaries", "digests"] as const) {
    const order = table === "summaries" ? "created_at" : "period_end";
    r.get(`/api/${table}`, ({ db, url }) => {
      const project = url.searchParams.get("project") || "";
      const rows = project
        ? db.query<SummaryRow, [string]>(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${order} DESC LIMIT 200`).all(project)
        : db.query<SummaryRow, []>(`SELECT * FROM ${table} ORDER BY ${order} DESC LIMIT 200`).all();
      return json({ items: rows.map(({ embedding: _e, ...x }) => x) });
    });
    const fields = table === "summaries" ? ["request", "completed", "learned", "next_steps"] : ["content"];
    r.patch(`/api/${table}/:id`, ({ db, params, body }) => {
      const id = intParam(params.id);
      if (!body) fail(400, "invalid json body");
      if (!db.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) fail(404, `no such ${table.slice(0, -1)}`);
      const sets: string[] = []; const vals: string[] = [];
      for (const f of fields) if (body![f] !== undefined) { const v = String(body![f]).trim(); if (!v) fail(400, `${f} cannot be empty`); sets.push(`${f} = ?`); vals.push(v); }
      if (!sets.length) fail(400, "nothing to edit");
      db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      const { embedding: _e, ...row } = db.query<SummaryRow, [number]>(`SELECT * FROM ${table} WHERE id = ?`).get(id)!;
      return json(row);
    });
    r.delete(`/api/${table}/:id`, ({ db, params }) => {
      const id = intParam(params.id);
      if (!db.query(`DELETE FROM ${table} WHERE id = ?`).run(id).changes) fail(404, `no such ${table.slice(0, -1)}`);
      return json({ ok: true, id });
    });
  }

  r.get("/api/preview", async ({ db, url }) => {
    const id = url.searchParams.get("project") || "";
    const p = db.query<{ id: string; name: string; root_path: string }, [string]>("SELECT id, name, root_path FROM projects WHERE id = ?").get(id);
    if (!p) fail(404, "no such project");
    const settings = loadSettings();
    const query = recentFilesQuery(p!.root_path, null);
    const c = await buildSessionContext(db, { projectId: p!.id, projectName: p!.name, branch: null, query, settings });
    const skipped = c.skippedPinned.length
      ? db.query<{ id: number; title: string }, number[]>(`SELECT id, title FROM observations WHERE id IN (${c.skippedPinned.map(() => "?").join(",")})`).all(...c.skippedPinned)
      : [];
    return json({
      text: c.text, tokens: c.tokens, budget: settings.contextTokenBudget, maxItems: settings.contextMaxItems, query, digest: c.digest, pending: c.pending,
      items: c.items.map((i) => ({ kind: i.kind, id: i.id, title: i.title, type: i.type, score: Number(i.score.toFixed(4)), why: i.why, pinned: i.pinned, created_at: i.created_at, confidence: i.confidence })),
      skippedPinned: skipped,
    });
  });

  r.get("/api/jobs", ({ db, url }) => {
    const status = url.searchParams.get("status") || "";
    const rows = status
      ? db.query("SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT 200").all(status)
      : db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT 200").all();
    return json({ items: rows });
  });
  r.post("/api/jobs/:id/retry", ({ db, params }) => {
    const id = intParam(params.id);
    if (!db.query("UPDATE jobs SET status = 'pending', attempts = 0, error = NULL, claimed_at = NULL WHERE id = ?").run(id).changes) fail(404, "no such job");
    return json({ ok: true });
  });
  r.post("/api/jobs/:id/cancel", ({ db, params }) => {
    const id = intParam(params.id);
    if (!db.query("UPDATE jobs SET status = 'failed', error = 'cancelled', claimed_at = NULL WHERE id = ?").run(id).changes) fail(404, "no such job");
    return json({ ok: true });
  });

  r.post("/api/actions/:name", async ({ db, params, body }) => {
    const project = typeof body?.project === "string" ? body.project : undefined;
    if (params.name === "consolidate") { enqueue(db, "consolidate", Math.floor(now() / 1000)); return json({ ok: true, message: "consolidation queued; run the queue to execute" }); }
    if (params.name === "reembed") { const { enqueueMissingEmbeddings } = await import("../../processor"); const n = enqueueMissingEmbeddings(db, project); return json({ ok: true, message: `queued ${n} embedding job(s)` }); }
    if (params.name === "process") { const { drain } = await import("../../processor"); const n = await drain(db, { quiet: true }); return json({ ok: true, message: n === 0 ? "nothing to process (or another processor holds the lock)" : `processed ${n} job(s)` }); }
    return fail(404, "unknown action");
  });

  r.get("/api/health", async ({ db }) => {
    const path = dbPath();
    let dbBytes = 0;
    try { dbBytes = statSync(path).size; } catch { /* in-memory or missing */ }
    const counts: Record<string, number> = {};
    for (const t of ["observations", "summaries", "digests", "jobs", "sessions", "projects"]) counts[t] = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${t}`).get()!.n;
    const embedded = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM observations WHERE embedding IS NOT NULL AND archived = 0").get()!.n;
    const embeddable = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM observations WHERE archived = 0").get()!.n;
    const s = loadSettings();
    return json({ dbPath: path, dbBytes, counts, embedded, embeddable, embeddingsEnabled: s.embeddings, embeddingsReady: s.embeddings ? await embeddingsAvailable() : false, settings: s, lastError: lastError() });
  });

  r.get("/api/export", ({ db, url }) => {
    const id = url.searchParams.get("project") || "";
    const format = url.searchParams.get("format") === "json" ? "json" : "md";
    const p = db.query<{ name: string }, [string]>("SELECT name FROM projects WHERE id = ?").get(id);
    if (!p) fail(404, "no such project");
    const rows = db.query<ObservationRow, [string]>("SELECT * FROM observations WHERE project_id = ? AND archived = 0 ORDER BY pinned DESC, created_at DESC").all(id);
    const items: ObsIn[] = rows.map((x) => ({ type: x.type, title: x.title, narrative: x.narrative, facts: parseList(x.facts), files: parseList(x.files), pinned: !!x.pinned }));
    const safe = p!.name.replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
    const body = format === "json" ? toJson(items) : toMarkdown(items);
    return new Response(body, { headers: { "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="recall-${safe}.${format}"` } });
  });

  r.post("/api/import", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const project_id = String(body!.project_id ?? "");
    if (!projectExists(db, project_id)) fail(400, "project_id does not exist");
    const format = String(body!.format ?? "md");
    if (format !== "md" && format !== "json") fail(400, "format must be md or json");
    const content = String(body!.content ?? "");
    const items = format === "json" ? fromJson(content) : fromMarkdown(content);
    if (body!.dryRun) return json({ count: items.length, dryRun: true, titles: items.map((i) => i.title) });
    const ids = db.transaction(() => items.map((i) => insertObservation(db, { ...i, project_id, narrative: i.narrative || i.title, source: "import" }).id))();
    return json({ count: ids.length, ids });
  });
}
