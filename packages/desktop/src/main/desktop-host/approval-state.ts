import type { BusinessMethods } from "../../host/composition/business-calls.js";
import type { PendingApprovalOperations } from "../../shared/pending-approvals.js";
import { randomUUID } from "node:crypto";
import { PendingMobileApprovals } from "@cjhyy/code-shell-server/mobile-remote";
import type { ApprovalRequestEnvelope } from "../../preload/types.js";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import type { ParsedWorkerLine } from "../worker-line.js";
import type { DesktopHostMethod } from "./server.js";

interface CallerView {
  epoch: string;
  stateVersion: number;
  lines: string[];
}

/** Pending decisions live for one worker generation. Each bound document gets
 * a revision for just the sessions it can currently see. Journal cursors play
 * no role in restoring approval state. */
export class HostApprovalState {
  private readonly pending: PendingMobileApprovals;
  private callers = new WeakMap<Readonly<DesktopHostIdentity>, CallerView>();

  constructor(
    private readonly visible: (session: string, owner: number) => boolean,
    now = Date.now,
  ) {
    this.pending = new PendingMobileApprovals(now);
  }

  observe({ message, line }: ParsedWorkerLine) {
    const method = (message as { method?: unknown } | null)?.method;
    if (method === "agent/approvalRequest" || method === "agent/approvalResolved")
      this.pending.observeOutboundLine(line);
  }
  forgetSession(id: string) {
    this.pending.forgetSession(id);
  }
  reset(generation: number) {
    this.pending.setWorkerState(generation, false);
    this.callers = new WeakMap();
  }

  /** A paired device, Mimi and the legacy desktop IPC read the same live queue
   * observed by the generation-bound worker port. These are private Main calls. */
  readonly native = {
    "approvals/find": ({ sessionId, requestId }) => this.pending.find(sessionId, requestId),
    "approvals/replay": (input) => {
      if (input.scope === "session") return this.pending.replayLines(input.sessionId);
      if (input.scope === "mimi") return this.pending.replayAllLines();
      if (input.scope === "window" && Number.isSafeInteger(input.owner))
        return this.pending
          .replayAllLines()
          .filter((line) => this.visible(JSON.parse(line).params.sessionId, input.owner));
      throw Error("Invalid approval recipient");
    },
    "approvals/resolve": ({ requestId, owner, ...route }, grant) => {
      grant.assertCurrent();
      if (owner !== undefined) {
        const pending = route.sessionId && this.pending.find(route.sessionId, requestId);
        if (
          !route.sessionId ||
          !this.visible(route.sessionId, owner) ||
          !pending ||
          pending.connectionId !== undefined ||
          pending.generation !== undefined
        )
          throw Error("Approval no longer belongs to the requesting document");
      }
      this.pending.resolve(requestId, route);
    },
    "approvals/forget": ({ sessionId }, grant) => {
      grant.assertCurrent();
      this.forgetSession(sessionId);
    },
  } satisfies Pick<BusinessMethods, keyof PendingApprovalOperations>;

  readonly method: DesktopHostMethod = {
    run: (ctx, params) => {
      const since = params?.since;
      if (
        Object.keys(params ?? {}).some((k) => k !== "since") ||
        (since !== undefined &&
          (!since ||
            typeof since !== "object" ||
            Array.isArray(since) ||
            Object.keys(since).some((k) => k !== "epoch" && k !== "stateVersion") ||
            !("epoch" in since) ||
            typeof since.epoch !== "string" ||
            since.epoch.length > 128 ||
            !("stateVersion" in since) ||
            typeof since.stateVersion !== "number" ||
            !Number.isSafeInteger(since.stateVersion) ||
            since.stateVersion < 0))
      )
        throw new Error("Invalid approval cursor");
      ctx.assertCurrent();
      const lines = this.pending.replayAllLines().filter((line) => {
        const { params } = JSON.parse(line);
        return this.visible(params.sessionId, ctx.identity.webContentsId);
      });
      let view = this.callers.get(ctx.identity);
      if (!view) {
        view = { epoch: randomUUID(), stateVersion: 0, lines };
        this.callers.set(ctx.identity, view);
      } else if (
        view.lines.length !== lines.length ||
        lines.some((line, i) => view!.lines[i] !== line)
      ) {
        view.lines = lines;
        view.stateVersion++;
      }
      const { epoch, stateVersion } = view;
      if (since && since.epoch === epoch && since.stateVersion === stateVersion)
        return { epoch, stateVersion };
      return {
        epoch,
        stateVersion,
        pending: lines.map((line) => JSON.parse(line).params as ApprovalRequestEnvelope),
      };
    },
  };
}
