import { createHash } from "node:crypto";
import type { CronJob } from "@cjhyy/code-shell-core/internal";

export const panelAutomationMethods = [
  "automations.list",
  "automations.create",
  "automations.createUnique",
  "automations.update",
  "automations.updateIfRevision",
  "automations.deleteIfRevision",
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
  /** True only if revision checks happen inside the scheduler storage transaction. */
  conditionalMutations?: boolean;
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
/** Definition identity excludes changing run statistics and execution receipts. */
export function panelAutomationRevision(job: Readonly<CronJob>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        job.id,
        job.createdAt,
        job.name,
        job.schedule,
        job.prompt,
        job.enabled,
        job.cwd ?? null,
        job.projectId ?? null,
        job.rootId ?? null,
        job.resumeSessionId ?? null,
        job.timezone ?? "UTC",
        job.permissionLevel ?? "read-only",
        job.once === true,
        job.disabledReason ?? null,
        job.creationKey ?? null,
        job.panelSource?.appId ?? null,
        job.panelSource?.revision ?? null,
        job.templateSource?.installKey ?? null,
        job.templateSource?.templateId ?? null,
        job.templateSource?.revision ?? null,
        job.templateSource?.pluginVersion ?? null,
      ]),
    )
    .digest("hex");
}
export class PanelAutomationConflictError extends Error {
  constructor() {
    super("Automation changed; reload before editing or deleting it");
  }
}
export function assertPanelAutomationRevision(job: Readonly<CronJob>, expected?: string): void {
  if (expected !== undefined && panelAutomationRevision(job) !== expected)
    throw new PanelAutomationConflictError();
}
type Definition = { name: string; schedule: string; prompt: string; timezone?: string };
export type PanelAutomationOperation =
  | { action: "list" }
  | { action: "create"; input: Definition; key?: string }
  | { action: "update"; id: string; patch: Partial<Definition>; expectedRevision?: string }
  | { action: "pause" | "resume" | "delete" | "runNow"; id: string; expectedRevision?: string };

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
  const conditional = method.endsWith("IfRevision");
  const action = method.slice("automations.".length).replace(/IfRevision$/, "");
  let expectedRevision: string | undefined;
  if (conditional) {
    if (
      typeof input.expectedRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    )
      throw Error("Panel automation expectedRevision is invalid");
    expectedRevision = input.expectedRevision;
  }
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
  if (conditional) allowed.push("expectedRevision");
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
    return {
      action: action as "pause" | "resume" | "delete" | "runNow",
      id,
      ...(expectedRevision ? { expectedRevision } : {}),
    };
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
    return { action, id, patch, ...(expectedRevision ? { expectedRevision } : {}) };
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
