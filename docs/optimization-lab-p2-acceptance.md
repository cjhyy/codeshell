# Optimization Lab P2: isolated instruction adoption

The Desktop Lab keeps its existing Settings entry and `optimization_lab` flag (off by default). Plans choose either existing standalone text evaluation or an isolated Engine instruction trial. Both reuse the frozen dataset, human grading checkpoints, native budget grant and physical request ledger. Adoption is a separate native confirmation after a complete qualifying isolated report.

The P2 consumer uses a fresh ephemeral Engine/Session and one immutable Skill body. It exposes no tools, MCP, sub-agents, background shells, source discovery, persistent memory or hooks. This validates instruction effects within an Agent harness; it does not establish capability for tasks that require tools. OpenAI and Anthropic streaming requests pass the same existing metered fetch gate as text trials. Missing terminal usage remains unknown and conservatively reserved. Neither trial mode installs candidates or edits source Skills.

A Core loading receipt binds project, provider/model, Skill source revision, fixed body hash and completed isolated Session. Native adoption shows the exact body, report and scope, then rechecks evidence and project/flag/trust after the dialog. Only an explicit project scope (new ordinary Sessions) or an existing ordinary Session scope (next run) is accepted. The Host-owned binding store retains accepted bodies independently of experiment artifact retention. Resumed snapshots must exactly match the trusted store, including their body hash and current parent Skill revision.

Ordinary Sessions freeze their applicable adopted revisions. A Session override replaces only its matching Skill and preserves other fixed Skills. The active instruction set also obeys the current model, Profile, disabled Skill/plugin lists and Skill allowlist. Effective-set changes clear the prior derived context once, preserving original user tasks and earlier unaffected context. Revocation stops active use through the existing AbortController lifecycle; late replies remain in the audit transcript but do not return to effective context. Idle Session cleanup does not clear another active Session's Engine fields; the existing runId CAS also prevents a former Engine from replacing a newer run's accepted configuration. Other current frozen Skills remain available. Source changes invalidate old revisions on the next run; revocation preserves the user's edited source file and reports the conflict.

Local acceptance uses `scripts/optimization-lab-p2-fixture.mjs` against compiled package entries. It sets independent HOME, USERPROFILE, AGENT_CWD and data roots before importing Core, refuses global network fetch, and supplies pure in-memory SDK responses. The ordinary Session portion disables the unrelated background memory pipeline; the isolated helper exercises the production ephemeral lifecycle. No sockets, accounts, paid model service or third-party write is used.

Verified scenarios:

- Real OpenAI and Anthropic SDK isolated trials each produce one metered request, authoritative usage and an exact loading receipt; no tools are exposed.
- Construction-time cancellation and cancellation immediately after run admission produce zero provider requests. A separate Bun fixture checks nine constructor/abort/error/close cleanup paths in its own process.
- Project/model selection, exact receipt schema, source revision changes and revision-protected idempotent revocation.
- Two fixed Skills across Profile/allowlist changes, continuous restricted runs retaining new normal replies, and a Session override preserving the other Skill.
- Two Engines successively owning the same durable Session: revoking the former project binding preserves the newer Session override.
- Revoking a frozen revision after disabling instructions preserves subsequent ordinary replies.
- Idle project-binding revocation while another Session uses its own override; active override revocation aborting the current run and rejecting its late derived reply.
- Original user messages and audit history retained; edited restored snapshot bodies rejected; edited source Skills preserved.
- Dedicated native IPC adoption, cancellation/evidence-change revalidation, preload routing and explicit Session scope selection in the existing Lab page.

The focused fixture/tests are normal product acceptance. They do not constitute validation of tool-bearing Agent workflows, live providers or external side effects.

## Local gates

Historical focused runs passed 140 tests across 15 files and 299 tests across 38 files. The compiled P2 fixture passed for both SDK providers and the scope/revocation cases. Final package and combined acceptance must be rerun after integration of the private child-environment fix at `ace16819` and the Phase D temporary signer; earlier package results are not final acceptance. Public CI green checks without a complete zero-failure summary are also not acceptance. Live provider and tool workflow validation remains outside this acceptance.

After integrating `ace16819`, the package gate passed (9 tarballs, 47 typed entries, 45 runtime imports, private-environment packed consumers). The P2 cleanup and compiled SDK consumers passed through the private child wrapper, and the guarded combined suite completed with 284 tests across 36 files, zero failures and a complete JUnit report. All workspace typechecks, Desktop production build, engine-construction/workflow-path guards and the ESLint baseline gate passed (zero errors, 105 existing warnings). This checkpoint still precedes the Phase D signer integration and final combined CI acceptance.

The compiled P2 fixture also runs as a separate CI rest-shard step after workspace build, independently of the Bun test summary. Both its Node consumer and separate Bun cleanup process launch through the private child-environment wrapper before importing Core.

Frozen-body resolution, effective revision comparison and derived-context checkpoint persistence live in `engine-instruction-context.ts`. Engine retains its run owner, subscription, AbortController and private cache lifetimes. Relative to the integrated `ace16819` baseline, P2 adds 131 Engine wiring/lifecycle lines (4,818 total), three extension export declarations (53 total) consumed by the Lab (binding store/hash/types and isolated Host helper), and one dedicated native adoption IPC/preload route (321 registrations / 314 invokes total). These are exact measured bounds with no allowance for future features. The stable public SDK is unchanged.
