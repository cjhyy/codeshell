/**
 * CheckQuota builtin — thin shell over the `quota/` module.
 *
 * Lets an orchestrating agent read how much CC/Codex quota is left before/while
 * delegating work (DriveAgent), so it can plan: how many to spawn, whether to
 * wait for a reset, or switch providers. See quota/index.ts for the sources.
 *
 * NOTE the cost asymmetry (surfaced in the description): Codex is a free GET;
 * Claude costs ~1 output token because Anthropic only returns quota via
 * response headers. So restrict with `provider` when you only need one.
 */
import type { ToolContext, ToolDefinition } from "@cjhyy/code-shell-core";
import { checkQuota, formatQuota } from "../quota/index.js";
import { resolveQuotaCredentials } from "../quota/credentials.js";

export const checkQuotaToolDef: ToolDefinition = {
  name: "CheckQuota",
  description:
    "Check remaining usage/rate-limit quota for the external coding-agent CLIs (Claude Code and/or " +
    "Codex) — the same 5h/7d subscription windows their status lines show. Use before or during " +
    "orchestration (DriveAgent) to plan how much work to hand off, whether to wait for a reset, or " +
    "which provider to use. Returns each provider's 5h/7d used-% and reset time. " +
    "COST: 'codex' is free (reads a usage endpoint). 'claude' costs ~1 token (Anthropic exposes " +
    "quota only via a response header, so this sends a 1-token probe). Pass `provider` to query " +
    "just one and avoid the other's cost/latency.",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["claude", "codex", "both"],
        description:
          "Which to check. 'both' (default) queries Claude Code and Codex. 'claude' sends a 1-token probe; 'codex' is free.",
      },
    },
    required: [],
  },
};

export async function checkQuotaTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const which: ("claude" | "codex")[] =
    args.provider === "claude"
      ? ["claude"]
      : args.provider === "codex"
        ? ["codex"]
        : ["claude", "codex"];
  const creds = await resolveQuotaCredentials();
  const result = await checkQuota({
    creds,
    providers: which,
    signal: ctx?.signal,
  });
  const nowSec = Math.floor(Date.now() / 1000);
  return formatQuota(result, nowSec);
}
