# Plugin metadata and command expansion audit — round 8

Frozen source: `ec0e16bf0068a458abcbaa28225a4c764c24f4de`. Documentation and owned fixtures only; product code is unchanged. Three new confirmed P3 defects. No acquisition, marketplace addition/refresh/removal, plugin installation, archive extraction, Git/npm/network operation, hook/MCP execution, permission experiment, native app or model was run.

## PLUGIN-R8-01 — Empty quoted command arguments shift later positions (P3)

Location: `packages/core/src/plugins/pluginCommandsLoader.ts:230` (`parsePluginCommandArguments`; quoting at 245–252, positional lookup at 300). The module advertises positional/named placeholder expansion, recognizes single and double quotes, and its existing expansion test requires quoted argument values with spaces to work. Preserving an explicitly empty quoted token is inferred from that advertised tokenizer grammar and ordinary quoted positional argument meaning; this is not a claim about a separately executed upstream Codex implementation.

A command with `one=<$1> two=<$2> three=<$3>` and raw `"" next last` should retain the empty first argument. The real expander instead returns `one=<next> two=<last> three=<>`. Raw `left '' right` likewise returns `<left>|<right>|<>` rather than `<left>|<>|<right>`. Closing quotes leave `current` empty, and `push()` discards it, so all subsequent positions shift. A command prompt can consequently target the wrong argument while reporting no error. `$ARGUMENTS` still contains the unchanged raw input.

The first guarded [command fixture](evidence/plugins-command-metadata.test.ts) asserts both current failures and controls for nonempty quotes, named empty `FILE=""`, missing positions, ordinary named values, and raw expansion. The [raw first log](evidence/plugins-command-metadata.first.log) contains observations. Single/double quotes count as one tokenizer defect.

## PLUGIN-R8-02 — `$ARGUMENTS` matches the prefix of a complete named placeholder (P3)

Location: `packages/core/src/plugins/pluginCommandsLoader.ts:289` (`PLUGIN_COMMAND_PLACEHOLDER`; named argument grammar at 266, replacement at 299–304). This module publicly documents named `KEY=value` placeholders. Both named assignment and placeholder grammars admit uppercase names with digits/underscores, so `ARGUMENTS_FILE` is a supported name in the module's own grammar. Its existing test separately requires unknown environment-like placeholders to remain literal.

With body `file=$ARGUMENTS_FILE untouched=$ARGUMENTS_UNKNOWN raw=$ARGUMENTS` and raw `ARGUMENTS_FILE=src/example.ts`, the actual output is:

```text
file=ARGUMENTS_FILE=src/example.ts_FILE untouched=ARGUMENTS_FILE=src/example.ts_UNKNOWN raw=ARGUMENTS_FILE=src/example.ts
```

The earlier all-arguments alternative has no token boundary and consumes the prefix before the complete named alternative can match. Thus a supplied supported name fails to substitute, and an unknown name is also changed. These are two manifestations of one regex defect, counted once. `$FILE`, an unrelated unknown `$UNKNOWN`, exact `$ARGUMENTS`/`{args}`, and one-pass substitution of placeholder-like argument text are passing controls in the same [fixture](evidence/plugins-command-metadata.test.ts).

For both expansion bugs, the actual `copyCodexCommands` is also run on self-owned temporary `prompts/` and `commands/` directories. It preserves the affected command body and the subsequent real expander reproduces both defects; an explicit `commands/` collision correctly wins. This proves conversion-to-expansion behavior without installation or installed-registry access. Static caller tracing shows Desktop `plugin-command-service.ts:54` returns this output as `prompt`, Core `protocol/server.ts:1310` returns it in the command expansion RPC, and TUI `plugin-commands-registration.ts:23–24` stages it in `setNextContext`. These hosts, their IPC/UI, and a model submission were not executed.

## PLUGIN-R8-03 — Accepted Windows marketplace source derives a rejected name (P3)

Location: `packages/core/src/plugins/parseMarketplaceInput.ts:86`. The parser explicitly accepts drive-prefixed local `.git` paths with forward or backward slashes at line 27. `deriveMarketplaceName` is documented to extract the repository tail, but splits only on `/` and `:`.

The real parser accepts `C:\work\skills.git`; the real deriver returns `\work\skills` rather than `skills`. The same real `assertSafePluginName` used by `marketplaceDir` rejects that name because it contains backslashes. The [parser fixture](evidence/plugins-parser-metadata.test.ts) proves this pure string chain on macOS; `C:/work/skills.git`, POSIX `/tmp/skills.git`, GitHub shorthand and HTTPS `.git` URLs all derive `skills` and pass the guard. Forward slashes are a workaround.

Static propagation: TUI `plugin-handler.ts:116–121` and Desktop `marketplace-service.ts:350–355` pass the derived name unchanged to `addMarketplace`. Its first statement (`marketplaceManager.ts:97`) calls `marketplaceDir`, which invokes the validated guard at line 42 before any clone. No `addMarketplace`, Git operation or Windows-native filesystem was executed, and no broader Windows support claim is made.

## Validation and additional coverage

Two first guarded shards completed: **11 pass, 40 expect calls, 0 fail, 0 skipped**. These are eleven new focused proof/control tests, not eleven product bugs or an existing whole-package baseline. Passing defect assertions describe the incorrect current behavior; no fix was made. Commands, immutable first raw logs, exit responses and SHA256 values are recorded in [plugins-validation.json](evidence/plugins-validation.json).

The parser shard also exercises ordinary marketplace schema source normalization/owner fallback/version preservation, the documented binary format detection, and own-temp canonical manifest normalization/readback of displayName/defaultPrompt/brandColor. Source review covered `parseSource` npm/local/github/ref/subdir grammar, `normalizeManifest`, `detectFormat`, converter metadata handling, selected catalog identity/projection and command callers. No further fresh defect was confirmed there. These checks do not establish all source formats, assets, all plugins, all catalog states, runtime permissions, or any build/typecheck/lint/full suite.

Skill frontmatter separator/CRLF candidates from round 6 were not revalidated. The skills/frontmatter module is a transitive import of the command expander, but neither scanner nor parser is invoked by these fixtures. Converter field-prefix preservation and arbitrary custom component path compatibility were not promoted to bugs without an independent supported contract. Asset-validation, installed-state mutation, hook/MCP/security behavior and acquisition directions remain outside this batch.

## Deduplication and evidence custody

Historical selection includes every tracked `.md`/`.json` path containing audit/review/archive (including `_archive`) plus `bugs/`. **550 Markdown files, 393 parsed JSON files, 95,926 string leaves, zero JSON parse errors** were checked. [Corpus receipt](evidence/plugins-dedup-corpus.json) and [targeted receipt](evidence/plugins-targeted-dedup.json) retain paths/hashes and bounded matching excerpts. The sole empty-position match was an unrelated Git quoted filename finding. No prefix or Windows marketplace defect matched. Old plugin matches covered a redundant cache-clear optional chain, metadata integrity/transport or installer topics; those were excluded, not counted again. Search/dedup evidence is not proof that all historical wording was semantically identical or exhaustive.

One metadata collector initially misread Git's quoted non-ASCII filenames; [assembly note](evidence/plugins-metadata-assembly-note.md) preserves the relevant tool response excerpt. Only NUL-delimited metadata path enumeration was corrected. No product test failed or was repaired/retried. [Source manifest](evidence/plugins-source-manifest.json) captures 35 selected frozen source files and current equality separately; it is not a full-file review claim for selected-range callers/imports. [Machine-readable findings](evidence/plugins-findings.json) and [artifact receipt](evidence/plugins-artifact-receipt.json) complete this lane's handoff.
