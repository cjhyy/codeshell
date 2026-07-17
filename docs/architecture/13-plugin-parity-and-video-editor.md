# 13 · Plugin parity and the video-editor reference plugin

> Engineering comparison against the current public Codex plugin model, plus
> the concrete CodeShell `examples/plugins/video-editor` implementation. Codex
> product facts come from the current [Build plugins](https://learn.chatgpt.com/docs/build-plugins),
> [Plugins](https://learn.chatgpt.com/docs/plugins), and
> [MCP](https://learn.chatgpt.com/docs/extend/mcp) documentation.

## 1. Bottom line

CodeShell is no longer missing the basic plugin runtime. It already supports
installable packages, skills, agents, slash commands, lifecycle hooks, MCP
servers, enable/disable controls, marketplaces, local/archive/git installs,
update/uninstall, and sandboxed Desktop panels.

The remaining gap is concentrated in **ecosystem and policy**, not the basic
ability to run a useful local plugin:

- For local agent workflows built from skills/scripts/hooks/MCP, CodeShell is
  roughly **97%** of the current Codex building-block surface.
- For the entire Codex + ChatGPT plugin product — hosted apps/connectors,
  workspace sharing, public submission, organization policy, and managed
  distribution — CodeShell is roughly **67%**.

Those percentages are an engineering estimate, not an upstream compatibility
claim. They weight whether a user can complete the same workflow, not whether
every manifest field has an identically named implementation.

## 2. Capability matrix

| Surface                               | CodeShell status                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required plugin manifest              | **Full**                        | Detects `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`; writes a trusted canonical manifest for runtime/UI consumption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Skills with scripts/references/assets | **Full**                        | Codex skill trees are preserved; `Skill` exposes the absolute skill directory through `${CODESHELL_SKILL_DIR}` substitution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Prompts / slash commands              | **Strong**                      | `prompts/*.md` and `commands/*.md` become bounded CodeShell plugin commands with `$1`–`$9`, named `KEY=value`, `$ARGUMENTS`, `{args}`, quoting, and `$$` expansion. TUI and Desktop surface them; Desktop expands into a reviewable draft and never auto-sends. `pluginCommands/list` + `pluginCommands/expand` provide the same trusted-server discovery seam to headless/server/Web/SDK hosts, while each host still chooses its UI.                                                                                                                                                                                                                             |
| Agent definitions                     | **Strong**                      | TOML agents become Markdown agents. Name, description, model, instructions, and `mcp_servers` are enforced; MCP names are rewritten to the installed plugin namespace so a role cannot silently inherit every server. Unsupported Codex-only fields remain `codex_*` metadata and are inert.                                                                                                                                                                                                                                                                                                                                                                       |
| Plugin hooks                          | **Strong**                      | Default, path-based, mixed-array, and inline Codex declarations are projected into `hooks/hooks.json`; root/data aliases are exposed. New executable hook digests start pending, require explicit approval, fail closed after changes, and require re-approval when an update changes the digest. The last approved bounded command snapshot survives updates, so Desktop and TUI show per-hook added/removed/changed/unchanged review before the next approval.                                                                                                                                                                                                   |
| Plugin MCP servers                    | **Strong**                      | Inline/file declarations, STDIO/HTTP configuration, env-secret field normalization, OAuth-capable host MCP, probing, and an explicit plugin-digest approval/revocation gate exist. After plugin approval, each server can be enabled/disabled independently and can carry exact-name tool allow/deny policy in Desktop or TUI through a global override that cannot replace connection identity.                                                                                                                                                                                                                                                                   |
| Apps / hosted connectors              | **Missing**                     | CodeShell has no `.app.json`/ChatGPT connector installation or hosted plugin service. External tools use MCP or CodeShell credentials/browser bridges instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plugin UI                             | **Different, usable**           | CodeShell provides sandboxed right-dock HTML panels with scoped context/storage/agent submission. Codex/ChatGPT apps use MCP-backed Apps SDK UI across hosted surfaces. Neither is a drop-in substitute for the other.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Browser extension contribution        | **Missing as manifest surface** | CodeShell has browser/CDP capabilities, but an installed plugin cannot declare a browser extension contribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Scheduled task templates              | **Strong**                      | A CodeShell overlay can package bounded reusable templates. Install/update never creates a job. Desktop shows the exact prompt and requires confirmation; TUI requires the reviewed SHA-256 revision plus `--confirm`. Main/TUI re-read the canonical manifest, reject disabled plugins and stale revisions, cap jobs at 256, and copy immutable provenance into a standalone cron job that survives plugin removal.                                                                                                                                                                                                                                               |
| Marketplace install                   | **Strong partial**              | Git/GitHub/git-subdir/local marketplace entries, local directories, ZIP archives, public npm exact versions/dist-tags, update, uninstall, and recommended catalogs exist. Local directory/ZIP installs have a no-mutation review step, authoritative contribution summary, source-bound token, private snapshot install, and overwrite confirmation. Public npm materialization is CLI-only, fixed to `registry.npmjs.org`, SHA-512 verified, exact-version pinned, self-contained, and lifecycle-free. Desktop remote-source review, private registries, ranges/dependencies, npm auto-update, and Codex personal/repo marketplace auto-discovery remain missing. |
| Install metadata/assets               | **Full for local UI metadata**  | Codex display text, developer/category/capabilities, HTTPS website/privacy/terms links, brand color, up to three 128-character starter prompts, composer icon, light/dark logos, and up to three screenshots survive normalization. Starter prompts can be appended to the current composer draft but never auto-send or discard unsent text. Raster assets are containment-, format-, dimension-, and size-checked before bounded data-URL serving to Desktop.                                                                                                                                                                                                    |
| Sharing and publication               | **Missing**                     | No workspace sharing links, public directory submission, review pipeline, or organization-managed install policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Plugin lifecycle / data               | **Strong partial**              | Trusted built-in panel modules have lifecycle hooks; untrusted packages are static + hooks/MCP/panels. Hook processes receive stable per-plugin writable storage through `CODESHELL_PLUGIN_DATA` and Codex-compatible `PLUGIN_DATA`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Permissions and trust                 | **Strong partial**              | Agent tools use normal permission gates and panels are capability-scoped. Plugin shell hooks and plugin MCP servers have separate install-digest approval/revocation gates in Desktop and TUI; pending and changed executable definitions fail closed while other contributions remain usable. Local install review exposes commands/matchers, server transports, panel permissions, links, and media before mutation. Hook update diffs and MCP tool allow/deny policy are enforced locally. Organization-managed policy is still missing.                                                                                                                        |

## 3. Compatibility fixes in this iteration

Before this iteration, the local Codex installer handled skills, agents,
prompts, and MCP, but silently lost hook scripts and non-selected package
assets. Marketplace installs were worse: they materialized the Codex package
but skipped the conversion path entirely.

The installer now:

1. preserves the complete Codex package for local/direct installs, so a hook
   can actually reach scripts and assets through `$PLUGIN_ROOT`;
2. accepts the Codex default hook location plus manifest path, inline, and
   mixed array declarations;
3. merges hook declarations into CodeShell's canonical `hooks/hooks.json`;
4. rejects hook path traversal and escaping symlinks;
5. exposes CodeShell-native and Codex-compatible root/data variables while
   keeping mutable plugin data outside replaceable install directories;
6. projects Codex agents, prompts/commands, hooks, and MCP servers for
   marketplace installs too, including snake_case MCP secret fields.
7. expands deprecated Codex prompt placeholders at invocation time instead of
   leaving `$1` and named values inert.
8. records the installed hook definition digest and refuses to execute hooks
   that changed outside an explicit install/update; pre-digest installs remain
   visible as `legacy` for compatibility.
9. validates `interface.composerIcon`, `logo`, `logoDark`, and `screenshots`
   against their real paths, rejects escaping symlinks, missing files, format
   spoofing, oversized/dimension-bomb images, and non-`assets/*.png`
   screenshots, then copies accepted bytes into an installer-owned canonical
   asset directory. Brand images are capped at 2 MiB each, screenshots at
   5 MiB each and three entries, with an 8192 px edge / 40-megapixel ceiling;
10. serves plugin media through a bounded main-process DTO containing only
    PNG/JPEG/WebP data URLs. Author and installed file paths never enter the
    rich-media renderer contract, and Extensions opens only normalized HTTPS
    website/privacy/terms links through the existing external-browser host.
11. records a separate `approvedHookDigest`: new installs with executable
    hooks start pending, hook-free installs remain silent, and matching
    approvals survive an update only when the hook digest is unchanged.
    Pending or post-install-changed hooks do not register; legacy records
    without a digest remain compatible until explicitly revoked. Desktop
    plugin detail and TUI `/plugin hooks list|approve|revoke` expose the same
    approval state, and both interactive hosts request a hook reload after a
    decision.
12. applies the same explicit trust boundary to plugin-provided MCP servers,
    separately from hooks and user-configured MCP. New installs that normalize
    to runnable stdio/HTTP/SSE servers record `mcpDigest` but remain pending
    until `approvedMcpDigest` matches; installs without MCP stay silent.
    Matching approved bytes retain approval across update, while changed
    on-disk bytes fail closed and cannot be directly blessed without an
    update/reinstall. Pre-digest installs remain available as `legacy` until
    revoked. Desktop plugin detail, MCP settings, and TUI
    `/plugin mcp list|approve|revoke` expose the shared trust state and request
    a runtime settings reload after a decision.
13. exposes plugin prompt discovery and expansion through the core JSON-RPC
    protocol. The renderer/client receives only bounded metadata and the final
    expanded prompt; command bodies and install paths remain in the trusted
    server. Expansion is single-pass, so placeholders inside user arguments
    are never recursively amplified.
14. adds local directory/ZIP install review. Core projects the source with the
    real installer, shows authoritative name/format/version and every
    executable/network/UI contribution, then binds the review token to that
    projection. Confirmation installs a private symlink-free snapshot that
    matches the token, closing the re-review/install race; overwrite remains a
    separate confirmation.
15. adds per-server plugin MCP policy. The plugin digest must still be
    approved, but Desktop and TUI can independently disable or re-enable
    `<plugin>:<server>` through `mcpServerOverrides.enabled`. Command, args,
    URL, and transport remain owned by the reviewed plugin bytes.
16. adds exact-name per-tool MCP policy. A server may define or receive
    `allowedTools` and `disabledTools`; deny is applied after allow. The same
    run-scoped policy hides tools from the model, removes them from ToolSearch,
    rejects direct registered-tool calls, and rejects generic `MCPTool`
    dispatch. Desktop exposes the policy in the server editor, while TUI
    provides `/plugin mcp tools|allow|deny|tools-reset`.
17. stores a bounded, non-executable snapshot of the last explicitly approved
    hook commands. An update with a different digest keeps that baseline while
    clearing execution approval. Desktop plugin detail and TUI
    `/plugin hooks diff` show added, removed, changed, and unchanged event,
    matcher, and command entries before the user approves the new definition.
18. adds reusable plugin automation templates without granting install-time
    execution. Template IDs, schedules, timezones, prompts, permissions, and
    workspace requirements are bounded and canonicalized during installation.
    Local-install review shows the declaration, while the plugin detail view
    shows the exact prompt. Creation is explicit and binds to a SHA-256 content
    revision; the trusted host re-reads the installed manifest, refuses stale
    reviews or disabled plugins, caps the global automation count, and copies
    source provenance into the standalone persisted job. Plugin update or
    uninstall never mutates a job the user already created.
19. maps Codex agent `mcp_servers` into CodeShell's enforced per-agent `mcp`
    allowlist. Server names are namespaced to the owning plugin, malformed
    declarations fail installation, and an agent that requests a subset no
    longer inherits every MCP server by accident.
20. turns normalized starter prompts into safe composer actions. A bounded,
    renderer-local event can append an exact prompt to the current chat draft,
    focus the composer, and switch back to chat, but cannot submit a run. The
    seed is acknowledged once so page remounts cannot replay it; an existing
    unsent draft is preserved and separated from the appended prompt.
21. adds fail-closed public npm materialization for Core and the Commander CLI.
    `npm:<package>@<exact-or-dist-tag>` resolves only against
    `registry.npmjs.org`; a tag is pinned to the resolved exact version and the
    tarball must match its SHA-512 integrity. Metadata, compressed and expanded
    sizes, entry count, paths, depth, and individual file sizes are bounded.
    Extraction accepts only regular files/directories, rejects links and
    special entries, and double-checks package name/version. Packages declaring
    dependencies are rejected, and no npm/Bun process or lifecycle script is
    ever run. Phase A deliberately excludes private registries, ranges,
    dependency installation, auto-update, and a Desktop remote-install UI.

This closes the difference between "the marketplace says installed" and "the
runtime contributions are actually discoverable."

## 4. Video editor reference plugin

`examples/plugins/video-editor` demonstrates an installable workflow that is
useful without a hosted service:

```text
video-editor/
├── .codeshell-plugin/plugin.json
├── .codex-plugin/plugin.json
├── prompts/edit.md
├── skills/video-editor/
│   ├── SKILL.md
│   ├── references/plan-schema.md
│   └── scripts/video-editor.mjs
└── panels/video-cut/
    ├── index.html
    ├── style.css
    └── app.js
```

The editor wrapper:

- probes inputs through `ffprobe`;
- validates timecodes, clip bounds, paths, output collisions, dimensions,
  speed, volume, and encoding parameters;
- builds FFmpeg arguments as an array and never invokes a shell;
- performs frame-accurate multi-clip trim/concat;
- supports reviewed hard cuts or bounded video/audio crossfades between clips;
- supports 16:9, 9:16, 1:1, and 4:5 cover/contain exports;
- preserves, mutes, retimes, or adjusts source audio;
- burns an optional subtitle file;
- provides a JSON dry-run before rendering;
- probes the completed output.

The panel is intentionally a **drafting surface**, not a privileged editor. It
stores a draft in panel-scoped storage and submits a structured request to the
current session. The skill still enforces inspect → plan → dry-run → user
confirmation → render, and refuses accidental overwrite.

The CodeShell overlay also declares a read-only `daily-edit-audit` automation
template. Installing the plugin does nothing on a timer. A user may review its
exact prompt and explicitly instantiate it for the current project; the daily
audit reports missing inputs, unsafe output paths, destructive steps, subtitle
or audio risks, and human decisions without rendering or modifying media.

## 5. Next parity work

Recommended order:

1. **Marketplace parity** — repo/personal auto-discovery, Desktop review for
   public npm sources, and an explicit product decision on whether the strict
   self-contained npm subset should ever support reviewed dependencies.
2. **Browser contribution surface** — package and permission a browser/CDP
   contribution instead of requiring host-specific wiring.
3. **Hosted connector/app layer** — only if CodeShell wants a cloud/workspace
   product; this is a product and auth boundary, not a small installer patch.
