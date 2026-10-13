# Core remaining review — 62a58ac

Review workspace: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell`.
Frozen HEAD: `62a58ac8702835f848108e152234a6bdd6c3eb3f`.
This is review evidence, not a patch. No product source/tests, repository docs, account state or remote resources were changed. Prior 86 findings were compared against the old review README and priority-and-coverage; none of the five candidates below duplicates their stated trigger/root cause. The old report uses 84740/a66f and is not evidence of current complete coverage.

## Execution record and boundaries

- Original fixture: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/candidates.test.ts`.
- Original output: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/candidates.log`.
- Original command: `node scripts/run-bun-test-shard.mjs --timeout 30000 /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/candidates.test.ts`.
- Completed: 10 tests pass, 0 fail, 33 expect calls, no skips; maintained runner confirms completed JUnit and deletes its temporary isolated HOME. The fixture restores its network guards and clears registry/notification/auth caches. No actual model/socket request, browser action, or tool command was executed.
- **Coordination limitation:** this original run was started before root explicitly announced its package-release gate. It imports Core source directly, with installed SDK dependencies, while root dependency preparation was still in progress. It must not be described as a clean build or a stable-dist verification. Root subsequently announced a successful gate (9 tarballs / 47 type / 45 runtime entries). Post-gate runs below verify only the selected provider/auth/accounting controls; policy/agent tests were not rerun.
- Before any Core import, the fixture replaces global fetch, HTTP(S) request/get, net Socket connect and datagram send with denial; it owns zero network origins. SDK instances receive explicit in-memory fetch functions that validate synthetic `http://fixture.invalid` URLs and return Response objects without sockets. afterAll confirms zero denied network attempts. Auth command tests use the public injected `runCommand` seam; no program is spawned.
- Original source imports are absolute paths under `packages/core/src`. Post-gate Bun resolution is `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/node_modules/.bun/openai@4.104.0+8b4daec44fbddaf3/node_modules/openai/index.mjs` and `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/node_modules/.bun/@anthropic-ai+sdk@0.39.0+d56b95ac411b1cdd/node_modules/@anthropic-ai/sdk/index.mjs`. No core production source import of another `@cjhyy/*` package was found.
- Root's latest direction stops all command-execution/permission reproduction work. The previously noted `rg --pre`/package-manager classification idea remains **static, unexecuted and unfiled**. No such command was run. Further work is limited to LLM parsing/retry/output consistency, auth refresh, budget/accounting and resource cleanup, using no-network fetch substitutes.

### Post-gate provider/accounting runs

