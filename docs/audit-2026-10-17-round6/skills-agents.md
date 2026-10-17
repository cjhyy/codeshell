# Round 6 — Skills and agent definition metadata

Frozen source: `cef9ff76167d33a6a6e5b4464ba5313f7fd35f79`, branch `codex/audit/task-skills-package-round6-20261017`. Product source was read-only; this audit added only this report and `evidence/skills-*` artifacts. **Confirmed findings: 0. Static candidates: 2, both SKIP after the first fixture dependency failure.**

## Supported contract and reviewed caller chain

The source, rather than older architectural prose, is the contract for this pass. `SkillDefinition` makes the directory name authoritative and exposes a coerced description plus the Markdown body (`packages/core/src/skills/scanner.ts:30–40,113–132`). Local discovery precedence is project `.code-shell`, project `.agents`, then user `.code-shell`; duplicates are first-base-wins (`scanner.ts:57–69,135–179`). Cache identity includes cwd, HOME, registry/directory mtimes and project package pins; disabled/allowlist filters run after the cached scan. Existing-content edits requiring explicit invalidation are documented behavior, not a new finding.

The prompt reads the scanner's metadata (`packages/core/src/prompt/composer.ts:232–244`); the Skill builtin uses the same scan for metadata search and exact-name bodies (`packages/core/src/tool-system/builtin/skill.ts:79–88,135–154`). Snapshot reads current disk text and validates it rather than trusting the cached body; the final metadata/body split still uses the shared frontmatter parser (`packages/core/src/skills/snapshot.ts:29–62`). Management validation was read only to establish the supported Markdown shape, not audited as an installation/write/security subsystem (`packages/core/src/skills/management.ts:64–89`).

Agent files use YAML frontmatter with required nonempty name/description and a Markdown system prompt; serializer omits unset fields and runtime metadata (`packages/core/src/agent/agent-definition.ts:85–146`). Registry recursion is deterministic; later directories win and record shadowed sources; malformed files produce warnings; disabled names are removed after merging (`packages/core/src/agent/agent-definition-registry.ts:36–81,104–124`). Current engine policy is user → plugin → project, making project highest priority (`packages/core/src/engine/engine.ts:268–294`), despite a stale adjacent overview comment. The Agent tool lists the loaded definitions and constructs its name enum (`packages/core/src/tool-system/builtin/agent.ts:141–194`); Desktop lists the same registry and renders returned summaries (`packages/desktop/src/main/agents-service.ts:67–96`, `packages/desktop/src/renderer/settings/AgentsSection.tsx:139–144,223–234`). These are caller/source observations, not executed Engine or Desktop flows.

## First execution and required stop

