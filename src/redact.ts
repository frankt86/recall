// Redaction runs before anything hits the database or a model. Default on.

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_\-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/sk-(proj-|live-|test-)?[A-Za-z0-9_\-]{20,}/g, "[REDACTED_API_KEY]"],
  [/(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
  [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED_GOOGLE_KEY]"],
  [/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "[REDACTED_JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/(Bearer|Basic)\s+[A-Za-z0-9_\-\.=+\/]{16,}/gi, "$1 [REDACTED]"],
  [/((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^:\s\/]+:)[^@\s]+@/gi, "$1[REDACTED]@"],
  [/(DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=)[^;\s]+/gi, "$1[REDACTED]"],
  [/(SharedAccessSignature=|sig=)[A-Za-z0-9%+\/=]{20,}/gi, "$1[REDACTED]"],
  [/\b(dapi[0-9a-f]{32})\b/g, "[REDACTED_DATABRICKS_TOKEN]"],
  [/((?:api[_\-]?key|secret|token|password|passwd|pwd|client[_\-]?secret|access[_\-]?key)\s*[=:]\s*["']?)([^\s"',;]{8,})/gi, "$1[REDACTED]"],
];

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[private]");
}

export function pathIsSensitive(path: string, patterns: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  return patterns.some((pat) => new RegExp(pat, "i").test(p));
}
