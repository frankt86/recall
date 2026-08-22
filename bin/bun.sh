#!/usr/bin/env bash
# recall runtime bootstrap. Resolves a Bun binary and execs it with the given arguments, downloading a
# pinned, checksum-verified release from GitHub if none is available. Never runs a remote install script
# and never touches PATH or shell profiles.
#
#   bash bin/bun.sh src/hooks/stop.ts      run a script
#   bash bin/bun.sh --print                print the resolved bun path and exit
#   bash bin/bun.sh --ensure               resolve (download if needed), mirror into the plugin, exit
#
# Resolution order:
#   1. $RECALL_BUN                                   explicit override
#   2. $CLAUDE_PLUGIN_ROOT/runtime/bun               plugin-private mirror (what .mcp.json uses)
#   3. $RECALL_DIR/runtime/bun-v<PIN>/bun            cache that survives plugin updates
#   4. bun on PATH or ~/.bun/bin/bun, version >= MIN
#   5. download bun-v<PIN> for this platform, verify sha256, install into 3
# Whatever is resolved is mirrored into 2 so the MCP server can start without a shell.
#
# Env: RECALL_DIR (data dir, default ~/.recall), RECALL_NO_DOWNLOAD=1 (fail instead of downloading),
#      RECALL_BUN_TARGET (override platform detection, e.g. linux-x64-baseline).

set -u

PIN="1.4.0"
MIN_MAJOR=1; MIN_MINOR=1
RELEASE="https://github.com/oven-sh/bun/releases/download/bun-v${PIN}"

# sha256 of bun-<target>.zip from the release's SHASUMS256.txt.
sha_for() {
  case "$1" in
    darwin-aarch64)           echo c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381 ;;
    darwin-x64)               echo 1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0 ;;
    darwin-x64-baseline)      echo da9b9f1b4ba766c6f299711f38dfaa98623e1ed9c40896aa53db803c52ec1fa0 ;;
    linux-aarch64)            echo 4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e ;;
    linux-aarch64-musl)       echo 576300ce33ff16ffcd455bf178c2f095f9df845c6cc3d0284ba1c96ca0e80473 ;;
    linux-x64)                echo 2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452 ;;
    linux-x64-baseline)       echo 184fb4595f0d401a217cf7c78c1bc430ba83314dab7a8b94805babbf7fa7097f ;;
    linux-x64-musl)           echo 83b5f12fd258dd8d4fdcaea65ede954366aa717dab399e20093ecab280d54e7a ;;
    linux-x64-musl-baseline)  echo 618c4bc1f94b02337ee210003c0b7c066f11548a8cdc5109df10db043dc47ca2 ;;
    windows-x64)              echo e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901 ;;
    windows-x64-baseline)     echo b929c54a9badb104a16dedd23aab6152c86793ae653d4e6b13983ffd0c882a66 ;;
    *) echo "" ;;
  esac
}

log() { printf '[recall] %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) OS=windows; EXE=.exe ;;
  Darwin) OS=darwin; EXE= ;;
  Linux)  OS=linux;  EXE= ;;
  *) OS=unknown; EXE= ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HERE")}"
DATA="${RECALL_DIR:-$HOME/.recall}"
CACHE="$DATA/runtime/bun-v$PIN"
MIRROR="$ROOT/runtime/bun$EXE"

# --- helpers ------------------------------------------------------------------------------------

version_ok() {  # $1 = path; true if it runs and reports >= MIN
  local v
  v="$("$1" --version 2>/dev/null | tr -d '\r')" || return 1
  [ -n "$v" ] || return 1
  local maj="${v%%.*}" rest="${v#*.}"; local min="${rest%%.*}"
  case "$maj$min" in *[!0-9]*) return 1 ;; esac
  [ "$maj" -gt "$MIN_MAJOR" ] || { [ "$maj" -eq "$MIN_MAJOR" ] && [ "$min" -ge "$MIN_MINOR" ]; }
}

detect_target() {
  [ -n "${RECALL_BUN_TARGET:-}" ] && { echo "$RECALL_BUN_TARGET"; return; }
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=aarch64 ;;
    *) die "unsupported CPU architecture: $(uname -m). Install Bun manually (https://bun.sh) or set RECALL_BUN." ;;
  esac
  local t="$OS-$arch"
  if [ "$OS" = linux ]; then
    if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then t="$t-musl"; fi
    if [ "$arch" = x64 ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then t="$t-baseline"; fi
  elif [ "$OS" = darwin ] && [ "$arch" = x64 ]; then
    sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2 || t="$t-baseline"
  fi
  echo "$t"
}

fetch() {  # $1 url, $2 out
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  elif [ "$OS" = windows ]; then powershell.exe -NoProfile -NonInteractive -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '$1' -OutFile '$(cygpath -w "$2")'" >/dev/null
  else return 1; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'
  elif [ "$OS" = windows ]; then powershell.exe -NoProfile -NonInteractive -Command "(Get-FileHash -Algorithm SHA256 '$(cygpath -w "$1")').Hash.ToLower()" | tr -d '\r'
  else return 1; fi
}

