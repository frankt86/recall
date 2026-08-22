import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// bin/bun.sh must resolve a Bun without network when one is available, mirror it into the plugin
// for .mcp.json, and fail with a clear message (not hang or download) when told not to download.
const script = join(import.meta.dir, "..", "bin", "bun.sh");
const bash = Bun.which("bash")!;
const run = (args: string[], env: Record<string, string>) => {
  const p = Bun.spawnSync([bash, script, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const tmp = (n: string) => { const d = join(tmpdir(), `recall-bs-${n}-${process.pid}`); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

test("resolves the bun on PATH and mirrors it into the plugin", () => {
  const root = tmp("a"); mkdirSync(join(root, "src"));
  const r = run(["--ensure"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data") });
  expect(r.code).toBe(0);
  expect(r.out.length).toBeGreaterThan(0);
  const mirror = join(root, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  expect(existsSync(mirror)).toBe(true);
  // the mirror is runnable on its own, exactly how .mcp.json launches it
  expect(Bun.spawnSync([mirror, "--version"]).stdout.toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
  // second call prefers the mirror
  expect(run(["--print"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data") }).out.replaceAll("\\", "/")).toBe(mirror.replaceAll("\\", "/"));
  rmSync(root, { recursive: true, force: true });
});

test("RECALL_BUN override wins and is validated", () => {
  const root = tmp("b");
  expect(run(["--print"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data"), RECALL_BUN: process.execPath }).out.replaceAll("\\", "/")).toBe(process.execPath.replaceAll("\\", "/"));
  const bad = join(root, "notbun"); writeFileSync(bad, "");
  const r = run(["--print"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data"), RECALL_BUN: bad });
  expect(r.code).toBe(1);
  expect(r.err).toContain("not a working bun");
  rmSync(root, { recursive: true, force: true });
});

test("execs bun with arguments", () => {
  const root = tmp("c");
  const r = run(["-e", "console.log('hi', typeof Bun)"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data") });
  expect(r.out).toBe("hi object");
  rmSync(root, { recursive: true, force: true });
});

test("no bun anywhere + RECALL_NO_DOWNLOAD=1 fails fast with guidance", () => {
  const root = tmp("d");
  const r = run(["--print"], { CLAUDE_PLUGIN_ROOT: root, RECALL_DIR: join(root, "data"), HOME: root, USERPROFILE: root, PATH: [dirname(bash), process.platform === "win32" ? "C:\Windows\System32" : "/bin"].join(process.platform === "win32" ? ";" : ":"), RECALL_NO_DOWNLOAD: "1" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("https://bun.sh");
  rmSync(root, { recursive: true, force: true });
});
