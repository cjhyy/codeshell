/**
 * Settings schema with Zod validation.
 */

import { z } from "zod";
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
      })
      .default({}),

    /**
     * Primary source of truth for the active model is settings.activeKey
     * (points at models[].key). settings.model is a derived mirror of that
     * entry kept in sync for legacy boot paths (cli/main.ts, repl.ts, etc.)
     * which read provider/name/apiKey/baseUrl directly. Writers must update
     * both — appendOnboardingResult does this in one shot.
     */
    activeKey: z.string().optional(),

    /**
     * Toggle background auto-update. When true (default), code-shell checks
     * npm for newer versions and — if the npm global prefix is writable —
     * installs the update in the background on process exit so the next
     * launch picks it up.
     * Can also be disabled via env var `DISABLE_AUTOUPDATER=1`.
     */
    autoUpdates: z.boolean().default(true),

    model: z
      .object({
        provider: z.string().default("openai"),
        name: z.string().default("anthropic/claude-opus-4-6"),
        apiKey: z.string().optional(),
        baseUrl: z.string().default("https://openrouter.ai/api/v1"),
        temperature: z.number().min(0).max(2).default(0.3),
        maxTokens: z.number().default(8192),
      })
      .default({}),

    providers: z
      .array(
        z.object({
          key: z.string(),
          label: z.string().optional(),
          kind: z.enum([
            "openai",
            "anthropic",
            "deepseek",
            "zai",
            "xai",
            "mistral",
            "groq",
            "google",
            "openrouter",
            "ollama",
            "custom",
          ]),
          baseUrl: z.string(),
          apiKey: z.string().optional(),
          protocol: z.enum(["openai-compat", "anthropic-style"]).optional(),
          modelsPath: z.string().optional(),
          /**
           * DeepSeek V4 thinking-mode default for this provider. "enabled"
           * matches endpoint default; "disabled" makes V4 calls run in
           * non-thinking mode (faster, cheaper). Ignored by every provider
           * other than DeepSeek V4. Per-call overrides still win.
           */
          thinking: z.enum(["enabled", "disabled"]).optional(),
        }),
      )
      .default([]),

    models: z
      .array(
        z
          .object({
            key: z.string(),
            label: z.string().optional(),
            providerKey: z.string().optional(),
            model: z.string(),
            maxOutputTokens: z.number().optional(),
            maxContextTokens: z.number().optional(),
            /**
             * Which LLM client to use ("openai" or "anthropic"). New name —
             * the legacy field is `provider`, which we still accept and
             * fold into `protocol` below so old configs keep working.
             * NOT the brand/vendor — that's providerKey above.
             */
            protocol: z.string().optional(),
            provider: z.string().optional(),
            baseUrl: z.string().optional(),
            apiKey: z.string().optional(),
            /**
             * Per-model thinking override. Wins over the provider-level
             * setting (settings.providers[].thinking). Use this when
             * different models under the same provider need different
             * defaults — e.g. DeepSeek V4 Pro off (faster) but V4 Flash on.
             */
            thinking: z.enum(["enabled", "disabled"]).optional(),
          })
          .transform((m) => {
            // Normalize: prefer `protocol`; fall back to legacy `provider`.
            // We keep `provider` populated as a mirror because engine code
            // and a few downstream readers still query it directly.
            const effective = m.protocol ?? m.provider;
            return {
              ...m,
              protocol: effective,
              provider: effective,
            };
          }),
      )
      .default([]),

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
        compactAtRatio: z.number().default(0.6),
        summarizeAtRatio: z.number().default(0.8),
      })
      .default({}),

    session: z
      .object({
        storageDir: z.string().optional(),
        maxHistory: z.number().default(100),
      })
      .default({}),

    mcpServers: z
      .record(
        z.object({
          name: z.string(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
          url: z.string().optional(),
          transport: z.enum(["stdio", "sse", "streamable-http", "inprocess"]).optional(),
          headers: z.record(z.string()).optional(),
          // Codex-style on/off switch. Absent or true → connected; only
          // literal false disables. Filtered in MCPManager.connectAll.
          enabled: z.boolean().optional(),
        }),
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

    instructions: z
      .object({
        fileName: z.string().default("CODESHELL.md"),
        scanDirs: z.array(z.string()).default([]),
        compatFileNames: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md"]),
        ignoreGitBoundary: z.boolean().default(false),
      })
      .default({}),

    arena: z
      .object({
        participants: z
          .array(
            z.union([
              // Short form: just a model pool key
              z.string(),
              // Full form: explicit config (backward compat)
              z.object({
                name: z.string(),
                model: z.string(),
                provider: z.string().optional(),
                apiKey: z.string().optional(),
                baseUrl: z.string().optional(),
              }),
            ]),
          )
          .default([]),
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
     *   - detail: OpenAI-style fidelity hint applied to every user-
     *     attached image. "low" = 85 tokens/image fixed (cheap
     *     thumbnail), "high" = ~768 px tiles (default), "original" =
     *     keep client-side dimensions (most expensive). Anthropic
     *     ignores this field today; that's fine — it just gets
     *     dropped on the Claude path.
     *   - mcpImageTokenBudget: per-turn cap on token cost of images
     *     returned by MCP tools. Codex doesn't enforce this; CC uses
     *     25 000. Set to 0 to disable.
     */
    images: z
      .object({
        detail: z.enum(["low", "high", "original"]).optional(),
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
        }),
      )
      .optional(),
  })
  .passthrough();

export type ValidatedSettings = z.infer<typeof SettingsSchema>;

export function validateSettings(raw: unknown): ValidatedSettings {
  return SettingsSchema.parse(raw);
}