unzip_to() {  # $1 zip, $2 dir
  if [ "$OS" = windows ]; then
    powershell.exe -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '$(cygpath -w "$1")' -DestinationPath '$(cygpath -w "$2")' -Force" >/dev/null
  elif command -v unzip >/dev/null 2>&1; then unzip -q -o "$1" -d "$2"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
  else return 1; fi
}

# Serialise installs across concurrently firing hooks. mkdir is atomic on every platform we run on.
lock() {
  LOCKDIR="$DATA/runtime/.lock"; local i=0
  mkdir -p "$DATA/runtime"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    # A lock older than 10 minutes belongs to a dead process.
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rm -rf "$LOCKDIR"; continue; fi
    i=$((i+1)); [ "$i" -gt 240 ] && die "timed out waiting for another recall process to finish installing bun"
    sleep 0.5
  done
  trap 'rm -rf "$LOCKDIR"' EXIT
}

download() {
  [ "${RECALL_NO_DOWNLOAD:-}" = 1 ] && die "bun not found and RECALL_NO_DOWNLOAD=1. Install Bun (https://bun.sh) or set RECALL_BUN."
  local target sha zip tmp
  target="$(detect_target)"
  sha="$(sha_for "$target")"
  [ -n "$sha" ] || die "no pinned checksum for platform $target. Install Bun manually (https://bun.sh) or set RECALL_BUN."
  lock
  # Another process may have finished while we waited.
  [ -x "$CACHE/bun$EXE" ] && return 0
  tmp="$DATA/runtime/.tmp-$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  zip="$tmp/bun-$target.zip"
  log "downloading bun v$PIN ($target) to $CACHE ..."
  fetch "$RELEASE/bun-$target.zip" "$zip" || { rm -rf "$tmp"; die "download failed ($RELEASE/bun-$target.zip). Check network, or install Bun manually (https://bun.sh)."; }
  local got; got="$(sha256_of "$zip")" || { rm -rf "$tmp"; die "no sha256 tool available; cannot verify download"; }
  [ "$got" = "$sha" ] || { rm -rf "$tmp"; die "checksum mismatch for bun-$target.zip (expected $sha, got $got). Refusing to install."; }
  unzip_to "$zip" "$tmp" || { rm -rf "$tmp"; die "could not extract $zip (need unzip, bsdtar, or python3)"; }
  local bin; bin="$(find "$tmp" -type f -name "bun$EXE" | head -n1)"
  [ -n "$bin" ] || { rm -rf "$tmp"; die "bun binary not found inside archive"; }
  chmod +x "$bin" 2>/dev/null
  version_ok "$bin" || { rm -rf "$tmp"; die "downloaded bun does not run on this machine (try RECALL_BUN_TARGET=$target-baseline)"; }
  rm -rf "$CACHE.new"; mkdir -p "$CACHE.new"; mv "$bin" "$CACHE.new/bun$EXE"
  rm -rf "$CACHE"; mv "$CACHE.new" "$CACHE"
  rm -rf "$tmp"
  log "installed bun v$PIN"
}

mirror() {  # copy/link the resolved bun into the plugin so .mcp.json can launch it without a shell
  [ "$1" = "$MIRROR" ] && return 0
  [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || [ -d "$ROOT/src" ] || return 0
  mkdir -p "$ROOT/runtime" 2>/dev/null || return 0
  if [ -x "$MIRROR" ] && [ "$(cat "$ROOT/runtime/.source" 2>/dev/null)" = "$1" ]; then return 0; fi
  rm -f "$MIRROR" "$MIRROR.tmp"
  if [ "$OS" != windows ] && ln -s "$1" "$MIRROR.tmp" 2>/dev/null; then :; else cp "$1" "$MIRROR.tmp" 2>/dev/null || { rm -f "$MIRROR.tmp"; return 0; }; fi
  chmod +x "$MIRROR.tmp" 2>/dev/null
  mv -f "$MIRROR.tmp" "$MIRROR" 2>/dev/null && printf '%s' "$1" > "$ROOT/runtime/.source"
}

# --- resolve ------------------------------------------------------------------------------------

resolve() {
  if [ -n "${RECALL_BUN:-}" ]; then
    version_ok "$RECALL_BUN" && { echo "$RECALL_BUN"; return; }
    die "RECALL_BUN=$RECALL_BUN is not a working bun >= $MIN_MAJOR.$MIN_MINOR"
  fi
  [ -x "$MIRROR" ] && version_ok "$MIRROR" && { echo "$MIRROR"; return; }
  [ -x "$CACHE/bun$EXE" ] && version_ok "$CACHE/bun$EXE" && { echo "$CACHE/bun$EXE"; return; }
  local p
  p="$(command -v bun 2>/dev/null || true)"
  [ -n "$p" ] && version_ok "$p" && { echo "$p"; return; }
  [ -x "$HOME/.bun/bin/bun$EXE" ] && version_ok "$HOME/.bun/bin/bun$EXE" && { echo "$HOME/.bun/bin/bun$EXE"; return; }
  download
  echo "$CACHE/bun$EXE"
}

BUN="$(resolve)" || exit 1
[ -n "$BUN" ] || exit 1

case "${1:-}" in
  --print)  echo "$BUN"; exit 0 ;;
  --ensure) mirror "$BUN"; echo "$BUN"; exit 0 ;;
esac

mirror "$BUN"
exec "$BUN" "$@"
