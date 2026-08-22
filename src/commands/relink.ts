import { createHash } from "node:crypto";
import { now, openDb } from "../db";
import { normalizeRemote } from "../project";
import type { CommandSpec } from "./args";

export const relink: CommandSpec<{ legacy: string; remote: string }> = {
  name: "relink",
  summary: "merge a migrated name-keyed project into a git-remote-keyed one",
  options: {
    legacy: { type: "string", help: "legacy project name (as shown by status)", required: true },
    remote: { type: "string", help: "git remote url of the real project", required: true },
  },
  run(o) {
    const db = openDb();
    const oldId = createHash("sha1").update(`legacy:${o.legacy.toLowerCase()}`).digest("hex").slice(0, 16);
    if (!db.query("SELECT 1 FROM projects WHERE id = ?").get(oldId)) throw new Error(`no legacy project named ${o.legacy}`);
    const norm = normalizeRemote(o.remote);
    const newId = createHash("sha1").update(norm).digest("hex").slice(0, 16);
    db.query("INSERT OR IGNORE INTO projects(id, name, root_path, remote, created_at) VALUES (?, ?, ?, ?, ?)").run(newId, norm.split("/").slice(-2).join("/"), "", norm, now());
    let moved = 0;
    db.transaction(() => {
      for (const t of ["observations", "summaries", "digests", "sessions"]) moved += db.query(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(newId, oldId).changes;
      db.query("DELETE FROM projects WHERE id = ?").run(oldId);
    })();
    console.log(`relinked ${o.legacy} -> ${newId} (${moved} rows)`);
  },
};
