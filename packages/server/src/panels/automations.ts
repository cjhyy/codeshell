import { createHash } from "node:crypto";

export const panelAutomationMethods = [
  "automations.list",
  "automations.create",
  "automations.createUnique",
  "automations.update",
  "automations.pause",
  "automations.resume",
  "automations.delete",
  "automations.runNow",
] as const;

/** Derived by the transport; sessionId is still untrusted until the Host verifies its workspace. */
export interface PanelAutomationScope {
  appId: string;
  cwd: string;
  sessionId: string;
  /** Host-selected installed package revision, never a field from Panel call JSON. */
  revision?: string;
  isAuthorized(): Promise<boolean>;
}
/** Borrowed Host service. A page/transport closing never stops the scheduler. */
export interface PanelAutomationHost {
  call(scope: PanelAutomationScope, method: string, params?: unknown): Promise<unknown>;
}
export function panelAutomationCreationKey(
  appId: string,
  cwd: string,
  sessionId: string,
  key: string,
): string {
  return `panel:${createHash("sha256")
    .update(JSON.stringify([appId, cwd, sessionId, key]))
    .digest("hex")}`;
}
type Definition = { name: string; schedule: string; prompt: string; timezone?: string };
export type PanelAutomationOperation =
  | { action: "list" }
  | { action: "create"; input: Definition; key?: string }
  | { action: "update"; id: string; patch: Partial<Definition> }
  | { action: "pause" | "resume" | "delete" | "runNow"; id: string };

/** Common wire validation; authority fields are never supplied by Panel JSON. */
export function parsePanelAutomationCall(
  method: string,
  params: unknown,
): PanelAutomationOperation {
  if (!(panelAutomationMethods as readonly string[]).includes(method))
    throw Error("Unknown Panel automation method");
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params)))
    throw Error("Panel automation parameters must be an object");
  const input = (params ?? {}) as Record<string, unknown>;
  const action = method.slice("automations.".length);
  const create = action === "create" || action === "createUnique";
  const allowed =
    action === "list"
      ? []
      : create
        ? [
            "name",
            "schedule",
            "prompt",
            "timezone",
            "permissionLevel",
            ...(action === "createUnique" ? ["key"] : []),
          ]
        : action === "update"
          ? ["id", "name", "schedule", "prompt", "timezone"]
          : ["id"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Error("Panel automation parameters contain unsupported or authority fields");
  if (action === "list") return { action };
  let id = "";
  if (!create) {
    if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 128)
      throw Error("Panel automation id is invalid");
    id = input.id.trim();
  }
  if (!create && action !== "update")
    return { action: action as "pause" | "resume" | "delete" | "runNow", id };
  const patch: Partial<Definition> = {};
  for (const [key, limit] of [
    ["name", 120],
    ["schedule", 128],
    ["prompt", 20000],
    ["timezone", 120],
  ] as const) {
    const value = input[key];
    if (value === undefined && (!create || key === "timezone")) continue;
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
      throw Error(`Panel automation ${key} is invalid`);
    patch[key] = value.trim();
  }
  if (action === "update") {
    if (!Object.keys(patch).length) throw Error("Panel automation update is empty");
    return { action, id, patch };
  }
  if (input.permissionLevel !== undefined && input.permissionLevel !== "full")
    throw Error("Panel automation permissionLevel must be full");
  if (
    action === "createUnique" &&
    (typeof input.key !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(input.key))
  )
    throw Error("Panel unique automation requires a bounded key");
  return {
    action: "create",
    input: patch as Definition,
    ...(action === "createUnique" ? { key: input.key as string } : {}),
  };
}
