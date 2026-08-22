import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { now, openDb, pendingCount } from "../db";
import { ensureSession, guardInternal, readHookInput, spawnProcessor } from "../hook-io";

guardInternal();
import { resolveProject } from "../project";
import { estimateTokens, latestDigest, markShown, retrieve } from "../retrieve";
import { loadSettings } from "../settings";

const input = await readHookInput();
const db = openDb();
const s = loadSettings();
const cwd = input.cwd || process.cwd();
const { sessionId, projectId } = ensureSession(db, input);
const proj = resolveProject(cwd);

// Query signal: branch name plus recently modified source files (cheap, no git exec)
function recentFiles(root: string): string[] {
  const out: Array<{ p: string; m: number }> = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next"]);
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length > 4000) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (skip.has(e) || e.startsWith(".")) continue;
      const full = join(dir, e);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, depth + 1);
        else if (st.size < 2_000_000) out.push({ p: full.slice(root.length + 1), m: st.mtimeMs });
      } catch { /* ignore */ }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out.sort((a, b) => b.m - a.m).slice(0, 8).map((f) => f.p);
}

const files = recentFiles(proj.root);
const query = [proj.branch ?? "", ...files.map((f) => f.replace(/[\/\\._\-]+/g, " "))].join(" ");

const items = await retrieve(db, { projectId, query, limit: s.contextMaxItems, tokenBudget: s.contextTokenBudget });
const digest = latestDigest(db, projectId);
const pending = pendingCount(db);

const lines: string[] = [];
if (items.length || digest) {
  lines.push(`<recall project="${proj.name}"${proj.branch ? ` branch="${proj.branch}"` : ""}>`);
  lines.push("Memory from earlier sessions on this project. Use the recall MCP tools (search, timeline, get_observations) to dig deeper; call recall feedback when an item was useful or wrong.");
  if (digest) {
    lines.push("", "## Project digest", digest.slice(0, 1800));
  }
  if (items.length) {
    lines.push("", "## Relevant recent memory");
    for (const it of items) {
      const d = new Date(it.created_at).toISOString().slice(0, 10);
      const tag = it.kind === "observation" ? `#${it.id}` : `session`;
      lines.push(`- [${d}] [${it.type}] ${tag} ${it.title}`);
      const body = it.body.split("\n").slice(0, 3).join(" ").slice(0, 320);
      lines.push(`  ${body}`);
    }
  }
  if (pending) lines.push("", `(${pending} memory jobs still processing in the background)`);
  lines.push("</recall>");
}
markShown(db, items.filter((i) => i.kind === "observation").map((i) => i.id));
if (lines.length) {
  const text = lines.join("\n");
  db.query("INSERT INTO context_log(session_id, project_id, query, items, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    sessionId, projectId, query.trim().slice(0, 500),
    JSON.stringify(items.map((i) => ({ kind: i.kind, id: i.id, title: i.title, score: Number(i.score.toFixed(4)) }))),
    estimateTokens(text), now(),
  );
}
db.close();
if (pending) spawnProcessor();
if (lines.length) process.stdout.write(lines.join("\n") + "\n");
