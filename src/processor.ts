import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import {
  acquireLock,
  claimNextJob,
  enqueue,
  finishJob,
  blobToFloats,
  floatsToBlob,
  getMeta,
  now,
  openDb,
  releaseLock,
  renewLock,
  setMeta,
  type Job,
  type ObservationRow,
} from "./db";
import { cosine, embed } from "./embed";
import { linkObservation, type EntityIn, type RelationIn } from "./graph";
import { runMaintain } from "./maintain";
import { complete, extractJson } from "./llm";
import { env, loadSettings } from "./settings";
import { appendLog } from "./log";

const LOCK = "processor";
const LOCK_TTL = 5 * 60 * 1000;
const OWNER = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

const OBS_SYSTEM = `You are OBSERVATION_EXTRACTOR for a developer memory system.
You receive one user prompt to a coding agent plus the tool calls it made in response.
Produce durable, specific observations a future session would want: decisions made, bugs found and root causes, how the code is structured, commands that worked, constraints discovered, what was changed and why.
Skip trivia (listing directories, reading files with no conclusion). Merge related events into one observation. Prefer 1 to 4 observations. Never include secrets.
Rate "importance" 1-5: 5 = architectural decision, standing rule, or root cause that will matter for months; 3 = useful working detail; 1 = trivia that may be worth a line.
Also name the entities each observation is about and how they relate, for a knowledge graph: files, code symbols (functions, classes, modules), shell commands, libraries, and concepts (named decisions, patterns, features). Use exact identifiers; 2-8 entities per observation; relations only between named entities.
Respond with ONLY a JSON object:
{"observations":[{"type":"decision|bugfix|feature|change|discovery|refactor|config|other","title":"<=80 chars, specific","narrative":"2-5 sentences, past tense, concrete identifiers","facts":["short atomic facts"],"files":["relative/paths"],"importance":3,"entities":[{"name":"src/db.ts","kind":"file|symbol|command|library|concept"}],"relations":[{"from":"entity name","to":"entity name","rel":"uses|calls|defines|configures|depends_on|fixes|relates_to"}]}]}`;

const SUM_SYSTEM = `You are SESSION_SUMMARIZER for a developer memory system.
You receive the user prompts and extracted observations from one coding session.
Respond with ONLY a JSON object:
{"request":"what the user set out to do, 1-2 sentences","completed":"what was actually finished","learned":"non-obvious things discovered about the codebase or problem","next_steps":"open threads, TODOs, or none"}`;

const RECONCILE_SYSTEM = `You are MEMORY_RECONCILER for a developer memory system.
You receive one NEW observation and a few EXISTING observations about the same code. Decide, strictly:
- "supersedes": ids of existing observations whose facts the new one makes outdated or wrong (the state changed, a decision was reversed, a path/name/config moved). Only when the new observation clearly replaces them.
- "duplicate_of": the id of an existing observation that already says the same thing (no new information), else null.
When unsure, leave lists empty. Respond with ONLY a JSON object: {"supersedes":[ids],"duplicate_of":id|null}`;

const DIGEST_SYSTEM = `You are DIGEST_WRITER for a developer memory system.
You receive many older observations from one project over a period. Write a dense project digest in markdown (max 400 words): architecture facts, standing decisions, recurring gotchas, file map. Drop transient details. No preamble.`;

interface ObsOut {
  observations: Array<{ type?: string; title: string; narrative: string; facts?: string[]; files?: string[]; importance?: number; entities?: EntityIn[]; relations?: RelationIn[] }>;
}

interface ReconcileOut {
  supersedes?: number[];
  duplicate_of?: number | null;
}

interface SumOut {
  request: string;
  completed: string;
  learned: string;
  next_steps: string;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `... [${s.length - n} more chars]` : s;
}

