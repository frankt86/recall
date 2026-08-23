import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  maintainEveryHours: number;
  retireAfterDays: number;
  maxActivePerProject: number;
  dedupeThreshold: number;
  graphEdgeDecay: number;
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
  maintainEveryHours: 12,
  retireAfterDays: 45,
  maxActivePerProject: 400,
  dedupeThreshold: 0.92,
  graphEdgeDecay: 0.95,
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

/** Read the RECALL_<name> environment variable. */
export function env(name: string): string | undefined {
  return process.env[`RECALL_${name}`];
}

export function dataDir(): string {
  const d = env("DIR") || join(homedir(), ".recall");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function dbPath(): string {
  return join(dataDir(), "memory.db");
}

export function settingsPath(): string {
  return join(dataDir(), "settings.json");
}

let cached: Settings | null = null;

// Tests that change RECALL_* env between files need a fresh read.
export function resetSettings(): void {
  cached = null;
}

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