- Existing-provider rerun: `node scripts/run-bun-test-shard.mjs --timeout 30000 --test-name-pattern 'Anthropic|authCommand' /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/candidates.test.ts`; raw output `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/providers-post-gate.log`. **3 pass, 7 filtered/skipped, 0 fail, 9 expectations**. This is not another ten-test pass.
- Scoped accounting fixture: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/providers-accounting.test.ts`; command `node scripts/run-bun-test-shard.mjs --timeout 30000 /Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/providers-accounting.test.ts`; raw output `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/providers-accounting.log`. **5 pass, 0 skipped, 0 fail, 18 expectations**. The maintained runner completed JUnit and cleaned its isolated HOME. Tests use real SDK parsers, in-memory Response SSE/JSON, actual ModelFacade/TurnLoop/Transcript.inMemory/UsageLedger, with a no-tool executor and a pure continuation hook. No Engine process, actual model, real auth program, disk receipt or product tool was run.
- The scoped fixture installs network denial before importing Core, owns zero origins, asserts no denied call, restores the patches, and clears auth cache. Ledger state is memory-only. SDK failures are intentional SSE error events, not unexpected fixture/test failures. No test failed or hung in these two post-gate runs.
- OpenAI and Anthropic pre-aborted createMessage calls both return AbortError without entering injected SDK fetch. This proves the pre-send cancellation control only. Active-stream cancellation, stalled transport timers, real sockets, process shutdown and SDK resource retention were not dynamically exercised here.

## Candidates already evidenced

### C1 — P2 candidate: hook-updated input skips final plan/MCP argument gates

Location: `packages/core/src/tool-system/executor.ts` — MCP argument policy before hooks (267/296), plan Bash classification (333–335), pre_tool_use emit (364) and updatedInput assignment (382–383). Updated arguments get schema/path/permission checks, but plan command classification and generic MCP tool policy are not repeated.

Trigger/control: in plan mode, direct `echo x > result.txt` is rejected and direct `ls -la` succeeds. A trusted pre_tool_use handler rewriting the latter to the former reaches the synthetic Bash handler successfully. Similarly, an allowed MCP server with `disabledTools: delete_all` rejects a direct forbidden call, but a hook rewriting allowed `list` to `delete_all` on that same server reaches the synthetic MCPTool handler.

Impact: configured hooks can accidentally defeat the enforced plan promise or configured MCP per-tool policy. Hooks are user-configured executable programs, so this is a policy-composition correctness issue, not a claim of isolation against hostile hook code. The fixture executes only fake handlers; production Bash has no second plan gate, and builtin/mcp-tools.ts → MCPManager.callTool has no repeated mcpToolPolicies check. Run binding independently protects server/workspace identity; the finding is limited to a different disabled tool on the same allowed server. No actual shell write/MCP call was executed. Further permission reproduction is stopped per root instruction.

### C2 — P2 candidate: AgentCancel accepts another session's running child

Location: `packages/core/src/tool-system/builtin/agent.ts:1262–1273`. agentCancelTool takes args, looks up the process-global registry and cancels, without ToolContext ownership. Actual builtin registration in builtin/index.ts:550–557 has permissionDefault allow; harness preset default rules allow AgentCancel. Native ToolExecutor invocation does not traverse the separate agent/cancel RPC gate.

Trigger/control: synthetic running registry entry owned by session-b is rejected by AgentStatus(agent_id) from session-a, yet the real registered AgentCancel builtin through ToolExecutor from session-a invokes its abort and marks it cancelled. Own-session control succeeds. AgentStatus(all:true) can reveal the id, so this does not require guessing. The executor reproduction originally used bypassPermissions; static production default-allow rules corroborate reachability without relying on that mode. UI cancelBackgroundWorkForUI separately checks session, start and generation; KillShell is separately owner-scoped. No real child process or model was launched. Further permission reproduction is stopped.

### C3 — P2 candidate: cold child continuation loses the role's extra constraints

Location: `packages/core/src/tool-system/builtin/agent.ts:1425–1442`. The cold path calls resolveAgentTypeOverrides(entry?.agentType, currentDefinitions); when the process-local entry is gone, undefined resolves to the default role. Agent type and tool/skill/MCP/model/sandbox overrides are not persisted in SessionState. The direct-parent check at 1400–1413 correctly reads persisted parent identity and does not recover role scope.

Trigger/control: spawn reviewer with tools [Read], skills [], mcp [], seatbelt and safe-model; warm AgentSendInput keeps them. Reset only the process-local registry while retaining the fake persisted-session identity/parent; cold AgentSendInput resumes the same child session with general-purpose and no role overrides. The captured three spawner requests are in the original log.

Production chain: Engine.createSubAgentSpawner at engine.ts:2536–2566 supplies real sessionExists/readParentSessionId and child Engine constructors; engine/subagent-spawner.ts builds the child config from request.toolAllowlist/skillAllowlist/mcpAllowlist/sandboxMode/model; run-session-open restores transcript/cost/user input, not agent role. SessionManager.create records parentSessionId, not role. This is a registry-reset/spawner-seam reproduction, **not an executed process-restart/real Engine run**. Parent baseline permission/sandbox constraints still apply; only the role's additional restrictions are lost. Role removal's catch fallback can also omit old constraints. Further capability reproduction is stopped.

### C4 — P2 candidate: Anthropic retries after visible output without revoking it

Location: `packages/core/src/llm/providers/anthropic.ts:189–228`. withRetry receives only signal and forwards visible chunks from all attempts. OpenAI explicitly prevents transparent retries once a non-stop chunk escapes at openai.ts:499–502.

Trigger/control: real Anthropic SDK with in-memory SSE fetch gets first valid stream text `FAILED PREFIX`, then an overloaded_error SSE event; second stream succeeds with `SUCCESS`. Result text is SUCCESS, but ModelFacade emits `FAILED PREFIX` then `SUCCESS`, without tombstone, after two sends. Successful control emits just SUCCESS after one send.

Impact chain: TurnLoop only revokes partial output if facade.call throws; this internal retry returns success. Host reviewer statically confirmed `packages/web/src/lib/streamReducer.ts:209–220` appends text_delta and :457–473 final assistant_message seals without replacing, and `packages/tui/src/ui/App.tsx:781–819` accumulates the streaming buffer without an assistant_message replacement. Thus those surfaces retain the failed prefix in the completed bubble. Desktop pure text does replace with canonical final text in types.ts:1258–1303 per the host reviewer's source trace; do not generalize pure-text impact to Desktop. Streamed tool placeholders are independent, but ghost tool cards are only a static secondary implication. **No duplicate tool execution is claimed**: execution waits for the full response. UI behavior has static host evidence only, not executed UI reducers.

**Verified accounting impact of the same retry scenario (not counted as a sixth candidate):** with Goal tokenBudget=6, first failed stream reports 10 prompt tokens, transparent successful retry reports 2+2. Before the next logical turn's third physical send, the actual UsageLedger already knows 14 tokens, but TurnLoop has charged only the successful 4 tokens and allows that extra send. Final physical ledger is 3 requests / prompt14 / completion4 / total18, unknownUsageRequests=0; foreground client and TurnLoop cumulative callbacks contain only two successful 4-token responses, total8. It stops with goal_budget_exhausted only after that extra request. Normal control: a single successful 10+2 stream crosses the same budget and stops after one send. All values come from post-gate no-network tests.

The layers differ deliberately in source, but the hard Goal cap and session foreground totals fail to include known failed-attempt usage: Anthropic streamEvent records snapshots into physical receipts at anthropic.ts:302–304; only finalMessage success calls recordUsage at :368–371. client-base.ts:99–117 adds successful foreground totals; :124–126 records attempt snapshots only into the receipt owner. TurnLoop:1201–1212 feeds response.usage into logical/session accumulation and Goal. GoalConfig describes a whole-goal-run token cap at goal/lifecycle.ts:29–30; its tracker uses those charged response totals. Repair of visible retry output alone should not be assumed to repair billing: ensure known failed-attempt usage remains charged if the fallback/retry policy changes. Broader provider/fallback accounting is a follow-up boundary, not independently evidenced/countable here.

**Persisted-state chain, static only:** run-accounting.ts:101–112 derives getRunUsage from visible client totals plus external auxiliary usage. run-finalize.ts:308–315 folds that value into session.state.tokenUsage, then serializes costState independently and persists the state. engine.ts:3673–3677 derives costState from UsageLedger.sessionState, which retains physical usage. Persisted Goal lifecycle at goal/lifecycle.ts:95–126 contains its budget configuration/identity/phase, not a receipt-driven tokensUsed counter. There is no demonstrated reconciliation from costState to the live Goal tracker in this scenario. We did not execute actual SessionManager disk finalization, crash recovery or cross-run budget continuity; the budget is documented as run-scoped, so no independent resume/reset defect is claimed.

### C5 — P2 candidate: authCommand token is frozen for the SDK-client lifetime

Locations: `packages/core/src/llm/provider-auth.ts:42–73` caches short-lived tokens for 60 seconds; `llm/providers/openai.ts:330–347` and `anthropic.ts:85–97` resolve token only while creating a cached SDK instance.

Trigger/control: injected auth resolver seeds token-first, real OpenAI client sends Bearer token-first. Rotate the resolver cache through its public seam to token-fresh; the same SDK client still sends token-first, while a new SDK client sends token-fresh. Captured headers are `[token-first, token-first, token-fresh]`; zero command processes. This tests cache-rotation equivalence, not a real elapsed minute or real token expiry.

Impact: a long running tool loop retaining its model client can begin failing authentication once the externally minted token expires; subsequent requests/retries keep the old key. A new Engine/client can recover. The post-gate accounting fixture now also captures Anthropic x-api-key headers `[token-first, token-first, token-fresh]` under the same cache-rotation control. Thus both SDK clients are dynamically evidenced with injected auth resolution; neither real time expiry nor an external identity provider was exercised. Per-run reuse and creation should be included when explaining the trigger, rather than claiming all future sessions fail.

## Directory ledger (this subagent only)

Inventory: `/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/docs/review-remaining-2026-10-12/validation/core/core-inventory.json`, enumerating every production `.ts` file by Core source directory. Counts below are production TS / test TS, not statement or branch coverage. “Read” means only the listed entry/lifecycle evidence; it does not certify every file in a directory. “Not covered here” may be assigned to another root reviewer.

| Core directory | TS prod/tests | This review's static/dynamic state and remaining boundary |
| --- | --- | --- |
| agent | 2/4 | Both definition parser/registry read; cold role recovery statically traced through consumers, seam tested. Native reload not executed. |
| automation | 8/29 | Not covered here. |
| capabilities | 1/0 | Export wiring touched; no independent dynamic coverage. |
| capability-control | 6/5 | service/overlay/disabled-lists/project read, types/exports inspected; no dynamic toggle/recovery. |
| cli | 4/3 | Not covered here. |
| composition | 10/5 | activation/lifetime/freeze/compiler lifecycle read, remaining wiring partially read; no dynamic activation or disposal. |
| context | 7/17 | Not covered here. |
| cost-ledger | 6/1 | All production files read: attempt/snapshot ownership, receipt persistence, summary/pricing/unknown semantics. Real in-memory receipt aggregation tested with failed stream and successful retry; no dynamic disk/persistence failure, corruption or child stress. |
| credentials | 12/13 | Not covered here. |
| data | 4/2 | TS inventory only; shipped JSON data also exists and is outside this TS count. |
| engine | 51/112 | ModelFacade, request/fallback/stream sections, run-accounting/token-budget, run-finalize and subagent-spawner/session-open consumer paths read. Actual TurnLoop with in-memory transcript and pure dependency controls tested for retry budget; full Engine/session persistence and most of 51 files not covered here. |
| goal | 1/1 | Lifecycle budget accounting/control branches read; actual TurnLoop budget exhaustion and successful-stream control tested. Pause/resume/revision/waiting/terminal lifecycle and persisted recovery not dynamically covered here. |
| hooks | 7/4 | All hook handler/registry/merge/shell-runner/input-output paths read; goal-stop hook large parsing/cache/control sections read with some remaining body review. Only pure HookRegistry rewrites tested. No shell hook process. |
| links | 26/13 | Not covered here. |
| llm | 25/32 | Provider/base/retry/watchdog/model auth/pool/fetch/cache/catalog/support code read; capability/spec/type/export files partly read. Real Anthropic SDK error/retry/success parsing, both SDK auth headers/cache rotation and pre-aborted control tested. Existing 32 test files not run here; OpenAI streamed failure/fallback, malformed/interleaved tool streams, active cancellation/stalls and real provider networking remain outside executed coverage. |
| logging | 3/2 | Consumer calls inspected, no dedicated review. |
| model-catalog | 8/9 | Pricing/model identity consumers inspected, no dedicated review. |
| model-request-boundary | 7/5 | All production files read: logical projection, physical attempt/signature anchor, custody/session incarnation and durability. No dynamic signing/filesystem failures here. |
| operations | 9/6 | Not covered here. |
| panel-apps | 17/11 | Interfaces/strict-validator consumer touched; no dedicated review. |
| plugins | 46/46 | No dedicated review here. |
| preset | 2/6 | AgentCancel default permission wiring inspected; other preset behavior not covered. |
| product | 3/0 | Not covered here. |
| profile | 13/8 | Not covered here. |
| prompt | 5/9 | Only consumer interfaces; Markdown prompt assets not included in TS count and not fully reviewed. |
| protocol | 19/61 | Subagent cancel versus run-stop and session-tool-host trust/cancel ownership compared statically. Most protocol code not covered here. |
| remote | 1/1 | Not covered here. |
| run | 16/15 | Not covered here. |
| runtime | 12/12 | Bash safe-spawn references only; no dedicated full review or native execution. |
| services | 12/16 | Not covered here. |
| session | 11/33 | SessionManager create/read parent/resume role fields and Transcript consumers read; full persistence recovery not covered. |
| settings | 8/17 | AuthCommand schema/manager consumers and dangerous-field routing touched; no dedicated review. |
| skills | 8/5 | Child allowlist consumer paths only; no dedicated scanner/install review. |
| sources | 24/18 | Not covered here. |
| speech | 1/1 | Not covered here. |
| stt | 2/2 | Not covered here. |
| testing | 1/0 | Maintained runner and native isolator source read; no product test changes. |
| themes | 5/1 | Not covered here. |
| tool-system | 92/132 | Executor/registry/context/permission classifiers/session-tool-host/surface/metadata/guards/bound-result/redaction; agent registry/direction/notifications/heartbeat/progress/output/translator; MCP argument policy + run binding/call flow; path approval/final-write, Read/Write/Edit/Bash/REPL/PowerShell/WebFetch read. Most specialized media/network/browser/panel/config/cron builtin bodies and full MCP/sandbox transports still not covered. Three policy/child lifecycle seam groups tested; no real tools/commands/transports. Work now narrowed to provider/accounting per root. |
| utils | 20/7 | Secret-scrubber/path consumers touched; no dedicated full review. |
| workspace | 2/2 | Workspace scope/digest consumers touched; no dedicated review. |

## Appendix — unexecuted or non-countable boundaries

- Plan Bash classification for advanced command options/package-manager operations was noted statically; all new command/permission reproduction was stopped on root instruction. It is not an additional finding.
- Ghost tool cards after a failed Anthropic attempt have only static UI reasoning and were not dynamically reproduced; no duplicate tool side effect is claimed.
- Budget accounting is demonstrated for the same Anthropic transparent retry as C4 and merged into C4. Independent OpenAI stream fallback, cancellation with partial usage, auxiliary requests and child aggregation were not reproduced; do not count these as separate findings.
- Receipt/signature durability, filesystem failure, actual token expiry, real subprocess restart and real UI/native transport behavior were not executed. No independent signer-ledger defect was established.
- This handoff closes this subagent's narrowed provider/accounting scope and preserves its earlier static/seam review evidence. It does **not** claim all Core files, all 41 directories, all existing test suites, OS platforms, or real providers have been audited. Zero findings in a directory does not mean that directory was fully audited.
