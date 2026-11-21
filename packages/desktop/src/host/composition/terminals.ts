import type { ListSessions } from "../../shared/disk-session-query.js";
import { isDesktopSessionId } from "../../shared/disk-session-query.js";
import { HostRevokedError, type HostRequestContext } from "../../main/desktop-host/authority.js";
import { businessArguments, textArgument } from "../../main/desktop-host/business-read.js";
import {
  InvalidParams,
  type DesktopHostMethod,
  type DesktopHostServer,
} from "../../main/desktop-host/server.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { requireRendererProjectPath } from "../../main/renderer-project-path.js";
import { requireRendererOrSessionPath } from "../../main/renderer-session-path.js";
import {
  assertValidPtySessionId,
  ptyKill,
  ptyKillAll,
  ptyReapDestroyed,
  ptyResize,
  ptyStart,
  ptyWrite,
  type PtyOwner,
} from "../../main/pty-service.js";

function dimensions(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > 65535)
    throw new InvalidParams("Invalid terminal dimensions");
  return input;
}

/** A PTY survives a document reload but its shell belongs to the workbench
 * that created it. Only the current bound port receives output and scrollback. */
export function hostedTerminals(host: () => DesktopHostServer, list: ListSessions) {
  const owners = new Map<number, PtyOwner>();
  function owner(ctx: HostRequestContext) {
    const id = ctx.identity.webContentsId;
    let current = owners.get(id);
    if (!current) {
      current = {
        id,
        isDestroyed: () => !owners.has(id),
        send(channel, value) {
          host().notifyWindow(
            id,
            {
              "pty:data": "pty/data",
              "pty:exit": "pty/exit",
              "pty:remoteViewers": "pty/remoteViewers",
            }[channel],
            value,
          );
        },
      };
      owners.set(id, current);
    }
    return current;
  }
  const methods = new Map<string, DesktopHostMethod>([
    [
      "pty/start",
      {
        async run(ctx, params) {
          const p = businessArguments(params, [
            "sessionId",
            "cols",
            "rows",
            "cwd",
            "engineSessionId",
          ]);
          const id = p.sessionId;
          assertValidPtySessionId(id);
          const path = p.cwd === undefined ? resolveNoRepoCwd() : textArgument(p.cwd);
          const cols = p.cols === undefined ? 80 : dimensions(p.cols);
          const rows = p.rows === undefined ? 24 : dimensions(p.rows);
          let cwd: string;
          let session: HostRequestContext | undefined;
          try {
            try {
              cwd = await requireRendererProjectPath(path);
            } catch (error) {
              if (!isDesktopSessionId(p.engineSessionId)) throw error;
              const sessionId = p.engineSessionId;
              session = host().captureOperation(ctx.identity, sessionId);
              if (
                session.historical &&
                !(await list({ sessionId, limit: 1 })).sessions.some((s) => s.id === sessionId)
              )
                throw new HostRevokedError();
              cwd = await requireRendererOrSessionPath(path, sessionId);
              if (
                session.historical &&
                !(await list({ sessionId, limit: 1 })).sessions.some((s) => s.id === sessionId)
              )
                throw new HostRevokedError();
              session.assertCurrent();
            }
            ctx.assertCurrent();
            return ptyStart(owner(ctx), { sessionId: id, cwd, cols, rows });
          } finally {
            session?.release?.();
          }
        },
      },
    ],
    [
      "pty/write",
      {
        run(ctx, params) {
          const { sessionId, data, reply } = businessArguments(params, [
            "sessionId",
            "data",
            "reply",
          ]);
          if (reply !== undefined && typeof reply !== "boolean")
            throw new InvalidParams("Invalid terminal reply flag");
          assertValidPtySessionId(sessionId);
          if (typeof data !== "string" || data.length > 1024 * 1024)
            throw new InvalidParams("Invalid terminal input");
          ptyWrite(owner(ctx), sessionId, data, reply === true);
        },
      },
    ],
    [
      "pty/resize",
      {
        run(ctx, params) {
          const { sessionId, cols, rows } = businessArguments(params, [
            "sessionId",
            "cols",
            "rows",
          ]);
          assertValidPtySessionId(sessionId);
          ptyResize(owner(ctx), sessionId, dimensions(cols), dimensions(rows));
        },
      },
    ],
    [
      "pty/kill",
      {
        run(ctx, params) {
          const { sessionId } = businessArguments(params, ["sessionId"]);
          assertValidPtySessionId(sessionId);
          ptyKill(owner(ctx), sessionId);
        },
      },
    ],
  ]);
  return {
    methods,
    closeWindow(id: number) {
      owners.delete(id);
      ptyReapDestroyed();
    },
    close() {
      owners.clear();
      ptyKillAll();
    },
  };
}
