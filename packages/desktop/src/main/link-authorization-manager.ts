import type {
  LinkAuthorization,
  LinkAuthorizationResponse,
  LinkConnectionInput,
  LinkOperationContext,
  LinkService,
} from "@cjhyy/code-shell-server/links";
import type {
  NativeLinkAuthorizationInput,
  NativeLinkAuthorizationWindow,
} from "./remote-link-manager.js";

interface Flow {
  ownerId: string;
  requestId: string;
  jobId?: string;
  cancelled: boolean;
  finished: boolean;
  completing: boolean;
  window?: NativeLinkAuthorizationWindow;
  timer?: ReturnType<typeof setTimeout>;
}

/** Native platform adapter. Authorization state and persistence remain in the shared Host service. */
export function createNativeLinkAuthorizationManager(options: {
  service: LinkService;
  open: (input: NativeLinkAuthorizationInput) => NativeLinkAuthorizationWindow;
}) {
  const service = options.service;
  const flows = new Map<string, Flow>();
  const cancelled = new Map<string, { ownerId: string; expiresAt: number }>();
  let closed = false;
  const validId = (id: string) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
  const find = (id: string) =>
    flows.get(id) ?? [...flows.values()].find((flow) => flow.jobId === id);
  function finish(flow: Flow) {
    if (flow.finished) return;
    flow.finished = true;
    flows.delete(flow.requestId);
    clearTimeout(flow.timer);
    flow.window?.close();
  }
  function cancelFlow(context: LinkOperationContext, flow: Flow) {
    flow.cancelled = true;
    if (flow.jobId) void service.cancelAuthorization(context, flow.jobId).catch(() => {});
    finish(flow);
  }
  return {
    async start(
      context: LinkOperationContext,
      requestId: string,
      input: LinkConnectionInput,
      authModeId: string,
    ): Promise<LinkAuthorization> {
      if (!validId(requestId)) throw new Error("授权请求标识无效。");
      await service.assertAuthorized(context);
      if (closed) throw new Error("授权窗口已关闭。");
      for (const [id, value] of cancelled) if (value.expiresAt <= Date.now()) cancelled.delete(id);
      if (cancelled.get(requestId)?.ownerId === context.ownerId)
        return {
          id: requestId,
          providerId: input.providerId,
          methodId: input.methodId,
          authModeId,
          state: "cancelled",
        };
      if (
        flows.has(requestId) ||
        [...flows.values()].some((flow) => flow.ownerId === context.ownerId)
      )
        throw new Error("请先完成或取消当前授权。");
      const flow: Flow = {
        requestId,
        ownerId: context.ownerId,
        cancelled: false,
        finished: false,
        completing: false,
      };
      flows.set(requestId, flow);
      const guarded = {
        ownerId: context.ownerId,
        authorize: () => !closed && !flow.cancelled && context.authorize(),
      };
      try {
        const job = await service.startAuthorization(guarded, input, authModeId);
        flow.jobId = job.id;
        if (flow.cancelled || flow.finished || closed) {
          await service.cancelAuthorization(context, job.id).catch(() => {});
          return {
            ...job,
            state: "cancelled",
            step: undefined,
            prompt: undefined,
            redirect: undefined,
          };
        }
        if (job.step?.kind === "redirect") {
          const authorization = new URL(job.step.authorizationUrl);
          flow.window = options.open({
            authorizationUrl: authorization.href,
            redirectUri: authorization.searchParams.get("redirect_uri")!,
            providerName: service
              .snapshot()
              .providers.find((provider) => provider.id === job.providerId)?.displayName,
            onCancel: () => {
              if (!flow.finished) cancelFlow(context, flow);
            },
            onCallback: (url) => {
              if (flow.finished || flow.completing) return;
              flow.completing = true;
              void service
                .completeRemoteAuth(guarded, job.id, url)
                .catch(() => {})
                .finally(() => finish(flow));
            },
          });
          if (flow.finished) flow.window.close();
        }
        if (job.expiresAt) {
          flow.timer = setTimeout(
            () => {
              void service
                .authorization(context, job.id)
                .catch(() => {})
                .finally(() => finish(flow));
            },
            Math.max(1, Date.parse(job.expiresAt) - Date.now()),
          );
          flow.timer.unref?.();
        }
        return job;
      } catch (error) {
        cancelFlow(context, flow);
        throw error;
      }
    },
    async get(context: LinkOperationContext, id: string) {
      const result = await service.authorization(context, id);
      const flow = find(id);
      if (flow?.ownerId === context.ownerId && result.state !== "pending") finish(flow);
      return result;
    },
    async respond(context: LinkOperationContext, id: string, response: LinkAuthorizationResponse) {
      const result = await service.respondAuthorization(context, id, response);
      const flow = find(id);
      if (flow?.ownerId === context.ownerId && result.state !== "pending") finish(flow);
      return result;
    },
    async cancel(context: LinkOperationContext, id: string) {
      await service.assertAuthorized(context);
      if (!validId(id)) throw new Error("授权请求标识无效。");
      const flow = find(id);
      if (flow) {
        if (flow.ownerId !== context.ownerId) throw new Error("找不到这个授权任务。");
        flow.cancelled = true;
        if (flow.jobId) await service.cancelAuthorization(context, flow.jobId);
        finish(flow);
      } else {
        try {
          await service.cancelAuthorization(context, id);
        } catch (error) {
          if ((error as { code?: string }).code !== "not_found") throw error;
        }
        if (cancelled.size >= 64) cancelled.delete(cancelled.keys().next().value!);
        cancelled.set(id, { ownerId: context.ownerId, expiresAt: Date.now() + 600_000 });
      }
    },
    async open(context: LinkOperationContext, id: string) {
      await service.assertAuthorized(context);
      const flow = find(id);
      if (!flow || flow.ownerId !== context.ownerId || flow.finished || !flow.window) return false;
      flow.window.focus?.();
      return true;
    },
    cancelOwner(ownerId: string) {
      for (const flow of [...flows.values()])
        if (flow.ownerId === ownerId) {
          flow.cancelled = true;
          finish(flow);
        }
    },
    close() {
      closed = true;
      cancelled.clear();
      for (const flow of [...flows.values()]) {
        flow.cancelled = true;
        finish(flow);
      }
    },
  };
}
