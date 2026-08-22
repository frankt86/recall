import { enqueue, openDb } from "../db";
import { ensureSession, guardInternal, readHookInput, spawnProcessor } from "../hook-io";

guardInternal();

const input = await readHookInput();
if (input.stop_hook_active) process.exit(0);
const db = openDb();
const { sessionId } = ensureSession(db, input);
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
db.close();
if (needSpawn) spawnProcessor();
