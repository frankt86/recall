import type { Database } from "bun:sqlite";
import type { ObservationRow, SummaryRow } from "../db";
import { markUnhelpful, markUsed, retrieve } from "../retrieve";
import { PAGE } from "./page";
import { lastError } from "../log";

const PAGE_SIZE = 50;
const parseJson = (s: string | null): unknown[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};
const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function obsOut(r: ObservationRow) {
  return {
    id: r.id, project_id: r.project_id, session_id: r.session_id, type: r.type, title: r.title, narrative: r.narrative,
    facts: parseList(r.facts), files: parseList(r.files), created_at: r.created_at,
    confidence: r.alpha / (r.alpha + r.beta), alpha: r.alpha, beta: r.beta, archived: !!r.archived,
  };
}

async function listObservations(db: Database, url: URL) {
  const project = url.searchParams.get("project") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const type = url.searchParams.get("type") || "";
  const archived = url.searchParams.get("archived") === "1";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (project) { where.push("project_id = ?"); params.push(project); }
  if (type) { where.push("type = ?"); params.push(type); }
  if (!archived) where.push("archived = 0");
  const w = where.length ? "WHERE " + where.join(" AND ") : "";

  if (q) {
    // hybrid FTS + vector ranking, same as what gets injected into sessions
    const projects = project ? [project] : db.query<{ id: string }, []>("SELECT id FROM projects").all().map((p) => p.id);
    const scored: Array<{ id: number; score: number }> = [];
    for (const pid of projects) {
      const items = await retrieve(db, { projectId: pid, query: q, limit: 200, includeArchived: archived, types: type ? [type] : undefined });
      for (const it of items) if (it.kind === "observation") scored.push({ id: it.id, score: it.score });
    }
    const ids = scored.sort((a, b) => b.score - a.score).map((s) => s.id);
    const total = ids.length;
    const slice = ids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const rows = slice.length
      ? db.query<ObservationRow, number[]>(`SELECT * FROM observations WHERE id IN (${slice.map(() => "?").join(",")})`).all(...slice)
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: slice.map((id) => byId.get(id)).filter(Boolean).map((r) => obsOut(r!)), total, page, pageSize: PAGE_SIZE };
  }
  const total = db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) n FROM observations ${w}`).get(...params)!.n;
  const rows = db
    .query<ObservationRow, (string | number)[]>(`SELECT * FROM observations ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { items: rows.map(obsOut), total, page, pageSize: PAGE_SIZE };
}

function projects(db: Database) {
  const projects = db
    .query<{ id: string; name: string; observations: number; last: number | null }, []>(
      "SELECT p.id, p.name, COUNT(o.id) observations, MAX(o.created_at) last FROM projects p LEFT JOIN observations o ON o.project_id = p.id AND o.archived = 0 GROUP BY p.id ORDER BY last DESC, p.name",
    )
    .all();
  const queue: Record<string, number> = {};
  for (const j of db.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all()) queue[j.status] = j.n;
  const types = db.query<{ type: string; n: number }, []>("SELECT type, COUNT(*) n FROM observations GROUP BY type ORDER BY n DESC").all();
  return { projects, queue, types, lastError: lastError() };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try { const v = await req.json(); return v && typeof v === "object" ? (v as Record<string, unknown>) : null; } catch { return null; }
}

export function startUi(db: Database, port: number): { port: number; stop: () => void } {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (req.method === "GET") {
          if (p === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
          if (p === "/api/projects") return json(projects(db));
          if (p === "/api/observations") return json(await listObservations(db, url));
          if (p === "/api/context") {
            const project = url.searchParams.get("project") || "";
            const sql = `SELECT c.id, c.session_id, s.claude_session_id session, c.project_id, c.query, c.items, c.tokens, c.created_at
                         FROM context_log c JOIN sessions s ON s.id = c.session_id ${project ? "WHERE c.project_id = ?" : ""} ORDER BY c.created_at DESC LIMIT 100`;
            type Row = { id: number; session_id: number; session: string; project_id: string; query: string; items: string; tokens: number; created_at: number };
            const rows = project ? db.query<Row, [string]>(sql).all(project) : db.query<Row, []>(sql).all();
            return json({ items: rows.map((r) => ({ ...r, items: parseJson(r.items) })) });
          }
          if (p === "/api/summaries" || p === "/api/digests") {
            const project = url.searchParams.get("project") || "";
            const table = p === "/api/summaries" ? "summaries" : "digests";
            const order = table === "summaries" ? "created_at" : "period_end";
            const rows = project
              ? db.query<SummaryRow, [string]>(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY ${order} DESC LIMIT 200`).all(project)
              : db.query<SummaryRow, []>(`SELECT * FROM ${table} ORDER BY ${order} DESC LIMIT 200`).all();
            return json({ items: rows.map(({ embedding: _e, ...r }) => r) });
          }
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          if (!body) return bad("invalid json body");
          const id = Number(body.id);
          if (!Number.isInteger(id)) return bad("id must be an integer");
          if (!db.query("SELECT 1 FROM observations WHERE id = ?").get(id)) return bad("no such observation", 404);
          if (p === "/api/feedback") {
            if (typeof body.useful !== "boolean") return bad("useful must be boolean");
            if (body.useful) markUsed(db, [id], 2); else markUnhelpful(db, [id], 3);
            const r = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
            return json(obsOut(r));
          }
          if (p === "/api/edit") {
            const title = typeof body.title === "string" ? body.title.trim() : undefined;
            const narrative = typeof body.narrative === "string" ? body.narrative.trim() : undefined;
            const facts = Array.isArray(body.facts) ? body.facts.map(String).map((f) => f.trim()).filter(Boolean) : undefined;
            if (title === "" || narrative === "") return bad("title and narrative cannot be empty");
            if (title === undefined && narrative === undefined && facts === undefined) return bad("nothing to edit");
            const cur = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
            db.query("UPDATE observations SET title = ?, narrative = ?, facts = ? WHERE id = ?").run(
              (title ?? cur.title).slice(0, 200), narrative ?? cur.narrative, JSON.stringify(facts ?? parseList(cur.facts)), id,
            );
            return json(obsOut(db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!));
          }
          if (p === "/api/archive") {
            db.query("UPDATE observations SET archived = ? WHERE id = ?").run(body.archived ? 1 : 0, id);
            return json(obsOut(db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!));
          }
        }
        return p.startsWith("/api/") ? bad("not found", 404) : new Response("not found", { status: 404 });
      } catch (e) {
        return bad((e as Error).message, 500);
      }
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}
