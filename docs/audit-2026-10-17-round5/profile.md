# Round 5 — Core WorkspaceProfile data audit

Frozen baseline: `9a421b3e65d5bfe662b78062cb86bd99483a683a`, branch `codex/audit/prompt-profile-web-round5-20261017`. This report records **one new P2 finding**. Only this report and `evidence/profile-*` were written. No product source or Git state was changed.

## Confirmed finding

### PROFILE-R5-01 — P2: Distinct catalog sources share a cache and removing one deletes the other's catalog

**Root source:** `packages/core/src/profile/catalog.ts:91–94`. `sourceToRepoKey()` lowercases the source and replaces the owner/repository separator with `-`, which already occurs inside both valid names. `acme-labs/agents` and `acme/labs-agents` therefore both become `acme-labs-agents`. These are distinct sources accepted by `CATALOG_REPO_RE`; they are hypothetical fixture names, and neither repository was contacted.

**Expected behavior:** distinct registered sources have independent cached catalogs. The layout comment in `catalog-store.ts:5–9` describes one cache per source, the registry keeps the two identities distinct (`:112–116`), and the existing regression at `catalog-store.concurrency.test.ts:114–124` explicitly expects removing one repository to retain another repository's tree. Intentional case normalization is compatible with this expectation.

**Actual behavior and conditions:** `humanRepoDir()` directly uses the lossy key (`catalog-store.ts:66–67`), while registry deduplication compares complete source strings rather than this key. When both colliding sources are registered, `listHumanRepoDetails()` reads the same directory twice (`:376–383`). `readAllHumanRepoEntries()` reads that same tree using each registry source (`:403–415`), so the first source wins attribution even when the cached definition belongs to the second source. `removeHumanRepo(second)` removes only the second registry row and recursively deletes the shared directory (`:365–371`); the first source remains registered but becomes `cloned: false`.

**First-run evidence:** [fixture](evidence/profile-catalog-data.test.ts), [raw stdout and stderr](evidence/profile-catalog-data.first.log), [exit code](evidence/profile-catalog-data.first.exit.txt), [receipt](evidence/profile-catalog-data.receipt.json). All four tests passed, with 21 reported assertions and no skips. The defect tests intentionally assert the observed behavior; they are audit reproductions, not fixes.

- With only `second-human` in the shared owned cache, both repository details report count 1, and the combined catalog returns `{ name: "second-human", sourceRepo: "acme-labs/agents" }` plus a misleading duplicate-definition warning.
- Removing `acme/labs-agents` leaves only `acme-labs/agents` in the actual registry, but its directory is absent and its details contain `errors: ["尚未克隆"]`.
- A noncolliding `acme/alpha` and `acme/beta` control retains correct provenance and the first cache after removing the second. Another control isolates one invalid profile while preserving two valid profiles and a valid team.

**Consumer and impact:** Desktop's catalog directly exposes `readAllHumanRepoEntries()` results and their `sourceRepo` (`packages/desktop/src/main/profiles-service.ts:426–439`); its removal entry point delegates to the affected remover (`:459–460`). This makes a normal catalog operation display the wrong source and remove another registered source's cached catalog. P2 reflects incorrect catalog data and loss of its local cache; deletion of already-installed global profiles or portable memory was not demonstrated or claimed.

**Limits:** dynamic evidence uses the real Core key function, registry reader, catalog reader, repository-details reader, and remover, with synthetic definitions in owned temporary directories. No `addHumanRepo`, clone, update, dependency installation, network request, model, credential, real user data, or native/Desktop app was executed. The real Desktop consumer is source evidence only. Successful network acquisition/publication and concurrent processes were not tested.

**Repair direction:** encode the owner and repository boundaries unambiguously, and retain a migration/recovery strategy for existing cache paths. The normalized identity used for registry entries, cache lookup, locks, and removal should agree. No repair was made in this audit.

## Candidate disposition

| Candidate | Disposition and boundary |
| --- | --- |
| Catalog source-key collision | Promoted as PROFILE-R5-01; actual local reader and remover evidence above. |
| Profile file's `name` differs from its containing directory | Held out. The store parses the definition without comparing its identity with the requested directory, while the current Desktop switch service explicitly rejects this mismatch. Normal `saveWorkspaceProfile()` writes the matching directory, and no supported producer of a mismatched local layout was established. No dynamic claim was added. |
| Valid source grammar broader than safe cache-key grammar | Held out. Source inspection sees rejection of dots or overlong joined keys, but the current helper explicitly requires its safe-segment grammar. A broader supported-repository promise was not established in this bounded audit. No network or alternate path was tried. |
| Literal object-prototype capability names | Excluded from this ordinary-data audit. Historical reviews already cover reserved-key sanitization in settings; no security-boundary or bypass direction was executed or promoted. |

