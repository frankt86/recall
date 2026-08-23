// Knowledge graph: entities (files, symbols, commands, libraries, concepts) and weighted relations between them,
// extracted automatically from every observation and kept in sync with what is still active memory.
import type { Database } from "bun:sqlite";
import { now, type ObservationRow } from "./db";

export type EntityKind = "file" | "symbol" | "command" | "library" | "concept";
export const ENTITY_KINDS: EntityKind[] = ["file", "symbol", "command", "library", "concept"];
export const RELS = ["uses", "calls", "defines", "configures", "depends_on", "fixes", "relates_to", "co_occurs"] as const;

export interface EntityIn { name: string; kind: EntityKind }
export interface RelationIn { from: string; to: string; rel: string }

const MAX_ENTITIES_PER_OBS = 14;
const COMMANDS = new Set(["bun", "uv", "uvx", "cargo", "git", "gh", "npm", "npx", "pnpm", "pip", "python", "node", "docker", "recall", "claude", "make", "pytest", "rustup", "powershell", "pwsh"]);
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "true", "false", "null", "none", "string", "number", "int", "str", "bool", "json", "yes", "no", "todo", "ok", "id"]);

export function normalizeName(name: string, kind: EntityKind): string {
  let n = name.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  if (kind === "file") n = n.replace(/\\/g, "/").replace(/^\.\//, "");
  if (kind === "symbol") n = n.replace(/\(\)$/, "");
  if (kind === "command") n = n.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
  if (kind === "library" || kind === "concept") n = n.toLowerCase();
  return n.slice(0, 120);
}

const looksLikeFile = (t: string) => /^[\w.@-]+(\/[\w.@-]+)+$/.test(t) || /\.[a-z]{1,5}$/i.test(t) && !t.includes(" ") && t.length > 3;
const looksLikeSymbol = (t: string) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/.test(t) && t.length > 2 && !STOP.has(t.toLowerCase());

// Cheap, LLM-free extraction so the graph works in every mode (including fake/offline).
export function extractDeterministic(o: { title: string; narrative: string; facts: string[]; files: string[] }): EntityIn[] {
  const out = new Map<string, EntityIn>();
  const add = (name: string, kind: EntityKind) => {
    const n = normalizeName(name, kind);
    if (!n || STOP.has(n.toLowerCase())) return;
    const key = `${kind}:${n}`;
    if (!out.has(key) && out.size < MAX_ENTITIES_PER_OBS) out.set(key, { name: n, kind });
  };
  for (const f of o.files) add(f, "file");
  const text = [o.title, o.narrative, ...o.facts].join("\n");
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const t = m[1].trim();
    const first = t.split(/\s+/)[0].toLowerCase();
    if (COMMANDS.has(first)) add(t, "command");
    else if (looksLikeFile(t)) add(t, "file");
    else if (looksLikeSymbol(t)) add(t, "symbol");
  }
  for (const m of text.matchAll(/\b([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\(\)/g)) add(m[1], "symbol");
  for (const m of text.matchAll(/(?:^|[\s(])((?:src|tests?|lib|app|bin|docs)\/[\w./-]+\.[a-z]{1,5})\b/g)) add(m[1], "file");
  return [...out.values()];
}

export function upsertEntity(db: Database, projectId: string, e: EntityIn, t = now()): number {
  const name = normalizeName(e.name, e.kind);
  const kind = ENTITY_KINDS.includes(e.kind) ? e.kind : "concept";
  db.query(
    `INSERT INTO entities(project_id, name, kind, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, name, kind) DO UPDATE SET last_seen = MAX(entities.last_seen, excluded.last_seen)`,
  ).run(projectId, name, kind, t, t);
  return db.query<{ id: number }, [string, string, string]>("SELECT id FROM entities WHERE project_id = ? AND name = ? AND kind = ?").get(projectId, name, kind)!.id;
}

function bumpEdge(db: Database, projectId: string, src: number, dst: number, rel: string, t: number, w = 1): void {
  if (src === dst) return;
  const [a, b] = rel === "co_occurs" && src > dst ? [dst, src] : [src, dst];
  db.query(
    `INSERT INTO edges(project_id, src, dst, rel, weight, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(src, dst, rel) DO UPDATE SET weight = edges.weight + excluded.weight, last_seen = MAX(edges.last_seen, excluded.last_seen)`,
  ).run(projectId, a, b, rel, w, t);
}

// Link one observation to its entities and record relations. Idempotent: relinking replaces the observation's links.
export function linkObservation(db: Database, o: ObservationRow, llmEntities: EntityIn[] = [], relations: RelationIn[] = []): number {
  const facts = safeArr(o.facts);
  const files = safeArr(o.files);
  const ents = new Map<string, EntityIn>();
  for (const e of [...extractDeterministic({ title: o.title, narrative: o.narrative, facts, files }), ...llmEntities]) {
    if (!e?.name || typeof e.name !== "string") continue;
    const kind = ENTITY_KINDS.includes(e.kind) ? e.kind : "concept";
    const name = normalizeName(e.name, kind);
    if (!name) continue;
    const key = `${kind}:${name}`;
    if (!ents.has(key) && ents.size < MAX_ENTITIES_PER_OBS) ents.set(key, { name, kind });
  }
  const t = o.created_at || now();
  const ids = new Map<string, number>(); // name (lowercase, any kind) -> id, for relation resolution
  db.transaction(() => {
    db.query("DELETE FROM observation_entities WHERE observation_id = ?").run(o.id);
    for (const e of ents.values()) {
      const id = upsertEntity(db, o.project_id, e, t);
      ids.set(e.name.toLowerCase(), id);
      db.query("INSERT OR IGNORE INTO observation_entities(observation_id, entity_id) VALUES (?, ?)").run(o.id, id);
    }
    const all = [...ids.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) bumpEdge(db, o.project_id, all[i], all[j], "co_occurs", t, 0.5);
    for (const r of relations) {
      if (!r?.from || !r?.to) continue;
      const rel = (RELS as readonly string[]).includes(r.rel) ? r.rel : "relates_to";
      const a = ids.get(normalizeName(r.from, "concept")) ?? ids.get(r.from.toLowerCase());
      const b = ids.get(normalizeName(r.to, "concept")) ?? ids.get(r.to.toLowerCase());
      if (a && b) bumpEdge(db, o.project_id, a, b, rel, t, 1);
    }
  })();
  return ents.size;
}

// Rebuild links for every active observation of a project (or all) using deterministic extraction only.
export function relinkAll(db: Database, projectId?: string): number {
  const rows = projectId
    ? db.query<ObservationRow, [string]>("SELECT * FROM observations WHERE archived = 0 AND project_id = ?").all(projectId)
    : db.query<ObservationRow, []>("SELECT * FROM observations WHERE archived = 0").all();
  let n = 0;
  for (const o of rows) n += linkObservation(db, o) ? 1 : 0;
  return n;
}

export interface GraphNode { id: number; name: string; kind: EntityKind; mentions: number; last_seen: number }
export interface GraphEdge { src: number; dst: number; rel: string; weight: number }

// The graph as seen through active memory: nodes are entities with at least `minMentions` live observations.
export function graph(db: Database, projectId: string, opts: { minMentions?: number; limit?: number; kinds?: string[]; q?: string } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const min = opts.minMentions ?? 1;
  const limit = Math.min(opts.limit ?? 150, 600);
  const kinds = opts.kinds?.length ? `AND e.kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
  const q = opts.q?.trim() ? "AND e.name LIKE ?" : "";
  const params: (string | number)[] = [projectId, ...(opts.kinds ?? []), ...(opts.q?.trim() ? [`%${opts.q.trim()}%`] : []), min, limit];
  const nodes = db
    .query<GraphNode, (string | number)[]>(
      `SELECT e.id, e.name, e.kind, COUNT(oe.observation_id) mentions, e.last_seen
       FROM entities e JOIN observation_entities oe ON oe.entity_id = e.id JOIN observations o ON o.id = oe.observation_id AND o.archived = 0
       WHERE e.project_id = ? ${kinds} ${q} GROUP BY e.id HAVING mentions >= ? ORDER BY mentions DESC, e.last_seen DESC LIMIT ?`,
    )
    .all(...params);
  if (!nodes.length) return { nodes: [], edges: [] };
  const ids = nodes.map((n) => n.id);
  const ph = ids.map(() => "?").join(",");
  const edges = db
    .query<GraphEdge, number[]>(`SELECT src, dst, rel, weight FROM edges WHERE src IN (${ph}) AND dst IN (${ph}) ORDER BY weight DESC LIMIT 2000`)
    .all(...ids, ...ids);
  return { nodes, edges };
}

export function entityObservations(db: Database, entityId: number): ObservationRow[] {
  return db
    .query<ObservationRow, [number]>(
      "SELECT o.* FROM observations o JOIN observation_entities oe ON oe.observation_id = o.id WHERE oe.entity_id = ? AND o.archived = 0 ORDER BY o.pinned DESC, o.created_at DESC LIMIT 100",
    )
    .all(entityId);
}

export function neighbors(db: Database, entityId: number): Array<GraphNode & { rel: string; weight: number }> {
  return db
    .query<GraphNode & { rel: string; weight: number }, [number, number, number]>(
      `SELECT e.id, e.name, e.kind, e.last_seen, x.rel, x.weight,
              (SELECT COUNT(*) FROM observation_entities oe JOIN observations o ON o.id = oe.observation_id AND o.archived = 0 WHERE oe.entity_id = e.id) mentions
       FROM edges x JOIN entities e ON e.id = CASE WHEN x.src = ? THEN x.dst ELSE x.src END
       WHERE x.src = ? OR x.dst = ? ORDER BY x.weight DESC LIMIT 40`,
    )
    .all(entityId, entityId, entityId);
}

// Retrieval helper: observations linked to entities whose names match query terms, most-linked first.
export function graphHits(db: Database, projectId: string, query: string, includeArchived = false, limit = 40): number[] {
  const terms = [...new Set(query.toLowerCase().split(/[^\w./-]+/).filter((t) => t.length > 2 && !STOP.has(t)))].slice(0, 16);
  if (!terms.length) return [];
  const like = terms.map(() => "LOWER(e.name) LIKE ?").join(" OR ");
  const rows = db
    .query<{ id: number; n: number }, (string | number)[]>(
      `SELECT o.id, COUNT(DISTINCT e.id) n FROM entities e
       JOIN observation_entities oe ON oe.entity_id = e.id JOIN observations o ON o.id = oe.observation_id
       WHERE e.project_id = ? AND (${like}) ${includeArchived ? "" : "AND o.archived = 0"}
       GROUP BY o.id ORDER BY n DESC, o.created_at DESC LIMIT ?`,
    )
    .all(projectId, ...terms.map((t) => `%${t}%`), limit);
  return rows.map((r) => r.id);
}

// Drop entities no longer attached to active memory (and older than `graceMs`); decay edge weights and drop the faint ones.
export function pruneGraph(db: Database, opts: { graceMs: number; decay: number; minWeight?: number }): { entities: number; edges: number } {
  const cutoff = now() - opts.graceMs;
  const entities = db.query(
    `DELETE FROM entities WHERE last_seen < ? AND id NOT IN (
       SELECT oe.entity_id FROM observation_entities oe JOIN observations o ON o.id = oe.observation_id WHERE o.archived = 0)`,
  ).run(cutoff).changes;
  db.query("UPDATE edges SET weight = weight * ?").run(opts.decay);
  const edges = db.query("DELETE FROM edges WHERE weight < ?").run(opts.minWeight ?? 0.4).changes;
  return { entities, edges };
}

function safeArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
