import { expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-guard-" + process.pid);
mkdirSync(dir, { recursive: true });
const env = { ...process.env, RECALL_DIR: dir, RECALL_LLM: "fake", RECALL_EMBEDDINGS: "0", RECALL_NO_SPAWN: "1", RECALL_INTERNAL: "1" };

test("hooks are no-ops when RECALL_INTERNAL=1 (prevents recursion via claude -p)", async () => {
  for (const h of ["session-start", "user-prompt", "post-tool-use", "stop", "session-end"]) {
    const p = Bun.spawn(["bun", `src/hooks/${h}.ts`], { stdin: new Blob([JSON.stringify({ session_id: "x", cwd: dir, prompt: "hi", tool_name: "Read" })]), stdout: "pipe", stderr: "pipe", env });
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("");
  }
  expect(existsSync(join(dir, "memory.db"))).toBe(false);
});
