# recall

Persistent memory for Claude Code with no daemon, no port, no Python, no Chroma. One SQLite file is the entire system.

## Design

- **No daemon, no port.** Hooks write rows to one SQLite file; a short-lived processor drains the job queue and exits. A lock row with expiry replaces PID files, so it behaves the same on Windows.
- **One LLM call per prompt.** Tool events are batched per user prompt and turned into 1–4 observations; sessions get a summary; observations older than 30 days are folded into a project digest and archived (still searchable).
- **Hybrid retrieval.** FTS5 + in-process bge-small vectors fused with RRF, recency half-life, Beta-distribution confidence, and a token budget. Falls back to FTS5 alone if embeddings are unavailable.
- **Private by default.** Secret redaction, `.env`/key/credential paths never captured, `<private>` tags honoured.
- **Project identity** is the sha1 of the normalised git remote (path fallback), so worktrees and clones share memory.
- **Portable.** `recall export` writes Logseq-friendly markdown per project.

Runtime dependencies: `bun`, `@modelcontextprotocol/sdk`, `zod`. `@huggingface/transformers` is optional.

## Prerequisites

- **Claude Code** (it runs hooks under bash: Git for Windows on Windows, nothing extra elsewhere).
- **An LLM**: the `claude` CLI is used by default; set `ANTHROPIC_API_KEY` to call the API directly instead.
- **Bun is installed for you.** Nothing else is required up front; see "Runtime" below.

## Install

```
/plugin marketplace add frankt86/recall
/plugin install recall@memory-tools
```

or point Claude Code at the directory:

```
claude --plugin-dir /path/to/recall
```

The Setup hook bootstraps the runtime, runs `bun install`, then `doctor`. Restart Claude Code.

## Runtime

Everything (hooks, MCP server, CLI) runs on Bun. `bin/bun.sh` resolves one without a remote install script and without touching PATH or shell profiles, in this order:

1. `RECALL_BUN` (explicit override)
2. `<plugin>/runtime/bun` — a private copy the MCP server launches directly
3. `~/.recall/runtime/bun-v<pinned>/bun` — cache that survives plugin updates
4. `bun` on PATH (or `~/.bun/bin`) if it is >= 1.1
5. Download the pinned release zip from GitHub, verify its SHA-256 against checksums embedded in the script, and install into 3

Installs are atomic and locked against concurrently firing hooks. Set `RECALL_NO_DOWNLOAD=1` to fail instead of downloading, `RECALL_BUN_TARGET` to override platform detection (e.g. `linux-x64-baseline`). `recall doctor` reports which Bun is in use. With `--plugin-dir` (no Setup hook) the MCP server starts on the second session, after the first session's hooks have populated `runtime/`; run `bash bin/bun.sh --ensure` to do it immediately.

## How it runs

```
UserPromptSubmit  -> insert prompt row; close previous prompt; enqueue observe if it had events
PostToolUse       -> redact, filter sensitive paths, append event row       (async, ~5ms)
Stop              -> close prompt, enqueue observe, spawn processor (detached)
SessionEnd        -> enqueue summarize, spawn processor
SessionStart      -> retrieve with budget, print context, spawn processor if backlog

processor.ts      -> acquire lock row; UPDATE ... RETURNING to claim a job;
                     observe: events for one prompt -> 1 LLM call -> 1..4 observations + embeddings
                     summarize: prompts + observations for one session -> summary
                     consolidate: >30 day old observations -> project digest, archive
                     exit when queue empty; lock expires after 5 min if killed
```

Nothing listens on anything. If the processor dies mid job, the job returns to `pending` after 10 minutes and the next hook spawns a new processor. The processor is spawned with `detached: true` (via `node:child_process`) so it survives the hook exiting on Windows; every child it spawns (including `claude -p`) uses `windowsHide` so no console window ever appears.

When the LLM call goes through `claude -p`, that child Claude Code would load this plugin's hooks too. The processor sets `RECALL_INTERNAL=1` on the child and every hook exits immediately when it sees it, so internal LLM calls never create sessions or jobs.

## Settings

`~/.recall/settings.json` (created on first run). Env overrides: `RECALL_DIR`, `RECALL_MODEL`, `RECALL_LLM` (`auto|api|cli|fake`), `RECALL_EMBEDDINGS=0`, `RECALL_DEBUG=1`.

With `ANTHROPIC_API_KEY` set the processor calls the Messages API with Haiku. Without it, `claude -p --model <model>` is used, which bills your Claude subscription and needs no key.

## CLI

`recall` (or `bun src/cli.ts`) — every command has `--help`; bad flags exit 2 with usage, runtime errors exit 1 with a one-line `error:` (stack with `RECALL_DEBUG=1`).

```
recall status [--json]                   counts, queue, stuck/failed jobs, projects
recall process [--dry-run] [--max N] [--retry]
recall export [--out dir] [--project name]
recall migrate --from <path to a claude-mem db>
recall relink --legacy <name> --remote <git url>
recall consolidate [--now]
recall ui [--port n] [--open]            local viewer, exits with the process
recall doctor [--json]                   environment check, exit 1 on failure
```

`ui` binds 127.0.0.1 on an ephemeral port only while the command runs. It is dark-mode aware, searches with the same hybrid FTS + vector ranking that session injection uses, and lets you vote observations up/down (same alpha/beta update as the MCP `feedback` tool) or archive them. Tabs for observations, session summaries, and digests; JSON under `/api/*`.

## Seeing what happens in the background

There is no daemon, so `~/.recall/processor.log` (last 200 lines, rolling) is the only trace of background work: every processor start, each job's outcome and duration, and any error. `recall status` prints the last error and flags jobs that have been pending for over an hour (the processor is not running); `recall doctor` turns that into a failing `queue` check. The viewer's sidebar shows the same.

Every session start that received memory is recorded in `context_log` (query, injected items, token cost) and shown in the viewer's **injected** tab, so you can judge whether what Claude saw was the right thing.

## Standalone binary

`bun build --compile src/cli.ts --outfile recall` produces a single executable; pushing a `v*` tag builds Windows/Linux/macOS binaries via GitHub Actions and attaches them to a release. The binary is for the CLI and viewer only and runs FTS5-only (the ONNX runtime cannot be bundled); the hooks keep running under `bun` with embeddings.

## MCP tools

`search`, `timeline`, `get_observations`, `feedback`, `projects`. The server is stdio and opens the SQLite file directly.

Confidence is `alpha / (alpha + beta)`. Being injected at session start adds 0.15 to beta (prior pressure), being fetched adds 0.5 to alpha, explicit feedback adds 2 or 3. Items with low confidence sink in retrieval without being deleted.

## Tests

```
bun test
```

The pipeline test drives all five hooks and the processor with `RECALL_LLM=fake`.