async function runObserve(db: Database, promptId: number): Promise<void> {
  const s = loadSettings();
  const prompt = db
    .query<{ id: number; session_id: number; text: string; created_at: number }, [number]>(
      "SELECT id, session_id, text, created_at FROM prompts WHERE id = ?",
    )
    .get(promptId);
  if (!prompt) return;
  const session = db
    .query<{ project_id: string }, [number]>("SELECT project_id FROM sessions WHERE id = ?")
    .get(prompt.session_id)!;
  const events = db
    .query<{ tool_name: string; input: string; output: string }, [number, number]>(
      "SELECT tool_name, input, output FROM events WHERE prompt_id = ? ORDER BY id LIMIT ?",
    )
    .all(promptId, s.maxPromptEvents);
  if (events.length === 0) return;

  const lines: string[] = [`USER PROMPT: ${trunc(prompt.text, 2000)}`, "", "TOOL EVENTS:"];
  let budget = 60000;
  for (const [i, e] of events.entries()) {
    const block = `--- [${i + 1}] ${e.tool_name}\ninput: ${trunc(e.input, 1500)}\noutput: ${trunc(e.output, s.maxEventChars)}`;
    if (budget - block.length < 0) {
      lines.push(`--- (${events.length - i} more events omitted)`);
      break;
    }
    budget -= block.length;
    lines.push(block);
  }

  const res = await complete(OBS_SYSTEM, lines.join("\n"), 2500);
  const parsed = extractJson<ObsOut>(res.text);
  const obs = (parsed.observations ?? []).filter((o) => o.title && o.narrative).slice(0, 6);
  if (obs.length === 0) return;

  const vectors = await embed(obs.map((o) => `${o.title}\n${o.narrative}\n${(o.facts ?? []).join("\n")}`));
  const insert = db.query(
    `INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at, importance, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const inserted: number[] = [];
  const tx = db.transaction(() => {
    obs.forEach((o, i) => {
      const r = insert.run(
        session.project_id,
        prompt.session_id,
        promptId,
        (o.type || "other").toLowerCase(),
        o.title.slice(0, 120),
        o.narrative,
        JSON.stringify((o.facts ?? []).map(String).slice(0, 12)),
        JSON.stringify((o.files ?? []).map(String).slice(0, 20)),
        prompt.created_at,
        Math.min(5, Math.max(1, Number(o.importance) || 3)),
        vectors ? floatsToBlob(vectors[i]) : null,
      );
      const row = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(Number(r.lastInsertRowid))!;
      linkObservation(db, row, Array.isArray(o.entities) ? o.entities : [], Array.isArray(o.relations) ? o.relations : []);
      inserted.push(row.id);
    });
    db.query("DELETE FROM events WHERE prompt_id = ?").run(promptId);
  });
  tx();
  for (const id of inserted) {
    await reconcile(db, id);
    await checkRecurring(db, id);
  }
}
const LESSON_SYSTEM = `You are LESSON_WRITER for a developer memory system.
The same thing has been fixed repeatedly across separate sessions; the fix is not sticking. From the bugfix observations below, write one durable lesson so it never has to be rediscovered.
Respond with ONLY a JSON object: {"title":"Recurring: <what breaks>, <=80 chars","narrative":"what keeps breaking, why, and the rule to follow; 2-4 sentences","facts":["imperative rules, one each, max 5"]}`;

interface LessonOut { title?: string; narrative?: string; facts?: string[] }

// Recurring-failure detector: bugfix observations that share an entity across >= threshold distinct sessions become a
// pinned "lesson" memory (one per entity, updated as the count grows) so the rule is injected every session.
export async function checkRecurring(db: Database, obsId: number): Promise<number[]> {
  const s = loadSettings();
  const o = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(obsId);
  if (!o || o.type !== "bugfix") return [];
  const ents = db
    .query<{ id: number; name: string; kind: string }, [number]>("SELECT e.id, e.name, e.kind FROM observation_entities oe JOIN entities e ON e.id = oe.entity_id WHERE oe.observation_id = ?")
    .all(obsId);
  const made: number[] = [];
  for (const e of ents) {
    if (GENERIC_ENTITY.test(e.name)) continue;
    const fixes = db
      .query<ObservationRow, [number, string, number]>(
        `SELECT o.* FROM observations o JOIN observation_entities oe ON oe.observation_id = o.id
         WHERE oe.entity_id = ? AND o.type = 'bugfix' AND o.project_id = ? AND o.created_at > ? ORDER BY o.created_at DESC LIMIT 12`,
      )
      .all(e.id, o.project_id, now() - 90 * 86400000);
    const sessions = new Set(fixes.map((f) => f.session_id));
    if (sessions.size < s.recurringThreshold) continue;
    const id = await writeLesson(db, o.project_id, e, fixes, sessions.size);
    if (id) made.push(id);
  }
  return made;
}

const GENERIC_ENTITY = /^(readme\.md|package\.json|\.gitignore|src|tests?|main|index|app|utils?|config|settings)$/i;

async function writeLesson(db: Database, projectId: string, e: { id: number; name: string; kind: string }, fixes: ObservationRow[], sessions: number): Promise<number | null> {
  const key = `lesson:${projectId}:${e.id}`;
  const existing = Number(getMeta(db, key) ?? 0);
  const prev = existing ? db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(existing) : null;
  if (prev && Number(getMeta(db, `${key}:n`) ?? 0) >= sessions) return null; // nothing new since the last lesson
  const user = [`ENTITY: ${e.kind} ${e.name}`, `FIXED IN ${sessions} SEPARATE SESSIONS:`,
    ...fixes.map((f) => `- [${new Date(f.created_at).toISOString().slice(0, 10)}] ${f.title}: ${trunc(f.narrative, 400)}${f.facts !== "[]" ? ` facts: ${trunc(f.facts, 200)}` : ""}`)].join("\n");
  let out: LessonOut = {};
  try { out = extractJson<LessonOut>((await complete(LESSON_SYSTEM, user, 500)).text); } catch (err) { appendLog(`lesson for ${e.name} fell back: ${String((err as Error).message).slice(0, 100)}`); }
  const title = (out.title || `Recurring: ${e.name} keeps needing the same fix`).slice(0, 120);
  const narrative = out.narrative || `${e.name} has been fixed in ${sessions} separate sessions (${fixes.slice(0, 4).map((f) => f.title).join("; ")}). Check memory for the established fix before changing it again.`;
  const facts = (Array.isArray(out.facts) ? out.facts.map(String).filter(Boolean).slice(0, 5) : []);
  const files = [...new Set(fixes.flatMap((f) => { try { return JSON.parse(f.files) as string[]; } catch { return []; } }))].slice(0, 10);
  const v = await embed([`${title}\n${narrative}\n${facts.join("\n")}`]);
  let id = existing;
  db.transaction(() => {
    if (prev && !prev.archived) {
      db.query("UPDATE observations SET title = ?, narrative = ?, facts = ?, files = ?, pinned = 1, importance = 5, embedding = ?, created_at = ? WHERE id = ?")
        .run(title, narrative, JSON.stringify(facts), JSON.stringify(files), v ? floatsToBlob(v[0]) : null, now(), existing);
    } else {
      const sid = fixes[0].session_id;
      id = Number(db.query(
        `INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at, pinned, source, importance, embedding)
         VALUES (?, ?, NULL, 'lesson', ?, ?, ?, ?, ?, 1, 'auto', 5, ?)`,
      ).run(projectId, sid, title, narrative, JSON.stringify(facts), JSON.stringify(files), now(), v ? floatsToBlob(v[0]) : null).lastInsertRowid);
      setMeta(db, key, String(id));
    }
    setMeta(db, `${key}:n`, String(sessions));
    const row = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(id)!;
    linkObservation(db, row, [{ name: e.name, kind: e.kind as EntityIn["kind"] }]);
  })();
  appendLog(`lesson#${id} for ${e.kind} ${e.name} (${sessions} sessions)`);
  return id;
}

