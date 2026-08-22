import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import {
  acquireLock,
  claimNextJob,
  enqueue,
  finishJob,
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
import { embed } from "./embed";
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
Respond with ONLY a JSON object:
{"observations":[{"type":"decision|bugfix|feature|change|discovery|refactor|config|other","title":"<=80 chars, specific","narrative":"2-5 sentences, past tense, concrete identifiers","facts":["short atomic facts"],"files":["relative/paths"]}]}`;

const SUM_SYSTEM = `You are SESSION_SUMMARIZER for a developer memory system.
You receive the user prompts and extracted observations from one coding session.
Respond with ONLY a JSON object:
{"request":"what the user set out to do, 1-2 sentences","completed":"what was actually finished","learned":"non-obvious things discovered about the codebase or problem","next_steps":"open threads, TODOs, or none"}`;

const DIGEST_SYSTEM = `You are DIGEST_WRITER for a developer memory system.
You receive many older observations from one project over a period. Write a dense project digest in markdown (max 400 words): architecture facts, standing decisions, recurring gotchas, file map. Drop transient details. No preamble.`;

interface ObsOut {
  observations: Array<{ type?: string; title: string; narrative: string; facts?: string[]; files?: string[] }>;
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
    `INSERT INTO observations(project_id, session_id, prompt_id, type, title, narrative, facts, files, created_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    obs.forEach((o, i) => {
      insert.run(
        session.project_id,
        prompt.session_id,
        promptId,
        (o.type || "other").toLowerCase(),
        o.title.slice(0, 120),
        o.narrative,
        JSON.stringify((o.facts ?? []).map(String).slice(0, 12)),
        JSON.stringify((o.files ?? []).map(String).slice(0, 20)),
        prompt.created_at,
        vectors ? floatsToBlob(vectors[i]) : null,
      );
    });
    db.query("DELETE FROM events WHERE prompt_id = ?").run(promptId);
  });
  tx();
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

function maybeScheduleConsolidation(db: Database): void {
  const s = loadSettings();
  const last = Number(getMeta(db, "last_consolidation") ?? 0);
  if (now() - last > s.consolidateEveryHours * 3600000) enqueue(db, "consolidate", Math.floor(now() / 3600000));
}

async function handle(db: Database, job: Job): Promise<void> {
  if (job.kind === "observe") await runObserve(db, job.ref_id);
  else if (job.kind === "summarize") await runSummarize(db, job.ref_id);
  else if (job.kind === "consolidate") await runConsolidate(db);
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