Only this allowed command was attempted:

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round6/evidence/skills-metadata.test.ts tests/agent-definition.test.ts packages/core/src/agent/agent-definition.test.ts packages/core/src/agent/agent-definition.skills.test.ts
```

Raw stdout and stderr were redirected together to [skills-metadata-first.log](evidence/skills-metadata-first.log) before inspecting the result; [skills-metadata-first.exit](evidence/skills-metadata-first.exit) is `1`. Bun reports **13 pass, 1 fail, 1 unhandled error, 26 assertions, 14 tests across 4 files**. The three existing pure parser/serializer files completed. The new [skills-metadata.test.ts](evidence/skills-metadata.test.ts) failed during import because its direct `yaml` dependency does not resolve from `docs/`; none of its five declared cases or observations ran. Core's own tests resolve that package from Core. This is a fixture location/dependency failure, not a product defect.

The whole shard failed. Following the requested first-failure rule, the fixture and raw log remain unchanged, both candidate experiments are **SKIP**, and there was no repair, retry, alternate execution, install, or build. The 13 passing cases are partial results within a failed shard, not a successful validation gate. See [skills-validation.json](evidence/skills-validation.json).

## Static candidates — not confirmed findings

### S-C1 — provisional P3: embedded triple dashes may prematurely close Skill frontmatter

- Source: `packages/core/src/skills/frontmatter.ts:9,18–24,28–38`; scanner propagation at `packages/core/src/skills/scanner.ts:121–131`; snapshot propagation at `packages/core/src/skills/snapshot.ts:51–58`.
- Ordinary trigger: a Skill with valid YAML such as `description: Draft---review templates`, or an indented `---` line inside a block-scalar description, followed by the actual closing delimiter line.
- Expected: the complete description remains metadata; only content after the closing delimiter line becomes the body.
- Source-predicted behavior: the lazy regex is not constrained to a complete delimiter line, so it can stop at the embedded `---`. The inline example would give description `Draft` and move `review templates\n---\n` into the body. Search based on the description could then miss `review`, while Skill invocation/snapshot could expose the leftover metadata as instruction text.
- Impact and limits: ordinary discovery/body corruption in this input shape; no claimed execution, injection, permission, or data-loss effect. The scanner/snapshot/Skill calls and expected-versus-actual assertions in the preserved fixture **did not execute**. The static prediction must not be counted as observed product behavior or a confirmed finding. Parser compatibility with another tool is not independently verified.
- Validation: **SKIP — first fixture dependency failure**, no workaround.

### S-C2 — provisional P3: CRLF agent Markdown may disappear from the registry

- Source: `packages/core/src/agent/agent-definition.ts:89–93`; registry omission/warning at `packages/core/src/agent/agent-definition-registry.ts:43–64`; list/display callers at `packages/desktop/src/main/agents-service.ts:79–96` and `packages/core/src/tool-system/builtin/agent.ts:142–181`.
- Ordinary trigger: a manually authored `.code-shell/agents/researcher.md` uses CRLF for its frontmatter delimiter lines.
- Expected: the same YAML/Markdown definition loads with LF or CRLF.
- Source-predicted behavior: the parser requires the literal opening `---\n`, so CRLF would take the missing-frontmatter branch; the registry would omit that role and retain a warning. Desktop's summary mapper does not forward registry warnings. Missing roles would also be absent from the Agent tool's available names.
- Impact and limits: custom role discovery/unavailability for that newline format. Serializer-generated files use LF. No claim of restart, lost restrictions, fallback execution, real Windows behavior, or rendered UI observation. The pure CRLF and owned-directory registry cases **did not execute**.
- Validation: **SKIP — first fixture dependency failure**, no workaround.

## Deduplication and exclusions

[skills-dedup-corpus.json](evidence/skills-dedup-corpus.json) inventories and hashes every `.json` and `.md` from prior `docs/audit-*` and `docs/review*` (files and directories), plus every docs `archive` / `_archive` tree, excluding this round: **850 files = 338 parsed JSON + 512 Markdown; 78,387 JSON string leaves; 0 JSON parse errors**. Broad module/metadata matches and candidate-directed searches were inspected. [skills-candidates-and-dedup.json](evidence/skills-candidates-and-dedup.json) records zero historical matches for either candidate's specific root cause and ten matches for the explicitly excluded old cold-continuation role issue. Search absence is not proof of novelty, and the two unvalidated candidates remain separate from findings. A read-only corpus correction added the root review Markdown file and seven `docs/refactor/_archive` files; neither candidate gained a historical root-cause match. The original failed fixture and log were unchanged, and no further test ran.

The historical `docs/review-remaining-2026-10-12/core.md` C3 / findings N09 cold child continuation restriction loss was read for dedup only and was not reproduced. Installed-plugin/Panel acquisition and installation, isolated instruction runs, native applications/process experiments, permission/security/hooks/injection exercises, real user data, models, paid APIs and network were excluded. Old failed CLI/recorder/summary/Discord/memoryTTL experiments were not revived. No additional source issue was promoted from documented cache behavior, required field validation, recursive registry loading, merge precedence, or runtime-only metadata omission.

## Frozen receipts

[skills-source-manifest.json](evidence/skills-source-manifest.json) contains byte counts, line counts, SHA-256 and frozen-commit comparison receipts for **26 source/contract/test files; all 26 match the frozen commit**. Review modes distinguish complete primary modules from selected caller/contract excerpts. [skills-artifact-receipt.json](evidence/skills-artifact-receipt.json) records the audit artifacts and their hashes. No product edits or git mutations were made by this worker.
