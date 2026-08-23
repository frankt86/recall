// Assembles the memory block injected at SessionStart. Shared by the hook and the UI preview so what the
// viewer shows is byte-identical to what Claude receives. Pure with respect to the DB: no markShown, no logging.
import type { Database } from "bun:sqlite";
import { pendingCount } from "./db";
import { estimateTokens, latestDigest, retrieveWithSkipped, type ScoredItem } from "./retrieve";
import type { Settings } from "./settings";

export interface ContextInput {
  projectId: string;
  projectName: string;
  branch: string | null;
  query: string;
  settings: Settings;
}

export interface ContextResult {
  text: string;
  items: ScoredItem[];
  skippedPinned: number[];
  digest: string | null;
  tokens: number;
  pending: number;
}

export async function buildSessionContext(db: Database, o: ContextInput): Promise<ContextResult> {
  const { items, skippedPinned } = await retrieveWithSkipped(db, {
    projectId: o.projectId, query: o.query, limit: o.settings.contextMaxItems, tokenBudget: o.settings.contextTokenBudget,
  });
  const digest = latestDigest(db, o.projectId);
  const pending = pendingCount(db);

  const lines: string[] = [];
  if (items.length || digest) {
    lines.push(`<recall project="${o.projectName}"${o.branch ? ` branch="${o.branch}"` : ""}>`);
    lines.push("Memory from earlier sessions on this project. Use the recall MCP tools (search, timeline, get_observations) to dig deeper; call recall feedback when an item was useful or wrong.");
    if (digest) lines.push("", "## Project digest", digest.slice(0, 1800));
    if (items.length) {
      lines.push("", "## Relevant recent memory");
      for (const it of items) {
        const d = new Date(it.created_at).toISOString().slice(0, 10);
        const tag = it.kind === "observation" ? `#${it.id}` : `session`;
        lines.push(`- [${d}] [${it.type}] ${tag} ${it.title}`);
        const body = it.body.split("\n").slice(0, 3).join(" ").slice(0, 320);
        lines.push(`  ${body}`);
      }
    }
    if (pending) lines.push("", `(${pending} memory jobs still processing in the background)`);
    lines.push("</recall>");
  }
  const text = lines.join("\n");
  return { text, items, skippedPinned, digest, tokens: text ? estimateTokens(text) : 0, pending };
}
