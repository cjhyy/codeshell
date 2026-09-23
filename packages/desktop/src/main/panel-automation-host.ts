import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import {
  panelAutomationCreationKey,
  parsePanelAutomationCall,
  type PanelAutomationHost,
} from "@cjhyy/code-shell-server/panels";
import {
  resolveAutomationCreateAuthority,
  type AutomationAuthorityDeps,
} from "./automation-authority.js";
import { automationSummary, requireAutomationScheduler } from "./automation-service.js";
import { assertDesktopSessionId } from "./session-validation.js";

/** Paired Web borrows main's live scheduler; no page owns execution or timers. */
export function createDesktopPanelAutomationHost(
  authorityDeps: () => AutomationAuthorityDeps,
  scheduler = requireAutomationScheduler,
): PanelAutomationHost {
  return {
    async call(scope, method, params) {
      const operation = parsePanelAutomationCall(method, params);
      assertDesktopSessionId(scope.sessionId);
      if (!(await scope.isAuthorized())) throw Error("Panel automation authorization expired");
      // Never trust the sessionId supplied to HTTP prepare. Check it against
      // the transport's authorized workspace and current durable Session root.
      const authority = await resolveAutomationCreateAuthority(
        { resumeSessionId: scope.sessionId, cwd: scope.cwd },
        authorityDeps(),
      );
      if (!(await scope.isAuthorized())) throw Error("Panel automation authorization expired");
      const s = scheduler();
      s.loadJobs();
      const owns = (job: ReturnType<typeof s.list>[number]) =>
        job.resumeSessionId === scope.sessionId &&
        (job.projectId ?? null) === (authority.projectId ?? null) &&
        (job.rootId ?? null) === (authority.rootId ?? null) &&
        canonicalKey(job.cwd ?? "") === canonicalKey(authority.cwd ?? "");
      if (operation.action === "list")
        return { automations: s.list().filter(owns).map(automationSummary) };
      if (operation.action === "create") {
        return automationSummary(
          s.create(operation.input.name, operation.input.schedule, operation.input.prompt, {
            ...authority,
            projectId: authority.projectId ?? undefined,
            rootId: authority.rootId ?? undefined,
            timezone: operation.input.timezone,
            permissionLevel: "full",
            resumeSessionId: scope.sessionId,
            ...(operation.key
              ? {
                  creationKey: panelAutomationCreationKey(
                    scope.appId,
                    scope.cwd,
                    scope.sessionId,
                    operation.key,
                  ),
                }
              : {}),
          }),
        );
      }
      const job = s.get(operation.id);
      if (!job || !owns(job)) throw Error("Panel automation is not available in this project task");
      const assertCurrent = (current: Readonly<typeof job>) => {
        if (!owns(current)) throw Error("Panel automation binding changed; reload before retrying");
      };
      // No asynchronous gap between this final ownership check and mutation.
      if (operation.action === "update") {
        const updated = s.update(job.id, operation.patch, assertCurrent);
        return updated ? automationSummary(updated) : null;
      }
      return { ok: s[operation.action](job.id, assertCurrent) };
    },
  };
}
