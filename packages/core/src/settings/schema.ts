/**
 * Settings schema with Zod validation.
 */

import { z } from "zod";
import {
  DEFAULT_WORKTREE_BRANCH_PREFIX,
  isValidWorktreeBranchPrefix,
  normalizeWorktreeBranchPrefix,
} from "../git/worktree/slug.js";

/**
 * Tri-state project capability overlay. Lives in PROJECT settings only and
 * layers over the global baseline (disabledSkills / disabledPlugins /
 * mcpServers.<name>.enabled / disabledAgents). NOT a second denylist:
 *   - "on"      → force enabled (even if globally disabled)
 *   - "off"     → force disabled (even if globally enabled)
 *   - "inherit" → take the global baseline. We don't persist "inherit"; an
 *                 absent key means inherit. See the project-scoped
 *                 capabilities design (spec §4).
 */
export const CapabilityOverrideSchema = z.enum(["inherit", "on", "off"]);
export type CapabilityOverride = z.infer<typeof CapabilityOverrideSchema>;

export const CapabilityOverridesSchema = z
  .object({
    skills: z.record(CapabilityOverrideSchema).optional(),
    plugins: z.record(CapabilityOverrideSchema).optional(),
    agents: z.record(CapabilityOverrideSchema).optional(),
    mcp: z.record(CapabilityOverrideSchema).optional(),
    builtin: z.record(CapabilityOverrideSchema).optional(),
    /**
     * Per-hook overlay for PLUGIN-provided hooks, keyed by
     * `pluginHookKey()` (`<plugin>:<RawEvent>:<command>`). Finer-grained
     * than `plugins` (which kills a whole plugin): "off" suppresses one
     * hook for this project only. Only "off" is meaningful today — plugin
     * hooks have no global disable list to force back "on" from.
     */
    pluginHooks: z.record(CapabilityOverrideSchema).optional(),
  })
  .optional();
export type CapabilityOverrides = z.infer<typeof CapabilityOverridesSchema>;

const WorktreeBranchPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidWorktreeBranchPrefix, "Invalid git branch prefix")
  .transform((value) => normalizeWorktreeBranchPrefix(value));

