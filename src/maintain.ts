// Periodic maintenance against context rot: retire memory that has stopped earning its place, cap active memory
// per project, fold near-duplicates, prune the graph, and drop stale bookkeeping. Pinned and hand-written
// observations are never auto-retired.
import type { Database } from "bun:sqlite";
import { blobToFloats, now, setMeta, type ObservationRow } from "./db";
import { cosine } from "./embed";
import { pruneGraph } from "./graph";
import { loadSettings, type Settings } from "./settings";

export interface MaintainStats {
  at: number;
  retired: number;
  capped: number;
  deduped: number;
  graphEntities: number;
  graphEdges: number;
  jobsDeleted: number;
  contextLogsDeleted: number;
}

const PROTECTED = "pinned = 0 AND source NOT IN ('manual', 'import')";

// Shown at least three times (beta grew by 0.15 per injection) and never once marked useful, or low confidence.
function retire(db: Database, s: Settings): number {
  const cutoff = now() - s.retireAfterDays * 86400000;
  return db.query(
    `UPDATE observations SET archived = 1 WHERE archived = 0 AND ${PROTECTED} AND created_at < ?
       AND ((alpha <= 1.0 AND beta >= 1.45) OR (alpha / (alpha + beta)) < 0.4)`,
  ).run(cutoff).changes;
}

// Hard ceiling per project: archive the weakest (confidence x recency) beyond `maxActivePerProject`.
function cap(db: Database, s: Settings): number {
  let n = 0;
  const t = now();
  const projects = db.query<{ project_id: string; c: number }, [number]>("SELECT project_id, COUNT(*) c FROM observations WHERE archived = 0 GROUP BY project_id HAVING c > ?").all(s.maxActivePerProject);
  for (const p of projects) {
    const rows = db
      .query<{ id: number; alpha: number; beta: number; created_at: number }, [string]>(`SELECT id, alpha, beta, created_at FROM observations WHERE archived = 0 AND project_id = ? AND ${PROTECTED}`)
      .all(p.project_id)
      .map((r) => ({ id: r.id, score: (r.alpha / (r.alpha + r.beta)) * Math.pow(0.5, Math.max(0, t - r.created_at) / (21 * 86400000)) }))
      .sort((a, b) => a.score - b.score);
    const excess = p.c - s.maxActivePerProject;
    const victims = rows.slice(0, excess).map((r) => r.id);
    if (victims.length) n += db.query(`UPDATE observations SET archived = 1 WHERE id IN (${victims.map(() => "?").join(",")})`).run(...victims).changes;
  }
  return n;
}

// Near-duplicate pairs by embedding: the older one is archived and points at the newer via superseded_by.
function dedupe(db: Database, s: Settings): number {
  let n = 0;
  const projects = db.query<{ project_id: string }, []>("SELECT DISTINCT project_id FROM observations WHERE archived = 0 AND embedding IS NOT NULL").all();
  for (const p of projects) {
    const rows = db
      .query<ObservationRow, [string]>("SELECT * FROM observations WHERE archived = 0 AND embedding IS NOT NULL AND project_id = ? ORDER BY created_at DESC LIMIT 600")
      .all(p.project_id)
      .map((r) => ({ r, v: blobToFloats(r.embedding)! }));
    const gone = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      if (gone.has(rows[i].r.id)) continue;
      for (let j = i + 1; j < rows.length; j++) {
        const old = rows[j];
        if (gone.has(old.r.id) || old.r.pinned || old.r.source === "manual" || old.r.source === "import") continue;
        if (cosine(rows[i].v, old.v) >= s.dedupeThreshold) {
          db.query("UPDATE observations SET archived = 1, superseded_by = ? WHERE id = ?").run(rows[i].r.id, old.r.id);
          gone.add(old.r.id);
          n++;
        }
      }
    }
  }
  return n;
}

export function runMaintain(db: Database, settings = loadSettings()): MaintainStats {
  const stats: MaintainStats = { at: now(), retired: 0, capped: 0, deduped: 0, graphEntities: 0, graphEdges: 0, jobsDeleted: 0, contextLogsDeleted: 0 };
  db.transaction(() => {
    stats.retired = retire(db, settings);
    stats.deduped = dedupe(db, settings);
    stats.capped = cap(db, settings);
    const g = pruneGraph(db, { graceMs: 30 * 86400000, decay: settings.graphEdgeDecay });
    stats.graphEntities = g.entities;
    stats.graphEdges = g.edges;
    stats.jobsDeleted = db.query("DELETE FROM jobs WHERE status = 'done' AND created_at < ?").run(now() - 7 * 86400000).changes;
    stats.contextLogsDeleted = db.query("DELETE FROM context_log WHERE created_at < ?").run(now() - 90 * 86400000).changes;
    setMeta(db, "last_maintenance", JSON.stringify(stats));
  })();
  return stats;
}

export function lastMaintenance(db: Database): MaintainStats | null {
  const r = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("last_maintenance");
  try { return r ? (JSON.parse(r.value) as MaintainStats) : null; } catch { return null; }
}
