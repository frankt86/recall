import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCliLink, removeCliLink } from "../src/link";

let n = 0;
function fixture(): { home: string; root: string } {
  const base = `/tmp/recall-link-${process.pid}-${n++}`;
  const home = join(base, "home");
  const root = join(base, "plugin");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "recall"), "#!/usr/bin/env bash\n");
  mkdirSync(home, { recursive: true });
  return { home, root };
}

test("links into a PATH dir when one is writable, idempotently", () => {
  const { home, root } = fixture();
  const bin = join(home, ".local", "bin");
  const e = { home, pathVar: `${bin}:/usr/bin`, platform: "linux" as const };
  const r = ensureCliLink(root, e);
  expect(r).toMatchObject({ ok: true, action: "linked", dir: bin });
  expect(readlinkSync(join(bin, "recall"))).toBe(join(root, "bin", "recall"));
  expect(existsSync(join(home, ".bashrc"))).toBe(false); // no profile edit needed
  expect(ensureCliLink(root, e).action).toBe("unchanged");
});

test("re-points a stale link from an old plugin location", () => {
  const { home, root } = fixture();
  const { root: oldRoot } = fixture();
  const bin = join(home, ".local", "bin");
  const e = { home, pathVar: bin, platform: "linux" as const };
  ensureCliLink(oldRoot, e);
  const r = ensureCliLink(root, e);
  expect(r.ok).toBe(true);
  expect(readlinkSync(join(bin, "recall"))).toBe(join(root, "bin", "recall"));
});

test("no PATH candidate: creates ~/.local/bin and adds a guarded profile line once", () => {
  const { home, root } = fixture();
  const e = { home, pathVar: "/usr/bin", shell: "/bin/bash", platform: "linux" as const };
  const r = ensureCliLink(root, e);
  expect(r).toMatchObject({ ok: true, action: "linked" });
  const rc = readFileSync(join(home, ".bashrc"), "utf8");
  expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"');
  ensureCliLink(root, e);
  expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(rc); // marker prevents duplicates
});

test("profile: false never creates PATH entries or touches rc files", () => {
  const { home, root } = fixture();
  const r = ensureCliLink(root, { home, pathVar: "/usr/bin", shell: "/bin/bash", platform: "linux", profile: false });
  expect(r).toMatchObject({ ok: false, action: "skipped" });
  expect(existsSync(join(home, ".bashrc"))).toBe(false);
});

test("refuses to touch a foreign `recall` file", () => {
  const { home, root } = fixture();
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "recall"), "someone else's tool");
  const r = ensureCliLink(root, { home, pathVar: bin, platform: "linux" });
  expect(r.ok).toBe(false);
  expect(readFileSync(join(bin, "recall"), "utf8")).toBe("someone else's tool");
});

test("remove undoes the symlink and the profile line", () => {
  const { home, root } = fixture();
  const e = { home, pathVar: "/usr/bin", shell: "/bin/bash", platform: "linux" as const };
  ensureCliLink(root, e);
  const r = removeCliLink(e);
  expect(r.action).toBe("removed");
  expect(existsSync(join(home, ".local", "bin", "recall"))).toBe(false);
  const rc = readFileSync(join(home, ".bashrc"), "utf8");
  expect(rc).not.toContain("recall");
});
