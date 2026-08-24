#!/usr/bin/env bun
import { env } from "./settings";
import pkg from "../package.json" with { type: "json" };
import { levenshtein, parseCommand, UsageError, usage, type CommandSpec } from "./commands/args";
import { consolidate } from "./commands/consolidate";
import { doctor } from "./commands/doctor";
import { exportCmd } from "./commands/export";
import { link } from "./commands/link";
import { migrate } from "./commands/migrate";
import { processCmd } from "./commands/process";
import { relink } from "./commands/relink";
import { status } from "./commands/status";
import { ui } from "./commands/ui";

const COMMANDS: CommandSpec<any>[] = [status, processCmd, exportCmd, migrate, relink, consolidate, ui, link, doctor];

function version(): string {
  return (pkg as { version: string }).version;
}

function help(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    `recall ${version()}`,
    "usage: recall <command> [options]",
    "",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(w)}${c.summary}`),
    "",
    "  recall <command> --help   options for a command",
    "  env: RECALL_DIR, RECALL_MODEL, RECALL_LLM=auto|api|cli|fake, RECALL_EMBEDDINGS=0, RECALL_DEBUG=1",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log(help());
    return;
  }
  if (name === "--version" || name === "-v") {
    console.log(version());
    return;
  }
  const spec = COMMANDS.find((c) => c.name === name);
  if (!spec) {
    const near = COMMANDS.map((c) => ({ c, d: levenshtein(name, c.name) })).sort((a, b) => a.d - b.d)[0];
    const hint = near && near.d <= 3 ? ` (did you mean ${near.c.name}?)` : "";
    throw new UsageError(`unknown command: ${name}${hint}`);
  }
  const opts = parseCommand(spec, rest);
  await spec.run(opts);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`error: ${e.message}`);
    console.error(e.spec ? usage(e.spec) : "usage: recall <command> [options]  (try recall --help)");
    process.exit(e.spec ? 2 : 1);
  }
  const err = e as Error;
  console.error(`error: ${err?.message ?? String(e)}`);
  if (env("DEBUG") === "1" && err?.stack) console.error(err.stack);
  process.exit(1);
}
