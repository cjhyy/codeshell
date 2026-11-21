/** Named worker commands exposed by the existing workbench preload. */
export const desktopAgentMethods = [
  "agent/run",
  "agent/cancel",
  "agent/steer",
  "agent/unsteer",
  "agent/backgroundShells",
  "agent/approve",
  "agent/approvalKeepWaiting",
  "agent/closeSession",
  "agent/forkSession",
  "agent/query",
  "agent/configure",
  "agent/goalGet",
  "agent/goalUpdate",
  "agent/goalClear",
  "agent/goalExtend",
  "agent/goalDelete",
] as const;

export type DesktopAgentMethod = (typeof desktopAgentMethods)[number];
const commands: ReadonlySet<string> = new Set(desktopAgentMethods);

export function isDesktopAgentMethod(value: unknown): value is DesktopAgentMethod {
  return typeof value === "string" && commands.has(value);
}