## Duplicate and intentional-behavior exclusions

[Dedup scan](evidence/profile-dedup.json) records 810 Markdown/JSON artifacts from `docs/audit-*`, `docs/review*` (including source reports/validation records), and all `docs/archive` material including archived findings, with hashes and bounded matching snippets. The key-collision search had one unrelated “仓库清单” match, manually rejected; it found no prior finding about `sourceToRepoKey`, `humanRepoDir`, or distinct source cache collisions. Profile-related prior coverage and the reserved-key historical findings are retained in the same scan. Keyword scan absence alone is not proof of novelty; the older Core lifecycle report and the following contracts were also read.

- `docs/review-remaining-2026-10-12/core-lifecycle.md:71` already records broad profile activation/store/switch-plan/resolve/catalog-store review and activation/resolve/store/catalog tests. It reports no profile finding. This audit does not repackage that coverage or its unrelated run/auto-dream findings.
- Current activation deliberately uses runtime preset `general`, even when the definition has a legacy `basePreset`; its explicit regression passes. The original 2026-07-15 design is superseded on this point and does not establish a new bug.
- Project-default capability overrides are persisted activation snapshots, while instructions and portable-memory fields are read from the library. This distinction is explicit in activation/resolve and the design; it is not an accidental stale-definition finding.
- Session binding wins over a project default. Missing session-bound definitions fail run setup; missing project-default definitions resolve unavailable. The current tests and recovery contract describe these boundaries.
- Exclusivity without a host inventory deliberately falls back to union. Desktop currently supplies only Skills for the exclusive inventory. Neither behavior is promoted as a defect.
- Requirement planning deliberately regards only project-root named Skills as satisfied, preserves lower-priority conflicts, plans only missing names, and distinguishes missing/failed/unknown-version probes. Existing regressions pass. Installer, export, transport, and permission behavior remain outside scope.

## Executed validation

Both guarded commands were run once. Their first combined stdout/stderr and exit status were preserved immediately; no fixture/dependency/platform failure occurred, and no retry or replacement technique was needed.

| Evidence | Files | Tests | Assertions | Result |
| --- | ---: | ---: | ---: | --- |
| [Catalog data fixture](evidence/profile-catalog-data.first.log) | 1 | 4 | 21 | 4 pass, 0 fail, 0 skip |
| [Existing profile and run-setup suites](evidence/profile-baseline.first.log) | 7 | 86 | 207 | 86 pass, 0 fail, 0 skip |
| Total unique executed scope | 8 | 90 | 228 | 90 pass, 0 fail, 0 skip |

The baseline command ran `types.test.ts`, `store.test.ts`, `activation.test.ts`, `resolve.test.ts`, `requirements.test.ts`, `switch-plan.test.ts`, and `engine/run-setup.test.ts`, using only `node scripts/run-bun-test-shard.mjs --timeout 30000 FILES`. [Baseline command/exit receipt](evidence/profile-baseline.receipt.json), [first exit](evidence/profile-baseline.first.exit.txt). The existing `catalog.test.ts` was read but not run because it includes a real remote `addHumanRepo` test; catalog controls were exercised in the owned fixture instead.

## Coverage and evidence custody

[Source manifest](evidence/profile-source-manifest.json) records 25 source/test/contract files, their SHA-256 values, reviewed ranges, and an independent comparison against `git show` at the frozen commit. All 25 match the frozen baseline. [Structured finding](evidence/profile-findings.json) is the machine-readable counterpart of the confirmed item.

Substantive source review covers whole profile types, ordinary store read/list/save/delete, activation, resolve, requirement planning, switch-plan, overlay folding, and run setup; catalog parsing/local reading and repository identity/registry/read/remove paths were reviewed in full. Desktop switch/requirements/catalog consumers were traced statically. Dynamic validation covers ordinary schema/storage lifecycle, activation replacement and deactivation, selection priority/missing definitions, pure dependency/version plans, preview override precedence, run-profile instruction/memory mapping, and the four catalog fixture cases.

This is bounded source and unit validation, not full branch/statement coverage or complete Host/Desktop adoption. Plugin export/install, acquisition, network, security, actual Engine/model execution, credentials, user libraries, native applications, crash/failure injection, and cross-process catalog publication were excluded. Previously failed CLI, recorder, summary, Discord, and memory-TTL directions were not revived.
