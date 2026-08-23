import { loadSettings } from "./settings";

export interface LlmResult {
  text: string;
  provider: "api" | "cli" | "fake";
}

function pickProvider(): "api" | "cli" | "fake" {
  const s = loadSettings();
  if (s.llm !== "auto") return s.llm;
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return "cli";
}

async function viaApi(system: string, user: string, model: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

async function viaCli(system: string, user: string, model: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CLAUDECODE" && k !== "CLAUDE_CODE_ENTRYPOINT") env[k] = v;
  }
  env.RECALL_INTERNAL = "1"; // our hooks exit immediately inside this child
  const args = [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--system-prompt",
    system,
  ];
  // windowsHide: the processor runs detached without a console, so a console child would otherwise pop a visible window
  const proc = Bun.spawn(args, { stdin: new Blob([user]), stdout: "pipe", stderr: "pipe", env, windowsHide: true });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`claude cli exit ${code}: ${err.slice(0, 300)}`);
  try {
    const parsed = JSON.parse(out) as { result?: string };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // fall through to raw
  }
  return out;
}

function fake(system: string, user: string): string {
  if (system.includes("OBSERVATION_EXTRACTOR")) {
    const title = user.split("\n").find((l) => l.startsWith("USER PROMPT:"))?.slice(12).trim() || "Work done";
    return JSON.stringify({
      observations: [
        {
          type: "change",
          title: title.slice(0, 80),
          narrative: "Fake narrative for test mode covering the prompt: " + title,
          facts: ["fake fact one", "fake fact two"],
          files: ["src/example.ts"],
        },
      ],
    });
  }
  if (system.includes("MEMORY_RECONCILER")) {
    // Test mode: a candidate whose title contains "[stale]" is superseded, one containing "[dup]" is a duplicate.
    const supersedes = [...user.matchAll(/^#(\d+) .*\[stale\]/gm)].map((m) => Number(m[1]));
    const dup = user.match(/^#(\d+) .*\[dup\]/m);
    return JSON.stringify({ supersedes, duplicate_of: dup ? Number(dup[1]) : null });
  }
  if (system.includes("LESSON_WRITER")) {
    const ent = user.match(/^ENTITY: \S+ (.+)$/m)?.[1] ?? "thing";
    return JSON.stringify({ title: `Recurring: ${ent} keeps breaking`, narrative: `Fake lesson about ${ent}.`, facts: ["Check memory first", "Apply the established fix"] });
  }
  if (system.includes("SESSION_SUMMARIZER")) {
    return JSON.stringify({
      request: "Fake request",
      completed: "Fake completed",
      learned: "Fake learned",
      next_steps: "Fake next steps",
    });
  }
  return "Fake digest content for the period.";
}

export async function complete(system: string, user: string, maxTokens = 2000): Promise<LlmResult> {
  const s = loadSettings();
  const provider = pickProvider();
  if (provider === "fake") return { text: fake(system, user), provider };
  if (provider === "api") return { text: await viaApi(system, user, s.model, maxTokens), provider };
  if (provider === "cli") return { text: await viaCli(system, user, s.model), provider };
  throw new Error(`unknown llm provider "${String(provider)}" (expected auto|api|cli|fake)`);
}

export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no json object in model output");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
