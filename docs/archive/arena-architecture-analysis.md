# Arena Architecture Analysis

> Full-stack analysis of `src/arena/` — the multi-model collaborative analysis engine of Code Shell.

---

## 1. Overview

Arena is an **evidence-driven, multi-model collaborative analysis engine** built on three pillars:

1. **Evidence-first foundation** — Collect facts from git, repo, docs before any model produces an opinion
2. **Claim-verification loop** — Findings become claims, claims are verified by peers, contested claims enter structured debate, a moderator adjudicates
3. **Strategy × Lens composition** — Mode strategies (review/discussion/planning) compose with lens wrappers (engineering/product/architecture/general) for context-aware prompts

Three modes define the collaboration style:

| Mode | Purpose | Default Rounds | Output |
|------|---------|---------------|--------|
| `review` | Find issues, verify quality, structured verdict | 3 | Strengths/Improvements/Risks/Questions |
| `discussion` | Explore trade-offs, compare viewpoints, preserve disagreements | 4 | Balanced synthesis with minority viewpoints as open questions |
| `planning` | Build roadmap, identify phases/dependencies/risks | 5 | Roadmap phases + repo-level implementation details |

---

## 2. File-by-File Analysis

### 2.1 `index.ts` — Public API Barrel

- **Path:** `src/arena/index.ts`
- **Exports:** Nearly every public type and function from the arena module (~120 type exports, ~40 function/value exports)
- **Key responsibilities:**
  - Re-exports `Arena` class (main entry point)
  - Re-exports all phase functions: `runParticipantResearch`, `runCrossReview`, `runDebateRounds`, `runAdjudication`, `buildConsensus`
  - Re-exports providers: `collectEvidence`
  - Re-exports strategies: `ReviewStrategy`, `DiscussionStrategy`, `PlanningStrategy`, `getStrategy`, `getStrategyForPlan`
  - Re-exports lenses: `LENS_NAMES`, `getLens`, `resolveLenses`, `buildLensPrompt`
  - Re-exports tool selector: `selectTools`, `hasTools`
  - Re-exports ledger, digest-builder, transitions, claim-registry
  - Re-exports renderers: `formatArenaResult`, `printArenaResult`, `renderProgress`, `createProgressRenderer`, `formatArenaResultForSession`
  - Re-exports model presets: `MODEL_PRESETS`, `getMaxOutputTokens`
  - Re-exports the `IterativeArena` subsystem (iterate mode for authoring from scratch)
- **Connections:** This is the public facade — all consumers import from `./arena` or `./arena/index.js`

---

### 2.2 `arena.ts` — Main Orchestrator

- **Path:** `src/arena/arena.ts`
- **Exports:** `Arena` class
- **Key responsibilities:**
  - Takes `ArenaConfig` (participants, mode, concluder, strategy, limits, progress callback, abort signal)
  - Validates at least 2 participants
  - Orchestrates the full pipeline in `run(topic, flags)`:
    1. **Phase 0 — Plan:** Calls `planArena()` to LLM-auto-detect mode/lenses/sources from natural language
    2. **Phase 1 — Collect Evidence:** Calls `collectEvidence()` to gather git diffs, repo structure, docs
    3. **Phase 2 — Compose Strategy:** `getStrategyForPlan()` wraps mode strategy with lens + language wrappers
    4. **Phase 3 — Select Tools:** `selectTools()` maps plan sources to tool packs
    5. **Phase 4 — Participant Research (parallel):** `runParticipantResearchWithDossiers()` — each model investigates independently with tool access
    6. **Phase 4b — Claim Registry:** Creates `ArenaLedger`, registers findings as claims
    7. **Phase 5 — Mode Policy Router:** Routes to either `runPlanningPath()` or `runReviewDiscussionPath()`

  - **Planning path** (`runPlanningPath`): Merge-oriented review → Roadmap consensus → Detail expansion (repo-level implementation plans per phase). **No** debate/adjudication — contested findings become open questions or dependency risks.
  - **Review/Discussion path** (`runReviewDiscussionPath`): Verification review → Debate rounds → Adjudication → Claim-aware consensus. Full trust loop.

- **Connections:** Depends on `planner.ts`, `providers/index.ts`, `strategies/index.ts`, `tools/selector.ts`, all `phases/*` modules, `ledger.ts`, `claim-registry.ts`, `planning-detail-expansion.ts`, `language-wrapper.ts`

---

### 2.3 `types.ts` — Type System

- **Path:** `src/arena/types.ts`
- **Exports:** All arena types, constants `ARENA_MODE_DEFAULTS`, `DEFAULT_EXECUTION_LIMITS`, type guards `isStrategyV2()`, `isStrategyPlanning()`

