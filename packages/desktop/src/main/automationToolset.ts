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

/** Tools removed from automation runs: cron trio (no recursive scheduling) +
 *  AskUserQuestion (no human to answer in an unattended run). */
export const AUTOMATION_DISABLED_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "AskUserQuestion",
  "MCPTool",
  "ListMcpResources",
  "ReadMcpResource",
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
