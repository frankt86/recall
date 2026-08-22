import { openDb, pendingCount } from "../db";
import { drain } from "../processor";
import { UsageError, type CommandSpec } from "./args";

export const processCmd: CommandSpec<{ "dry-run"?: boolean; max?: string; retry?: boolean }> = {
  name: "process",
  summary: "drain the job queue now (foreground)",
  options: {
    "dry-run": { type: "boolean", help: "show pending work without running it" },
    max: { type: "string", help: "stop after N jobs" },
    retry: { type: "boolean", help: "re-queue failed jobs first" },
  },
  async run(o) {
    const db = openDb();
    const max = o.max === undefined ? undefined : Number(o.max);
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new UsageError(`--max must be a positive integer, got ${o.max}`, processCmd as CommandSpec);
    if (o.retry) {
      const r = db.query("UPDATE jobs SET status = 'pending', error = NULL, claimed_at = NULL WHERE status = 'failed'").run();
      console.log(`re-queued ${r.changes} failed job(s)`);
    }
    if (o["dry-run"]) {
      const rows = db.query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) n FROM jobs WHERE status = 'pending' GROUP BY kind").all();
      console.log(`${pendingCount(db)} pending${rows.length ? ": " + rows.map((r) => `${r.kind}=${r.n}`).join(", ") : ""}`);
      return;
    }
    const n = await drain(db, { quiet: false, maxJobs: max });
    const left = pendingCount(db);
    if (n === 0 && left > 0) console.log(`another processor holds the lock; ${left} pending`);
    else console.log(`processed ${n} job(s); ${left} remaining`);
  },
};
