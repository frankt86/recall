import { Database } from "bun:sqlite";
import { dbPath } from "./settings";

export type JobKind = "observe" | "summarize" | "consolidate" | "embed" | "maintain";
export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface Job {
  id: number;
  kind: JobKind;
  ref_id: number;
  status: JobStatus;
  attempts: number;
  claimed_at: number | null;
  error: string | null;
  created_at: number;
}

export interface ObservationRow {
  id: number;
  project_id: string;
  session_id: number;
  prompt_id: number | null;
  type: string;
  title: string;
  narrative: string;
  facts: string;
  files: string;
  created_at: number;
  alpha: number;
  beta: number;
  archived: number;
  pinned: number;
  source: string;
  superseded_by: number | null;
  importance: number;
  embedding: Uint8Array | null;
}

export interface SummaryRow {
  id: number;
  project_id: string;
  session_id: number;
  request: string;
  completed: string;
  learned: string;
  next_steps: string;
  created_at: number;
  embedding: Uint8Array | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  remote TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summarized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, prompt_no)
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, prompt_no DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_prompt ON events(prompt_id, id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  prompt_id INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  alpha REAL NOT NULL DEFAULT 1.0,
  beta REAL NOT NULL DEFAULT 1.0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',
  superseded_by INTEGER,
  importance REAL NOT NULL DEFAULT 3,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id, archived, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, narrative, facts, content='observations', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts) VALUES ('delete', old.id, old.title, old.narrative, old.facts);
END;
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE OF title, narrative, facts ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts) VALUES ('delete', old.id, old.title, old.narrative, old.facts);
  INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts);
END;

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id INTEGER NOT NULL UNIQUE,
  request TEXT NOT NULL,
  completed TEXT NOT NULL,
  learned TEXT NOT NULL,
  next_steps TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_sum_project ON summaries(project_id, created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  request, completed, learned, next_steps, content='summaries', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS sum_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, request, completed, learned, next_steps) VALUES (new.id, new.request, new.completed, new.learned, new.next_steps);
END;
CREATE TRIGGER IF NOT EXISTS sum_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, request, completed, learned, next_steps) VALUES ('delete', old.id, old.request, old.completed, old.learned, old.next_steps);
END;

CREATE TABLE IF NOT EXISTS context_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  query TEXT NOT NULL,
  items TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_project ON context_log(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_digest_project ON digests(project_id, period_end DESC);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(project_id, name, kind)
);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id, kind);
CREATE TABLE IF NOT EXISTS observation_entities (
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY(observation_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_obs_entities_entity ON observation_entities(entity_id);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  src INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rel TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL,
  UNIQUE(src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id, weight DESC);

CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

let instance: Database | null = null;

export function openDb(path = dbPath()): Database {
  if (instance) return instance;
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  migrate(db);
  instance = db;
  return db;
}

// Additive, idempotent upgrades for databases created before a column existed.
function migrate(db: Database): void {
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(observations)").all().map((c) => c.name));
  if (!cols.has("pinned")) db.exec("ALTER TABLE observations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("source")) db.exec("ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'");
  if (!cols.has("superseded_by")) db.exec("ALTER TABLE observations ADD COLUMN superseded_by INTEGER");
  if (!cols.has("importance")) db.exec("ALTER TABLE observations ADD COLUMN importance REAL NOT NULL DEFAULT 3");
  db.exec("CREATE INDEX IF NOT EXISTS idx_obs_pinned ON observations(project_id, pinned) WHERE pinned = 1");
  setMeta(db, "schema_version", "4");
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export const now = (): number => Date.now();

export function getMeta(db: Database, key: string): string | null {
  const r = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
  return r?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function enqueue(db: Database, kind: JobKind, refId: number): void {
  db.query(
    `INSERT INTO jobs(kind, ref_id, status, created_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(kind, ref_id) DO UPDATE SET status = CASE WHEN jobs.status = 'done' THEN 'done' ELSE 'pending' END`,
  ).run(kind, refId, now());
}

const STALE_MS = 10 * 60 * 1000;

export function claimNextJob(db: Database): Job | null {
  const t = now();
  db.query(
    `UPDATE jobs SET status = 'pending', claimed_at = NULL
     WHERE status = 'processing' AND claimed_at < ?`,
  ).run(t - STALE_MS);
  const row = db
    .query<Job, [number, number]>(
      `UPDATE jobs SET status = 'processing', claimed_at = ?, attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND attempts < 3 ORDER BY id LIMIT 1)
       AND ? > 0
       RETURNING *`,
    )
    .get(t, 1);
  return row ?? null;
}

export function finishJob(db: Database, id: number, ok: boolean, error?: string): void {
  if (ok) {
    db.query("UPDATE jobs SET status = 'done', error = NULL WHERE id = ?").run(id);
  } else {
    db.query(
      `UPDATE jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, claimed_at = NULL, error = ? WHERE id = ?`,
    ).run(error ?? "unknown", id);
  }
}

export function pendingCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','processing')").get()!.n;
}

export function acquireLock(db: Database, name: string, owner: string, ttlMs: number): boolean {
  const t = now();
  const r = db
    .query(
      `INSERT INTO locks(name, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE locks.expires_at < ? OR locks.owner = excluded.owner`,
    )
    .run(name, owner, t + ttlMs, t);
  return r.changes > 0;
}

export function renewLock(db: Database, name: string, owner: string, ttlMs: number): void {
  db.query("UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?").run(now() + ttlMs, name, owner);
}

export function releaseLock(db: Database, name: string, owner: string): void {
  db.query("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
}

export function floatsToBlob(v: Float32Array | number[]): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function blobToFloats(b: Uint8Array | null): Float32Array | null {
  if (!b) return null;
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
