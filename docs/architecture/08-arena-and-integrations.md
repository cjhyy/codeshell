# 08 · Arena & Integrations

> The multi-model reasoning engine (Arena), the external-CLI orchestrator (CC-orchestrator), and the smaller integration surfaces (STT, code review, external-agent config). Source-mapped against `packages/core/src/arena/`, `cc-orchestrator/`, `stt/`, `review/`, `external-agents/`.

## 1. Arena (`arena/`, ~53 files, ~2,100 LOC)

Arena is the largest single subsystem. It runs **multiple models** against a problem in two modes:
- **Arena** — *review* an existing artifact via an evidence-driven claim pipeline.
- **IterativeArena** — *author* an artifact (code, PRD, design doc) via a tournament → critique-revise loop.

### Review/Discussion mode (`arena.ts`, `Arena.run` @ `:83`)
Phases run in order: **Plan** (`planArena` @ `planner.ts:82` — one LLM call emits an `ArenaPlan` with mode/lenses/sources) → **Evidence** (`collectEvidence` @ `providers/index.ts:47` — parallel context providers: git/repo/docs/web, 8 s timeout each) → **Strategy/Tools** (`getStrategyForPlan`, `selectTools` — read-only tool packs by source) → **Research** (per-participant dossiers) → **Claims** (`registerClaims` elevates findings to trackable claims) → debate/adjudication or planning detail-expansion → **Consensus**.

The **claim lifecycle** is an append-only state machine (`transitions.ts`): `proposed → under_review → {verified | contested | rejected | unresolved}`, terminals having no outgoing edges. `resolveClaimStatus` is deterministic: a "disagree"/"needs_evidence" challenge → `contested`; an "agree" → `verified`; pending checks → `contested`. The `ArenaLedger` (`ledger.ts:39`) is the append-only, indexed store of dossiers/packets/claims/challenges/adjudications; `buildDigest` formats a round's relevant slice into prompt-injectable markdown (sanitized, capped).

**Lenses** (engineering / product / architecture / general) wrap the base strategy with role + criteria, so the same review machinery can be pointed at different concerns.

### Authoring mode (`iterate/iterative-arena.ts`, `IterativeArena.run` @ `:42`)
A tournament produces a v1 draft (multiple authors, or single-author), then argue/revise rounds run critics in parallel, check convergence (`diffRatio`), optionally pause at a human checkpoint, and revise — author rotation cycling through the participant set, default max 5 rounds. Format packs (`iterate/formats/`) supply code vs document conventions.

Key invariants: append-only ledger (queries return the latest view); read-only tool packs in verify/debate phases; `AbortSignal` threaded through every async phase. Use **Arena to review**, **IterativeArena to author** — the README and `index.ts` make this split explicit.

## 2. CC-orchestrator (`cc-orchestrator/`, 9 files, ~600 LOC)

CodeShell as an **external orchestrator** driving the Claude Code (`claude`) and Codex (`codex`) CLIs as black-box child processes.

| File | Role | ~LOC |
|------|------|------|
| `cc-orchestrator/agent-adapter.ts` | `claudeAdapter` / `codexAdapter` — command builders + result parsers | ~142 |
| `cc-orchestrator/external-agent-driver.ts` | `runAgentOnce` — spawn one headless invocation | ~85 |
| `cc-orchestrator/cc-capability.ts` | probe `claude`/`codex` CLI availability, fix macOS PATH | ~63 |
| `cc-orchestrator/*session-discovery*.ts`, `*session-history*.ts`, `relevance-judge.ts` | discover/replay prior CC/Codex sessions, judge relevance | — |

**The iron rule**: the CC/Codex side has *no* time/scheduling/looping logic — all timing, retries, approval loops, and multi-agent workflows live in the codeshell layer (the cc-orchestrator memory note). A driver invocation runs *one turn and exits*; codeshell decides whether to loop, when, and with what context.

- **`claudeAdapter`**: `-p <prompt> --output-format stream-json --verbose [--resume id] --disallowedTools Workflow`. It disables `Workflow` (a fleet fan-out = token sink) while leaving the single-sub-agent `Task` allowed, and appends a cost-guard prompt. `parseResult` reads the JSONL stream for `session_id` / result / `is_error`.
- **`codexAdapter`**: prompt fed over **stdin** (`promptViaStdin`, argv ends with bare `-`), not `-p`; permission levels map to sandbox modes (`default → read-only`, `acceptEdits → workspace-write`, `bypassPermissions → dangerously-bypass-…`). Different JSONL event schema (`thread.started`, `item.completed`, `turn.failed`). The codex-exec-noninteractive reference note records the `--json` contract and the resume-arg-order pitfall.

`runAgentOnce` spawns the child **non-detached** (bound to the worker — detached children orphaned across restarts caused the "background task never returned" bug) and prepends common bins to PATH for macOS GUI Electron. There are two spawn paths with independent parameters: full-auto `DriveClaudeCode` (default background, bypass, `--disallowedTools Workflow`) vs. CC rooms (stdio approval loop). The AskUserQuestion protocol requires answers in `updatedInput.answers` (key = question text, value = label) — auto-allowing reports "did not answer" (the cc-askuserquestion-protocol reference note).

## 3. Smaller integrations

### Speech-to-text (`stt/`, ~240 LOC)
`transcribe` (`transcribe.ts:51`) posts multipart audio to an OpenAI-compatible `/audio/transcriptions` endpoint (Whisper / Groq / self-hosted). `resolveTranscribeProvider` picks from settings with a fallback that reuses an OpenAI-family credential, so dictation works with zero extra config. **Voice input is UI-only** — it fills the input box, it is not an agent tool, mirroring Codex (the voice-input-stt memory note).

### Code review (`review/`, ~111 LOC)
`buildReviewPrompt` (`review-prompt.ts:63`) assembles a review prompt over `ReviewDimension`s (security / performance / readability / correctness), with a P0–P3 priority guide and an optional JSON mode for CI. Backs the `/review` flows.

### External-agent config (`external-agents/`, ~65 LOC)
`resolveExternalAgentConfig` applies defaults to the `externalAgents` settings block. `claudeCode.trustedWorkspaces` is the **permission source for a Room** — it decides who can auto-bypass the approval loop (the former managed `/cc` & `/codex` job path was removed; the phone now talks to resident Rooms only).

## 4. Where to read next
- The browser-bridge that Arena's web provider and the desktop browser panel both rely on: [02 · Tool system](02-tool-system.md), [10 · Desktop & mobile](10-desktop-and-mobile.md)
- The `Arena` / `DriveAgent` / `DriveClaudeCode` tools as the model sees them: [02 · Tool system](02-tool-system.md)
- The CC/Codex Rooms on the phone remote: [10 · Desktop & mobile](10-desktop-and-mobile.md)
