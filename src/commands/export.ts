import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type ObservationRow, type SummaryRow } from "../db";
import { dataDir } from "../settings";
import type { CommandSpec } from "./args";

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parseList = (s: string | null): string[] => {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

export const exportCmd: CommandSpec<{ out?: string; project?: string }> = {
  name: "export",
  summary: "markdown per project (Logseq friendly)",
  options: {
    out: { type: "string", help: "output directory", default: join(dataDir(), "export") },
    project: { type: "string", help: "only this project (name or id)" },
  },
  run(o) {
    const db = openDb();
    const outDir = o.out!;
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      throw new Error(`cannot create ${outDir}: ${(e as Error).message}`);
    }
    let projects = db.query<{ id: string; name: string }, []>("SELECT id, name FROM projects ORDER BY name").all();
    if (o.project) {
      projects = projects.filter((p) => p.id === o.project || p.name === o.project);
      if (!projects.length) throw new Error(`no project named ${o.project}`);
    }
    let written = 0;
    for (const p of projects) {
      const obs = db.query<ObservationRow, [string]>("SELECT * FROM observations WHERE project_id = ? ORDER BY created_at").all(p.id);
      const sums = db.query<SummaryRow, [string]>("SELECT * FROM summaries WHERE project_id = ? ORDER BY created_at").all(p.id);
      const digests = db
        .query<{ content: string; period_start: number; period_end: number }, [string]>(
          "SELECT content, period_start, period_end FROM digests WHERE project_id = ? ORDER BY period_end",
        )
        .all(p.id);
      if (!obs.length && !sums.length && !digests.length) continue;
      const lines: string[] = [`# ${p.name}`, ""];
      if (digests.length) {
        lines.push("## Digests", "");
        for (const d of digests) lines.push(`### ${fmt(d.period_start)} to ${fmt(d.period_end)}`, "", d.content, "");
      }
      if (sums.length) {
        lines.push("## Sessions", "");
        for (const s of sums) lines.push(`- **${fmt(s.created_at)}** ${s.request}`, `  - completed:: ${s.completed}`, `  - learned:: ${s.learned}`, `  - next:: ${s.next_steps}`);
        lines.push("");
      }
      if (obs.length) {
        lines.push("## Observations", "");
        for (const r of obs) {
          lines.push(`- **${fmt(r.created_at)}** #${r.id} [[${r.type}]] ${r.title}${r.archived ? " (archived)" : ""}`);
          lines.push(`  - ${r.narrative}`);
          for (const f of parseList(r.facts)) lines.push(`  - ${f}`);
          const files = parseList(r.files);
          if (files.length) lines.push(`  - files:: ${files.join(", ")}`);
        }
      }
      const file = join(outDir, `${p.name.replace(/[^a-z0-9_\-]+/gi, "_")}.md`);
      writeFileSync(file, lines.join("\n"));
      console.log(file);
      written++;
    }
    if (!written) console.log("nothing to export");
  },
};
