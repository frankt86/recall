import { enqueue, now, openDb } from "../db";
import { ensureSession, guardInternal, readHookInput, spawnProcessor } from "../hook-io";

guardInternal();
import { redact, stripPrivate } from "../redact";
import { loadSettings } from "../settings";

const input = await readHookInput();
const db = openDb();
const s = loadSettings();
const { sessionId } = ensureSession(db, input);

// close any prompt left open (Stop hook may not have fired on interrupt)
const open = db
  .query<{ id: number; n: number }, [number]>(
    "SELECT id, (SELECT COUNT(*) FROM events e WHERE e.prompt_id = p.id) AS n FROM prompts p WHERE session_id = ? AND closed = 0",
  )
  .all(sessionId);
let needSpawn = false;
for (const p of open) {
  db.query("UPDATE prompts SET closed = 1 WHERE id = ?").run(p.id);
  if (p.n > 0) {
    enqueue(db, "observe", p.id);
    needSpawn = true;
  }
}

const last = db.query<{ m: number | null }, [number]>("SELECT MAX(prompt_no) AS m FROM prompts WHERE session_id = ?").get(sessionId);
const text = s.redact ? redact(stripPrivate(input.prompt ?? "")) : stripPrivate(input.prompt ?? "");
db.query("INSERT INTO prompts(session_id, prompt_no, text, created_at) VALUES (?, ?, ?, ?)").run(sessionId, (last?.m ?? 0) + 1, text, now());
db.close();
if (needSpawn) spawnProcessor();
