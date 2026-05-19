#!/usr/bin/env bash
# Guard: every internal `new Engine(` site must be in an allowlist.
#
# Why this exists:
# All internal codeshell paths that run an engine should wrap it in the
# protocol layer (AgentServer + AgentClient via createInProcessClient).
# Direct `new Engine + await engine.run` bypasses TaskManager wiring,
# status notifications, and the in-process running lock — three behaviors
# that previously only worked from the REPL path. See P1 ADR
# docs/architecture/14-engine-call-paths.md.
#
# Allowed sites:
#   src/engine/engine.ts        — Engine class itself + sub-agent spawn
#   src/cli/commands/repl.ts    — REPL entry; wraps in AgentServer
#   src/cli/commands/run.ts     — headless CLI; wraps in createInProcessClient
#   src/run/EngineRunner.ts     — RunManager runner; wraps in createInProcessClient
#   tests/**                    — tests need direct Engine construction
#
# Anything new appearing outside this list is an architecture violation.
# If you have a legitimate new use case, add it here AND document why in
# the PR description so the next reader understands the exception.

set -euo pipefail

# Find all `new Engine(` references in src/ that are not in the allowlist.
# We don't filter tests/ here — they were never in scope of src/ scan.
violations=$(
  grep -rn --include="*.ts" --include="*.tsx" "new Engine(" \
    /Users/admin/Documents/个人学习/代码学习/codeshell/src/ \
    2>/dev/null \
  | grep -v "/engine/engine.ts:" \
  | grep -v "/cli/commands/repl.ts:" \
  | grep -v "/cli/commands/run.ts:" \
  | grep -v "/run/EngineRunner.ts:" \
  || true
)

if [ -n "$violations" ]; then
  echo "ERROR: unauthorized 'new Engine(' call site(s) found:" >&2
  echo "$violations" >&2
  echo "" >&2
  echo "All engine instantiations in src/ must route through" >&2
  echo "createInProcessClient (or be in the engine.ts internal spawn path)." >&2
  echo "See docs/architecture/14-engine-call-paths.md." >&2
  echo "" >&2
  echo "If your new site is legitimate, add it to scripts/check-no-engine-bypass.sh" >&2
  echo "and document the reason in your PR description." >&2
  exit 1
fi

echo "OK: 'new Engine(' is confined to the protocol layer."
