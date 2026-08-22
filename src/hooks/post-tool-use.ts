import { now, openDb } from "../db";
import { ensureSession, guardInternal, readHookInput } from "../hook-io";

guardInternal();
import { pathIsSensitive, redact, stripPrivate } from "../redact";
import { loadSettings } from "../settings";

const input = await readHookInput();
const s = loadSettings();
const tool = input.tool_name ?? "unknown";
if (s.excludeToolNames.includes(tool)) process.exit(0);

const ti = (input.tool_input ?? {}) as Record<string, unknown>;
const pathLike = [ti.file_path, ti.path, ti.notebook_path].filter((v): v is string => typeof v === "string");
if (pathLike.some((p) => pathIsSensitive(p, s.excludePathPatterns))) process.exit(0);
if (tool === "Bash" && typeof ti.command === "string" && /(cat|less|more|type|Get-Content)\s+[^|]*\.(env|pem|key)\b/i.test(ti.command)) process.exit(0);

const db = openDb();
const { sessionId } = ensureSession(db, input);
let prompt = db
  .query<{ id: number }, [number]>("SELECT id FROM prompts WHERE session_id = ? AND closed = 0 ORDER BY prompt_no DESC LIMIT 1")
  .get(sessionId);
if (!prompt) {
  // tool use without a recorded prompt (resume, or hook ordering); create a placeholder
  const last = db.query<{ m: number | null }, [number]>("SELECT MAX(prompt_no) AS m FROM prompts WHERE session_id = ?").get(sessionId);
  const r = db
    .query("INSERT INTO prompts(session_id, prompt_no, text, created_at) VALUES (?, ?, ?, ?)")
    .run(sessionId, (last?.m ?? 0) + 1, "(continued session)", now());
  prompt = { id: Number(r.lastInsertRowid) };
}

const clean = (v: unknown): string => {
  const raw = typeof v === "string" ? v : JSON.stringify(v ?? "");
  const t = stripPrivate(raw);
  return (s.redact ? redact(t) : t).slice(0, s.maxEventChars * 2);
};

db.query("INSERT INTO events(prompt_id, tool_name, input, output, created_at) VALUES (?, ?, ?, ?, ?)").run(
  prompt.id,
  tool,
  clean(input.tool_input),
  clean(input.tool_response),
  now(),
);
db.close();
