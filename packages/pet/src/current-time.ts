import type { ToolDefinition, ToolVisibilityContext } from "@cjhyy/code-shell-core/extension";
import { hasOnlyDeclaredToolArguments } from "./tool-arguments.js";

export const CURRENT_TIME_TOOL_NAME = "CurrentTime";

export const currentTimeToolDef: ToolDefinition = {
  name: CURRENT_TIME_TOOL_NAME,
  description:
    "Return the trusted current local date, time, timezone, UTC offset and epoch. Use this instead " +
    "of guessing from timestamps or trying to run a shell command.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

export function currentTimeAvailability(ctx: ToolVisibilityContext): boolean {
  return ctx.behaviorProfile === "pet";
}

export async function currentTimeTool(args: Record<string, unknown>): Promise<string> {
  if (!hasOnlyDeclaredToolArguments(args, [])) return "Error: CurrentTime accepts no arguments.";
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const utcOffset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(
    absolute % 60,
  ).padStart(2, "0")}`;
  return JSON.stringify({
    epochMs: now.getTime(),
    iso: now.toISOString(),
    local: parts,
    timeZone,
    utcOffset,
  });
}
