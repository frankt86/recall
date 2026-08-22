import { openDb, pendingCount } from "../db";
import { embeddingsAvailable } from "../embed";
import { dbPath } from "../settings";
import { lastError, logPath } from "../log";
import type { CommandSpec } from "./args";

const STALE_MS = 10 * 60 * 1000;
export const STALE_PENDING_MS = 60 * 60 * 1000;

export interface StatusReport {
  db: string;
  counts: { observations: number; summaries: number; digests: number; sessions: number; events: number };
  jobs: Record<string, number>;
  stuck: number;
  stalePending: number;
  lastError: string | null;
  log: string;
  failed: Array<{ id: number; kind: string; ref_id: number; error: string | null }>;
  embeddings: boolean;
  projects: Array<{ id: string; name: string; observations: number }>;
}

export async function collectStatus(): Promise<StatusReport> {
  const db = openDb();
  const counts = db
    .query<StatusReport["counts"], []>(
      `SELECT (SELECT COUNT(*) FROM observations) observations, (SELECT COUNT(*) FROM summaries) summaries,
              (SELECT COUNT(*) FROM digests) digests, (SELECT COUNT(*) FROM sessions) sessions, (SELECT COUNT(*) FROM events) events`,
    )
    .get()!;
  const jobs: Record<string, number> = {};
  for (const j of db.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all()) jobs[j.status] = j.n;
  const stuck = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM jobs WHERE status = 'processing' AND claimed_at < ?")
    .get(Date.now() - STALE_MS)!.n;
  const stalePending = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) n FROM jobs WHERE status = 'pending' AND created_at < ?")
    .get(Date.now() - STALE_PENDING_MS)!.n;
  const failed = db
    .query<StatusReport["failed"][number], []>("SELECT id, kind, ref_id, error FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 5")
    .all();
  const projects = db
    .query<StatusReport["projects"][number], []>(
      "SELECT p.id, p.name, COUNT(o.id) observations FROM projects p LEFT JOIN observations o ON o.project_id = p.id GROUP BY p.id ORDER BY observations DESC, p.name LIMIT 15",
    )
    .all();
  void pendingCount;
  return { db: dbPath(), counts, jobs, stuck, stalePending, lastError: lastError(), log: logPath(), failed, embeddings: await embeddingsAvailable(), projects };
}

export const status: CommandSpec<{ json?: boolean }> = {
  name: "status",
  summary: "counts, queue, failures",
  options: { json: { type: "boolean", help: "machine-readable output" } },
  async run(o) {
    const r = await collectStatus();
    if (o.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const c = r.counts;
    console.log(`db: ${r.db}`);
    console.log(`observations ${c.observations}  summaries ${c.summaries}  digests ${c.digests}  sessions ${c.sessions}  buffered events ${c.events}`);
    const jobs = Object.entries(r.jobs).map(([k, v]) => `${k}=${v}`).join("  ") || "none";
    console.log(`jobs: ${jobs}${r.stuck ? `  (${r.stuck} stuck >10min, will be reclaimed)` : ""}`);
    if (r.stalePending) console.log(`  ${r.stalePending} job(s) pending for over an hour: the background processor is not running. Run 'recall process' and check 'recall doctor'.`);
    for (const f of r.failed) console.log(`  failed ${f.kind}#${f.ref_id} (job ${f.id}): ${f.error ?? ""}`);
    if (r.lastError) console.log(`last error: ${r.lastError}`);
    console.log(`log: ${r.log}`);
    console.log(`embeddings: ${r.embeddings ? "on" : "off (FTS5 only)"}`);
    for (const p of r.projects) console.log(`  ${p.name}: ${p.observations}`);
  },
};
