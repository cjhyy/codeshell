/**
 * Settings schema with Zod validation.
 */

import { z } from "zod";
export const SettingsSchema = z.object({
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

  models: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().optional(),
        provider: z.string(),
        model: z.string(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        maxOutputTokens: z.number().optional(),
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

  mcpServers: z.record(
    z.object({
      name: z.string(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      url: z.string().optional(),
      transport: z.enum(["stdio", "sse", "streamable-http", "inprocess"]).optional(),
      headers: z.record(z.string()).optional(),
    }),
  ).default({}),

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
    })
    .default({}),

  output: z
    .object({
      format: z.enum(["text", "json", "jsonl", "stream-json"]).default("text"),
    })
    .default({}),
}).passthrough();

export type ValidatedSettings = z.infer<typeof SettingsSchema>;

export function validateSettings(raw: unknown): ValidatedSettings {
  return SettingsSchema.parse(raw);
}