- **Key type hierarchy:**

  **Configuration:**
  - `ArenaConfig` — participants, mode, maxDiscussionRounds, concluder, strategy, enableContextTools, executionLimits, onProgress, signal
  - `ArenaExecutionLimits` — maxClaimsForReview (12), maxContestedClaimsForDebate (5), maxRequestedChecksPerClaimPerRound (2), maxReviewersPerClaim (2), maxRoadmapPhases (6), maxExpandedPhasesPerRun (6)

  **Plan (Planner output):**
  - `ArenaPlan` — mode, lenses, sources, subject, outputShape, confidence, followUpQuestion
  - `ArenaLensRef` — { name: "engineering"|"product"|"architecture"|"general", weight }
  - `ArenaSourceSpec` — { kind: "git"|"repo"|"docs"|"web"|"none", targets?, toolPack? }
  - `ArenaSubject` — { kind: "changes"|"files"|"docs"|"topic"|"mixed", label, targets? }

  **Evidence layer:**
  - `ArenaContextProvider` — interface for evidence collection: `collect(plan, topic) → ArenaArtifact[]`
  - `ArenaArtifact` — unified artifact: { id, kind: "diff"|"file"|"tree"|"grep"|"doc"|"web", source, title, preview, metadata? }
  - `ArenaQuickFact` — { label, value }
  - `ArenaBaseContext` — { plan, artifacts, quickFacts }

  **Research layer:**
  - `ParticipantReport` — { participant, contextSummary, findings: ArenaFinding[] }
  - `ArenaFinding` — { id, kind: "strength"|"improvement"|"risk"|"question", title, summary, severity?, confidence, evidence[], affectedFiles[], suggestedChange? }
  - `ToolTrace` — { round, toolName, args, resultRef?, keptAsEvidence? }
  - `EvidencePacket` — { packetId, participant, source, title, refs[], summary, excerpts[] }
  - `FindingEvidenceLink` — { findingId, evidencePacketIds[] }
  - `ResearchDossier` — { participant, contextSummary, findings[], toolTrace[], evidencePackets[], findingEvidenceLinks[] }

  **Claim system:**
  - `ClaimRecord` — { claimId, owner, finding, evidenceRefs[], evidencePacketIds[], status: ClaimStatus, challenges[], debateRounds[], adjudication? }
  - `ClaimStatus` — "proposed" | "under_review" | "contested" | "verified" | "rejected" | "unresolved"
  - `ClaimChallenge` — { reviewer, claimId, verdict: PeerVerdict, reason, supportingEvidenceRefs?, requestedChecks? }
  - `PeerVerdict` — "agree" | "refine" | "disagree" | "needs_evidence"
  - `DebateTurn` — { participant, stance: "support"|"oppose"|"narrow"|"uncertain", summary, newEvidenceRefs? }
  - `DebateRound` — { round, claimId, participants: DebateTurn[], resolved, resolutionNote? }
  - `ClaimAdjudication` — { claimId, outcome: "accepted"|"accepted_with_revision"|"rejected"|"unresolved", rationale, finalSummary, supportingEvidenceRefs[] }

  **Consensus layer:**
  - `ArenaConsensus` — { summary, subjectSummary?, strengths[], improvements[], risks[], openQuestions[], roadmap[], roadmapDetails?, nextActions[] }
  - `ArenaConsensusItem` — { title, summary, support[], challenge[], confidence, evidenceRefs[] }
  - `ArenaRoadmapPhase` — { title, priority, goal, scope[], deliverables[], dependencies[], risks[], successCriteria[], relatedFindings[] }
  - `ArenaRoadmapPhaseDetail` — { phaseTitle, objective, targetFiles[], codeChanges[], interfaces[], migrationSteps[], validation[], effort, blockers[], evidenceRefs[] }

  **Result:**
  - `ArenaResultV2` — { topic, mode, participants, plan, baseContext, reports[], dossiers?, claims?, reviews[], debateRounds?, adjudications?, consensus }

  **Strategy interfaces (3-tier hierarchy):**
  - `ArenaStrategy` — base: researchSystemPrompt, researchUserPrompt, parseResearchResponse, crossReviewSystemPrompt, crossReviewUserPrompt, parseCrossReviewResponse, consensusSystemPrompt, consensusUserPrompt, parseConsensusResponse, preferredFindingKinds
  - `ArenaStrategyV2 extends ArenaStrategy` — adds: verificationReviewUserPrompt, parseVerificationReviewResponse, debateTurnUserPrompt, parseDebateTurnResponse, adjudicationUserPrompt, parseAdjudicationResponse, claimAwareConsensusUserPrompt
  - `ArenaStrategyPlanning extends ArenaStrategyV2` — adds: mergeReviewUserPrompt, parseMergeReviewResponse, detailExpansionSystemPrompt, detailExpansionUserPrompt, parseDetailExpansionResponse

  **Progress events (union type):**
  - `ArenaProgressEvent` — ~25 event types covering the full pipeline lifecycle

- **Connections:** Consumed by every other module in the arena system

---

### 2.4 `ledger.ts` — Shared Research Ledger

