import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { now } from "./db";

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  remote: string | null;
  branch: string | null;
}

function findGitDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    const g = join(dir, ".git");
    if (existsSync(g)) return g;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readGitRemote(gitDir: string): string | null {
  try {
    let cfgPath = join(gitDir, "config");
    if (!existsSync(cfgPath)) {
      // worktree: .git is a file pointing at the real gitdir
      const content = readFileSync(gitDir, "utf8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const real = m[1].replace(/[\\/]worktrees[\\/].*$/, "");
      cfgPath = join(real, "config");
    }
    const cfg = readFileSync(cfgPath, "utf8");
    const origin = cfg.match(/\[remote "origin"\][^\[]*?url\s*=\s*(.+)/);
    if (origin) return normalizeRemote(origin[1].trim());
    const any = cfg.match(/\[remote "[^"]+"\][^\[]*?url\s*=\s*(.+)/);
    return any ? normalizeRemote(any[1].trim()) : null;
  } catch {
    return null;
  }
}

function readGitBranch(gitDir: string): string | null {
  try {
    let head = join(gitDir, "HEAD");
    if (!existsSync(head)) {
      const content = readFileSync(gitDir, "utf8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      head = join(m[1], "HEAD");
    }
    const h = readFileSync(head, "utf8").trim();
    const m = h.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : h.slice(0, 12);
  } catch {
    return null;
  }
}

export function normalizeRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^git@([^:]+):/, "$1/");
  u = u.replace(/^(https?|ssh|git):\/\//, "");
  u = u.replace(/^[^@]+@/, "");
  u = u.replace(/\.git$/, "");
  u = u.replace(/\/+$/, "");
  return u.toLowerCase();
}

export function resolveProject(cwd: string): ProjectInfo {
  const gitDir = findGitDir(cwd);
  const root = gitDir ? dirname(gitDir) : cwd;
  const remote = gitDir ? readGitRemote(gitDir) : null;
  const branch = gitDir ? readGitBranch(gitDir) : null;
  const key = remote ?? `path:${root.replace(/\\/g, "/").toLowerCase()}`;
  const id = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const name = remote ? remote.split("/").slice(-2).join("/") : basename(root);
  return { id, name, root, remote, branch };
}

export function ensureProject(db: Database, p: ProjectInfo): void {
  db.query(
    `INSERT INTO projects(id, name, root_path, remote, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path`,
  ).run(p.id, p.name, p.root, p.remote, now());
}

// Query signal for retrieval: branch name plus recently modified source files (cheap, no git exec).
export function recentFiles(root: string): string[] {
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

export function recentFilesQuery(root: string, branch: string | null): string {
  return [branch ?? "", ...recentFiles(root).map((f) => f.replace(/[\/\\._\-]+/g, " "))].join(" ");
}
