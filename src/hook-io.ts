import { join } from "node:path";
import { env } from "./settings";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { now } from "./db";
import { ensureProject, resolveProject } from "./project";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
}

/** Hooks must be inert inside our own `claude -p` calls, otherwise each LLM call spawns a new session (infinite recursion). */
export function guardInternal(): void {
  if (env("INTERNAL") === "1") process.exit(0);
}

export async function readHookInput(): Promise<HookInput> {
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

export function pluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..");
}

export function ensureSession(db: Database, input: HookInput): { sessionId: number; projectId: string } {
  const cwd = input.cwd || process.cwd();
  const claudeId = input.session_id || `anon-${cwd}`;
  const existing = db
    .query<{ id: number; project_id: string }, [string]>("SELECT id, project_id FROM sessions WHERE claude_session_id = ?")
    .get(claudeId);
  if (existing) return { sessionId: existing.id, projectId: existing.project_id };
  const p = resolveProject(cwd);
  ensureProject(db, p);
  const r = db
    .query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES (?, ?, ?, ?)")
    .run(claudeId, p.id, cwd, now());
  return { sessionId: Number(r.lastInsertRowid), projectId: p.id };
}

export function spawnProcessor(): void {
  if (env("NO_SPAWN") === "1") return;
  const script = join(pluginRoot(), "src", "processor.ts");
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CLAUDECODE" && k !== "CLAUDE_CODE_ENTRYPOINT") childEnv[k] = v;
  }
  try {
    // node:child_process with detached:true survives the parent hook exiting on Windows; Bun.spawn+unref does not.
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: childEnv,
      cwd: pluginRoot(),
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // processor will be retried by the next hook
  }
}

export function log(msg: string): void {
  if (env("DEBUG") === "1") process.stderr.write(`[recall] ${msg}\n`);
}
