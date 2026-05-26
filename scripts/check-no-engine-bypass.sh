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
#   packages/core/src/engine/engine.ts       — Engine class itself + sub-agent spawn
#   packages/tui/src/cli/commands/repl.ts    — REPL entry; wraps in AgentServer
#   packages/tui/src/cli/commands/run.ts     — headless CLI; wraps in createInProcessClient
#   packages/core/src/run/EngineRunner.ts    — RunManager runner; wraps in createInProcessClient
#   packages/core/src/cli/agent-server-stdio.ts — stdio worker; wraps engines in AgentServer
#   tests/**                                 — tests need direct Engine construction
#
# Anything new appearing outside this list is an architecture violation.
# If you have a legitimate new use case, add it here AND document why in
# the PR description so the next reader understands the exception.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# Find all `new Engine(` references in package source trees that are not in the allowlist.
# Tests are intentionally out of scope; they can construct Engine directly for unit setup.
violations=$(
  grep -rn --include="*.ts" --include="*.tsx" "new Engine(" \
    "$repo_root/packages/core/src" \
    "$repo_root/packages/tui/src" \
    "$repo_root/packages/desktop/src" \
    2>/dev/null \
  | grep -v "/packages/core/src/engine/engine.ts:" \
  | grep -v "/packages/tui/src/cli/commands/repl.ts:" \
  | grep -v "/packages/tui/src/cli/commands/run.ts:" \
  | grep -v "/packages/core/src/run/EngineRunner.ts:" \
  | grep -v "/packages/core/src/cli/agent-server-stdio.ts:" \
  || true
)

if [ -n "$violations" ]; then
  echo "ERROR: unauthorized 'new Engine(' call site(s) found:" >&2
  echo "$violations" >&2
  echo "" >&2
  echo "All internal package-source engine instantiations must route through" >&2
  echo "createInProcessClient (or be in the engine.ts internal spawn path)." >&2
  echo "See docs/architecture/14-engine-call-paths.md." >&2
  echo "" >&2
  echo "If your new site is legitimate, add it to scripts/check-no-engine-bypass.sh" >&2
  echo "and document the reason in your PR description." >&2
  exit 1
fi

echo "OK: 'new Engine(' is confined to the protocol layer."
