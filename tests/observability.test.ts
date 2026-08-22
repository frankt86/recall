import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-obs-" + process.pid);
mkdirSync(dir, { recursive: true });
// bun runs every test file in one process: point in-process code at the same temp dir and never touch the shared openDb() singleton
process.env.RECALL_DIR = dir;
const env = { ...process.env, RECALL_DIR: dir, RECALL_LLM: "bogus", RECALL_EMBEDDINGS: "0", RECALL_NO_SPAWN: "1" };

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe", env });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

test("processor writes a rolling log and failures surface in status/doctor", async () => {
  await cli("status"); // creates the schema
  const { Database } = await import("bun:sqlite");
  const d = new Database(join(dir, "memory.db"));
  const t = Date.now();
  d.query("INSERT INTO projects(id, name, root_path, remote, created_at) VALUES ('p','p','/p',NULL,?)").run(t);
  d.query("INSERT INTO sessions(claude_session_id, project_id, cwd, started_at) VALUES ('s','p','/p',?)").run(t);
  d.query("INSERT INTO prompts(session_id, prompt_no, text, created_at, closed) VALUES (1, 1, 'do a thing', ?, 1)").run(t);
  d.query("INSERT INTO events(prompt_id, tool_name, input, output, created_at) VALUES (1, 'Edit', 'x', 'ok', ?)").run(t);
  // job 1 will fail: RECALL_LLM=bogus is rejected by the llm layer. job 2 is a stale pending job.
  d.query("INSERT INTO jobs(kind, ref_id, status, attempts, created_at) VALUES ('observe', 1, 'pending', 0, ?)").run(t);
  d.query("INSERT INTO jobs(kind, ref_id, status, attempts, created_at) VALUES ('summarize', 1, 'pending', 0, ?)").run(t - 2 * 3600_000);
  d.close();

  const r = await cli("process", "--max", "1");
  expect(r.code).toBe(0);
  const log = join(dir, "processor.log");
  expect(existsSync(log)).toBe(true);
  expect(readFileSync(log, "utf8")).toMatch(/observe#1 failed: unknown llm provider/);

  const s = JSON.parse((await cli("status", "--json")).out);
  expect(s.lastError).toMatch(/observe#1 failed/);
  expect(s.log).toBe(log);
  expect(s.stalePending).toBe(1);

  const doc = await cli("doctor", "--json");
  const q = JSON.parse(doc.out).checks.find((c: any) => c.name === "queue");
  expect(q.ok).toBe(false);
  expect(q.detail).toMatch(/pending/);
  expect(doc.code).toBe(1);
});

test("log is trimmed to the last 200 lines", async () => {
  const { appendLog, LOG_MAX } = await import("../src/log");
  for (let i = 0; i < LOG_MAX * 3; i++) appendLog(`line ${i}`);
  const lines = readFileSync(join(dir, "processor.log"), "utf8").trim().split("\n");
  expect(lines.length).toBeLessThanOrEqual(LOG_MAX * 2); // trimmed back to LOG_MAX whenever it passes 2x
  expect(lines[lines.length - 1]).toContain(`line ${LOG_MAX * 3 - 1}`);
});
