---
name: recall-search
description: Search persistent project memory from earlier Claude Code sessions. Use when the user references past work, asks what was decided, why something was done, or when context injected at session start is not enough.
---

Use the `recall` MCP tools in this order:

1. `search` with a few concrete keywords or a short sentence. Read the index.
2. `timeline` around the most relevant id if sequence matters.
3. `get_observations` with only the ids you need. Batch them.
4. `feedback` with useful=true when memory shaped the answer, useful=false when an observation was stale or wrong. This trains retrieval ranking.

Observations are per prompt, not per tool call, so one id usually covers a whole task. `projects` lists other repos if the user asks about work elsewhere.
