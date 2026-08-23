import type { Database } from "bun:sqlite";
import { enqueue, now, type ObservationRow } from "../../db";
import { markUnhelpful, markUsed, retrieve } from "../../retrieve";
import { TYPES } from "../transfer";
import { fail, getObs, intParam, json, obsOut, parseList, projectExists, strList, type Router } from "../http";

const PAGE_SIZE = 50;
const TYPE_SET = new Set<string>(TYPES);

export async function listObservations(db: Database, url: URL) {
  const project = url.searchParams.get("project") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const type = url.searchParams.get("type") || "";
  const archived = url.searchParams.get("archived") === "1";
  const pinned = url.searchParams.get("pinned") === "1";
  const since = Number(url.searchParams.get("since") || 0) || 0;
  const sort = url.searchParams.get("sort") === "confidence" ? "(alpha / (alpha + beta)) DESC, created_at DESC" : "created_at DESC";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1) || 1);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (project) { where.push("project_id = ?"); params.push(project); }
  if (type) { where.push("type = ?"); params.push(type); }
  if (!archived) where.push("archived = 0");
  if (pinned) where.push("pinned = 1");
  if (since) { where.push("created_at > ?"); params.push(since); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  if (q) {
    const projects = project ? [project] : db.query<{ id: string }, []>("SELECT id FROM projects").all().map((p) => p.id);
    const scored: Array<{ id: number; score: number }> = [];
    for (const pid of projects) {
      const items = await retrieve(db, { projectId: pid, query: q, limit: 200, includeArchived: archived, types: type ? [type] : undefined });
      for (const it of items) if (it.kind === "observation") scored.push({ id: it.id, score: it.score });
    }
    let ids = scored.sort((a, b) => b.score - a.score).map((s) => s.id);
    if (pinned || since) {
      const keep = new Set(db.query<{ id: number }, (string | number)[]>(`SELECT id FROM observations ${w}`).all(...params).map((r) => r.id));
      ids = ids.filter((id) => keep.has(id));
    }
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
    .query<ObservationRow, (string | number)[]>(`SELECT * FROM observations ${w} ORDER BY pinned DESC, ${sort} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { items: rows.map(obsOut), total, page, pageSize: PAGE_SIZE };
}

function validType(t: unknown): string {
  if (typeof t !== "string" || !TYPE_SET.has(t)) fail(400, `type must be one of ${TYPES.join(", ")}`);
  return t as string;
}

// A synthetic session to own hand-made rows (observations.session_id is NOT NULL).
export function manualSession(db: Database, projectId: string): number {
  const key = `manual:${projectId}`;
  const r = db.query<{ id: number }, [string]>("SELECT id FROM sessions WHERE claude_session_id = ?").get(key);
  if (r) return r.id;
  return Number(db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES (?, ?, '', ?)").run(key, projectId, now()).lastInsertRowid);
}

export function insertObservation(db: Database, o: { project_id: string; type: string; title: string; narrative: string; facts: string[]; files: string[]; pinned: boolean; source: string }): ObservationRow {
  const sid = manualSession(db, o.project_id);
  const id = Number(db.query(
    `INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at, pinned, source)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.project_id, sid, o.type, o.title.slice(0, 200), o.narrative, JSON.stringify(o.facts), JSON.stringify(o.files), now(), o.pinned ? 1 : 0, o.source).lastInsertRowid);
  enqueue(db, "embed", id);
  return getObs(db, id);
}

