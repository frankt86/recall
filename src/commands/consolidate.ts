import { enqueue, now, openDb } from "../db";
import type { CommandSpec } from "./args";

export const consolidate: CommandSpec<{ now?: boolean }> = {
  name: "consolidate",
  summary: "queue a digest pass for old observations",
  options: { now: { type: "boolean", help: "also run the queue immediately" } },
  async run(o) {
    const db = openDb();
    enqueue(db, "consolidate", Math.floor(now() / 1000));
    if (o.now) {
      const { drain } = await import("../processor");
      const n = await drain(db, { quiet: false });
      console.log(`processed ${n} job(s)`);
    } else console.log("consolidation queued; run 'recall process' to execute");
  },
};
