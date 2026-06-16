# arena

**One-line role.** A multi-model debate/research engine: several LLM participants independently research a topic, register findings as tracked claims, cross-review and debate contested ones, then a concluder builds structured consensus — all coordinated through an append-only ledger.

## 职责 / Responsibility

Arena runs an evidence-driven pipeline that turns a natural-language topic into a verified, claim-by-claim consensus produced by ≥2 LLM participants. It owns the whole flow: planning (mode/lens/source detection), evidence collection, parallel participant research, claim registration into a shared ledger, a verification → debate → adjudication trust loop, and final consensus rendering. It does **not** own LLM transport (it takes `LLMConfig` per participant), credential resolution, or the tool-invocation surface — that wiring lives in `tool-system/builtin/arena.ts`, which resolves participant names against the model pool/presets and injects per-call config. The `arena/iterate` submodule is a separate authoring loop (produce-a-thing-from-scratch) rather than review-an-existing-thing.

## 文件 / Files

| File / dir | Purpose |
| --- | --- |
| `index.ts` | Public barrel — re-exports `Arena`, phases, ledger, transitions, types, renderers, and `IterativeArena`. |
| `arena.ts` | The `Arena` class — orchestrates the full pipeline (`run()`), with two paths: review/discussion (heavy trust loop) and planning (merge → roadmap → detail expansion). **Main entry point.** |
| `types.ts` | All arena types — `ArenaConfig`, `ArenaParticipant`, `ArenaResultV2`, `ClaimRecord`, ledger/digest/debate types, mode defaults, execution limits. |
| `ledger.ts` | `ArenaLedger` — append-only single source of truth for dossiers/evidence/claims/challenges/adjudications, with by-id/by-owner/by-status query methods. |
| `transitions.ts` | Claim state machine — `transitionClaim`, `resolveClaimStatus`, `applyReviewResult`, `markUnresolved`, etc. Centralizes all `ClaimStatus` changes. |
| `digest-builder.ts` | `buildDigest`/`formatDigest` — builds a filtered, sanitized prompt-injection view of the ledger for a given round. |
| `planner.ts` | `planArena` — one LLM call that infers mode/lens/sources/subject into an `ArenaPlan` (skips the call when mode+base are explicit). |
| `detect-mode.ts` | `detectArenaMode` — pure heuristic keyword scorer; fallback / no-LLM mode inference. |
| `model-presets.ts` | `MODEL_PRESETS` short aliases (`claude`, `gpt`, …) + `getMaxOutputTokens`. |
| `strategies/` | Per-mode prompt strategies (`review`/`discussion`/`planning`) + lens/language wrappers; `getStrategy`, `getStrategyForPlan`. |
| `lenses/` | Analysis perspectives (architecture/engineering/product/general); `getLens`, `resolveLenses`, `buildLensPrompt`. |
| `providers/` | Evidence collectors (repo/git/docs/none); `collectEvidence`. |
| `tools/` | `selectTools`/`hasTools` — read-only context tools participants may use during research. |
| `phases/` | Pipeline stages: `participant-research`, `claim-registry`, `cross-review`, `debate-rounds`, `adjudication`, `build-consensus`, `planning-detail-expansion`. |
| `render/` | `terminal.ts` (chalk/ANSI for stdout, progress renderer) and `session.ts` (`formatArenaResultForSession` — markdown for tool results). |
| `iterate/` | Separate iterative-authoring engine (`IterativeArena`): tournament → critique-revise rounds; its own types/formats/convergence. |

## 公开接口 / Public API

The high-level surface most consumers touch (all re-exported from `arena/index.ts`):

```ts
class Arena {
  constructor(config: ArenaConfig); // throws if participants.length < 2
  run(topic: string, flags?: PlannerFlags): Promise<ArenaResultV2>;
}

interface ArenaConfig {
  participants: ArenaParticipant[];      // ≥2 required
  mode?: ArenaMode;                      // "review" | "discussion" | "planning" (default "review", usually auto-detected)
  maxDiscussionRounds?: number;          // overrides per-mode default
  concluder?: string;                    // participant name that builds consensus (default: first)
  strategy?: ArenaStrategy;              // override mode-based strategy
  enableContextTools?: boolean;          // read-only research tools (default true)
  executionLimits?: ArenaExecutionLimits;
  onProgress?: (event: ArenaProgressEvent) => void;
  signal?: AbortSignal;
}

interface ArenaParticipant { name: string; llm: LLMConfig; clientDefaults?: ClientDefaults; }
```

Lower-level building blocks (for callers wiring their own pipeline or reading results):