- **Path:** `src/arena/ledger.ts`
- **Exports:** `ArenaLedger` class
- **Key responsibilities:**
  - Append-only shared state across all arena rounds
  - Maintains `SharedResearchLedger` with arrays: dossiers, evidencePackets, toolTraces, claims, challenges, requestedChecks, adjudications
  - **Index layer:** Maps for fast lookup — claimsById, packetsById, requestsById
  - **Append operations:** `appendDossier()`, `appendEvidencePacket()`, `appendClaim()`, `appendChallenge()`, `appendRequestedCheck()`, `appendAdjudication()`
    - `appendDossier()` also unpacks the dossier's evidence packets and tool traces
    - `appendChallenge()` also registers requested checks and links challenge to claim
    - `appendAdjudication()` also attaches to the claim record
  - **Query operations:** `getSnapshot()`, `getClaimById()`, `getPacketById()`, `getAllClaims()`, `getClaimsByStatus()`, `getClaimsByOwner()`, `getChallengesForClaim()`, `getPendingChecks()`, `getPendingChecksForClaim()`, `getPacketsForClaim()`, `getDossiers()`, `getDossierByParticipant()`
  - **Growth warnings:** Logs warnings at 50 claims, 200 packets, 100 challenges
  - Deduplicates evidence packets by packetId on append
- **Connections:** Instantiated by `Arena.run()`, passed to all phases, consumed by `digest-builder.ts`, `claim-registry.ts`, `transitions.ts`, and all phase modules

---

### 2.5 `detect-mode.ts` — Mode Auto-Detection (Heuristic, unused in V2 pipeline)

- **Path:** `src/arena/detect-mode.ts`
- **Exports:** `detectArenaMode()` function, `ArenaModeDetection` interface
- **Key responsibilities:**
  - Keyword-based heuristic detection of mode from topic text
  - Weighted scoring: review (diff/bug/PR/refactor), discussion (debate/compare/trade-off), planning (roadmap/strategy/phase/milestone)
  - Confidence tiers: `bestScore >= 3 && lead >= 2 → "high"`, `bestScore > 0 → "low"`, else `"low"` with "review" default
- **Connections:** This is the "legacy" detector. The V2 pipeline uses `planner.ts` (LLM-based) instead. Still exported from index but `arena.ts` does not import it — the planner handles mode detection.

---

### 2.6 `planner.ts` — LLM-Based Planning

- **Path:** `src/arena/planner.ts`
- **Exports:** `planArena()` function, `PlannerFlags` interface
- **Key responsibilities:**
  - Takes natural language topic + optional flags (mode, base, head) → produces `ArenaPlan`
  - **Priority:** explicit flags > LLM plan > safe fallback defaults
  - If both `mode` and `base` are explicit, skips LLM call entirely (`buildExplicitPlan`)
  - LLM call uses a single prompt that outputs structured JSON: mode, lenses, sources, subject, outputShape, confidence
  - **Fallback plan:** Keyword-based heuristic (Chinese + English) in `buildFallbackPlan()` covers: roadmap/planning words, doc/PRD words, feasibility/discussion words, review/diff words, repo/codebase words. Returns confidence "low" for all fallback paths.
  - Validators: `validateMode()`, `validateConfidence()`, `parseLenses()`, `parseSources()`, `parseSubject()`, `parseOutputShape()` — all sanitize LLM output to valid values
- **Connections:** Called by `Arena.run()` as Phase 0. Output drives: evidence providers (sources), strategy+lens composition (mode+lenses), tool selector (sources), render ordering (outputShape.emphasize)

---

### 2.7 `digest-builder.ts` — Prompt Digest Construction

- **Path:** `src/arena/digest-builder.ts`
- **Exports:** `buildDigest()`, `formatDigest()`
- **Key responsibilities:**
  - Builds `RoundResearchDigest` from the ledger — a filtered view for prompt injection
  - Selects only evidence packets referenced by relevant claims (to avoid token explosion)
  - Collects tool trace summary from dossiers (only traces marked `keptAsEvidence`)
  - Filters challenges, requested checks, and adjudications by relevant claim IDs
  - **`formatDigest()`**: Renders digest as markdown text block with sanitization:
    - Strips `<system>`, `<assistant>`, `<user>` tags (anti-prompt-injection)
    - Strips instruction-like prefixes (IGNORE, DISREGARD, etc.)
    - Collapses excessive whitespace
    - Limits per-field to 2000 chars
  - This is **program-built, not model-built** — avoids recursion/token spiraling
- **Connections:** Called by all V2 phase modules (verification review, debate, adjudication, detail expansion). Consumes `ArenaLedger`.

---

### 2.8 `transitions.ts` — Claim State Machine

- **Path:** `src/arena/transitions.ts`
- **Exports:** `transitionClaim()`, `resolveClaimStatus()`, `markUnderReview()`, `applyReviewResult()`, `markUnresolved()`, `isTerminal()`, `validTransitions()`
- **State machine:**
  ```
  proposed → under_review
  under_review → verified | contested | rejected
  contested → under_review | unresolved | verified | rejected
  verified → (terminal)
  rejected → (terminal)
  unresolved → (terminal)
  ```
- **`resolveClaimStatus()` rules:**
  - No challenges → stays as-is (unreviewed ≠ verified)
  - Any "disagree" or "needs_evidence" → contested
  - Pending checks exist → contested
  - At least one explicit "agree" and rest "agree"/"refine" → verified
  - All "refine" without "agree" → stays under review
- **Connections:** Called by verification review, debate, adjudication phases. Centralized enforcement of valid state transitions.

---

### 2.9 Phases

#### 2.9.1 `phases/participant-research.ts` — Independent Investigation

