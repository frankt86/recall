import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";

const dir = "/tmp/recall-pipe-" + process.pid;
mkdirSync(dir, { recursive: true });
mkdirSync(dir + "/repo/.git", { recursive: true });
writeFileSync(dir + "/repo/.git/HEAD", "ref: refs/heads/feature/x\n");
writeFileSync(dir + "/repo/.git/config", '[remote "origin"]\n\turl = git@github.com:terry/demo.git\n');
const env = { ...process.env, RECALL_DIR: dir, RECALL_LLM: "fake", RECALL_EMBEDDINGS: "0", RECALL_NO_SPAWN: "1" };

async function hook(name: string, input: object): Promise<string> {
  const p = Bun.spawn(["bun", `src/hooks/${name}.ts`], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe", env });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${name}: ${err}`);
  return out;
}

test("hooks -> queue -> processor -> context", async () => {
  const base = { session_id: "sess-1", cwd: dir + "/repo" };
  expect(await hook("session-start", base)).toBe("");
  await hook("user-prompt", { ...base, prompt: "Fix the login redirect loop in auth middleware" });
  await hook("post-tool-use", { ...base, tool_name: "Read", tool_input: { file_path: "src/auth.ts" }, tool_response: "export function auth() {}" });
  await hook("post-tool-use", { ...base, tool_name: "Read", tool_input: { file_path: ".env" }, tool_response: "SECRET=abc" });
  await hook("post-tool-use", { ...base, tool_name: "Edit", tool_input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" }, tool_response: "ok API_KEY=shouldbegone123" });
  await hook("stop", base);
  await hook("session-end", base);

  const { Database } = await import("bun:sqlite");
  const db = new Database(dir + "/memory.db");
  expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 2 });
  expect((db.query("SELECT output FROM events ORDER BY id DESC LIMIT 1").get() as { output: string }).output).toContain("[REDACTED]");
  expect(db.query("SELECT COUNT(*) n FROM jobs WHERE status='pending'").get()).toEqual({ n: 2 });
  db.close();

  const p = Bun.spawn(["bun", "src/processor.ts"], { stdout: "pipe", stderr: "pipe", env });
  await p.exited;

  const db2 = new Database(dir + "/memory.db");
  expect(db2.query("SELECT COUNT(*) n FROM observations").get()).toEqual({ n: 1 });
  expect(db2.query("SELECT COUNT(*) n FROM summaries").get()).toEqual({ n: 1 });
  expect(db2.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
  expect(db2.query("SELECT COUNT(*) n FROM jobs WHERE status='done' AND kind IN ('observe','summarize')").get()).toEqual({ n: 2 });
  expect((db2.query("SELECT name FROM projects").get() as { name: string }).name).toBe("terry/demo");
  db2.close();

  const ctx = await hook("session-start", { session_id: "sess-2", cwd: dir + "/repo" });
  expect(ctx).toContain("<recall");
  expect(ctx).toContain("login redirect");
  expect(ctx).toContain('branch="feature/x"');

  // what Claude saw is recorded so the UI can show it
  const db3 = new Database(dir + "/memory.db");
  const row = db3.query<{ items: string; tokens: number; query: string }, []>("SELECT items, tokens, query FROM context_log ORDER BY id DESC LIMIT 1").get()!;
  expect(JSON.parse(row.items).length).toBeGreaterThan(0);
  expect(row.tokens).toBeGreaterThan(0);
  expect(row.query).toContain("feature/x");
  db3.close();
}, 30000);