```ts
// Ledger — the shared source of truth
class ArenaLedger {
  appendDossier(d): void; appendClaim(c): void; appendChallenge(c): void;
  appendAdjudication(a): void;
  getAllClaims(): ClaimRecord[];
  getClaimsByStatus(...s: ClaimStatus[]): ClaimRecord[];
  getClaimById(id): ClaimRecord | undefined;
  getSnapshot(): Readonly<SharedResearchLedger>; // shallow readonly — do not mutate
}

// Claim state machine
function transitionClaim(claim: ClaimRecord, to: ClaimStatus): boolean; // false if invalid
function resolveClaimStatus(claim, challenges, hasPendingChecks): ClaimStatus;
function applyReviewResult(claim, challenges, hasPendingChecks): void;
function isTerminal(claim: ClaimRecord): boolean;

// Planning / detection / digests
function planArena(topic, llmConfig: LLMConfig, flags?, signal?): Promise<ArenaPlan>;
function detectArenaMode(topic: string): { mode: ArenaMode; confidence: "high"|"low"; reason: string };
function buildDigest(ledger: ArenaLedger, { round, relevantClaimIds }): RoundResearchDigest;
function formatDigest(digest: RoundResearchDigest): string;

// Model presets / rendering
const MODEL_PRESETS: Record<string, ModelPreset>;
function getMaxOutputTokens(model: string): number;
function formatArenaResultForSession(result: ArenaResultV2): string; // markdown
function createProgressRenderer(sink: (text: string) => void): (e: ArenaProgressEvent) => void;
```

## 怎么用 / How to use

**1. Running a session (real call site: `tool-system/builtin/arena.ts`).** Resolve participant names into `ArenaParticipant`s (inheriting `baseUrl`/`apiKey`), then construct and run:

```ts
import { Arena } from "../../arena/index.js";
import { createProgressRenderer } from "../../arena/render/terminal.js";
import { formatArenaResultForSession } from "../../arena/render/session.js";

const progressLog: string[] = [];
const onProgress = createProgressRenderer((text) => progressLog.push(stripAnsi(text)));

const arena = new Arena({
  participants,            // ≥2, each { name, llm: LLMConfig }
  mode,                    // optional; planner auto-detects when omitted
  concluder,               // optional participant name
  enableContextTools: true,
  onProgress,
  signal,                  // AbortSignal from the tool call
});

const result = await arena.run(topic);          // ArenaResultV2
const markdown = formatArenaResultForSession(result); // for the tool result string
```

**2. Inspecting claims after a run** (the ledger output is on `result.claims`, already bucketed in `result.consensus`):

```ts
const verified  = result.claims.filter((c) => c.status === "verified");
const contested = result.claims.filter((c) => c.status === "contested");
```

If you need to drive the ledger/state-machine directly (as the phases do internally):

```ts
import { ArenaLedger } from "../ledger.js";
import { applyReviewResult } from "../transitions.js";

const ledger = new ArenaLedger();
ledger.appendDossier(dossier);          // also folds in its evidence packets + tool traces
const claims = ledger.getAllClaims();
applyReviewResult(claim, ledger.getChallengesForClaim(claim.claimId), hasPendingChecks);
```

## 注意 / Gotchas

- **≥2 participants is enforced in the constructor** — `new Arena({ participants })` throws synchronously if fewer than 2. The builtin tool special-cases a single-model pool by listing it twice (self-review).
- **`Arena.run()` never throws for `signal` aborts gracefully** — it calls `signal?.throwIfAborted()` between every phase, so cancellation surfaces as a thrown `AbortError`; the builtin tool catches it and returns a plain string. Callers must wrap `run()` in try/catch.
- **The ledger is append-only and `getSnapshot()` is only shallow-`Readonly`** — inner arrays are still mutable at the type level. Never mutate the snapshot; always go through the `append*` methods. All ledger objects carry stable IDs and dedup by ID (packets/checks).
- **Claim transitions are guarded** — `transitionClaim` returns `false` on an invalid edge instead of throwing, and silently no-ops. `verified`/`rejected`/`unresolved` are terminal. A claim with no challenges is **not** auto-verified (`resolveClaimStatus` keeps its current status).
- **Challenges/adjudications for an unknown `claimId`** still land in the ledger arrays but won't attach to a claim — the ledger logs `arena.challenge_for_unknown_claim` / `arena.adjudication_for_unknown_claim` rather than failing.
- **Mode drives the path.** `planning` mode skips the heavy debate/adjudication loop (merge-review → roadmap consensus → optional detail expansion); `review`/`discussion` run the full verification → debate → adjudication → consensus loop. Detail expansion is best-effort and degrades to a logged warning on failure.
- **The planner makes its own LLM call** using `participants[0].llm` (capped at 1024 max tokens) unless both `mode` and `base` flags are explicit; for a pure heuristic guess with no network use `detectArenaMode`.
- **Model presets use OpenRouter-style namespaced paths** (`anthropic/claude-opus-4.6`). Those only resolve on a multi-vendor gateway; a vendor's direct endpoint will reject them — the builtin tool fails fast with a descriptive error (`assertEndpointAcceptsModel`) rather than burning retries.
- **Digest text is sanitized before prompt re-injection** (`digest-builder.ts` strips fake role tags / instruction prefixes and caps length) — preserve that when adding new digest fields, since digest content is LLM-originated.
- **ESM:** all intra-module imports use explicit `.js` extensions; this is a TypeScript→ESM package, so keep that convention. Core is built — host/desktop consume the compiled `dist`, so changes here require a core rebuild to take effect downstream.
