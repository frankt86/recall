// Puts `recall` on the user's shell PATH automatically. The Setup hook runs `recall link` at
// install/update, and SessionStart repairs a broken link (symlink/shim only — it never edits
// shell profiles; only an explicit `recall link` may do that). `recall link --remove` undoes
// everything; RECALL_NO_LINK=1 disables the SessionStart repair.
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

export interface LinkEnv {
  home?: string;
  pathVar?: string;
  shell?: string;
  platform?: NodeJS.Platform;
  /** false = maintain existing links only; never create PATH entries or touch shell profiles. */
  profile?: boolean;
}

export interface LinkResult {
  ok: boolean;
  action: "linked" | "unchanged" | "skipped" | "removed";
  dir?: string;
  note?: string;
}

const MARKER = "# added by recall (undo with: recall link --remove)";
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

const isOurs = (linkTarget: string) => linkTarget.endsWith(join("bin", "recall"));

function candidateDirs(home: string): string[] {
  return [join(home, ".local", "bin"), join(home, "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

function writable(dir: string, home: string): boolean {
  try {
    if (!existsSync(dir)) {
      if (!dir.startsWith(home + sep)) return false;
      mkdirSync(dir, { recursive: true });
    }
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function rcFile(home: string, shell: string): string {
  return join(home, shell.endsWith("zsh") ? ".zshrc" : ".bashrc");
}

export function ensureCliLink(pluginRoot: string, e: LinkEnv = {}): LinkResult {
  if ((e.platform ?? process.platform) === "win32") return linkWindows(pluginRoot, e);
  const home = e.home ?? homedir();
  const pathVar = e.pathVar ?? process.env.PATH ?? "";
  const target = join(pluginRoot, "bin", "recall");
  const onPath = new Set(pathVar.split(delimiter).filter(Boolean));
  let dir = candidateDirs(home).find((d) => onPath.has(d) && writable(d, home));
  let needProfile = false;
  if (!dir) {
    if (e.profile === false) return { ok: false, action: "skipped", note: "no writable PATH dir; run `recall link`" };
    dir = join(home, ".local", "bin");
    if (!writable(dir, home)) return { ok: false, action: "skipped", note: `cannot create ${dir}` };
    needProfile = true;
  }
  const link = join(dir, "recall");
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return { ok: false, action: "skipped", dir, note: `${link} exists and is not ours; not touching it` };
    const cur = readlinkSync(link);
    if (!isOurs(cur)) return { ok: false, action: "skipped", dir, note: `${link} points elsewhere; not touching it` };
    if (cur === target && !needProfile) return { ok: true, action: "unchanged", dir };
    if (cur !== target) {
      rmSync(link);
      symlinkSync(target, link);
    }
  } catch {
    try {
      symlinkSync(target, link);
    } catch (err) {
      return { ok: false, action: "skipped", dir, note: `cannot link into ${dir}: ${(err as Error).message}` };
    }
  }
  if (needProfile) {
    const rc = rcFile(home, e.shell ?? process.env.SHELL ?? "");
    const cur = existsSync(rc) ? readFileSync(rc, "utf8") : "";
    if (!cur.includes(MARKER)) writeFileSync(rc, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}\n${MARKER}\n${PATH_LINE}\n`);
    return { ok: true, action: "linked", dir, note: `added ${dir} to PATH in ${rc}; open a new terminal` };
  }
  return { ok: true, action: "linked", dir };
}

export function removeCliLink(e: LinkEnv = {}): LinkResult {
  if ((e.platform ?? process.platform) === "win32") return unlinkWindows(e);
  const home = e.home ?? homedir();
  const removed: string[] = [];
  for (const dir of candidateDirs(home)) {
    const link = join(dir, "recall");
    try {
      if (lstatSync(link).isSymbolicLink() && isOurs(readlinkSync(link))) {
        rmSync(link);
        removed.push(link);
      }
    } catch {
      // nothing there
    }
  }
  for (const rc of [join(home, ".zshrc"), join(home, ".bashrc")]) {
    if (!existsSync(rc)) continue;
    const lines = readFileSync(rc, "utf8").split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === MARKER) {
        if (lines[i + 1] === PATH_LINE) i++;
        removed.push(rc);
        continue;
      }
      out.push(lines[i]);
    }
    if (removed.includes(rc)) writeFileSync(rc, out.join("\n"));
  }
  return removed.length ? { ok: true, action: "removed", note: removed.join(", ") } : { ok: true, action: "unchanged", note: "nothing to remove" };
}

// Windows: bash-free shims in %USERPROFILE%\.recall\bin plus a user-PATH entry (registry, via
// PowerShell SetEnvironmentVariable — setx would truncate long PATHs). New terminals pick it up.
function shimDir(home: string): string {
  return join(home, ".recall", "bin");
}

function linkWindows(root: string, e: LinkEnv): LinkResult {
  const home = e.home ?? homedir();
  const dir = shimDir(home);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, action: "skipped", note: `cannot create ${dir}` };
  }
  const fwd = root.replace(/\\/g, "/");
  const win = root.replace(/\//g, "\\");
  // Never invoke bare `bash` from cmd: on many Windows machines it resolves to the WSL stub in
  // System32 (which fails with "execvpe /bin/bash" when no distro is installed), not Git Bash.
  // Prefer the plugin's own Bun, then the cached Bun, then an explicitly located Git Bash.
  const cmd = [
    "@echo off",
    `if exist "${win}\\runtime\\bun.exe" (`,
    `  "${win}\\runtime\\bun.exe" "${win}\\src\\cli.ts" %*`,
    "  exit /b",
    ")",
    `for /d %%D in ("%USERPROFILE%\\.recall\\runtime\\bun-v*") do (`,
    `  if exist "%%D\\bun.exe" (`,
    `    "%%D\\bun.exe" "${win}\\src\\cli.ts" %*`,
    "    exit /b",
    "  )",
    ")",
    `for %%B in ("%ProgramFiles%\\Git\\bin\\bash.exe" "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" "%LocalAppData%\\Programs\\Git\\bin\\bash.exe") do (`,
    `  if exist "%%~B" (`,
    `    "%%~B" "${fwd}/bin/bun.sh" "${fwd}/src/cli.ts" %*`,
    "    exit /b",
    "  )",
    ")",
    "echo recall: no runtime found. Start one Claude Code session (it stages the runtime), or install Git for Windows, then retry.",
    "exit /b 1",
    "",
  ].join("\r\n");
  const sh = `#!/usr/bin/env bash\nexec bash "${fwd}/bin/bun.sh" "${fwd}/src/cli.ts" "$@"\n`;
  let changed = false;
  for (const [name, body] of [["recall.cmd", cmd], ["recall", sh]] as const) {
    const p = join(dir, name);
    if (!existsSync(p) || readFileSync(p, "utf8") !== body) {
      writeFileSync(p, body);
      changed = true;
    }
  }
  if (e.profile === false) return { ok: true, action: changed ? "linked" : "unchanged", dir };
  const ps = `$d='${dir.replace(/'/g, "''")}';$p=[Environment]::GetEnvironmentVariable('Path','User');if(-not $p){$p=''};if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$d).Trim(';'),'User')}`;
  try {
    Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  } catch {
    return { ok: true, action: "linked", dir, note: `shims written, but could not update user PATH; add ${dir} to PATH manually` };
  }
  return { ok: true, action: changed ? "linked" : "unchanged", dir, note: "on user PATH; new terminals pick it up" };
}

function unlinkWindows(e: LinkEnv): LinkResult {
  const home = e.home ?? homedir();
  const dir = shimDir(home);
  for (const name of ["recall.cmd", "recall"]) rmSync(join(dir, name), { force: true });
  const ps = `$d='${dir.replace(/'/g, "''")}';$p=[Environment]::GetEnvironmentVariable('Path','User');if($p){[Environment]::SetEnvironmentVariable('Path',(($p -split ';' | Where-Object { $_ -and $_ -ne $d }) -join ';'),'User')}`;
  try {
    Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  } catch {
    return { ok: true, action: "removed", dir, note: `shims removed; remove ${dir} from PATH manually` };
  }
  return { ok: true, action: "removed", dir };
}
