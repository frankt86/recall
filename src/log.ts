import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, env } from "./settings";

export const LOG_MAX = 200;

export function logPath(): string {
  return join(dataDir(), "processor.log");
}

/** Append one timestamped line; keep the file to the last LOG_MAX lines. No daemon, so this is the only trace of background work. */
export function appendLog(msg: string): void {
  const p = logPath();
  const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
  try {
    appendFileSync(p, line);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (lines.length > LOG_MAX * 2) writeFileSync(p, lines.slice(-LOG_MAX).join("\n") + "\n");
  } catch {
    /* logging must never break the processor */
  }
  if (env("DEBUG") === "1") process.stderr.write(`[recall] ${msg}\n`);
}

export function lastError(): string | null {
  const p = logPath();
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").trim().split("\n").reverse();
  const hit = lines.find((l) => / failed: /.test(l));
  return hit ?? null;
}
