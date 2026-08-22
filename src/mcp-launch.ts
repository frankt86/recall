// Zero-dependency launcher for the MCP server. Plugin installs are a bare git checkout; this
// guarantees node_modules exists before mcp.ts (which needs @modelcontextprotocol/sdk) is started.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const marker = join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json");

if (!existsSync(marker)) {
  const r = Bun.spawnSync(["bun", "install", "--silent", "--production"], { cwd: root, stdout: "ignore", stderr: "pipe", windowsHide: true });
  if (r.exitCode !== 0 || !existsSync(marker)) {
    process.stderr.write(`[recall] bun install failed in ${root}: ${r.stderr.toString().slice(0, 500)}\n`);
    process.exit(1);
  }
}

// Run the real server as a child with inherited stdio: a fresh process sees the freshly installed modules,
// and stdin/stdout pass straight through to the MCP client.
const child = Bun.spawn(["bun", join(root, "src", "mcp.ts")], { stdio: ["inherit", "inherit", "inherit"], cwd: root, windowsHide: true });
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
process.exit(await child.exited);