- **Path:** `src/arena/phases/participant-research.ts`
- **Exports:** `runParticipantResearch()` (returns `ParticipantReport[]`), `runParticipantResearchWithDossiers()` (returns `ResearchResult[]` with dossiers), `ResearchResult` type
- **Key responsibilities:**
  - Runs all participants **in parallel** (`Promise.all`)
  - Each participant:
    1. Gets system prompt from strategy (`strategy.researchSystemPrompt`)
    2. Gets user prompt with base context (`strategy.researchUserPrompt`)
    3. Enters **tool-use loop** (up to `MAX_TOOL_ROUNDS` rounds, cap 30 messages)
    4. Each tool call: executes via `executeContextTool()`, records `ToolTrace`, builds `EvidencePacket` from successful results (result > 50 chars, no error prefix)
    5. Builds `FindingEvidenceLink` by matching finding evidence refs to packet refs
    6. If no text after max rounds, **force-concludes** with a "output findings NOW" prompt
    7. If still empty → returns failed report
    8. Otherwise → `strategy.parseResearchResponse()` to parse structured findings
  - Output: `ResearchDossier` with full evidence trail (toolTrace, evidencePackets, findingEvidenceLinks)
- **Connections:** Called by `Arena.run()`. Uses `context/context-tools.ts` for tool execution. Feeds into `ArenaLedger` and `claim-registry.ts`.

#### 2.9.2 `phases/cross-review.ts` — Peer Review (V1 + V2)

- **Path:** `src/arena/phases/cross-review.ts`
- **Exports:** `runCrossReview()` (V1), `runVerificationReview()` (V2)
- **Key responsibilities:**
  - **V1 (`runCrossReview`):** Each participant reviews all other participants' reports, produces `FindingReview[]` (agree/refine/disagree/needs_evidence). Retry on truncation (`stopReason === "length"`).
  - **V2 (`runVerificationReview`):**
    1. Selects claims for review via `selectClaimsForReview()` (prioritized by severity + confidence)
    2. Marks selected claims as `under_review`
    3. Builds round digest from ledger
    4. Routes to **planning merge review** (`ArenaStrategyPlanning.mergeReviewUserPrompt`) or **standard verification review** (`ArenaStrategyV2.verificationReviewUserPrompt`)
    5. Falls back to V1 cross-review if strategy doesn't implement V2
    6. For V1 fallback: maps `FindingReview` → `ClaimChallenge`
    7. After all reviews: applies results via `applyReviewResult()` (transitions claims to verified/contested/rejected)
  - Both paths run participants in parallel
- **Connections:** Called by `Arena.run()`. Uses `ledger.ts`, `digest-builder.ts`, `transitions.ts`, `claim-registry.ts`. Produces challenges consumed by debate/adjudication.

#### 2.9.3 `phases/debate-rounds.ts` — Structured Debate

- **Path:** `src/arena/phases/debate-rounds.ts`
- **Exports:** `runDebateRounds()`
- **Key responsibilities:**
  - Selects contested claims (capped at `limits.maxContestedClaimsForDebate`, default 5)
  - Debates each claim **sequentially** (not parallel — to avoid token explosion)
  - For each claim:
    1. Identifies **debaters:** claim owner + primary challenger (prefers "disagree" over "needs_evidence")
    2. Runs up to `maxRounds` (default 3-5 per mode)
    3. Each round: both debaters produce a `DebateTurn` (stance + argument), with `RoundResearchDigest` for evidence context
    4. **Convergence check:** all stances are "support" or "narrow" → resolved
    5. Falls back to generic prompt + `parseDebateTurn` util for non-V2 strategies
  - Attaches debate rounds to claim records in the ledger
- **Connections:** Called by `Arena.runReviewDiscussionPath()`. Uses `digest-builder.ts`, `strategies/utils.ts`.

#### 2.9.4 `phases/adjudication.ts` — Moderator Rulings

- **Path:** `src/arena/phases/adjudication.ts`
- **Exports:** `runAdjudication()`
- **Key responsibilities:**
  - The concluder acts as moderator
  - Adjudicates each contested claim via LLM with full context (claim + challenges + debate rounds + evidence digest)
  - Outcomes: "accepted", "accepted_with_revision", "rejected", "unresolved"
  - **Synthetic adjudications:** Verified claims get auto-generated adjudications (outcome: "accepted", rationale: "Verified by peer review without contest")
  - **Cleanup:** Remaining proposed/under_review claims are marked unresolved
  - Transitions claims to appropriate terminal state based on adjudication outcome
- **Connections:** Called by `Arena.runReviewDiscussionPath()`. Uses `ledger.ts`, `digest-builder.ts`, `transitions.ts`, `strategies/utils.ts`.

#### 2.9.5 `phases/build-consensus.ts` — Final Synthesis

- **Path:** `src/arena/phases/build-consensus.ts`
- **Exports:** `buildConsensus()`
- **Key responsibilities:**
  - The concluder synthesizes all reports, reviews, and optionally claim data
  - Routes to **claim-aware consensus** (V2: `claimAwareConsensusUserPrompt`) or **standard consensus** (V1: `consensusUserPrompt`)
  - Retry on truncation with condensed prompt
  - Output: `ArenaConsensus` — summary, subjectSummary, strengths/improvements/risks/openQuestions, roadmap, nextActions
