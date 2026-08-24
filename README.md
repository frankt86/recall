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

Restart Claude Code after installing. The **first session** bootstraps everything (Bun runtime, dependencies, the `recall` PATH link) via the SessionStart hook — Claude Code has no install-time hook, so nothing runs until a session starts. The MCP server launches through `bin/mcp`, which finds a Bun runtime wherever one lives (the `~/.recall` cache, PATH, or by downloading the pinned build), so it survives plugin updates; only a machine that has never resolved Bun at all may need its very first session to finish before the server connects.

## Runtime

Everything (hooks, MCP server, CLI) runs on Bun. `bin/bun.sh` resolves one without a remote install script and without touching PATH or shell profiles, in this order:

1. `RECALL_BUN` (explicit override)
2. `<plugin>/runtime/bun` — a private copy the MCP server launches directly
3. `~/.recall/runtime/bun-v<pinned>/bun` — cache that survives plugin updates
4. `bun` on PATH (or `~/.bun/bin`) if it is >= 1.1
5. Download the pinned release zip from GitHub, verify its SHA-256 against checksums embedded in the script, and install into 3

Installs are atomic and locked against concurrently firing hooks. Set `RECALL_NO_DOWNLOAD=1` to fail instead of downloading, `RECALL_BUN_TARGET` to override platform detection (e.g. `linux-x64-baseline`). `recall doctor` reports which Bun is in use. The MCP server starts through `bin/mcp` (`bin/mcp.cmd` on Windows), which resolves Bun via this same chain — plugin updates land in a fresh directory with an empty `runtime/`, and the cached Bun in `~/.recall` keeps the server starting on the first session after every update.

## How it runs

