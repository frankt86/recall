import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  model: string;
  llm: "auto" | "api" | "cli" | "fake";
  embeddings: boolean;
  embeddingModel: string;
  contextTokenBudget: number;
  contextMaxItems: number;
  consolidateAfterDays: number;
  consolidateEveryHours: number;
  maxEventChars: number;
  maxPromptEvents: number;
  redact: boolean;
  excludeToolNames: string[];
  excludePathPatterns: string[];
}

export const DEFAULTS: Settings = {
  model: "claude-haiku-4-5-20251001",
  llm: "auto",
  embeddings: true,
  embeddingModel: "Xenova/bge-small-en-v1.5",
  contextTokenBudget: 2500,
  contextMaxItems: 12,
  consolidateAfterDays: 30,
  consolidateEveryHours: 24,
  maxEventChars: 6000,
  maxPromptEvents: 80,
  redact: true,
  excludeToolNames: ["TodoWrite", "AskUserQuestion"],
  excludePathPatterns: [
    "\\.env($|\\.)",
    "secrets?\\.(ya?ml|json|toml)$",
    "credentials(\\.json)?$",
    "id_(rsa|ed25519|ecdsa)",
    "\\.pem$",
    "\\.p12$",
    "\\.pfx$",
    "\\.kdbx$",
    "\\.netrc$",
  ],
};

/** Read RECALL_<name>, falling back to the pre-rename CLAUDE_MEM_<name>. */
export function env(name: string): string | undefined {
  return process.env[`RECALL_${name}`] ?? process.env[`CLAUDE_MEM_${name}`];
}

export const LEGACY_DIR = join(homedir(), ".claude-mem-lite");

export function dataDir(): string {
  const d = env("DIR") || join(homedir(), ".recall");
  if (!existsSync(d)) {
    // one-time move of a pre-rename data dir so existing memory is kept
    if (!env("DIR") && existsSync(LEGACY_DIR)) {
      try {
        renameSync(LEGACY_DIR, d);
      } catch {
        // rename fails across volumes or while the old db is open; copy instead and leave the original in place
        try { cpSync(LEGACY_DIR, d, { recursive: true }); } catch { /* fall through to fresh dir */ }
      }
    }
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return d;
}

export function dbPath(): string {
  return join(dataDir(), "memory.db");
}

export function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;
  const p = settingsPath();
  let fromFile: Partial<Settings> = {};
  if (existsSync(p)) {
    try {
      fromFile = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      fromFile = {};
    }
  } else {
    writeFileSync(p, JSON.stringify(DEFAULTS, null, 2));
  }
  const s: Settings = { ...DEFAULTS, ...fromFile };
  if (env("MODEL")) s.model = env("MODEL")!;
  if (env("LLM")) s.llm = env("LLM") as Settings["llm"];
  if (env("EMBEDDINGS") === "0") s.embeddings = false;
  cached = s;
  return s;
}