- **Connections:** Called by both `runPlanningPath()` and `runReviewDiscussionPath()`. Receives `ClaimStatusSummary` with grouped verified/contested/unresolved/rejected claims.

#### 2.9.6 `phases/claim-registry.ts` — Finding-to-Claim Conversion

- **Path:** `src/arena/phases/claim-registry.ts`
- **Exports:** `registerClaims()`, `selectClaimsForReview()`
- **Key responsibilities:**
  - Converts each `ArenaFinding` from a dossier into a `ClaimRecord` with stable ID (`participant:findingId`)
  - Links evidence packet IDs from `FindingEvidenceLink`
  - Initial status: "proposed"
  - `selectClaimsForReview()`: sorts by severity (high > medium > low) then confidence (descending), capped at `maxClaims`
- **Connections:** Called by `Arena.run()` between research and review phases.

---

### 2.10 Strategies

#### 2.10.1 `strategies/index.ts` — Strategy Registry

- **Path:** `src/arena/strategies/index.ts`
- **Exports:** `ReviewStrategy`, `DiscussionStrategy`, `PlanningStrategy`, `withLens`, `getStrategy()`, `getStrategyForPlan()`
- **Key responsibilities:**
  - `getStrategy(mode)`: Returns new instance of mode-appropriate strategy
  - `getStrategyForPlan(plan)`: Returns `withLens(baseStrategy, plan)` — wraps mode strategy with lens-specific prompts
- **Connections:** Factory for all strategy instances. `Arena.run()` calls `getStrategyForPlan()`.

#### 2.10.2 `strategies/review.ts` — ReviewStrategy

- **Path:** `src/arena/strategies/review.ts`
- **Exports:** `ReviewStrategy` class (implements `ArenaStrategyV2`)
- **Key responsibilities:**
  - All prompt methods for review mode: research, cross-review, verification review, debate, adjudication, consensus (both V1 and V2/claim-aware)
  - **Finding emphasis:** risks > improvements > questions, strengths optional
  - Each method delegates formatting to shared utils (`formatBaseContext`, `formatReports`, `formatClaimsForReview`, etc.) and parsing to shared parsers (`parseReport`, `parseReviews`, `parseConsensus`, etc.)
- **Connections:** Uses `strategies/utils.ts` extensively. Implemented as class but has no instance state — all methods are pure prompt builders.

#### 2.10.3 `strategies/discussion.ts` — DiscussionStrategy

- **Path:** `src/arena/strategies/discussion.ts`
- **Exports:** `DiscussionStrategy` class (implements `ArenaStrategyV2`)
- **Key responsibilities:**
  - Same structure as ReviewStrategy but with discussion-specific tone: "engage thoughtfully, challenge weak arguments, acknowledge strong ones"
  - Consensus prompt emphasizes preserving minority viewpoints, not suppressing disagreements
  - No roadmap output in consensus
- **Connections:** Same utils dependency as ReviewStrategy.

#### 2.10.4 `strategies/planning.ts` — PlanningStrategy

- **Path:** `src/arena/strategies/planning.ts`
- **Exports:** `PlanningStrategy` class (implements `ArenaStrategyPlanning`)
- **Key responsibilities:**
  - Same structure as V2 strategies plus planning-specific methods:
    - **`mergeReviewUserPrompt`**: Review for merge/convergence, not correctness judging. Uses semantic tags: `[merge]`, `[reprioritize]`, `[split_phase]`, `[combine_phase]`, `[dependency_risk]`, `[needs_detail]`, `[open_question]`
    - **`detailExpansionSystemPrompt`**: Architect expanding roadmap phase into repo-level implementation plan — names actual files, modules, interfaces
    - **`detailExpansionUserPrompt`**: For a single roadmap phase, asks 7 specific questions (files, changes, interfaces, migration, validation, effort, blockers)
  - Consensus prompt emphasizes 3-6 roadmap phases with sequencing, dependencies, deliverables, success criteria
- **Connections:** Uses `parseDetailExpansion` from utils (unique to planning). The only strategy implementing `ArenaStrategyPlanning`.

---

### 2.11 Lenses

#### 2.11.1 `lenses/index.ts` — Lens Registry

- **Path:** `src/arena/lenses/index.ts`
- **Exports:** `getLens()`, `resolveLenses()`, `buildLensPrompt()`, `LENS_NAMES`, `engineeringLens`, `productLens`, `architectureLens`, `generalLens`
- **Key responsibilities:**
  - Maps `ArenaLensName` → `ArenaLens` object
  - `buildLensPrompt(lenses, phase)`: Builds combined prompt fragment for participant/reviewer/moderator roles, merging criteria from multiple lenses with deduplication
  - `LENS_NAMES`: ["engineering", "product", "architecture", "general"]
- **Connections:** Used by planner validator, strategy lens-wrapper

#### 2.11.2 `lenses/general.ts` — General Lens