// Sweep used by maintenance: every bugfix of the last 90 days gets the recurrence check (cheap; lessons dedupe by entity).
export async function sweepRecurring(db: Database): Promise<number> {
  const ids = db.query<{ id: number }, [number]>("SELECT id FROM observations WHERE type = 'bugfix' AND created_at > ? ORDER BY created_at DESC LIMIT 400").all(now() - 90 * 86400000);
  const made = new Set<number>();
  for (const r of ids) for (const id of await checkRecurring(db, r.id)) made.add(id);
  return made.size;
}


// Candidates an observation might update: nearest by vector, plus those sharing 2+ graph entities. Active, same project.
function relatedCandidates(db: Database, o: ObservationRow, limit = 6): ObservationRow[] {
  const out = new Map<number, ObservationRow>();
  const v = blobToFloats(o.embedding);
  if (v) {
    const rows = db
      .query<ObservationRow, [string, number]>("SELECT * FROM observations WHERE project_id = ? AND archived = 0 AND id != ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 1500")
      .all(o.project_id, o.id)
      .map((r) => ({ r, s: cosine(v, blobToFloats(r.embedding)!) }))
      .filter((x) => x.s >= 0.72)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    for (const x of rows) out.set(x.r.id, x.r);
  }
  const shared = db
    .query<ObservationRow, [number, string, number]>(
      `SELECT o.*, COUNT(*) n FROM observation_entities a JOIN observation_entities b ON b.entity_id = a.entity_id AND b.observation_id != a.observation_id
       JOIN observations o ON o.id = b.observation_id
       WHERE a.observation_id = ? AND o.project_id = ? AND o.archived = 0 AND o.id != ? GROUP BY o.id HAVING n >= 2 ORDER BY n DESC LIMIT 6`,
    )
    .all(o.id, o.project_id, o.id);
  for (const r of shared) if (out.size < limit + 4) out.set(r.id, r);
  return [...out.values()];
}

