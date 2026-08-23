import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Simulates a plugin install: a bare copy of the repo with no node_modules. The MCP launcher must
// bootstrap dependencies itself and then answer a real handshake.
test("mcp launcher bootstraps node_modules from a bare checkout", async () => {
  const dir = join(tmpdir(), "recall-bare-" + process.pid);
  mkdirSync(dir, { recursive: true });
  for (const f of ["src", "package.json", "bun.lock"]) if (existsSync(f)) cpSync(f, join(dir, f), { recursive: true }); // bun.lock is gitignored, so CI checkouts lack it
  expect(existsSync(join(dir, "node_modules"))).toBe(false);

  const msgs = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n") + "\n";
  const p = Bun.spawn(["bun", join(dir, "src", "mcp-launch.ts")], {
    stdin: new Blob([msgs]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, RECALL_DIR: join(dir, "data"), RECALL_EMBEDDINGS: "0" },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  expect(existsSync(join(dir, "node_modules", "@modelcontextprotocol", "sdk"))).toBe(true);
  expect(out).toContain('"serverInfo":{"name":"recall"');
  expect(out).toContain('"name":"search"');
}, 120000);
