#!/usr/bin/env bash
#
# logs.sh — query helper for the split log files in ~/.code-shell/logs.
#
# Layout (per day):
#   engine-YYYY-MM-DD.log   engine, llm, tool, context, mcp, sandbox, ...
#   ui-ink-YYYY-MM-DD.log   UI events: stream events, ctx render, chatStore, ink ratio
#
# Why: separating the buckets keeps engine traces from being drowned by the
# 200ms spinner ticks and per-stream-event UI logs. A single sid is still
# reconstructible by merging both buckets sorted by `t`.
#
# Usage:
#   scripts/logs.sh                          # today, both buckets, sorted by time
#   scripts/logs.sh sid <SID>                # only lines for that sid, merged
#   scripts/logs.sh ui                       # only ui-ink bucket
#   scripts/logs.sh engine                   # only engine bucket
#   scripts/logs.sh grep '<pattern>'         # ripgrep across both, merged
#   scripts/logs.sh date <YYYY-MM-DD> sid X  # a non-today date
#   scripts/logs.sh repo <SID>               # full session timeline:
#                                            # <repo>/log/<date>/engine/session-<SID>.jsonl
#   scripts/logs.sh repo <SID> ui            # UI-only timeline for that session
#
# Output is the raw JSONL line per match. Pipe to `jq -c .` for pretty.

set -euo pipefail

LOGS_DIR="${HOME}/.code-shell/logs"
DATE="$(date +%Y-%m-%d)"

usage() {
  sed -n '3,22p' "$0"
  exit "${1:-0}"
}

# Allow `date YYYY-MM-DD …` prefix to override today.
if [[ "${1:-}" == "date" && -n "${2:-}" ]]; then
  DATE="$2"
  shift 2
fi

ENGINE_FILE="${LOGS_DIR}/engine-${DATE}.log"
UI_FILE="${LOGS_DIR}/ui-ink-${DATE}.log"

merge_sorted() {
  # Concat files (skipping missing ones), sort by leading {"t":"..." stamp.
  # `sort -s -t '"' -k 4` would also work but awk-prefix is clearer.
  local files=()
  for f in "$@"; do
    [[ -f "$f" ]] && files+=("$f")
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    return 0
  fi
  cat "${files[@]}" | awk -F'"' 'NF>=4 { print $4 "\t" $0 }' | sort | cut -f2-
}

case "${1:-all}" in
  ""|all)
    merge_sorted "$ENGINE_FILE" "$UI_FILE"
    ;;
  ui)
    [[ -f "$UI_FILE" ]] && cat "$UI_FILE"
    ;;
  engine)
    [[ -f "$ENGINE_FILE" ]] && cat "$ENGINE_FILE"
    ;;
  sid)
    SID="${2:-}"
    [[ -z "$SID" ]] && { echo "usage: $0 sid <SID>" >&2; exit 2; }
    merge_sorted "$ENGINE_FILE" "$UI_FILE" | grep -F "\"sid\":\"${SID}\""
    ;;
  grep)
    PATTERN="${2:-}"
    [[ -z "$PATTERN" ]] && { echo "usage: $0 grep <pattern>" >&2; exit 2; }
    merge_sorted "$ENGINE_FILE" "$UI_FILE" | grep -E "$PATTERN" || true
    ;;
  repo)
    SID="${2:-}"
    [[ -z "$SID" ]] && { echo "usage: $0 repo <SID>" >&2; exit 2; }
    REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || cd "$(dirname "$0")/.." && pwd)"
    # engine/session-<sid>.jsonl is the full timeline (engine + UI dual-write).
    # ui/session-<sid>.jsonl has only UI events; tail it when debugging
    # display bugs. Append "ui" as third arg to view ui bucket instead.
    BUCKET="${3:-engine}"
    REPO_FILE="${REPO_ROOT}/log/${DATE}/${BUCKET}/session-${SID}.jsonl"
    if [[ ! -f "$REPO_FILE" ]]; then
      echo "no repo log file: $REPO_FILE" >&2
      exit 1
    fi
    cat "$REPO_FILE"
    ;;
  -h|--help|help)
    usage 0
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    usage 2
    ;;
esac
