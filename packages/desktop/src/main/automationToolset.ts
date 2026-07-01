/**
 * Automation tool whitelist.
 *
 * An unattended automation run must NOT be able to recursively schedule more
 * automations, so the cron tools (CronCreate/CronDelete/CronList) are stripped
 * from the builtin set its Engine gets. AskUserQuestion is stripped too — no
 * human is watching, so it can only waste a turn and error ("not available in
 * headless mode"); better the model never sees it. Everything else stays.
 *
 * `automationBuiltinTools()` is the absolute allowlist (every core builtin
 * except the cron trio); `AUTOMATION_DISABLED_TOOLS` is the same exclusion
 * expressed as a delta, which the runner feeds to Engine's
 * `disabledBuiltinTools` (a delta on the preset's base set).
 */
import { BUILTIN_TOOLS } from "@cjhyy/code-shell-core";

/** Tools removed from automation runs: cron trio (no recursive scheduling),
 *  AskUserQuestion (no human to answer), MCP tools (no blocking on external
 *  startup), background-shell tools (no unreaped dev server), and the external
 *  -agent drivers (no bypass-sandbox escape from the automation write-policy). */
export const AUTOMATION_DISABLED_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "AskUserQuestion",
  "MCPTool",
  "ListMcpResources",
  "ReadMcpResource",
  // External-agent drivers: a full-tier cron/automation run must not be able to
  // spawn an external claude/codex with bypassPermissions + no seatbelt, which
  // would break the automation write-policy invariant ("even full stays inside
  // the workspace"). RemoteTrigger is additionally a dead tool (nothing
  // consumes ~/.code-shell/triggers), so it has no business in an unattended
  // run either.
  "DriveAgent",
  "DriveClaudeCode",
  "RemoteTrigger",
  // Background shells (design §5.5): an unattended run must not start a
  // long-lived dev server no one will reap. The Bash run_in_background
  // *parameter* is separately rejected via Engine allowBackgroundShells=false.
  "BashOutput",
  "KillShell",
  "ListShells",
] as const;

/**
 * All core builtin tool names EXCEPT the cron tools. Each BUILTIN_TOOLS element
 * is `{ definition: { name, ... }, execute }`.
 */
export function automationBuiltinTools(): string[] {
  const excluded = new Set<string>(AUTOMATION_DISABLED_TOOLS);
  return BUILTIN_TOOLS.map((t) => t.definition.name).filter(
    (name) => !excluded.has(name),
  );
}
