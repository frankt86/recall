---
name: recall-ui
description: Open or troubleshoot the recall memory manager web UI. Use when the user asks to open, launch, or see the recall UI / memory manager / memory viewer, or says the recall UI is not working.
---

Try these in order; stop at the first that works and give the user the URL.

1. Call the recall MCP tool `open_ui`. It starts the viewer on 127.0.0.1, opens the browser, and returns the URL. It stops when this Claude Code session ends.
2. If the tool is unavailable (the MCP server starts on the session after first install), run `recall ui --open` with the Bash tool in the background — the plugin's `bin/` is on the Bash PATH — and report the `viewer:` URL it prints. `recall doctor` explains any failure.
3. If `recall` is not on PATH, locate the plugin and run it directly:
   `p=$(find ~/.claude/plugins -maxdepth 6 -type f -path '*recall/bin/bun.sh' | head -1); bash "$p" "${p%/bin/bun.sh}/src/cli.ts" ui --open`

Notes for the user, mention when relevant:
- On a fresh machine the UI is empty until Claude Code sessions have run and the processor has stored memories; the Jobs and Health tabs show live state immediately.
- To get a `recall` command in their own terminal: `ln -s <plugin>/bin/recall ~/.local/bin/recall`.
