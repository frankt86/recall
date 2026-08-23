// Import/export formats for hand-editing memory outside the app. Markdown is the human format:
//   ## [type] title
//   narrative paragraphs
//   - fact
//   files: a, b
//   pinned: yes
export interface ObsIn {
  type: string;
  title: string;
  narrative: string;
  facts: string[];
  files: string[];
  pinned: boolean;
}

export const TYPES = ["decision", "bugfix", "feature", "change", "discovery", "refactor", "config", "other", "manual", "lesson"] as const;

const norm = (o: Partial<ObsIn> & Record<string, unknown>): ObsIn => ({
  type: typeof o.type === "string" && o.type ? o.type : "other",
  title: String(o.title ?? "").trim(),
  narrative: String(o.narrative ?? "").trim(),
  facts: Array.isArray(o.facts) ? o.facts.map(String).map((s) => s.trim()).filter(Boolean) : [],
  files: Array.isArray(o.files) ? o.files.map(String).map((s) => s.trim()).filter(Boolean) : [],
  pinned: !!o.pinned,
});

export function toMarkdown(items: ObsIn[]): string {
  return items
    .map((o) => {
      const parts = [`## [${o.type}] ${o.title}`, "", o.narrative];
      if (o.facts.length) parts.push("", ...o.facts.map((f) => `- ${f}`));
      if (o.files.length) parts.push("", `files: ${o.files.join(", ")}`);
      if (o.pinned) parts.push("", "pinned: yes");
      return parts.join("\n");
    })
    .join("\n\n") + (items.length ? "\n" : "");
}

export function fromMarkdown(md: string): ObsIn[] {
  const out: ObsIn[] = [];
  let cur: ObsIn | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (cur && para.length) cur.narrative = cur.narrative ? `${cur.narrative}\n\n${para.join(" ")}` : para.join(" ");
    para = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+(?:\[([a-z]+)\]\s*)?(.+)$/i);
    if (h) {
      flushPara();
      if (cur) out.push(cur);
      cur = norm({ type: h[1]?.toLowerCase(), title: h[2] });
      continue;
    }
    if (!cur) continue;
    if (line === "") { flushPara(); continue; }
    const fact = line.match(/^[-*]\s+(.+)$/);
    const files = line.match(/^files:\s*(.*)$/i);
    const pinned = line.match(/^pinned:\s*(yes|true|1)\s*$/i);
    if (fact) { flushPara(); cur.facts.push(fact[1].trim()); }
    else if (files) { flushPara(); cur.files.push(...files[1].split(",").map((s) => s.trim()).filter(Boolean)); }
    else if (pinned) { flushPara(); cur.pinned = true; }
    else para.push(line.trim());
  }
  flushPara();
  if (cur) out.push(cur);
  return out.filter((o) => o.title);
}

export function toJson(items: ObsIn[]): string {
  return JSON.stringify(items, null, 2) + "\n";
}

export function fromJson(s: string): ObsIn[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object").map(norm).filter((o) => o.title) : [];
  } catch {
    return [];
  }
}