- **Path:** `src/arena/lenses/general.ts`
- **Exports:** `generalLens: ArenaLens` constant
- **Key responsibilities:** Fallback lens — broad analysis without domain focus. Criteria: logical coherence, completeness, trade-off identification, assumption clarity, evidence quality, actionability.
- **Connections:** One of four lens modules (engineering, product, architecture, general). Other three not shown but follow same pattern.

---

### 2.12 Providers

#### 2.12.1 `providers/index.ts` — Provider Registry

- **Path:** `src/arena/providers/index.ts`
- **Exports:** `collectEvidence()`, `CollectEvidenceOptions`, re-exports all providers
- **Key responsibilities:**
  - Maps source kinds to providers: git→`gitProvider`, repo→`repoProvider`, docs→`docsProvider`, web→`noneProvider` (deferred), none→`noneProvider`
  - Runs providers **in parallel** with per-provider **8-second timeout** (prevents slow grep from stalling arena startup)
  - Builds `quickFacts` from artifacts: branch name, changed file count, document count, sources, lenses
  - Deduplicates by source kind (only one provider per kind)
  - Timeout uses `Promise.race()` with `setTimeout`; also listens for abort signal
- **Connections:** Called by `Arena.run()` Phase 1. Output feeds into `ArenaBaseContext`.

#### 2.12.2 `providers/git.ts` — Git Evidence Provider

- **Path:** `src/arena/providers/git.ts`
- **Exports:** `gitProvider: ArenaContextProvider`
- **Key responsibilities:**
  - Collects: current branch, commit log, diff stat, changed files (with name-status), directory clustering, truncated diff (max 20K chars), git status (fallback)
  - Supports comparison mode (base...head) or working-tree mode (HEAD / staged)
  - **Security:** Uses `execFileSync` with argument arrays — no shell interpretation. `sanitizeRef()` strips range operators (`..`, `...`) and shell-unsafe characters.
  - Directory clustering groups changed files by top-2 directory levels
- **Connections:** Sync provider (returns `ArenaArtifact[]`, not Promise). Called by provider registry.

#### 2.12.3 `providers/repo.ts` — Repository Evidence Provider

- **Path:** `src/arena/providers/repo.ts`
- **Exports:** `repoProvider: ArenaContextProvider`
- **Key responsibilities:**
  - Collects: project tree (max depth 2), specific files if targets provided, grep results for topic keywords
  - **Tree walk:** Iterative + node-capped (max 400 nodes). Skips dot files, `node_modules`, `dist`, `__pycache__`.
  - **Grep:** Fan-out up to 5 keyword hints in parallel (3s timeout each). Keyword extraction strips stop words (English + Chinese).
  - **Entry files:** Priority order: `index.ts`, `index.js`, `main.ts`, `main.js`, `mod.ts`, `__init__.py`
  - **File safety:** Skips files > 500KB. Truncates content at 8K chars.
  - If no explicit git source in plan, also collects recent git log (avoids duplicate with git provider)
  - **Performance:** Parallel grep + iterative capped walk replaced the previous serial/serial recursive approach
- **Connections:** Async provider (returns `Promise<ArenaArtifact[]>`). Called by provider registry.

---

### 2.13 Renderers

#### 2.13.1 `render/terminal.ts` — Terminal CLI Renderer

- **Path:** `src/arena/render/terminal.ts`
- **Exports:** `formatArenaResult()`, `printArenaResult()`, `renderProgress()`, `createProgressRenderer()`, `OutputSink` type
- **Key responsibilities:**
  - `formatArenaResult()`: Renders full arena result as styled string using **chalk** colors:
    - Planning: roadmap + implementation details first, then consensus sections
    - Non-planning: consensus sections first, then roadmap
    - Sections ordered by `outputShape.emphasize` (from plan), falling back to default order: risks → improvements → strengths → questions
    - Icons: ✓ (strength/green), → (improvement/yellow), ⚠ (risk/red), ? (question/cyan)
    - Next Actions with priority tags (HIGH/MED/LOW)
    - Footer with mode, finding count, participant names, lenses, sources
  - `createProgressRenderer(sink)`: Maps ~25 `ArenaProgressEvent` types to styled status lines:
    - Plan, evidence phases, research (with tool lookups), cross-review, verification review (vs planning merge review), debate rounds, adjudication, roadmap expansion, consensus
  - `renderProgress()`: Legacy direct-to-console wrapper
- **Connections:** Used by CLI command and REPL. Consumes `ArenaResultV2` and `ArenaProgressEvent` types.

#### 2.13.2 `render/session.ts` — Markdown Session Renderer

- **Path:** `src/arena/render/session.ts`
- **Exports:** `formatArenaResultForSession()`
- **Key responsibilities:**
  - Renders `ArenaResultV2` as markdown for display as `assistant_text` and follow-up LLM context
  - Output order: subject summary → overall assessment → roadmap (planning-first) → consensus sections (ordered by emphasis) → next actions → per-participant findings (collapsed)
  - Adapts subject summary label per mode: "What Changed" (review), "Current Scope" (planning), "Problem Framing" (discussion)
  - Participant findings section includes contextSummary quote and per-finding kind/severity tags
  - Roadmap phases get markdown headings with priority labels
  - Implementation details show target files as inline code, numbered migration steps
