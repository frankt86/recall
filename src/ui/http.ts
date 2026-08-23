// Tiny router + JSON helpers shared by the UI route modules. No framework: Bun.serve hands us a Request.
import type { Database } from "bun:sqlite";
import type { ObservationRow } from "../db";

export interface Ctx {
  db: Database;
  req: Request;
  url: URL;
  params: Record<string, string>;
  body: Record<string, unknown> | null;
}
export type Handler = (c: Ctx) => Promise<Response> | Response;

interface Route { method: string; re: RegExp; keys: string[]; h: Handler }

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, h: Handler): this {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, h });
    return this;
  }

  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  async handle(db: Database, req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body = req.method === "GET" ? null : await readJson(req);
      return r.h({ db, req, url, params, body });
    }
    return url.pathname.startsWith("/api/") ? bad("not found", 404) : new Response("not found", { status: 404 });
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
export const bad = (msg: string, status = 400) => json({ error: msg }, status);

export class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
export const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

export const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

export function intParam(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(400, "id must be an integer");
  return n;
}

export function obsOut(r: ObservationRow) {
  return {
    id: r.id, project_id: r.project_id, session_id: r.session_id, type: r.type, title: r.title, narrative: r.narrative,
    facts: parseList(r.facts), files: parseList(r.files), created_at: r.created_at,
    confidence: r.alpha / (r.alpha + r.beta), alpha: r.alpha, beta: r.beta,
    archived: !!r.archived, pinned: !!r.pinned, source: r.source, embedded: r.embedding != null,
  };
}

export function getObs(db: Database, id: number): ObservationRow {
  const r = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id);
  return r ?? fail(404, "no such observation");
}

export function projectExists(db: Database, id: string): boolean {
  return !!db.query("SELECT 1 FROM projects WHERE id = ?").get(id);
}
