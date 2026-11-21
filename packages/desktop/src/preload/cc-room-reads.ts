import type { IpcRenderer } from "electron";
import type { DesktopHostClient } from "./desktop-host-client.js";
import type { CcRoomReads, CliKind } from "../shared/cc-room-reads.js";

/** Auxiliary windows keep the native adapter. Workbenches use their bound Host port. */
export function createCcRoomReads(ipc: Pick<IpcRenderer, "invoke">, host?: DesktopHostClient) {
  function read<K extends keyof CcRoomReads>(
    name: K,
    params: CcRoomReads[K]["params"],
    fallback: () => Promise<CcRoomReads[K]["result"]>,
  ) {
    return host ? host.readBusiness(name, params, fallback) : fallback();
  }
  const probe = (kind: CliKind, force?: boolean) =>
    read("ccRoom/probe", { kind, force }, () =>
      kind === "codex" ? ipc.invoke("ccRoom:codexProbe", force) : ipc.invoke("ccRoom:probe", force),
    );
  const list = (kind: CliKind, cwd: string, all?: boolean) =>
    read("ccRoom/sessions", { kind, cwd, all }, () =>
      kind === "codex"
        ? ipc.invoke("ccRoom:listCodexSessions", cwd, all)
        : ipc.invoke("ccRoom:listSessions", cwd, all),
    );
  const history = (kind: CliKind, cwd: string, sessionId: string, limit: number) =>
    read("ccRoom/history", { kind, cwd, sessionId, limit }, () =>
      kind === "codex"
        ? ipc.invoke("ccRoom:readCodexHistory", cwd, sessionId, limit)
        : ipc.invoke("ccRoom:readHistory", cwd, sessionId, limit),
    );
  return {
    probe: (force?: boolean) => probe("claude-code", force),
    codexProbe: (force?: boolean) => probe("codex", force),
    listSessions: (cwd: string, all?: boolean) => list("claude-code", cwd, all),
    listCodexSessions: (cwd: string, all?: boolean) => list("codex", cwd, all),
    readHistory: (cwd: string, id: string, limit: number) => history("claude-code", cwd, id, limit),
    readCodexHistory: (cwd: string, id: string, limit: number) => history("codex", cwd, id, limit),
  };
}