export function registerObservationRoutes(r: Router): void {
  r.get("/api/observations", async ({ db, url }) => json(await listObservations(db, url)));

  r.post("/api/observations", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const b = body!;
    const project_id = String(b.project_id ?? "");
    if (!projectExists(db, project_id)) fail(400, "project_id does not exist");
    const type = validType(b.type ?? "manual");
    const title = String(b.title ?? "").trim();
    const narrative = String(b.narrative ?? "").trim();
    if (!title) fail(400, "title is required");
    if (!narrative) fail(400, "narrative is required");
    const row = db.transaction(() => insertObservation(db, {
      project_id, type, title, narrative, facts: strList(b.facts) ?? [], files: strList(b.files) ?? [], pinned: !!b.pinned, source: "manual",
    }))();
    return json(obsOut(row), 201);
  });

  const patch = ({ db, params, body }: { db: Database; params: Record<string, string>; body: Record<string, unknown> | null }) => {
    const id = intParam(params.id);
    if (!body) fail(400, "invalid json body");
    const b = body!;
    const cur = getObs(db, id);
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) fail(400, "title cannot be empty"); sets.push("title = ?"); vals.push(t.slice(0, 200)); }
    if (b.narrative !== undefined) { const n = String(b.narrative).trim(); if (!n) fail(400, "narrative cannot be empty"); sets.push("narrative = ?"); vals.push(n); }
    if (b.facts !== undefined) { sets.push("facts = ?"); vals.push(JSON.stringify(strList(b.facts) ?? [])); }
    if (b.files !== undefined) { sets.push("files = ?"); vals.push(JSON.stringify(strList(b.files) ?? [])); }
    if (b.type !== undefined) { sets.push("type = ?"); vals.push(validType(b.type)); }
    if (b.project_id !== undefined) { const p = String(b.project_id); if (!projectExists(db, p)) fail(400, "project_id does not exist"); sets.push("project_id = ?"); vals.push(p); }
    if (b.pinned !== undefined) { sets.push("pinned = ?"); vals.push(b.pinned ? 1 : 0); }
    if (b.archived !== undefined) { sets.push("archived = ?"); vals.push(b.archived ? 1 : 0); }
    if (!sets.length) fail(400, "nothing to edit");
    const reembed = b.title !== undefined || b.narrative !== undefined || b.facts !== undefined;
    db.transaction(() => {
      db.query(`UPDATE observations SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      if (reembed) enqueue(db, "embed", id);
    })();
    void cur;
    return json(obsOut(getObs(db, id)));
  };
  r.patch("/api/observations/:id", patch);

  r.delete("/api/observations/:id", ({ db, params }) => {
    const id = intParam(params.id);
    getObs(db, id);
    db.transaction(() => {
      db.query("DELETE FROM jobs WHERE kind = 'embed' AND ref_id = ?").run(id);
      db.query("DELETE FROM observations WHERE id = ?").run(id);
    })();
    return json({ ok: true, id });
  });

  r.post("/api/observations/bulk", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const ids = Array.isArray(body!.ids) ? body!.ids.map(Number) : [];
    if (!ids.length || ids.some((n) => !Number.isInteger(n))) fail(400, "ids must be a non-empty integer array");
    const op = String(body!.op ?? "");
    const ph = ids.map(() => "?").join(",");
    const sql: Record<string, string> = {
      archive: "UPDATE observations SET archived = 1 WHERE id IN",
      unarchive: "UPDATE observations SET archived = 0 WHERE id IN",
      pin: "UPDATE observations SET pinned = 1 WHERE id IN",
      unpin: "UPDATE observations SET pinned = 0 WHERE id IN",
      delete: "DELETE FROM observations WHERE id IN",
      move: "UPDATE observations SET project_id = ? WHERE id IN",
    };
    if (!sql[op]) fail(400, `op must be one of ${Object.keys(sql).join(", ")}`);
    const project = op === "move" ? String(body!.project_id ?? "") : "";
    if (op === "move" && !projectExists(db, project)) fail(400, "project_id does not exist");
    db.transaction(() => {
      const found = db.query<{ n: number }, number[]>(`SELECT COUNT(*) n FROM observations WHERE id IN (${ph})`).get(...ids)!.n;
      if (found !== ids.length) fail(404, `${ids.length - found} id(s) not found`);
      if (op === "delete") db.query(`DELETE FROM jobs WHERE kind = 'embed' AND ref_id IN (${ph})`).run(...ids);
      const args = op === "move" ? [project, ...ids] : ids;
      db.query(`${sql[op]} (${ph})`).run(...args);
    })();
    return json({ ok: true, count: ids.length });
  });

  r.post("/api/observations/merge", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const ids = Array.isArray(body!.ids) ? body!.ids.map(Number) : [];
    if (ids.length < 2 || ids.some((n) => !Number.isInteger(n))) fail(400, "merge needs at least two integer ids");
    const rows = ids.map((id) => getObs(db, id));
    const projects = new Set(rows.map((x) => x.project_id));
    if (projects.size > 1) fail(400, "all observations must belong to the same project");
    const counts = new Map<string, number>();
    for (const x of rows) counts.set(x.type, (counts.get(x.type) ?? 0) + 1);
    const type = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const facts = [...new Set(rows.flatMap((x) => parseList(x.facts)))];
    const files = [...new Set(rows.flatMap((x) => parseList(x.files)))];
    const title = (typeof body!.title === "string" && body!.title.trim()) || rows[0].title;
    const narrative = (typeof body!.narrative === "string" && body!.narrative.trim()) || rows.map((x) => x.narrative).join("\n\n");
    const merged = db.transaction(() => {
      const row = insertObservation(db, { project_id: rows[0].project_id, type, title, narrative, facts, files, pinned: rows.some((x) => x.pinned === 1), source: "merged" });
      db.query(`UPDATE observations SET archived = 1, pinned = 0 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      return row;
    })();
    return json(obsOut(merged), 201);
  });

  r.post("/api/feedback", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const id = intParam(String(body!.id));
    getObs(db, id);
    if (typeof body!.useful !== "boolean") fail(400, "useful must be boolean");
    if (body!.useful) markUsed(db, [id], 2); else markUnhelpful(db, [id], 3);
    return json(obsOut(getObs(db, id)));
  });

  // Legacy aliases (pre-0.2 page). Same validation as PATCH.
  r.post("/api/edit", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    const { id, ...rest } = body!;
    return patch({ db, params: { id: String(id) }, body: rest });
  });
  r.post("/api/archive", ({ db, body }) => {
    if (!body) fail(400, "invalid json body");
    return patch({ db, params: { id: String(body!.id) }, body: { archived: !!body!.archived } });
  });
}
