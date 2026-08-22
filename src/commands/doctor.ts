import { join } from "node:path";
import { existsSync } from "node:fs";
import { openDb } from "../db";
import { COMPILED, embeddingsAvailable } from "../embed";
import { dataDir, loadSettings, settingsPath } from "../settings";
import type { CommandSpec } from "./args";
import { lastError } from "../log";
import { STALE_PENDING_MS } from "./status";

export interface Check { name: string; ok: boolean; detail: string; warn?: boolean }

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ name: "bun", ok: true, detail: `${Bun.version} (${process.execPath})` });
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..", "..");
  const mirror = join(pluginRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  checks.push({ name: "runtime", ok: true, warn: !existsSync(mirror), detail: existsSync(mirror) ? mirror : `${mirror} missing; MCP server cannot start until a hook runs (bash bin/bun.sh --ensure)` });
  checks.push({ name: "data dir", ok: existsSync(dataDir()), detail: dataDir() });
  let s;
  try {
    s = loadSettings();
    checks.push({ name: "settings", ok: true, detail: settingsPath() });
  } catch (e) {
    checks.push({ name: "settings", ok: false, detail: `${settingsPath()}: ${(e as Error).message}` });
  }
  try {
    const db = openDb();
    const jm = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode;
    const fts = db.query("SELECT 1 FROM sqlite_master WHERE name = 'observations_fts'").get();
    checks.push({ name: "db", ok: jm === "wal" && !!fts, detail: `journal=${jm}${fts ? ", fts5 ok" : ", FTS5 MISSING"}` });
    const stale = db.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM jobs WHERE status = 'pending' AND created_at < ?").get(Date.now() - STALE_PENDING_MS)!.n;
    const failed = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM jobs WHERE status = 'failed'").get()!.n;
    const err = lastError();
    checks.push({
      name: "queue",
      ok: stale === 0,
      warn: failed > 0,
      detail: stale ? `${stale} job(s) pending >1h; background processor not running. Try 'recall process'` : failed ? `${failed} failed job(s); last: ${err ?? "?"}` : "healthy",
    });
  } catch (e) {
    checks.push({ name: "db", ok: false, detail: (e as Error).message });
  }
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const llm = s?.llm ?? "auto";
  checks.push({ name: "llm", ok: true, detail: `${llm}, model ${s?.model ?? "?"}${hasKey ? " (api key present)" : " (no api key -> claude cli)"}` });
  if (llm === "cli" || (llm === "auto" && !hasKey)) {
    let detail = "not found on PATH";
    let ok = false;
    try {
      const p = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (p.exitCode === 0) { ok = true; detail = p.stdout.toString().trim(); }
    } catch { /* not found */ }
    checks.push({ name: "claude cli", ok, detail: ok ? detail : `${detail}; set ANTHROPIC_API_KEY or install Claude Code` });
  }
  const emb = await embeddingsAvailable();
  checks.push({ name: "embeddings", ok: true, warn: !emb, detail: emb ? "ready" : COMPILED ? "off in the standalone binary (FTS5 only); hooks run under bun and keep embeddings" : "unavailable, FTS5 only (bun add @huggingface/transformers)" });
  return checks;
}

export const doctor: CommandSpec<{ json?: boolean }> = {
  name: "doctor",
  summary: "environment check; exit 1 if anything is broken",
  options: { json: { type: "boolean", help: "machine-readable output" } },
  async run(o) {
    const checks = await runChecks();
    const bad = checks.filter((c) => !c.ok);
    if (o.json) console.log(JSON.stringify({ ok: !bad.length, checks }, null, 2));
    else {
      const w = Math.max(...checks.map((c) => c.name.length));
      for (const c of checks) console.log(`${c.ok ? (c.warn ? "warn" : " ok ") : "FAIL"}  ${c.name.padEnd(w)}  ${c.detail}`);
    }
    if (bad.length) process.exitCode = 1;
  },
};
