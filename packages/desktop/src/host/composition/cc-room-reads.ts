import { hostRuntimePath } from "../runtime-path.js";
import { probeClaudeCli, probeCodexCli } from "@cjhyy/code-shell-capability-coding/orchestration";
import {
  businessArguments,
  businessRead,
  textArgument,
} from "../../main/desktop-host/business-read.js";
import { HostRevokedError } from "../../main/desktop-host/authority.js";
import { InvalidParams } from "../../main/desktop-host/server.js";
import { getProjectStore } from "../../main/project-store.js";
import { requireRendererProjectPath } from "../../main/renderer-project-path.js";
import type { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import type { CcRoomReads, CliKind } from "../../shared/cc-room-reads.js";
import { isDesktopSessionId } from "../../shared/disk-session-query.js";

function kind(value: unknown): CliKind {
  if (value !== "claude-code" && value !== "codex") throw new InvalidParams("Invalid CLI kind");
  return value;
}
function flag(value: unknown) {
  if (value !== undefined && typeof value !== "boolean")
    throw new InvalidParams("Invalid CLI option");
  return value === true;
}
async function projectRead<T>(cwd: string, run: (path: string) => Promise<T>, current: () => void) {
  async function scope() {
    const path = await requireRendererProjectPath(cwd).catch(() => {
      throw new HostRevokedError();
    });
    const owner = getProjectStore().resolveExactRootSync(path);
    current();
    return {
      path,
      id: owner?.project.id,
      root: owner?.mainRoot.id,
      revision: owner?.project.revision,
    };
  }
  const first = await scope();
  const value = await run(first.path);
  const last = await scope();
  if (
    first.path !== last.path ||
    first.id !== last.id ||
    first.root !== last.root ||
    first.revision !== last.revision
  )
    throw new HostRevokedError();
  return value;
}
export function ccRoomReads(
  history: Pick<ActivityHistoryWorker, "externalSessions" | "externalHistory">,
) {
  async function probe(input: unknown, current: () => void) {
    await hostRuntimePath.ready;
    current();
    const p = businessArguments(input, ["kind", "force"]);
    return (kind(p.kind) === "codex" ? probeCodexCli : probeClaudeCli)(flag(p.force));
  }
  function sessions(input: unknown, current: () => void) {
    const p = businessArguments(input, ["kind", "cwd", "all"]);
    const cli = kind(p.kind),
      all = flag(p.all);
    return projectRead(
      textArgument(p.cwd),
      (cwd) => history.externalSessions({ cwd, kind: cli, all }),
      current,
    );
  }
  function read(input: unknown, current: () => void) {
    const p = businessArguments(input, ["kind", "cwd", "sessionId", "limit", "before"]);
    const cli = kind(p.kind);
    const { sessionId, limit, before } = p;
    if (
      !isDesktopSessionId(sessionId) ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (before !== undefined &&
        (typeof before !== "number" || !Number.isSafeInteger(before) || before < 0))
    )
      throw new InvalidParams("Invalid CLI history request");
    return projectRead(
      textArgument(p.cwd),
      (cwd) => history.externalHistory({ cwd, kind: cli, sessionId, limit, before }),
      current,
    );
  }
  // Both transports use the same validators and check their live grant after I/O.
  function checked<K extends keyof CcRoomReads>(
    method: K,
    run: (input: unknown, current: () => void) => Promise<CcRoomReads[K]["result"]>,
  ) {
    return businessRead(
      method,
      (input) => input as CcRoomReads[K]["params"],
      (p, ctx) => run(p, () => ctx.assertCurrent()),
    );
  }
  return {
    read(signal: AbortSignal): import("../../shared/cc-room-reads.js").ReadCcRoom {
      const operations = {
        "ccRoom/probe": probe,
        "ccRoom/sessions": sessions,
        "ccRoom/history": read,
      };
      return async <K extends keyof CcRoomReads>(method: K, input: CcRoomReads[K]["params"]) => {
        const result = await operations[method](input, () => signal.throwIfAborted());
        signal.throwIfAborted();
        return result as CcRoomReads[K]["result"];
      };
    },
    methods: [
      checked("ccRoom/probe", probe),
      checked("ccRoom/sessions", sessions),
      checked("ccRoom/history", read),
    ],
    native: {
      "ccRoom/probe": (p, grant) => probe(p, grant.assertCurrent),
      "ccRoom/sessions": (p, grant) => sessions(p, () => grant.signal.throwIfAborted()),
      "ccRoom/history": (p, grant) => read(p, () => grant.signal.throwIfAborted()),
    } satisfies Pick<import("./business-calls.js").BusinessMethods, keyof CcRoomReads>,
  };
}
