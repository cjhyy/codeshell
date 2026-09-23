import type {
  LinkAuthorization,
  LinkConnectionInput,
  LinkOperationContext,
  LinkService,
} from "@cjhyy/code-shell-server/links";

export interface NativeLinkAuthorizationWindow {
  close(): void;
}
export interface NativeLinkAuthorizationInput {
  authorizationUrl: string;
  redirectUri: string;
  onCallback: (url: string) => void;
  onCancel: () => void;
}

/** One native owner can authorize at a time; only the shared service can exchange and save. */
export function createNativeRemoteLinkManager(options: {
  service: LinkService;
  open: (input: NativeLinkAuthorizationInput) => NativeLinkAuthorizationWindow;
}) {
  const flows = new Map<
    string,
    {
      ownerId: string;
      cancel: () => void;
    }
  >();
  const cancelledRequests = new Map<string, { ownerId: string; expiresAt: number }>();
  const service = options.service;
  return {
    service,
    async start(
      context: LinkOperationContext,
      requestId: string,
      input: LinkConnectionInput,
    ): Promise<LinkAuthorization> {
      if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("授权请求标识无效。");
      await service.assertAuthorized(context);
      for (const [id, request] of cancelledRequests)
        if (request.expiresAt <= Date.now()) cancelledRequests.delete(id);
      if (cancelledRequests.get(requestId)?.ownerId === context.ownerId)
        return { id: "", providerId: "github", state: "cancelled" };
      if (
        flows.has(requestId) ||
        [...flows.values()].some((flow) => flow.ownerId === context.ownerId)
      )
        throw new Error("请先完成或取消当前授权。");
      return new Promise<LinkAuthorization>((resolve, reject) => {
        let cancelled = false,
          settled = false,
          completing = false;
        let job: LinkAuthorization | undefined;
        let window: NativeLinkAuthorizationWindow | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          settled = true;
          flows.delete(requestId);
          clearTimeout(timer);
          window?.close();
        };
        const fail = (error: unknown) => {
          if (settled) return;
          if (job) void service.cancelAuthorization(context, job.id).catch(() => {});
          cleanup();
          reject(error);
        };
        const cancel = () => {
          if (settled) return;
          cancelled = true;
          if (job) void service.cancelAuthorization(context, job.id).catch(() => {});
          cleanup();
          resolve({ id: job?.id ?? "", providerId: "github", state: "cancelled" });
        };
        flows.set(requestId, { ownerId: context.ownerId, cancel });
        const guarded = {
          ownerId: context.ownerId,
          authorize: () => !cancelled && !settled && context.authorize(),
        };
        void (async () => {
          job = await service.startRemoteAuth(guarded, input);
          if (cancelled || settled) {
            await service.cancelAuthorization(context, job.id).catch(() => {});
            return;
          }
          const authorization = new URL(job.redirect!.authorizationUrl);
          timer = setTimeout(cancel, Math.max(0, Date.parse(job.redirect!.expiresAt) - Date.now()));
          timer.unref?.();
          window = options.open({
            authorizationUrl: authorization.href,
            redirectUri: authorization.searchParams.get("redirect_uri")!,
            onCancel: cancel,
            onCallback: (callbackUrl) => {
              if (settled || completing) return;
              if (new URL(callbackUrl).searchParams.has("error")) return cancel();
              completing = true;
              void service.completeRemoteAuth(guarded, job!.id, callbackUrl).then((result) => {
                if (settled) return;
                cleanup();
                resolve(result);
              }, fail);
            },
          });
          if (settled) window.close();
        })().catch(fail);
      });
    },
    cancel(context: LinkOperationContext, requestId: string) {
      const flow = flows.get(requestId);
      if (!flow && /^[a-f0-9-]{36}$/.test(requestId)) {
        if (cancelledRequests.size >= 64)
          cancelledRequests.delete(cancelledRequests.keys().next().value!);
        cancelledRequests.set(requestId, {
          ownerId: context.ownerId,
          expiresAt: Date.now() + 600_000,
        });
        return true;
      }
      if (flow?.ownerId !== context.ownerId) return false;
      flow.cancel();
      return true;
    },
    cancelOwner(ownerId: string) {
      service.cancelOwner(ownerId);
      for (const flow of [...flows.values()]) if (flow.ownerId === ownerId) flow.cancel();
    },
    close() {
      service.close();
      cancelledRequests.clear();
      for (const flow of [...flows.values()]) flow.cancel();
    },
  };
}
