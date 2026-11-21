import { randomUUID } from "node:crypto";
import {
  desktopAgentMethods,
  type DesktopAgentMethod,
} from "../../shared/desktop-agent-methods.js";
import { isDesktopSessionId } from "../../shared/disk-session-query.js";
import { HostRevokedError } from "./authority.js";
import { InvalidParams, type DesktopHostMethod } from "./server.js";
import type { WorkbenchRequest } from "./ingress-wire.js";

const ownedOnly = new Set<DesktopAgentMethod>([
  "agent/cancel",
  "agent/steer",
  "agent/unsteer",
  "agent/approve",
  "agent/approvalKeepWaiting",
  "agent/closeSession",
]);

function scope(method: DesktopAgentMethod, p?: Record<string, unknown>): string | undefined {
  if (!p) throw new InvalidParams();
  if (method === "agent/query" && p.type !== "compact") throw new InvalidParams();
  if (
    method === "agent/configure" &&
    Object.keys(p).some(
      (key) =>
        ![
          "sessionId",
          "model",
          "permissionMode",
          "planMode",
          "reloadModels",
          "reloadSettings",
        ].includes(key),
    )
  )
    throw new InvalidParams();
  if (method === "agent/configure" && p.sessionId === undefined) return;
  if (
    method === "agent/forkSession" &&
    p.targetSessionId !== undefined &&
    !isDesktopSessionId(p.targetSessionId)
  )
    throw new InvalidParams();
  if (method === "agent/backgroundShells" && !["list", "output", "kill"].includes(String(p.action)))
    throw new InvalidParams();
  const id = method === "agent/forkSession" ? p.sourceSessionId : p.sessionId;
  if (!isDesktopSessionId(id)) throw new InvalidParams("A valid sessionId is required");
  return id;
}

/** A request is admitted by the document owning the transferred port. A cold
 * session needs a visible disk row; fresh runs still pass native project
 * registration, Quick Chat ownership and the shared cwd/trust normalizer. */
export function ingressMethods(
  send: (request: WorkbenchRequest, current: () => void) => Promise<unknown>,
  cold: (id: string) => Promise<"visible" | "absent" | "hidden">,
) {
  return new Map<string, DesktopHostMethod>(
    desktopAgentMethods.map((method) => [
      method,
      {
        admission: true,
        sessionId: (params) => scope(method, params),
        async run(ctx, params) {
          const id = scope(method, params);
          if (id && ctx.historical) {
            if (ownedOnly.has(method)) throw new HostRevokedError();
            const visibility = await cold(id);
            ctx.assertCurrent();
            const newSession =
              (method === "agent/run" || method === "agent/configure") && visibility === "absent";
            const quickChat =
              method === "agent/run" &&
              id.startsWith("qchat-") &&
              typeof params?.quickChatClaimId === "string";
            if (visibility !== "visible" && !newSession && !quickChat) throw new HostRevokedError();
          }
          ctx.assertCurrent();
          return send(
            { id: "workbench:" + randomUUID(), identity: ctx.identity, method, params: params! },
            ctx.assertCurrent,
          );
        },
      },
    ]),
  );
}
