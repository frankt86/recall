import { Database } from "bun:sqlite";
import { blobToFloats, type ObservationRow, type SummaryRow } from "./db";
import { cosine, embedOne } from "./embed";
import { graphHits } from "./graph";

export type ItemKind = "observation" | "summary" | "digest";

// Rank each retrieval list gave the item (1 = best); absent when the list did not return it.
export interface Why {
  fts?: number;
  vec?: number;
  graph?: number;
  recent?: number;
  recency: number;
  confidence: number;
  importance?: number;
}

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
  pinned: boolean;
  importance: number;
  why: Why;
}

export interface RetrieveResult {
  items: ScoredItem[];
  skippedPinned: number[];
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
    pinned: !!o.pinned,
    importance: o.importance ?? 3,
    why: { recency: 1, confidence: o.alpha / (o.alpha + o.beta) },
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
    pinned: false,
    importance: 3,
    why: { recency: 1, confidence: 0.6 },
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
  return (await retrieveWithSkipped(db, opts)).items;
}

type ListName = "fts" | "vec" | "graph" | "recent";
const RECENT_ONLY_MAX = 3;

export async function retrieveWithSkipped(db: Database, opts: RetrieveOptions): Promise<RetrieveResult> {
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
  const why = new Map<string, Partial<Record<ListName, number>>>();
  const push = (key: string, rank: number, list: ListName) => {
    ranks.set(key, [...(ranks.get(key) ?? []), rank]);
    why.set(key, { ...(why.get(key) ?? {}), [list]: Math.min(rank, why.get(key)?.[list] ?? Infinity) });
  };

  const q = ftsQuery(opts.query);
  if (q) {
    const obsHits = db
      .query<{ id: number }, (string | number)[]>(
        `SELECT o.id FROM observations_fts f JOIN observations o ON o.id = f.rowid
         WHERE observations_fts MATCH ? AND o.project_id = ? ${archivedClause} ${typeClause} ${sinceClause} ${untilClause}
         ORDER BY bm25(observations_fts, 3.0, 1.0, 2.0) LIMIT 60`,
      )
      .all(q, opts.projectId, ...extra);
    obsHits.forEach((h, i) => push(`observation:${h.id}`, i + 1, "fts"));
    const sumHits = db
      .query<{ id: number }, (string | number)[]>(
        `SELECT s.id FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
         WHERE summaries_fts MATCH ? AND s.project_id = ? ${sinceClause} ${untilClause}
         ORDER BY bm25(summaries_fts) LIMIT 20`,
      )
      .all(q, opts.projectId, ...(opts.since ? [opts.since] : []), ...(opts.until ? [opts.until] : []));
    sumHits.forEach((h, i) => push(`summary:${h.id}`, i + 1, "fts"));
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
    sims.forEach((h, i) => push(`observation:${h.id}`, i + 1, "vec"));
    const srows = db
      .query<{ id: number; embedding: Uint8Array | null }, [string]>(
        "SELECT id, embedding FROM summaries WHERE project_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 1000",
      )
      .all(opts.projectId);
    srows
      .map((r) => ({ id: r.id, s: cosine(qv, blobToFloats(r.embedding)!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .forEach((h, i) => push(`summary:${h.id}`, i + 1, "vec"));
  }

  // knowledge-graph list: observations attached to entities the query names
  if (opts.query.trim()) {
    const hits = graphHits(db, opts.projectId, opts.query, !!opts.includeArchived);
    const allowed = opts.types?.length || opts.since || opts.until
      ? new Set(db.query<{ id: number }, (string | number)[]>(`SELECT id FROM observations WHERE project_id = ? ${archivedClause} ${typeClause} ${sinceClause} ${untilClause}`).all(opts.projectId, ...extra).map((r) => r.id))
      : null;
    hits.filter((id) => !allowed || allowed.has(id)).forEach((id, i) => push(`observation:${id}`, i + 1, "graph"));
  }

  // recency list always contributes so an empty query still returns the latest work
  const recentObs = db
    .query<{ id: number }, (string | number)[]>(
      `SELECT id FROM observations WHERE project_id = ? ${archivedClause} ${typeClause} ${sinceClause} ${untilClause} ORDER BY created_at DESC LIMIT 30`,
    )
    .all(opts.projectId, ...extra);
  recentObs.forEach((h, i) => push(`observation:${h.id}`, i + 1, "recent"));
  const recentSum = db
    .query<{ id: number }, [string]>("SELECT id FROM summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT 5")
    .all(opts.projectId);
  recentSum.forEach((h, i) => push(`summary:${h.id}`, i + 1, "recent"));

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
    // relevance (fused rank) x recency x confidence x importance (1..5 -> 0.8..1.2), after Park et al. 2023
    item.score = base * (0.5 + 0.5 * recency) * (0.5 + item.confidence) * (0.7 + 0.1 * item.importance);
    item.why = { ...(why.get(key) ?? {}), recency, confidence: item.confidence, importance: item.importance };
    items.push(item);
  }
  items.sort((a, b) => b.score - a.score);

  // Pinned observations always lead (newest first); they are exempt from `limit` but not from the token budget.
  const pinnedRows = opts.includeArchived
    ? db.query<ObservationRow, (string | number)[]>(`SELECT * FROM observations WHERE project_id = ? AND pinned = 1 ${typeClause} ORDER BY created_at DESC`).all(opts.projectId, ...(opts.types ?? []))
    : db.query<ObservationRow, (string | number)[]>(`SELECT * FROM observations WHERE project_id = ? AND pinned = 1 AND archived = 0 ${typeClause} ORDER BY created_at DESC`).all(opts.projectId, ...(opts.types ?? []));
  const pinnedIds = new Set(pinnedRows.map((r) => r.id));
  const pinnedItems = pinnedRows.map((r) => {
    const it = obsToItem(r);
    const scored = items.find((i) => i.kind === "observation" && i.id === r.id);
    it.score = scored ? scored.score : 0;
    it.why = scored ? scored.why : it.why;
    return it;
  });
  // Relevance gate: with a real query, items that only matched by recency are filler; allow at most RECENT_ONLY_MAX of them
  // so a session with little relevant memory injects less rather than the same amount.
  let recentOnly = 0;
  const rest = items.filter((i) => {
    if (i.kind === "observation" && pinnedIds.has(i.id)) return false;
    if (!q && !qv) return true;
    const w = i.why;
    if (w.fts || w.vec || w.graph) return true;
    return ++recentOnly <= RECENT_ONLY_MAX;
  });

  if (!opts.tokenBudget) return { items: [...pinnedItems, ...rest.slice(0, limit)], skippedPinned: [] };
  const out: ScoredItem[] = [];
  const skippedPinned: number[] = [];
  let used = 0;
  for (const it of pinnedItems) {
    const cost = estimateTokens(it.title + it.body) + 8;
    if (used + cost > opts.tokenBudget) { skippedPinned.push(it.id); continue; }
    out.push(it);
    used += cost;
  }
  let n = 0;
  for (const it of rest) {
    const cost = estimateTokens(it.title + it.body) + 8;
    if (used + cost > opts.tokenBudget) continue;
    out.push(it);
    used += cost;
    if (++n >= limit) break;
  }
  return { items: out, skippedPinned };
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
