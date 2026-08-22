import { Database } from "bun:sqlite";
import { blobToFloats, type ObservationRow, type SummaryRow } from "./db";
import { cosine, embedOne } from "./embed";

export type ItemKind = "observation" | "summary" | "digest";

export interface ScoredItem {
  kind: ItemKind;
  id: number;
  score: number;
  created_at: number;
  confidence: number;
  title: string;
  body: string;
  files: string[];
  type: string;
}

export interface RetrieveOptions {
  projectId: string;
  query: string;
  limit?: number;
  tokenBudget?: number;
  includeArchived?: boolean;
  since?: number;
  until?: number;
  types?: string[];
  halfLifeDays?: number;
}

export function ftsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.\/\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[\.\-\/]+|[\.\-\/]+$/g, ""))
    .filter((t) => t.length > 1);
  const uniq = [...new Set(tokens)].slice(0, 24);
  if (uniq.length === 0) return "";
  return uniq.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function rrf(ranks: Map<string, number[]>, k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, rs] of ranks) {
    let s = 0;
    for (const r of rs) s += 1 / (k + r);
    out.set(key, s);
  }
  return out;
}

function obsToItem(o: ObservationRow): ScoredItem {
  const facts = safeArr(o.facts);
  const body = [o.narrative, ...facts.map((f) => `- ${f}`)].join("\n");
  return {
    kind: "observation",
    id: o.id,
    score: 0,
    created_at: o.created_at,
    confidence: o.alpha / (o.alpha + o.beta),
    title: o.title,
    body,
    files: safeArr(o.files),
    type: o.type,
  };
}

function sumToItem(s: SummaryRow): ScoredItem {
  const body = [`Completed: ${s.completed}`, `Learned: ${s.learned}`, `Next: ${s.next_steps}`].join("\n");
  return {
    kind: "summary",
    id: s.id,
    score: 0,
    created_at: s.created_at,
    confidence: 0.6,
    title: `Session: ${s.request.slice(0, 100)}`,
    body,
    files: [],
    type: "session",
  };
}

function safeArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export async function retrieve(db: Database, opts: RetrieveOptions): Promise<ScoredItem[]> {
  const limit = opts.limit ?? 12;
  const halfLife = (opts.halfLifeDays ?? 21) * 86400000;
  const archivedClause = opts.includeArchived ? "" : "AND archived = 0";
  const typeClause = opts.types?.length ? `AND type IN (${opts.types.map(() => "?").join(",")})` : "";
  const sinceClause = opts.since ? "AND created_at >= ?" : "";
  const untilClause = opts.until ? "AND created_at <= ?" : "";
  const extra: (string | number)[] = [...(opts.types ?? [])];
  if (opts.since) extra.push(opts.since);
  if (opts.until) extra.push(opts.until);

  const ranks = new Map<string, number[]>();
  const push = (key: string, rank: number) => ranks.set(key, [...(ranks.get(key) ?? []), rank]);

  const q = ftsQuery(opts.query);
  if (q) {
    const obsHits = db
      .query<{ id: number }, (string | number)[]>(
        `SELECT o.id FROM observations_fts f JOIN observations o ON o.id = f.rowid
         WHERE observations_fts MATCH ? AND o.project_id = ? ${archivedClause} ${typeClause} ${sinceClause} ${untilClause}
         ORDER BY bm25(observations_fts, 3.0, 1.0, 2.0) LIMIT 60`,
      )
      .all(q, opts.projectId, ...extra);
    obsHits.forEach((h, i) => push(`observation:${h.id}`, i + 1));
    const sumHits = db
      .query<{ id: number }, (string | number)[]>(
        `SELECT s.id FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
         WHERE summaries_fts MATCH ? AND s.project_id = ? ${sinceClause} ${untilClause}
         ORDER BY bm25(summaries_fts) LIMIT 20`,
      )
      .all(q, opts.projectId, ...(opts.since ? [opts.since] : []), ...(opts.until ? [opts.until] : []));
    sumHits.forEach((h, i) => push(`summary:${h.id}`, i + 1));
  }

  const qv = opts.query.trim() ? await embedOne(opts.query) : null;
  if (qv) {
    const rows = db
      .query<{ id: number; embedding: Uint8Array | null }, (string | number)[]>(
        `SELECT id, embedding FROM observations WHERE project_id = ? AND embedding IS NOT NULL ${archivedClause} ${typeClause} ${sinceClause} ${untilClause}
         ORDER BY created_at DESC LIMIT 5000`,
      )
      .all(opts.projectId, ...extra);
    const sims = rows
      .map((r) => ({ id: r.id, s: cosine(qv, blobToFloats(r.embedding)!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 60);
    sims.forEach((h, i) => push(`observation:${h.id}`, i + 1));
    const srows = db
      .query<{ id: number; embedding: Uint8Array | null }, [string]>(
        "SELECT id, embedding FROM summaries WHERE project_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 1000",
      )
      .all(opts.projectId);
    srows
      .map((r) => ({ id: r.id, s: cosine(qv, blobToFloats(r.embedding)!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .forEach((h, i) => push(`summary:${h.id}`, i + 1));
  }

  // recency list always contributes so an empty query still returns the latest work
  const recentObs = db
    .query<{ id: number }, (string | number)[]>(
      `SELECT id FROM observations WHERE project_id = ? ${archivedClause} ${typeClause} ${sinceClause} ${untilClause} ORDER BY created_at DESC LIMIT 30`,
    )
    .all(opts.projectId, ...extra);
  recentObs.forEach((h, i) => push(`observation:${h.id}`, i + 1));
  const recentSum = db
    .query<{ id: number }, [string]>("SELECT id FROM summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT 5")
    .all(opts.projectId);
  recentSum.forEach((h, i) => push(`summary:${h.id}`, i + 1));

  const fused = rrf(ranks);
  const items: ScoredItem[] = [];
  const t = Date.now();
  for (const [key, base] of fused) {
    const [kind, idStr] = key.split(":");
    const id = Number(idStr);
    let item: ScoredItem | null = null;
    if (kind === "observation") {
      const o = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id);
      if (o) item = obsToItem(o);
    } else {
      const s = db.query<SummaryRow, [number]>("SELECT * FROM summaries WHERE id = ?").get(id);
      if (s) item = sumToItem(s);
    }
    if (!item) continue;
    const age = Math.max(0, t - item.created_at);
    const recency = Math.pow(0.5, age / halfLife);
    item.score = base * (0.5 + 0.5 * recency) * (0.5 + item.confidence);
    items.push(item);
  }
  items.sort((a, b) => b.score - a.score);

  if (!opts.tokenBudget) return items.slice(0, limit);
  const out: ScoredItem[] = [];
  let used = 0;
  for (const it of items) {
    const cost = estimateTokens(it.title + it.body) + 8;
    if (used + cost > opts.tokenBudget) continue;
    out.push(it);
    used += cost;
    if (out.length >= limit) break;
  }
  return out;
}

export function latestDigest(db: Database, projectId: string): string | null {
  const r = db
    .query<{ content: string }, [string]>("SELECT content FROM digests WHERE project_id = ? ORDER BY period_end DESC LIMIT 1")
    .get(projectId);
  return r?.content ?? null;
}

export function markShown(db: Database, ids: number[]): void {
  if (!ids.length) return;
  db.query(`UPDATE observations SET beta = beta + 0.15 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
}

export function markUsed(db: Database, ids: number[], weight = 1): void {
  if (!ids.length) return;
  db.query(`UPDATE observations SET alpha = alpha + ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(weight, ...ids);
}

export function markUnhelpful(db: Database, ids: number[], weight = 1): void {
  if (!ids.length) return;
  db.query(`UPDATE observations SET beta = beta + ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(weight, ...ids);
}
