# Optimization Lab P2: isolated instruction adoption

The Desktop Lab keeps its existing Settings entry and `optimization_lab` flag (off by default). Plans choose either existing standalone text evaluation or an isolated Engine instruction trial. Both reuse the frozen dataset, human grading checkpoints, native budget grant and physical request ledger. Adoption is a separate native confirmation after a complete qualifying isolated report.

The P2 consumer uses a fresh ephemeral Engine/Session and one immutable Skill body. It exposes no tools, MCP, sub-agents, background shells, source discovery, persistent memory or hooks. This validates instruction effects within an Agent harness; it does not establish capability for tasks that require tools. OpenAI and Anthropic streaming requests pass the same existing metered fetch gate as text trials. Missing terminal usage remains unknown and conservatively reserved. Neither trial mode installs candidates or edits source Skills.

A Core loading receipt binds project, provider/model, Skill source revision, fixed body hash and completed isolated Session. Native adoption shows the exact body, report and scope, then rechecks evidence and project/flag/trust after the dialog. Only an explicit project scope (new ordinary Sessions) or an existing ordinary Session scope (next run) is accepted. The Host-owned binding store retains accepted bodies independently of experiment artifact retention. Resumed snapshots must exactly match the trusted store, including their body hash and current parent Skill revision.

Ordinary Sessions freeze their applicable adopted revisions. A Session override replaces only its matching Skill and preserves other fixed Skills. The active instruction set also obeys the current model, Profile, disabled Skill/plugin lists and Skill allowlist. Effective-set changes clear the prior derived context once, preserving original user tasks and earlier unaffected context. Revocation stops active use through the existing AbortController lifecycle; late replies remain in the audit transcript but do not return to effective context. Idle Session cleanup does not clear another active Session's Engine fields; the existing runId CAS also prevents a former Engine from replacing a newer run's accepted configuration. Other current frozen Skills remain available. Source changes invalidate old revisions on the next run; revocation preserves the user's edited source file and reports the conflict.

Local acceptance uses `scripts/optimization-lab-p2-fixture.mjs` against compiled package entries. It sets independent HOME, USERPROFILE, AGENT_CWD and data roots before importing Core, refuses global network fetch, and supplies pure in-memory SDK responses. The ordinary Session portion disables the unrelated background memory pipeline; the isolated helper exercises the production ephemeral lifecycle. No sockets, accounts, paid model service or third-party write is used.

Verified scenarios:

- Real OpenAI and Anthropic SDK isolated trials each produce one metered request, authoritative usage and an exact loading receipt; no tools are exposed.
- Project/model selection, exact receipt schema, source revision changes and revision-protected idempotent revocation.
- Two fixed Skills across Profile/allowlist changes, continuous restricted runs retaining new normal replies, and a Session override preserving the other Skill.
- Two Engines successively owning the same durable Session: revoking the former project binding preserves the newer Session override.
- Revoking a frozen revision after disabling instructions preserves subsequent ordinary replies.
- Idle project-binding revocation while another Session uses its own override; active override revocation aborting the current run and rejecting its late derived reply.
- Original user messages and audit history retained; edited restored snapshot bodies rejected; edited source Skills preserved.
- Dedicated native IPC adoption, cancellation/evidence-change revalidation, preload routing and explicit Session scope selection in the existing Lab page.

The focused fixture/tests are normal product acceptance. They do not constitute validation of tool-bearing Agent workflows, live providers or external side effects.

## Local gates

After normal integration of `origin/main` at `754e8edd` (cost ledger and operation lifecycle): package release smoke passed with 9 tarballs and 47 typed entries; root workspace typecheck, Desktop production build, engine-bypass and workflow test-path checks passed. ESLint reported zero errors. The compiled P2 fixture passed for both SDK providers and all scope/revocation cases. A focused combined run passed 140 tests across 15 files; the earlier full Lab and related lifecycle/UI run passed 299 tests across 38 files. Live provider and tool workflow validation remains outside this acceptance.

The compiled P2 fixture also runs as a separate CI rest-shard step after workspace build, independently of the Bun test summary.
