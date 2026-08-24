import { now, openDb } from "../db";
import { ensureSession, guardInternal, readHookInput, spawnProcessor } from "../hook-io";

guardInternal();
import { recentFilesQuery, resolveProject } from "../project";
import { markShown } from "../retrieve";
import { buildSessionContext } from "../context";
import { ensureCliLink } from "../link";
import { dataDir, env, loadSettings } from "../settings";
import { pluginRoot } from "../hook-io";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Claude Code's Setup event never fires on plugin installs (it is a CI/--init-only thing), so the
// first SessionStart does the install-time work: a full `recall link` (which may add one guarded
// PATH line to the shell profile), recorded in a marker file. Every later session is repair-only
// (profile: false) so a user who deletes the profile line never has it silently re-added.
if (env("NO_LINK") !== "1") {
  try {
    const done = join(dataDir(), ".cli-linked");
    const first = !existsSync(done);
    const r = ensureCliLink(pluginRoot(), first ? {} : { profile: false });
    if (first && r.ok) writeFileSync(done, r.dir ?? "");
  } catch {
    // never let PATH maintenance break context injection
  }
}

const input = await readHookInput();
const db = openDb();
const s = loadSettings();
const cwd = input.cwd || process.cwd();
const { sessionId, projectId } = ensureSession(db, input);
const proj = resolveProject(cwd);

const query = recentFilesQuery(proj.root, proj.branch);

const ctx = await buildSessionContext(db, { projectId, projectName: proj.name, branch: proj.branch, query, settings: s });
const items = ctx.items;
markShown(db, items.filter((i) => i.kind === "observation").map((i) => i.id));
if (ctx.text) {
  db.query("INSERT INTO context_log(session_id, project_id, query, items, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    sessionId, projectId, query.trim().slice(0, 500),
    JSON.stringify(items.map((i) => ({ kind: i.kind, id: i.id, title: i.title, score: Number(i.score.toFixed(4)) }))),
    ctx.tokens, now(),
  );
}
db.close();
if (ctx.pending) spawnProcessor();
if (ctx.text) {
  process.stdout.write(ctx.text + "\n");
} else {
  // An empty database and a broken pipeline look identical when the hook is silent, so always say something.
  const pending = ctx.pending ? ` (${ctx.pending} memory job${ctx.pending === 1 ? "" : "s"} still processing — memories appear once they finish)` : "";
  process.stdout.write(`recall: no stored memories for ${proj.name} yet${pending}\n`);
}
