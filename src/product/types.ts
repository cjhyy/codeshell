/**
 * Product Adapter — the contract for turning CodeShell into a domain-specific agent.
 *
 * A "product" is a concrete agent application built on top of CodeShell.
 * Examples:
 *   - Code reviewer agent
 *   - Data pipeline orchestrator
 *   - DevOps deployment agent
 *   - Documentation writer
 *   - Security audit agent
 *
 * To build a product, an external repo provides:
 *
 *   1. **Preset** (brain)     — system prompt, tool set, permission rules
 *   2. **Adapter** (hands)    — custom tools, MCP servers, domain-specific IO
 *   3. **Contract** (quality) — evaluator, completion criteria, artifact specs
 *
 * These three layers compose into a ProductDefinition that CodeShell's
 * `defineProduct()` function turns into a fully configured RunManager.
 */

import type { PermissionRule, MCPServerConfig } from "../types.js";
import type { Evaluator } from "../run/Evaluator.js";
import type { HookEventName } from "../hooks/events.js";
import type { RegisteredTool } from "../types.js";

// ─── 1. Preset (brain) ──────────────────────────────────────────

export interface ProductPreset {
  /** Unique name for this product's preset. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** One-line description. */
  description: string;

  /**
   * System prompt for the agent. Two options:
   *   - `sections`: reuse CodeShell's built-in markdown sections (e.g. ["base", "orchestration"])
   *   - `customPrompt`: provide a full custom system prompt string
   * If both are provided, customPrompt takes precedence.
   */
  sections?: string[];
  customPrompt?: string;

  /** Additional text appended after the main system prompt. */
  appendPrompt?: string;

  /** Whether to inject git status into system context. Default: false */
  injectGitStatus?: boolean;
}

// ─── 2. Adapter (hands) ─────────────────────────────────────────

export interface CustomTool {
  /** Tool definition (name, description, inputSchema). */
  definition: RegisteredTool;
  /** Tool executor function. */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ProductAdapter {
  /**
   * Custom tools specific to this product domain.
   * These are registered in addition to the preset's builtin tools.
   */
  tools?: CustomTool[];

  /**
   * MCP servers to connect (external tool providers).
   */
  mcpServers?: Record<string, MCPServerConfig>;

  /**
   * Builtin tools to explicitly enable (add to preset defaults).
   */
  enableTools?: string[];

  /**
   * Builtin tools to explicitly disable (remove from preset defaults).
   */
  disableTools?: string[];

  /**
   * Permission rules specific to this product.
   * Applied on top of the preset's default rules.
   */
  permissionRules?: PermissionRule[];

  /**
   * Hooks to register for this product.
   * Key: hook event name, Value: handler function.
   */
  hooks?: Array<{
    event: HookEventName;
    handler: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
    priority?: number;
    name?: string;
  }>;
}

// ─── 3. Contract (quality) ───────────────────────────────────────

export interface ProductContract {
  /**
   * Evaluator(s) to run on completion.
   * Can be a single Evaluator or an array (composed automatically).
   */
  evaluator?: Evaluator | Evaluator[];

  /**
   * Default tags applied to every run submitted through this product.
   */
  defaultTags?: string[];

  /**
   * Default metadata attached to every run.
   */
  defaultMetadata?: Record<string, unknown>;

  /**
   * Maximum turns per run. Overrides the default 30.
   */
  maxTurns?: number;

  /**
   * Maximum context tokens. Overrides the default 200_000.
   */
  maxContextTokens?: number;

  /**
   * Queue concurrency. Default: 1.
   */
  concurrency?: number;
}

// ─── Composed Definition ─────────────────────────────────────────

export interface ProductDefinition {
  preset: ProductPreset;
  adapter?: ProductAdapter;
  contract?: ProductContract;
}