export const SettingsSchema = z
  .object({
    agent: z
      .object({
        // Use z.string() instead of z.enum() to allow custom presets registered via registerPreset()
        preset: z.string().default("terminal-coding"),
        enabledBuiltinTools: z.array(z.string()).default([]),
        disabledBuiltinTools: z.array(z.string()).default([]),
        customSystemPrompt: z.string().optional(),
        appendSystemPrompt: z.string().optional(),
        responseLanguage: z.string().optional(),
        userProfile: z.string().optional(),
        instructions: z
          .object({
            compatClaude: z.boolean().default(true),
            compatCodex: z.boolean().default(true),
          })
          .optional(),
      })
      .default({}),

    /**
     * Toggle background auto-update. When true (default), code-shell checks
     * npm for newer versions and — if the npm global prefix is writable —
     * installs the update in the background on process exit so the next
     * launch picks it up.
     * Can also be disabled via env var `DISABLE_AUTOUPDATER=1`.
     */
    autoUpdates: z.boolean().default(true),

    /**
     * Image generation is a general capability, decoupled from LLM providers
     * (TODO 7.1): a vendor may use different keys/endpoints/models for chat vs
     * image, and image vendors (Gemini, and later 国内 模型) don't fit the LLM
     * `providers[].kind` enum. `imageGen.providers[]` is the canonical config;
     * each entry has a user-chosen `id` (selected via GenerateImage's
     * `provider` arg) and a `kind` that picks the adapter. When `imageGen` is
     * absent, resolution falls back to scanning LLM `providers[]` for an
     * image-capable kind — so existing configs keep working with no migration.
     */
    imageGen: z
      .object({
        defaultProvider: z.string().optional(),
        providers: z
          .array(
            z.object({
              /** User-chosen instance name; GenerateImage(provider) selects by this. */
              id: z.string(),
              /** Adapter selector — e.g. "openai", "google". */
              kind: z.string(),
              baseUrl: z.string(),
              apiKey: z.string().optional(),
              /** Default model for this instance when the call omits `model`. */
              defaultModel: z.string().optional(),
              /** Catalog template this instance was created from (for paramsDoc / displayName回显). */
              catalogId: z.string().optional(),
              /** Reuse another instance's key: id of the instance whose apiKey to use (when apiKey is empty). */
              apiKeyRef: z.string().optional(),
            }),
          )
          .default([]),
      })
      .optional(),

    /**
     * Video generation config (TODO 7.1) — same shape as imageGen, decoupled
     * from LLM providers. `videoGen.providers[]` each carry an `id` (selected
     * via GenerateVideo's `provider` arg) + a `kind` picking the adapter. With
     * no real adapters wired yet, this is config-ready: a future getVideoProvider
     * case lights it up. Falls back to scanning LLM providers[] when absent.
     */
    videoGen: z
      .object({
        defaultProvider: z.string().optional(),
        providers: z
          .array(
            z.object({
              id: z.string(),
              kind: z.string(),
              baseUrl: z.string(),
              apiKey: z.string().optional(),
              defaultModel: z.string().optional(),
              /** Catalog template this instance was created from (for paramsDoc / displayName回显). */
              catalogId: z.string().optional(),
              /** Reuse another instance's key: id of the instance whose apiKey to use (when apiKey is empty). */
              apiKeyRef: z.string().optional(),
            }),
          )
          .default([]),
      })
      .optional(),

    /**
     * Credentials — independent key entities (统一模型接入方案 §3.3). A key
     * lives here, not inlined on a connection, so deleting a connection never
     * loses a key and many connections share one key by referencing the same
     * credential id (LiteLLM credential_list model).
     */
    credentials: z
      .array(
        z.object({
          /** User-chosen unique credential name. */
          id: z.string(),
          /** Catalog template this credential is for (a key belongs to one provider). */
          catalogId: z.string(),
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
        }),
      )
      .default([]),

    /**
     * Unified instance layer (统一模型接入方案, see
     * docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §3.3).
     * One store for text/image/video connections, each pointing at a catalog
     * entry (catalogId), a credential (credentialId), its chosen model, and the
     * param values the user picked. Replaces the legacy split of
     * providers[]/models[]/imageGen/videoGen.
     */
    modelConnections: z
      .array(
        z.object({
          /** User-chosen unique instance name. */
          id: z.string(),
          /** Catalog template this instance was created from. */
          catalogId: z.string(),
          tag: z.enum(["text", "image", "video", "audio"]),
          /** Selected modelId (from the entry's modelPresets). */
          model: z.string(),
          /** Per-connection baseUrl override (else the credential's / catalog's). */
          baseUrl: z.string().optional(),
          /** Which credential supplies this connection's key. */
          credentialId: z.string().optional(),
          /** Values the user picked for the model's params, e.g. { reasoning: "high" }. */
          paramValues: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .default([]),

    /** Default instance id per tag (replaces activeKey / defaultProvider). */
    defaults: z
      .object({
        text: z.string().optional(),
        image: z.string().optional(),
        video: z.string().optional(),
        /** Default speech-to-text (voice input) connection. */
        audio: z.string().optional(),
        /** Background-task model (replaces auxModelKey). */
        auxText: z.string().optional(),
      })
      .default({}),

    permissions: z
      .object({
        defaultMode: z
          .enum(["default", "acceptEdits", "dontAsk", "bypassPermissions", "auto", "plan"])
          .default("default"),
        rules: z
          .array(
            z.object({
              tool: z.string(),
              argsPattern: z.record(z.string()).optional(),
              decision: z.enum(["allow", "deny", "ask"]),
              reason: z.string().optional(),
            }),
          )
          .default([]),
      })
      .default({}),

    context: z
      .object({
        maxTokens: z.number().default(200_000),
        // 压缩阈值（占上下文窗口的比例）。窗口越大可调越高：1M 窗口的模型
        // 把 compactAtRatio 调到 0.95 能少浪费几十万 token。三档须满足
        // floor < compact < summarize，否则运行时会 clamp 回安全顺序。
        compactAtRatio: z
          .number()
          .min(0.1)
          .max(0.98)
          .default(0.85)
          .describe("达到该比例开始压缩历史（先试摘要，再退化为窗口裁剪）。默认 0.85。"),
        summarizeAtRatio: z
          .number()
          .min(0.1)
          .max(0.99)
          .default(0.92)
          .describe("紧急阈值：到此比例做最激进的窗口压缩。须 ≥ compactAtRatio。默认 0.92。"),
        microcompactFloorRatio: z
          .number()
          .min(0.1)
          .max(0.95)
          .default(0.7)
          .describe(
            "低于该比例不做 microcompact，保留早期工具输出、保住 prompt cache 前缀。默认 0.7。",
          ),
      })
      .default({}),

    session: z
      .object({
        storageDir: z.string().optional(),
        maxHistory: z.number().default(100),
      })
      .default({}),

    worktree: z
      .object({
        branchPrefix: WorktreeBranchPrefixSchema.default(DEFAULT_WORKTREE_BRANCH_PREFIX),
      })
      .default({}),

    // The record key IS the server name at runtime (MCPManager.connectAll
    // uses Object.entries keys; desktop's persist strips the `name` field and
    // keys by it via stripNameFromServer). So `name` here is optional and
    // backfilled from the key — a config keyed `{"23": {…}}` with no `name`
    // field is valid, not a crash. The preprocess also tolerates a legacy
    // array form (`[{name, …}]`) by re-keying it into a name → config record.
    mcpServers: z
      .preprocess(
        (value) => {
          const entries: Array<[string, unknown]> = Array.isArray(value)
            ? value
                .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
                .map((v, i) => [String(v.name ?? i), v])
            : value && typeof value === "object"
              ? Object.entries(value as Record<string, unknown>)
              : [];
          return Object.fromEntries(
            entries.map(([key, raw]) => [
              key,
              raw && typeof raw === "object"
                ? { ...raw, name: (raw as { name?: unknown }).name ?? key }
                : raw,
            ]),
          );
        },
        z.record(
          z.object({
            // Always present here: the preprocess above backfills it from the
            // record key, so a stored entry that omits `name` (the common
            // desktop case, which strips it) still validates.
            name: z.string(),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            env: z.record(z.string()).optional(),
            url: z.string().optional(),
            transport: z.enum(["stdio", "sse", "streamable-http", "inprocess"]).optional(),
            headers: z.record(z.string()).optional(),
            // Codex-style env-secret handling: store env-var NAMES, read the
            // secret from process.env at connect time (never plaintext here).
            envVars: z.array(z.string()).optional(), // (stdio) forward these env vars
            bearerTokenEnvVar: z.string().optional(), // (HTTP) → Authorization: Bearer <env value>
            envHeaders: z.record(z.string()).optional(), // (HTTP) header-name → env-var-name
            credentialRef: z.string().optional(), // (HTTP) id of a stored credential → Bearer, resolved at connect time
            // Codex-style on/off switch. Absent or true → connected; only
            // literal false disables. Filtered in MCPManager.connectAll.
            enabled: z.boolean().optional(),
          }),
        ),
      )
      .default({}),

    /**
     * User supplements for PLUGIN-provided MCP servers, keyed by the server's
     * `<plugin>:<server>` name. Layered onto the plugin config at merge time
     * (mergePluginMcpServers). Only env/credential fields are accepted —
     * command/args/url/transport are intentionally absent and `.strict()`
     * rejects them, so a plugin update is never shadowed by a stale copy.
     */
    mcpServerOverrides: z
      .record(
        z
          .object({
            env: z.record(z.string()).optional(),
            envVars: z.array(z.string()).optional(),
            credentialRef: z.string().optional(),
            bearerTokenEnvVar: z.string().optional(),
            envHeaders: z.record(z.string()).optional(),
          })
          .strict(),
      )
      .default({}),

    /**
     * Skill names hidden from the LLM. Names include the full
     * "<plugin>:<skill>" prefix for plugin skills. Filtered at the
     * scanner so PromptComposer's skills listing and the skill builtin
     * tool both see the filtered set — see scanSkills(opts).
     */
    disabledSkills: z.array(z.string()).default([]),

    /**
     * Plugin-level total switch: every skill whose namespaced name
     * starts with `${pluginName}:` is filtered. Coarser knob than
     * disabledSkills; both are honored simultaneously. Bare plugin
     * names (no colon suffix). See scanSkills(opts.disabledPlugins).
     */
    disabledPlugins: z.array(z.string()).default([]),

    /**
     * Sub-agent role names (the `name` in .code-shell/agents/*.md) to
     * hide from the registry. A disabled role is filtered out at load
     * so it never appears in registry.list()/get() — the Agent tool's
     * agent_type list won't show it and the LLM can't pick it. Mirrors
     * disabledSkills / disabledPlugins.
     */
    disabledAgents: z.array(z.string()).default([]),

    /**
     * Project-scoped tri-state capability overlay. Only meaningful in
     * ${cwd}/.code-shell/settings.json; layered over the global baseline at
     * capability-assembly time. Optional — absence === everything inherits.
     */
    capabilityOverrides: CapabilityOverridesSchema,

    /**
     * Feature flags overlay: a map of flag name → boolean that overrides the
     * compiled-in defaults (see settings/feature-flags.ts FEATURE_FLAGS).
     * Project settings override user settings via the normal merge, so a flag
     * can be flipped per-workspace. Unknown flag names are tolerated (kept as
     * data) for forward-compat; consumers only read known flags via
     * isFeatureEnabled(). Passthrough record — values coerced to boolean.
     */
    featureFlags: z.record(z.string(), z.boolean()).default({}),

    /**
     * Cross-session memory knobs. Optional — absence keeps the built-in
     * defaults (see services/extract-memories.ts). `maxCount` caps memories
     * accepted per extraction pass; `maxAge`/`extractionModel` are reserved
     * for the consolidation/extraction pipeline.
     */
    memories: z
      .object({
        maxCount: z.number().int().positive().optional(),
        maxAge: z.number().int().positive().optional(),
        extractionModel: z.string().optional(),
        /** Master switch for end-of-session automatic memory extraction.
         *  Absent/true = extract (current behavior); false = skip extraction
         *  while keeping session summaries and Dream untouched. */
        autoExtract: z.boolean().optional(),
      })
      .optional(),

    instructions: z
      .object({
        fileName: z.string().default("CODESHELL.md"),
        scanDirs: z.array(z.string()).default([]),
        compatFileNames: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md"]),
        ignoreGitBoundary: z.boolean().default(false),
      })
      .default({}),

    search: z
      .object({
        provider: z.enum(["serper", "tavily", "searxng"]).default("serper"),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        /**
         * Per-provider credentials bag. Lets the desktop UI keep
         * Serper/Tavily/SearXNG configured simultaneously and flip the
         * default without losing the others. `provider/apiKey/baseUrl`
         * remain authoritative for the *active* provider so legacy
         * readers keep working.
         */
        providers: z
          .record(
            z.enum(["serper", "tavily", "searxng"]),
            z.object({
              apiKey: z.string().optional(),
              baseUrl: z.string().optional(),
              lastProbe: z
                .object({
                  status: z.enum(["ok", "error", "unconfigured"]),
                  sampleTitles: z.array(z.string()).optional(),
                  errorMessage: z.string().optional(),
                  errorDetail: z.string().optional(),
                  lastProbedAt: z.string(),
                })
                .optional(),
            }),
          )
          .optional(),
      })
      .default({}),

    output: z
      .object({
        format: z.enum(["text", "json", "jsonl", "stream-json"]).default("text"),
      })
      .default({}),

    /**
     * Image attachment handling. Sub-fields:
     *   - detail: provider-agnostic image clarity. Drives the
     *     renderer-side downscale (low→~1024 / standard→~1568 /
     *     high→~2576 px long edge) so BOTH providers save tokens
     *     before send. Legacy "original" is migrated to "high".
     *   - mcpImageTokenBudget: per-turn cap on token cost of images
     *     returned by MCP tools. Codex doesn't enforce this; CC uses
     *     25 000. Set to 0 to disable.
     */
    images: z
      .object({
        detail: z
          .preprocess(
            // Legacy migration: old settings stored "original"; map it to
            // "high" so existing user.json doesn't fail validation on boot.
            (v) => (v === "original" ? "high" : v),
            z.enum(["low", "standard", "high"]),
          )
          .optional(),
        mcpImageTokenBudget: z.number().int().nonnegative().optional(),
      })
      .optional(),

    /**
     * OS-level sandbox for shell-tool execution. "auto" picks per platform:
     * Seatbelt on macOS, bubblewrap on Linux when installed, otherwise off.
     * Defaults are applied per Engine run depending on headless vs REPL —
     * see Engine.run() and run.ts.
     */
    sandbox: z
      .object({
        mode: z.enum(["off", "auto", "seatbelt", "bwrap"]).optional(),
        writableRoots: z.array(z.string()).optional(),
        deniedReads: z.array(z.string()).optional(),
        network: z.enum(["allow", "deny"]).optional(),
      })
      .optional(),

    /**
     * Top-level environment variables injected into tool subprocesses (the
     * Bash tool, background shells). Mirrors Claude Code's `env` field: a
     * KEY=VALUE map that can be set globally (~/.code-shell/settings.json) and
     * overridden per-project (.code-shell/settings.json). The canonical home
     * for API keys (e.g. OPENAI_API_KEY) that a skill's script reads — configure
     * once globally and every project's skills can use it.
     *
     * Precedence when merged into the spawn env (lowest → highest):
     *   project localEnvironment.env  →  global env  →  project env
     * None of these is filtered through the deny regex (see mergeShellEnv):
     * they are values the user typed deliberately, a different trust class from
     * the host process.env passthrough the deny machinery guards against.
     */
    env: z.record(z.string()).optional(),

    /**
     * Project-local environment profile. Mirrors Codex's local-environment
     * shape at the settings layer: setup/cleanup scripts can be customized per
     * platform, and env values are stored as KEY=VALUE pairs. Runtime wiring is
     * intentionally separate from the MCP server env model above.
     */
    localEnvironment: z
      .object({
        name: z.string().optional(),
        setupScripts: z
          .object({
            default: z.string().optional(),
            macos: z.string().optional(),
            linux: z.string().optional(),
            windows: z.string().optional(),
          })
          .optional(),
        cleanupScripts: z
          .object({
            default: z.string().optional(),
            macos: z.string().optional(),
            linux: z.string().optional(),
            windows: z.string().optional(),
          })
          .optional(),
        env: z.record(z.string()).optional(),
      })
      .optional(),

    /**
     * Shell-hook configuration. Each entry binds a HookEventName to a
     * shell command; the command receives ctx JSON on stdin and returns
     * a HookResult JSON on stdout (or exit 2 = deny with stderr as
     * reason). See src/hooks/shell-runner.ts for the wire protocol.
     *
     * The event field is loose-typed here (z.string()) because adding
     * new lifecycle events shouldn't force a schema bump; the runner
     * silently ignores entries whose event isn't registered.
     */
    hooks: z
      .array(
        z.object({
          event: z.string(),
          command: z.string().min(1),
          matcher: z.string().optional(),
          timeout_ms: z.number().int().positive().optional(),
          cwd: z.string().optional(),
          /** Soft off-switch: the entry stays in the file (and the UI) but
           *  registerSettingsHooks skips it. Absent = enabled. */
          disabled: z.boolean().optional(),
        }),
      )
      .optional(),

    /**
     * External coding-agent orchestration (Claude Code / Codex CLI).
     * Used by the Mobile Web Remote to launch managed jobs. dangerousArgs
     * is config-provided (not hardcoded) so it tracks CLI flag changes;
     * project-default dangerous mode only applies inside trustedWorkspaces.
     */
    externalAgents: z
      .object({
        claudeCode: z
          .object({
            command: z.string().optional(),
            defaultMode: z.enum(["safe", "dangerous"]).optional(),
            dangerousArgs: z.array(z.string()).optional(),
            trustedWorkspaces: z.array(z.string()).optional(),
            autoStartInTrustedWorkspaces: z.boolean().optional(),
          })
          .optional(),
        codex: z
          .object({
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),

    /**
     * Credential-use gate (凭证模块第二期). Controls whether the AI's
     * `UseCredential` tool prompts before handing a stored credential to a
     * command. `autoApprove: true` skips the prompt entirely (默认关 — every
     * use asks, or is remembered for the session). See
     * docs/superpowers/specs/2026-06-16-credential-use-gate-design.md §5.
     */
    credentialUse: z
      .object({
        autoApprove: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export type ValidatedSettings = z.infer<typeof SettingsSchema>;

export function validateSettings(raw: unknown): ValidatedSettings {
  return SettingsSchema.parse(raw);
}
