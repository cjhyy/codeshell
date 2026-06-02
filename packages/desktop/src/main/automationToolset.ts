/**
 * Automation tool whitelist.
 *
 * An unattended automation run must NOT be able to recursively schedule more
 * automations, so the cron tools (CronCreate/CronDelete/CronList) are stripped
 * from the builtin set its Engine gets. Everything else stays available.
 *
 * `automationBuiltinTools()` is the absolute allowlist (every core builtin
 * except the cron trio); `AUTOMATION_DISABLED_TOOLS` is the same exclusion
 * expressed as a delta, which the runner feeds to Engine's
 * `disabledBuiltinTools` (a delta on the preset's base set).
 */
import { BUILTIN_TOOLS } from "@cjhyy/code-shell-core";

/** Cron tools removed from automation runs to prevent recursive scheduling. */
export const AUTOMATION_DISABLED_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
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
