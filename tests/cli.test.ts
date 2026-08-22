import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "recall-cli-" + process.pid);
mkdirSync(dir, { recursive: true });
const env = { ...process.env, RECALL_DIR: dir, RECALL_LLM: "fake", RECALL_EMBEDDINGS: "0", RECALL_NO_SPAWN: "1" };

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe", env });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

test("help and version", async () => {
  expect((await cli()).out).toContain("usage");
  expect((await cli("--help")).code).toBe(0);
  expect((await cli("status", "-h")).out).toContain("--json");
  expect((await cli("--version")).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("unknown command suggests and exits 1", async () => {
  const r = await cli("stauts");
  expect(r.code).toBe(1);
  expect(r.err).toContain("did you mean status");
});

test("unknown flag exits 2 with usage", async () => {
  const r = await cli("ui", "--prot", "1234");
  expect(r.code).toBe(2);
  expect(r.err).toContain("--prot");
  expect(r.err).toContain("usage");
});

test("missing required flag exits 2", async () => {
  const r = await cli("relink", "--legacy", "x");
  expect(r.code).toBe(2);
  expect(r.err).toContain("--remote");
});

test("status --json and process --dry-run", async () => {
  const s = await cli("status", "--json");
  expect(s.code).toBe(0);
  const j = JSON.parse(s.out);
  expect(j.counts.observations).toBe(0);
  expect(j.jobs).toEqual({});
  expect(j.db).toContain("memory.db");
  const d = await cli("process", "--dry-run");
  expect(d.code).toBe(0);
  expect(d.out).toContain("0 pending");
});

test("doctor --json reports checks", async () => {
  const r = await cli("doctor", "--json");
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.checks.find((c: { name: string }) => c.name === "db").ok).toBe(true);
});

test("migrate with missing source exits 1 with one-line error", async () => {
  const r = await cli("migrate", "--from", join(dir, "nope.db"));
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/^error: /);
  expect(r.err.split("\n").filter(Boolean).length).toBe(1);
});