// Write-time reconciliation: the moment a new fact arrives, retire the older facts it replaces (or itself if redundant).
export async function reconcile(db: Database, obsId: number): Promise<{ superseded: number[]; duplicateOf: number | null }> {
  const o = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(obsId);
  const none = { superseded: [] as number[], duplicateOf: null as number | null };
  if (!o || o.archived) return none;
  const cands = relatedCandidates(db, o).filter((c) => c.created_at <= o.created_at && !c.pinned);
  if (!cands.length) return none;
  const fmt = (r: ObservationRow) => `#${r.id} [${new Date(r.created_at).toISOString().slice(0, 10)}] [${r.type}] ${r.title}\n${trunc(r.narrative, 500)}\nfacts: ${trunc(r.facts, 300)}`;
  const user = [`NEW OBSERVATION:\n${fmt(o)}`, "", "EXISTING OBSERVATIONS:", ...cands.map(fmt)].join("\n");
  let parsed: ReconcileOut;
  try {
    parsed = extractJson<ReconcileOut>((await complete(RECONCILE_SYSTEM, user, 300)).text);
  } catch (e) {
    appendLog(`reconcile#${obsId} skipped: ${String((e as Error).message).slice(0, 120)}`);
    return none;
  }
  const ids = new Set(cands.map((c) => c.id));
  const superseded = (parsed.supersedes ?? []).map(Number).filter((id) => ids.has(id));
  const dup = parsed.duplicate_of != null && ids.has(Number(parsed.duplicate_of)) ? Number(parsed.duplicate_of) : null;
  db.transaction(() => {
    if (dup != null && o.source === "auto") {
      // redundant: keep the established memory, fold the newcomer into it
      db.query("UPDATE observations SET archived = 1, superseded_by = ? WHERE id = ?").run(dup, o.id);
      db.query("UPDATE observations SET alpha = alpha + 0.5 WHERE id = ?").run(dup);
    } else {
      for (const id of superseded) db.query("UPDATE observations SET archived = 1, superseded_by = ? WHERE id = ? AND pinned = 0").run(o.id, id);
    }
  })();
  if (superseded.length || dup != null) appendLog(`reconcile#${obsId}: supersedes [${superseded.join(",")}]${dup != null ? ` duplicate_of #${dup}` : ""}`);
  return { superseded: dup != null && o.source === "auto" ? [] : superseded, duplicateOf: o.source === "auto" ? dup : null };
}


async function runSummarize(db: Database, sessionId: number): Promise<void> {
  const session = db
    .query<{ project_id: string; started_at: number }, [number]>("SELECT project_id, started_at FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!session) return;
  const prompts = db
    .query<{ text: string }, [number]>("SELECT text FROM prompts WHERE session_id = ? ORDER BY prompt_no")
    .all(sessionId);
  const obs = db
    .query<ObservationRow, [number]>("SELECT * FROM observations WHERE session_id = ? ORDER BY id")
    .all(sessionId);
  if (prompts.length === 0 && obs.length === 0) return;
  if (obs.length === 0 && prompts.every((p) => p.text.length < 40)) return;

  const user = [
    "USER PROMPTS:",
    ...prompts.map((p, i) => `${i + 1}. ${trunc(p.text, 600)}`),
    "",
    "OBSERVATIONS:",
    ...obs.map((o) => `- [${o.type}] ${o.title}: ${trunc(o.narrative, 600)}`),
  ].join("\n");
  const res = await complete(SUM_SYSTEM, user, 1200);
  const p = extractJson<SumOut>(res.text);
  const text = `${p.request}\n${p.completed}\n${p.learned}\n${p.next_steps}`;
  const v = await embed([text]);
  db.query(
    `INSERT INTO summaries(project_id, session_id, request, completed, learned, next_steps, created_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET request = excluded.request, completed = excluded.completed,
       learned = excluded.learned, next_steps = excluded.next_steps, embedding = excluded.embedding`,
  ).run(
    session.project_id,
    sessionId,
    p.request ?? "",
    p.completed ?? "",
    p.learned ?? "",
    p.next_steps ?? "",
    now(),
    v ? floatsToBlob(v[0]) : null,
  );
  db.query("UPDATE sessions SET summarized = 1 WHERE id = ?").run(sessionId);
}

async function runConsolidate(db: Database): Promise<void> {
  const s = loadSettings();
  const cutoff = now() - s.consolidateAfterDays * 86400000;
  const projects = db
    .query<{ project_id: string; n: number }, [number]>(
      "SELECT project_id, COUNT(*) AS n FROM observations WHERE archived = 0 AND created_at < ? GROUP BY project_id HAVING n >= 8",
    )
    .all(cutoff);
  for (const p of projects) {
    const old = db
      .query<ObservationRow, [string, number]>(
        "SELECT * FROM observations WHERE project_id = ? AND archived = 0 AND created_at < ? ORDER BY created_at LIMIT 150",
      )
      .all(p.project_id, cutoff);
    if (old.length < 8) continue;
    const prior = db
      .query<{ content: string }, [string]>("SELECT content FROM digests WHERE project_id = ? ORDER BY period_end DESC LIMIT 1")
      .get(p.project_id);
    const user = [
      prior ? `PREVIOUS DIGEST (fold into the new one):\n${prior.content}\n` : "",
      "OBSERVATIONS:",
      ...old.map((o) => `- [${new Date(o.created_at).toISOString().slice(0, 10)}] [${o.type}] ${o.title}: ${trunc(o.narrative, 400)}`),
    ].join("\n");
    const res = await complete(DIGEST_SYSTEM, user, 1500);
    const content = res.text.trim();
    if (!content) continue;
    const v = await embed([content]);
    const ids = old.map((o) => o.id);
    const tx = db.transaction(() => {
      db.query(
        "INSERT INTO digests(project_id, period_start, period_end, content, source_count, created_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(p.project_id, old[0].created_at, old[old.length - 1].created_at, content, old.length, now(), v ? floatsToBlob(v[0]) : null);
      db.query(`UPDATE observations SET archived = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    });
    tx();
  }
  setMeta(db, "last_consolidation", String(now()));
}

async function runEmbed(db: Database, obsId: number): Promise<void> {
  const o = db.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(obsId);
  if (!o) return;
  let facts: string[] = [];
  try { facts = JSON.parse(o.facts); } catch { /* ignore */ }
  const v = await embed([[o.title, o.narrative, ...facts].join("\n")]);
  if (!v) return; // embeddings unavailable: job still completes, re-embed later
  db.query("UPDATE observations SET embedding = ? WHERE id = ?").run(floatsToBlob(v[0]), obsId);
  await reconcile(db, obsId);
}

// Queue an embed job for every live observation lacking a vector (optionally one project). Returns how many were queued.
export function enqueueMissingEmbeddings(db: Database, projectId?: string): number {
  const rows = projectId
    ? db.query<{ id: number }, [string]>("SELECT id FROM observations WHERE embedding IS NULL AND archived = 0 AND project_id = ?").all(projectId)
    : db.query<{ id: number }, []>("SELECT id FROM observations WHERE embedding IS NULL AND archived = 0").all();
  db.transaction(() => { for (const r of rows) enqueue(db, "embed", r.id); })();
  return rows.length;
}

function maybeScheduleConsolidation(db: Database): void {
  const s = loadSettings();
  const last = Number(getMeta(db, "last_consolidation") ?? 0);
  if (now() - last > s.consolidateEveryHours * 3600000) enqueue(db, "consolidate", Math.floor(now() / 3600000));
  let lastMaint = 0;
  try { lastMaint = Number(JSON.parse(getMeta(db, "last_maintenance") ?? "{}").at ?? 0); } catch { /* ignore */ }
  if (now() - lastMaint > s.maintainEveryHours * 3600000) enqueue(db, "maintain", Math.floor(now() / 3600000));
}

async function handle(db: Database, job: Job): Promise<void> {
  if (job.kind === "observe") await runObserve(db, job.ref_id);
  else if (job.kind === "summarize") await runSummarize(db, job.ref_id);
  else if (job.kind === "consolidate") await runConsolidate(db);
  else if (job.kind === "embed") await runEmbed(db, job.ref_id);
  else if (job.kind === "maintain") { runMaintain(db); await sweepRecurring(db); }
}

export async function drain(db: Database, opts: { maxJobs?: number; quiet?: boolean } = {}): Promise<number> {
  if (!acquireLock(db, LOCK, OWNER, LOCK_TTL)) return 0;
  let done = 0;
  appendLog(`start (${loadSettings().llm} llm)`);
  try {
    maybeScheduleConsolidation(db);
    for (;;) {
      if (opts.maxJobs && done >= opts.maxJobs) break;
      const job = claimNextJob(db);
      if (!job) break;
      renewLock(db, LOCK, OWNER, LOCK_TTL);
      const t0 = Date.now();
      try {
        await handle(db, job);
        finishJob(db, job.id, true);
        appendLog(`${job.kind}#${job.ref_id} done in ${Date.now() - t0}ms`);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 500);
        finishJob(db, job.id, false, msg);
        appendLog(`${job.kind}#${job.ref_id} failed: ${msg} (attempt ${job.attempts})`);
        if (!opts.quiet) process.stderr.write(`[recall] job ${job.kind}#${job.ref_id} failed: ${msg}\n`);
      }
      done++;
    }
  } finally {
    releaseLock(db, LOCK, OWNER);
    appendLog(`exit after ${done} job(s)`);
  }
  return done;
}

if (import.meta.main) {
  const db = openDb();
  // small delay lets a burst of hooks enqueue before we start claiming
  await Bun.sleep(1500);
  const n = await drain(db, { quiet: env("DEBUG") !== "1" });
  if (env("DEBUG") === "1") process.stderr.write(`[recall] processed ${n} jobs\n`);
  db.close();
}
