#!/usr/bin/env bash
# Install the real npm tarball into a throwaway prefix and use it the way a new
# user would: init (wrapping an existing statusline), one hook event, render,
# doctor, uninstall -- then check the settings file is byte-identical.
# Runs twice: with Bun on PATH, and Node-only. Never touches the real ~/.claude.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
# Stop any collector a case left running before deleting its home.
trap 'pkill -f "$WORK" 2>/dev/null || true; sleep 0.3; rm -rf "$WORK"' EXIT
NODE_BIN="$(command -v node)"
BUN_BIN="$(command -v bun)"

(cd "$WORK" && npm pack "$ROOT/packages/cli" --silent >/dev/null)
TARBALL="$(ls "$WORK"/*tminus-*.tgz)"

run_case() {
  local name="$1" path="$2"
  local home="$WORK/$name"
  mkdir -p "$home/claude" "$home/prefix"
  printf '{\n  "statusLine": {\n    "type": "command",\n    "command": "echo user-line"\n  }\n}\n' > "$home/claude/settings.json"
  cp "$home/claude/settings.json" "$home/original.json"
  npm install -g --prefix "$home/prefix" "$TARBALL" --silent >/dev/null 2>&1
  local T="$home/prefix/bin/tminus"
  (
    export PATH="$path" TMINUS_HOME="$home/tminus" CLAUDE_CONFIG_DIR="$home/claude" CODEX_HOME="$home/codex" NO_COLOR=1
    echo "== $name: $("$T" --version) (runtime: $(command -v bun >/dev/null && echo bun || echo node))"
    "$T" init --yes --no-backfill --agents claude-code >/dev/null
    # Functional checks only: latency on shared CI runners is reported, not enforced here
    # (the render benchmark test and `tminus doctor` on a real machine enforce the 30ms budget).
    DOC="$("$T" doctor || true)"
    echo "$DOC" | grep -q 'Claude Code: hooks: SessionStart' || { echo "hooks not recognised"; echo "$DOC"; exit 1; }
    echo "$DOC" | grep -q 'statusline: .*tminus-render' || { echo "statusline does not use the render-only entry"; echo "$DOC"; exit 1; }
    echo "   $(echo "$DOC" | grep 'statusline render' | sed 's/^[^ ]* //')"
    # One prompt through the installed hook command, then the wrapped statusline.
    HOOK_CMD="$(node -e 'const s=require(process.argv[1]);console.log(s.hooks.UserPromptSubmit.at(-1).hooks[0].command)' "$home/claude/settings.json")"
    echo '{"session_id":"smoke","prompt_id":"p1","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"fix the login bug"}' | sh -c "$HOOK_CMD"
    for _ in $(seq 1 50); do [ -f "$home/tminus/state/smoke.json" ] && break; sleep 0.1; done
    SL_CMD="$(node -e 'const s=require(process.argv[1]);console.log(s.statusLine.command)' "$home/claude/settings.json")"
    OUT="$(echo '{"session_id":"smoke"}' | sh -c "$SL_CMD")"
    echo "   statusline: $OUT"
    case "$OUT" in "user-line │ ⏳"*) ;; *) echo "unexpected statusline output"; exit 1 ;; esac
    "$T" uninstall --yes --purge >/dev/null
  )
  cmp "$home/claude/settings.json" "$home/original.json"
  echo "   uninstall restored settings.json byte-for-byte"
}

run_case bun "$(dirname "$BUN_BIN"):$(dirname "$NODE_BIN"):/usr/bin:/bin"
NODE_ONLY="$WORK/node-only-bin"
mkdir -p "$NODE_ONLY"
ln -s "$NODE_BIN" "$NODE_ONLY/node"
ln -s "$(command -v npm)" "$NODE_ONLY/npm"
run_case node-only "$NODE_ONLY:/usr/bin:/bin"
echo "smoke test passed"
