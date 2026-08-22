import { parseArgs } from "node:util";

export type OptSpec = { type: "string" | "boolean"; short?: string; help: string; required?: boolean; default?: string | boolean };
export interface CommandSpec<T = Record<string, string | boolean | undefined>> {
  name: string;
  summary: string;
  options: Record<string, OptSpec>;
  run: (opts: T) => Promise<void> | void;
}

export class UsageError extends Error {
  constructor(msg: string, public readonly spec?: CommandSpec) {
    super(msg);
  }
}

export function usage(spec: CommandSpec): string {
  const names = Object.keys(spec.options);
  const flags = names.map((n) => {
    const o = spec.options[n];
    const v = o.type === "string" ? ` <${n}>` : "";
    return o.required ? `--${n}${v}` : `[--${n}${v}]`;
  });
  const lines = [`usage: recall ${spec.name} ${flags.join(" ")}`.trimEnd(), `  ${spec.summary}`];
  if (names.length) {
    lines.push("");
    const w = Math.max(...names.map((n) => n.length)) + 2;
    for (const n of names) {
      const o = spec.options[n];
      const left = `  --${n}${o.short ? `, -${o.short}` : ""}`.padEnd(w + 8);
      const def = o.default !== undefined && o.default !== false ? ` (default: ${o.default})` : "";
      lines.push(`${left}${o.help}${o.required ? " (required)" : def}`);
    }
  }
  return lines.join("\n");
}

/** Parse argv for one command; throws UsageError with usage text on bad input. */
export function parseCommand<T>(spec: CommandSpec<T>, argv: string[]): T {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = { help: { type: "boolean", short: "h" } };
  for (const [n, o] of Object.entries(spec.options)) options[n] = o.short ? { type: o.type, short: o.short } : { type: o.type };
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options, allowPositionals: false, strict: true }));
  } catch (e) {
    const m = (e as Error).message
      .replace(/^Unknown option '(.*?)'.*$/s, "unknown option $1")
      .replace(/^Option '(.*?)' argument is missing.*$/s, "option $1 needs a value")
      .replace(/^Unexpected argument '(.*?)'.*$/s, "unexpected argument $1");
    throw new UsageError(m, spec as CommandSpec);
  }
  if (values.help) {
    console.log(usage(spec as CommandSpec));
    process.exit(0);
  }
  for (const [n, o] of Object.entries(spec.options)) {
    if (values[n] === undefined && o.default !== undefined) values[n] = o.default;
    if (o.required && values[n] === undefined) throw new UsageError(`--${n} is required`, spec as CommandSpec);
  }
  return values as T;
}

export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function portOption(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`invalid port: ${v}`);
  return n;
}