```
UserPromptSubmit  -> insert prompt row; close previous prompt; enqueue observe if it had events
PostToolUse       -> redact, filter sensitive paths, append event row       (async, ~5ms)
Stop              -> close prompt, enqueue observe, spawn processor (detached)
SessionEnd        -> enqueue summarize, spawn processor
SessionStart      -> retrieve with budget, print context, spawn processor if backlog
                     (fires on startup, resume, clear and compact; when there is nothing
                      to inject yet it prints a one-line status instead of staying silent)

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

Installing the plugin puts `recall` on your PATH automatically: the first session start runs `recall link`, which symlinks `bin/recall` into a writable directory already on your PATH (`~/.local/bin`, `~/bin`, `/opt/homebrew/bin`, `/usr/local/bin`); if none exists it creates `~/.local/bin` and adds one guarded `export PATH=...` line to your `~/.zshrc`/`~/.bashrc` (marked, added once, removed by `recall link --remove`). On Windows it writes shims to `%USERPROFILE%\.recall\bin` and adds that to your user PATH. Open a new terminal after installing. SessionStart repairs a stale link after plugin updates (symlink only, never profiles); `RECALL_NO_LINK=1` disables that, `recall link --remove` undoes everything, and a `recall` that isn't ours is never overwritten.

You can also skip the terminal entirely: asking Claude to "open the recall UI" calls the MCP `open_ui` tool, and inside Claude Code's Bash tool `recall <command>` always works (the plugin's `bin/` is on that PATH).

Every command has `--help`; bad flags exit 2 with usage, runtime errors exit 1 with a one-line `error:` (stack with `RECALL_DEBUG=1`).

```
recall status [--json]                   counts, queue, stuck/failed jobs, projects
recall process [--dry-run] [--max N] [--retry]
recall export [--out dir] [--project name]
recall migrate --from <path to a claude-mem db>
recall relink --legacy <name> --remote <git url>
recall consolidate [--now]
recall ui [--port n] [--open]            memory manager web app, exits with the process
recall doctor [--json]                   environment check, exit 1 on failure
```

`ui` binds 127.0.0.1 on an ephemeral port only while the command runs (asking Claude to "open the recall UI" starts the same server inside the MCP process; it stops with the session). It is a full memory manager, not just a viewer — everything that ends up in Claude's context can be edited, pinned, excluded, merged, or written by hand:

- **Inbox / All / Pinned / Archived** — list views with hybrid FTS + vector search, type filter, sort. Inbox shows what arrived since your last visit.
- **Detail pane** — edit title / narrative / facts / files / type / project in place, pin, archive, delete, vote 👍/👎 (same alpha/beta update as the MCP `feedback` tool).
- **Pinned** observations are always injected at session start (newest first, within the token budget) regardless of score; **archived** ones are never recalled. `+ New` writes a memory by hand.
- **Bulk triage** — select with `x`, then pin / archive / move to another project / merge duplicates into one / delete.
- **Session preview** — the exact text the SessionStart hook will inject for a project, its token cost against the budget, and for every item *why* it was chosen (keyword rank, semantic rank, recency, confidence). Pin or exclude from there and the preview refreshes. Pinned items that do not fit the budget are called out.
- **Knowledge graph** — entities (files, symbols, commands, libraries, concepts) and weighted relations, extracted automatically from every observation (deterministically from paths/backticked identifiers, plus what the extractor LLM names) and updated incrementally. The view is a force layout filtered by kind / minimum mentions / name; click a node for its related entities and the memories behind it. The graph only ever reflects *active* memory, so retiring memory prunes it. Retrieval also uses it: query terms that hit entity names pull in linked memories as a fourth ranked list.
- **Sessions / Digests** — edit or delete summaries and digests.
- **Jobs** — the processor queue with retry/cancel, plus buttons to run the queue, queue a consolidation, or re-embed observations that lack vectors.
- **Health & transfer** — DB size, counts, embedding coverage, settings, and markdown/JSON **export** of a project's memory and **import** (dry run first). The markdown is hand-editable:

  ```markdown
  ## [decision] Use UV, never pip

  Narrative paragraph.

  - a fact
  files: pyproject.toml
  pinned: yes
  ```

Keyboard: `j`/`k` move, `Enter` open, `e` edit, `n` new, `p` pin, `a` archive, `d` delete (press twice), `x` select, `Shift+X` select all, `m` merge, `f`/`F` vote, `/` search, `g` then `i a p r s d v j h` to jump views, `?` for the full list. JSON under `/api/*`.

## Context rot

Memory rots in two ways: facts go stale (the code changed, the decision was reversed) and dead weight accumulates. Both are handled.

**At write time — reconciliation.** When a new observation is extracted, its nearest neighbours (by embedding and by shared graph entities) are shown to the model with one question: which of these does the new fact make wrong, and is it merely a duplicate? Superseded memories are archived immediately with `superseded_by` pointing at the replacement (the UI shows the link); a redundant newcomer is folded into the established memory, which gains confidence. Pinned memory is never superseded; hand-written memory is never folded. This is the main defence: a stale fact is retired the moment the correction arrives, not weeks later.

**At read time — relevance gate.** With a real query, only three items that matched by recency alone are allowed in; the rest must have a keyword, semantic, or graph hit. A session with little relevant memory injects less, not the same 2.5k tokens of filler. Every injection also costs an item a little confidence (`beta`) unless it is later marked useful, so memory that keeps being shown without helping sinks.

**When the same thing keeps breaking — lessons.** Bugfix observations that share an entity (a file, command, or symbol) across `recurringThreshold` (3) separate sessions mean the fix is not sticking. The model is asked to write one durable lesson from those fixes — what breaks, why, the rule — and it is stored as a **pinned** `lesson` memory with importance 5, so it is injected every session from then on. One lesson per entity, rewritten as the count grows; never auto-retired. Runs right after each bugfix is observed and in maintenance.

**Importance.** The extractor rates each observation 1–5 (5 = architectural decision, standing rule, root cause; 1 = trivia). Retrieval ranks by relevance × recency × confidence × importance, after the Generative Agents memory model, so a decision outranks a same-day note about a typo.

**Periodically — `maintain` job**, run with the processor every `maintainEveryHours` (12) and triggerable from the UI:

- **Retire** — after `retireAfterDays` (45), observations that were injected 3+ times but never marked useful, or whose confidence fell below 40 %, are archived.
- **Deduplicate** — near-duplicate observations (embedding cosine ≥ `dedupeThreshold`, 0.92) are folded: the older is archived with `superseded_by` pointing at the newer.
- **Cap** — at most `maxActivePerProject` (400) active observations per project; the weakest by confidence × recency are archived first.
- **Prune** — graph entities with no active memory are dropped after 30 days; edge weights decay by `graphEdgeDecay` (0.95) per run and faint edges are removed; done jobs older than 7 days and context logs older than 90 days are deleted.

Pinned and hand-written (`manual` / `import`) memory is never auto-retired. Archived memory is not injected but stays searchable (`include_archived`) and can be restored from the Archived view. Health shows the last run's numbers.

## Seeing what happens in the background

There is no daemon, so `~/.recall/processor.log` (last 200 lines, rolling) is the only trace of background work: every processor start, each job's outcome and duration, and any error. `recall status` prints the last error and flags jobs that have been pending for over an hour (the processor is not running); `recall doctor` turns that into a failing `queue` check. The UI's sidebar and Jobs view show the same.

Every session start that received memory is recorded in `context_log` (query, injected items, token cost) and available at `/api/context`, so you can judge whether what Claude saw was the right thing.

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