- **Connections:** Used by engine/session to inject arena results into conversation context.

---

### 2.14 `tools/selector.ts` — Tool Selector

- **Path:** `src/arena/tools/selector.ts`
- **Exports:** `selectTools()`, `hasTools()`
- **Key responsibilities:**
  - Maps source kinds to tool packs:
    - `git` → `read_file`, `grep_code`, `list_files`, `git_show`, `git_blame`
    - `repo` → `read_file`, `grep_code`, `list_files`
    - `docs` → `read_file`, `list_files`
    - `web`/`none` → no tools
  - Merges tool packs from all active sources, deduplicating by name
  - Filters `CONTEXT_TOOLS` registry to produce final `ToolDefinition[]`
  - Supports custom `toolPack` override in `ArenaSourceSpec`
- **Connections:** Called by `Arena.run()` Phase 3. Output passed to participant research phase.

---

### 2.15 `model-presets.ts` — Model Registry

- **Path:** `src/arena/model-presets.ts`
- **Exports:** `MODEL_PRESETS`, `getMaxOutputTokens()`, `ModelPreset` type
- **Key responsibilities:**
  - Maps 16 preset names to provider/model paths with maxOutputTokens
  - Presets: claude, claude-sonnet, claude-haiku, gpt, gpt4o, o4, o3, deepseek, deepseek-r1, gemini, gemini-2.5, gemini-flash, qwen, qwen-coder, llama, devstral
  - `getMaxOutputTokens(model)`: Lookup by preset key first, then by full model path, fallback 8192
- **Connections:** Used by the `Arena` tool definition in `src/tool-system/builtin/arena.ts` to resolve participant presets into full LLM configs.

---

## 3. Product Module (`src/product/`)

### 3.1 `product/index.ts`

- **Path:** `src/product/index.ts`
- **Exports:** `defineProduct`, `ProductRuntimeOptions`, `ProductInstance` (from `define.ts`), all types from `types.ts`
- **Key responsibilities:** Public API barrel for the product module

### 3.2 `product/define.ts` — Product Builder

- **Path:** `src/product/define.ts`
- **Exports:** `defineProduct()`, `ProductRuntimeOptions`, `ProductInstance`
- **Key responsibilities:**
  - Assembles a domain-specific agent from three layers:
    1. **Preset (brain)** — system prompt, tool set, permission rules
    2. **Adapter (hands)** — custom tools, MCP servers, permission overrides
    3. **Contract (quality)** — evaluator, tags, max turns
  - Registers the preset into CodeShell's preset registry
  - Creates a `RunManager` with `FileRunStore`, custom tools, evaluators, and hooks
  - Default enabled tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Agent, ToolSearch, TaskCreate, TaskList, TaskUpdate, TaskGet
  - Default permission rules: Read/Glob/Grep/AskUserQuestion/ToolSearch/TaskCreate/TaskList/TaskUpdate/TaskGet all "allow"
  - Evaluator can be single, array (auto-composed), or none (NoopEvaluator)
- **Connections:** This is the primary entry point for external repos building agents on CodeShell. Consumes preset registry, RunManager, FileRunStore, Evaluator infrastructure.

### 3.3 `product/types.ts` — Product Contract Types

- **Path:** `src/product/types.ts`
- **Exports:** `ProductPreset`, `CustomTool`, `ProductAdapter`, `ProductContract`, `ProductDefinition`
- **Key hierarchy:**
  - `ProductPreset`: name, label, description, sections/customPrompt, appendPrompt, injectGitStatus
  - `CustomTool`: definition (RegisteredTool) + execute function
  - `ProductAdapter`: tools[], mcpServers, enableTools[], disableTools[], permissionRules[], hooks[]
  - `ProductContract`: evaluator, defaultTags, defaultMetadata, maxTurns, maxContextTokens, concurrency
  - `ProductDefinition`: preset + optional adapter + optional contract
- **Connections:** Consumed by `defineProduct()`. References `PermissionRule`, `MCPServerConfig`, `EngineHookConfig` from the core framework types.

---

## 4. Data Flow Summary

