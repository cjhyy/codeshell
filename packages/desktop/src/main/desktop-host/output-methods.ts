import { isDesktopSessionId, type ListSessions } from "../../shared/disk-session-query.js";
import type { Snapshot } from "../SessionSnapshotStore.js";
import { HostRevokedError } from "./authority.js";
import { InvalidParams, type DesktopHostMethod } from "./server.js";

export function outputMethods(
  read: (sessionId: string, sinceSeq?: number) => Promise<Snapshot>,
  list: ListSessions,
): Map<string, DesktopHostMethod> {
  return new Map([
    [
      "agent/subscribe",
      {
        historyRead: "output",
        sessionId(params) {
          if (
            !params ||
            !isDesktopSessionId(params.sessionId) ||
            Object.keys(params).some((key) => key !== "sessionId" && key !== "sinceSeq") ||
            (params.sinceSeq !== undefined &&
              !(Number.isSafeInteger(params.sinceSeq) && Number(params.sinceSeq) >= 0))
          )
            throw new InvalidParams();
          return params.sessionId;
        },
        async run(context, params) {
          const id = params!.sessionId as string;
          const visible = async () => {
            if (!(await list({ sessionId: id, limit: 1 })).sessions.some((row) => row.id === id))
              throw new HostRevokedError();
            context.assertCurrent();
          };
          if (context.historical) await visible();
          const result = await read(id, params!.sinceSeq as number | undefined);
          context.assertCurrent();
          if (context.historical) await visible();
          return result;
        },
      },
    ],
  ]);
}
