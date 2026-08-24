import { pluginRoot } from "../hook-io";
import { ensureCliLink, removeCliLink } from "../link";
import type { CommandSpec } from "./args";

export const link: CommandSpec<{ remove?: boolean }> = {
  name: "link",
  summary: "put `recall` on your shell PATH (runs automatically at plugin install)",
  options: {
    remove: { type: "boolean", help: "remove the link and any PATH line recall added" },
  },
  async run(o) {
    const r = o.remove ? removeCliLink() : ensureCliLink(pluginRoot());
    const detail = [r.dir, r.note].filter(Boolean).join("  ");
    console.log(`${r.action}${detail ? `: ${detail}` : ""}`);
    if (!r.ok) process.exitCode = 1;
  },
};