```
User Topic (NL)
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 0: Planner (LLM)                                   │
│   topic → {mode, lenses, sources, subject, outputShape} │
└──────────┬──────────────────────────────────────────────┘
           │ ArenaPlan
           ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 1: Evidence Collection (parallel providers)        │
│   plan.sources → git diff, repo tree, grep, docs →      │
│   ArenaArtifact[] + ArenaQuickFact[]                     │
└──────────┬──────────────────────────────────────────────┘
           │ ArenaBaseContext
           ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 2: Strategy Composition                             │
│   plan.mode → Strategy + plan.lenses → LensWrapper       │
└──────────┬──────────────────────────────────────────────┘
           │ ArenaStrategy
           ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 3: Tool Selection                                   │
│   plan.sources → ToolPack merge → ToolDefinition[]       │
└──────────┬──────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 4: Participant Research (parallel)                  │
│   Each model: tool loop → ResearchDossier                │
│   (Report + EvidencePackets + ToolTraces)                │
└──────────┬──────────────────────────────────────────────┘
           │ dossiers[]
           ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 4b: Claim Registry + Ledger                         │
│   findings → ClaimRecord[] → ArenaLedger                 │
└──────────┬──────────────────────────────────────────────┘
           │
           ▼
     ┌─────┴─────┐
     │  Mode = ?  │
     └─────┬─────┘
     ┌─────┴──────────────┐
     │                    │
  planning           review/discussion
     │                    │
     ▼                    ▼
┌──────────────┐  ┌──────────────────────┐
│ Merge Review │  │ Verification Review   │
│ (converge)   │  │ (V2 claim-aware)      │
└──────┬───────┘  └──────────┬───────────┘
       │                     │
       ▼                     ▼
┌──────────────┐  ┌──────────────────────┐
│ Consensus    │  │ Debate Rounds         │
│ (roadmap)    │  │ (contested claims)    │
└──────┬───────┘  └──────────┬───────────┘
       │                     │
       ▼                     ▼
┌──────────────┐  ┌──────────────────────┐
│ Detail       │  │ Adjudication          │
│ Expansion    │  │ (moderator rulings)   │
│ (repo-level) │  └──────────┬───────────┘
└──────┬───────┘             │
       │                     ▼
       │            ┌──────────────────────┐
       │            │ Consensus             │
       │            │ (claim-aware)         │
       │            └──────────┬───────────┘
       │                       │
       └───────────┬───────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │ ArenaResultV2        │
         │ → Terminal Renderer  │
         │ → Session Renderer   │
         └─────────────────────┘
```

---

## 5. Strategy Interface Hierarchy

```
ArenaStrategy (base)
├── researchSystemPrompt / researchUserPrompt / parseResearchResponse
├── crossReviewSystemPrompt / crossReviewUserPrompt / parseCrossReviewResponse
├── consensusSystemPrompt / consensusUserPrompt / parseConsensusResponse
└── preferredFindingKinds
     │
     ▼ extends
ArenaStrategyV2 (+ V2 claim-aware methods)
├── verificationReviewUserPrompt / parseVerificationReviewResponse
├── debateTurnUserPrompt / parseDebateTurnResponse
├── adjudicationUserPrompt / parseAdjudicationResponse
└── claimAwareConsensusUserPrompt
     │
     ▼ extends
ArenaStrategyPlanning (+ planning-specific methods)
├── mergeReviewUserPrompt / parseMergeReviewResponse
├── detailExpansionSystemPrompt / detailExpansionUserPrompt / parseDetailExpansionResponse

Implementations:
  ReviewStrategy       → implements ArenaStrategyV2
  DiscussionStrategy   → implements ArenaStrategyV2
  PlanningStrategy     → implements ArenaStrategyPlanning
```

---

## 6. Claim Lifecycle

```
Finding (from research)
    │
    ▼ registerClaims()
ClaimRecord (status: "proposed")
    │
    ▼ selectClaimsForReview() + markUnderReview()
ClaimRecord (status: "under_review")
    │
    ▼ runVerificationReview()
    ├── all agree → applyReviewResult() → "verified"
    ├── disagree/needs_evidence → applyReviewResult() → "contested"
    └── no clear signal → stays "under_review"
     │
     ▼ (contested path)
runDebateRounds()
    │
    ├── convergence → claim.debateRounds resolved
    └── max rounds exhausted
     │
     ▼
runAdjudication()
    ├── accepted/accepted_with_revision → "verified"
    ├── rejected → "rejected"
    ├── unresolved → "unresolved"
    └── synthetic (pre-verified claims) → "accepted"
     │
     ▼ (any remaining proposed/under_review)
markUnresolved() → "unresolved"
```

States and valid transitions are enforced **centrally** by `transitions.ts`.

---

## 7. Key Design Decisions

1. **Evidence-first:** Models don't produce opinions until providers have collected artifacts. This anchors analysis in ground truth (git diffs, repo structure, docs).

2. **Append-only ledger:** The `ArenaLedger` preserves all history. Claims, challenges, and adjudications are never overwritten — only appended. Indices enable fast lookups.

3. **Digest for token control:** Rather than injecting the full ledger into every prompt, `buildDigest()` creates filtered views scoped to relevant claims. Sanitization strips prompt-injection patterns.

4. **Parallel where safe, sequential where necessary:** Participant research and cross-review run in parallel. Debate runs sequentially (to avoid token explosion from parallel debates feeding into each other). Evidence providers also run in parallel.

5. **Graceful degradation:** Every phase has fallbacks. V2 strategies fall back to V1. Detail expansion failures are non-critical. Provider timeouts return empty arrays. Truncated LLM responses trigger retries.

6. **Planner as single LLM call:** Instead of separate intent/scope resolution steps, one planner prompt produces the full `ArenaPlan`. Explicit flags completely bypass the LLM.

7. **Strategy × Lens composition:** Mode strategies are wrapped by lens wrappers (`withLens`) and language wrappers (`withLanguage`) — each adding prompt fragments without the strategy needing to know about lenses.

8. **Product module as external surface:** `defineProduct()` enables external repos to build domain-specific agents on CodeShell without modifying the framework. It composes preset + adapter + contract into a ready-to-use `RunManager`.
