import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { floatsToBlob, now, openDb } from "../db";
import { embed } from "../embed";
import type { CommandSpec } from "./args";

async function runMigrate(src: string): Promise<void> {
  if (!existsSync(src)) throw new Error(`not found: ${src}`);
  let old: Database;
  try {
    old = new Database(src, { readonly: true });
    old.query("SELECT 1 FROM observations LIMIT 1").get();
    old.query("SELECT 1 FROM session_summaries LIMIT 1").get();
  } catch (e) {
    throw new Error(`${src} is not a claude-mem database: ${(e as Error).message}`);
  }
  const db = openDb();
  const projectId = (name: string) => {
    const id = createHash("sha1").update(`legacy:${name.toLowerCase()}`).digest("hex").slice(0, 16);
    db.query("INSERT OR IGNORE INTO projects(id, name, root_path, remote, created_at) VALUES (?, ?, ?, NULL, ?)").run(id, name, `legacy:${name}`, now());
    return id;
  };
  const sessionId = (memId: string, pid: string, started: number) => {
    const key = `legacy:${memId}`;
    const ex = db.query<{ id: number }, [string]>("SELECT id FROM sessions WHERE claude_session_id = ?").get(key);
    if (ex) return ex.id;
    const r = db.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at, summarized) VALUES (?, ?, NULL, ?, 1)").run(key, pid, started);
    return Number(r.lastInsertRowid);
  };
  type OldObs = { id: number; memory_session_id: string; project: string; text: string; type: string; created_at_epoch: number; title?: string; narrative?: string; facts?: string; files_modified?: string; files_read?: string };
  const obsRows = old.query<OldObs, []>("SELECT * FROM observations ORDER BY id").all();
  let n = 0;
  const batch: Array<{ row: OldObs; text: string }> = [];
  const insert = db.query(
    "INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at, embedding) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
  );
  const flush = async () => {
    if (!batch.length) return;
    const vecs = await embed(batch.map((b) => b.text));
    const tx = db.transaction(() => {
      batch.forEach((b, i) => {
        const o = b.row;
        const pid = projectId(o.project);
        const sid = sessionId(o.memory_session_id, pid, o.created_at_epoch);
        const files = [o.files_modified, o.files_read].flatMap((s) => {
          try { return s ? (JSON.parse(s) as string[]) : []; } catch { return s ? s.split(",").map((x) => x.trim()) : []; }
        });
        let facts: string[] = [];
        try { facts = o.facts ? (JSON.parse(o.facts) as string[]) : []; } catch { facts = []; }
        insert.run(pid, sid, o.type || "other", (o.title || o.text.split("\n")[0] || "observation").slice(0, 120), o.narrative || o.text, JSON.stringify(facts), JSON.stringify(files), o.created_at_epoch, vecs ? floatsToBlob(vecs[i]) : null);
      });
    });
    tx();
    n += batch.length;
    batch.length = 0;
  };
  for (const o of obsRows) {
    batch.push({ row: o, text: `${o.title ?? ""}\n${o.narrative ?? o.text}` });
    if (batch.length >= 64) await flush();
  }
  await flush();
  type OldSum = { memory_session_id: string; project: string; request: string; completed: string; learned: string; next_steps: string; created_at_epoch: number };
  const sums = old.query<OldSum, []>("SELECT * FROM session_summaries ORDER BY id").all();
  let m = 0;
  for (const s of sums) {
    const pid = projectId(s.project);
    const sid = sessionId(s.memory_session_id, pid, s.created_at_epoch);
    const v = await embed([`${s.request}\n${s.completed}\n${s.learned}`]);
    db.query("INSERT OR IGNORE INTO summaries(project_id, session_id, request, completed, learned, next_steps, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      pid, sid, s.request ?? "", s.completed ?? "", s.learned ?? "", s.next_steps ?? "", s.created_at_epoch, v ? floatsToBlob(v[0]) : null,
    );
    m++;
  }
  console.log(`migrated ${n} observations, ${m} summaries from ${src}`);
  console.log("legacy projects are keyed by name; new sessions key on git remote. Use 'recall relink --legacy <name> --remote <url>' to merge.");
}

export const migrate: CommandSpec<{ from?: string }> = {
  name: "migrate",
  summary: "one-time import from the third-party claude-mem plugin",
  options: { from: { type: "string", help: "path to the claude-mem sqlite file", required: true } },
  run: (o) => runMigrate(o.from!),
};
