import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, type ObservationRow } from "./db";
import { resolveProject } from "./project";
import { markUnhelpful, markUsed, retrieve } from "./retrieve";
import { openBrowser, startUi } from "./ui/server";

const db = openDb();
const server = new McpServer({ name: "recall", version: "0.4.2" });

function projectIdFor(project?: string): string {
  if (project) {
    const r = db
      .query<{ id: string }, [string, string]>("SELECT id FROM projects WHERE name = ? OR id = ? LIMIT 1")
      .get(project, project);
    if (r) return r.id;
  }
  return resolveProject(process.cwd()).id;
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

server.tool(
  "search",
  "Search project memory. Returns a compact index (id, date, type, title). Follow with get_observations for full detail. Hybrid keyword plus semantic retrieval with recency and confidence weighting.",
  {
    query: z.string().describe("Natural language or keywords"),
    limit: z.number().int().min(1).max(50).optional(),
    type: z.string().optional().describe("decision|bugfix|feature|change|discovery|refactor|config|other"),
    since: z.string().optional().describe("ISO date lower bound"),
    until: z.string().optional().describe("ISO date upper bound"),
    project: z.string().optional().describe("Project name or id; defaults to current directory's project"),
    include_archived: z.boolean().optional(),
  },
  async ({ query, limit, type, since, until, project, include_archived }) => {
    const items = await retrieve(db, {
      projectId: projectIdFor(project),
      query,
      limit: limit ?? 15,
      types: type ? [type] : undefined,
      since: since ? Date.parse(since) : undefined,
      until: until ? Date.parse(until) : undefined,
      includeArchived: include_archived,
    });
    if (!items.length) return { content: [{ type: "text", text: "No matching memory." }] };
    const lines = items.map((it) =>
      it.kind === "observation"
        ? `#${it.id} ${fmtDate(it.created_at)} [${it.type}] conf=${it.confidence.toFixed(2)} ${it.title}`
        : `S${it.id} ${fmtDate(it.created_at)} [session] ${it.title}`,
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "get_observations",
  "Fetch full observations by id. Batch ids. Fetching counts as a weak positive signal for confidence.",
  { ids: z.array(z.number().int()).min(1).max(40) },
  async ({ ids }) => {
    const rows = db
      .query<ObservationRow, number[]>(`SELECT * FROM observations WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`)
      .all(...ids);
    markUsed(db, rows.map((r) => r.id), 0.5);
    const text = rows
      .map((r) => {
        const facts = JSON.parse(r.facts || "[]") as string[];
        const files = JSON.parse(r.files || "[]") as string[];
        return [
          `## #${r.id} [${r.type}] ${r.title}`,
          `${fmtDate(r.created_at)}  confidence ${(r.alpha / (r.alpha + r.beta)).toFixed(2)}${r.archived ? "  (archived)" : ""}`,
          r.narrative,
          ...facts.map((f) => `- ${f}`),
          files.length ? `files: ${files.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    return { content: [{ type: "text", text: text || "Not found." }] };
  },
);

server.tool(
  "timeline",
  "Chronological context around an observation id or a query: the prompts and observations before and after it in the same project.",
  {
    observation_id: z.number().int().optional(),
    query: z.string().optional(),
    before: z.number().int().min(0).max(20).optional(),
    after: z.number().int().min(0).max(20).optional(),
    project: z.string().optional(),
  },
  async ({ observation_id, query, before, after, project }) => {
    const pid = projectIdFor(project);
    let anchor: ObservationRow | undefined;
    if (observation_id) anchor = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(observation_id) ?? undefined;
    else if (query) {
      const hit = (await retrieve(db, { projectId: pid, query, limit: 1 })).find((i) => i.kind === "observation");
      if (hit) anchor = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(hit.id) ?? undefined;
    }
    if (!anchor) return { content: [{ type: "text", text: "No anchor found." }] };
    const b = before ?? 5;
    const a = after ?? 5;
    const prev = db
      .query<ObservationRow, [string, number, number]>(
        "SELECT * FROM observations WHERE project_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(anchor.project_id, anchor.created_at, b)
      .reverse();
    const next = db
      .query<ObservationRow, [string, number, number]>(
        "SELECT * FROM observations WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?",
      )
      .all(anchor.project_id, anchor.created_at, a);
    const fmt = (r: ObservationRow, mark = " ") => `${mark} #${r.id} ${fmtDate(r.created_at)} [${r.type}] ${r.title}`;
    const text = [...prev.map((r) => fmt(r)), fmt(anchor, ">"), ...next.map((r) => fmt(r))].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "feedback",
  "Tell memory whether observations were useful (raises confidence) or wrong/stale (lowers it). Use after relying on or being misled by memory.",
  { ids: z.array(z.number().int()).min(1), useful: z.boolean(), note: z.string().optional() },
  async ({ ids, useful }) => {
    if (useful) markUsed(db, ids, 2);
    else markUnhelpful(db, ids, 3);
    return { content: [{ type: "text", text: `Recorded ${useful ? "positive" : "negative"} feedback for ${ids.length} observation(s).` }] };
  },
);

server.tool(
  "projects",
  "List known projects with observation counts.",
  {},
  async () => {
    const rows = db
      .query<{ name: string; id: string; n: number; last: number | null }, []>(
        `SELECT p.name, p.id, COUNT(o.id) AS n, MAX(o.created_at) AS last FROM projects p LEFT JOIN observations o ON o.project_id = p.id GROUP BY p.id ORDER BY last DESC`,
      )
      .all();
    const text = rows.map((r) => `${r.name}  (${r.id})  ${r.n} obs${r.last ? "  last " + fmtDate(r.last) : ""}`).join("\n");
    return { content: [{ type: "text", text: text || "No projects yet." }] };
  },
);

let ui: { port: number; stop: () => void } | null = null;
server.tool(
  "open_ui",
  "Start the recall memory-manager web app on 127.0.0.1 and return its URL. No setup needed; runs until this Claude Code session ends. Idempotent: calling again returns the URL of the already-running viewer. Use when the user asks to open, see, or manage their memory UI.",
  { open_browser: z.boolean().optional().describe("Also open the URL in the default browser (default true)") },
  async ({ open_browser }) => {
    if (!ui) ui = startUi(db, 0);
    const url = `http://127.0.0.1:${ui.port}/`;
    const opened = open_browser === false ? false : openBrowser(url);
    return {
      content: [{ type: "text", text: `recall UI running at ${url}${opened ? " (opened in browser)" : ""} — it stops when this Claude Code session ends. Give this URL to the user.` }],
    };
  },
);

await server.connect(new StdioServerTransport());
