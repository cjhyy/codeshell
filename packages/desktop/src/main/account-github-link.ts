import { randomUUID } from "node:crypto";
import type { LinkService } from "@cjhyy/code-shell-server/links";
import { createNativeLinkAuthorizationManager } from "./link-authorization-manager.js";
import type {
  NativeLinkAuthorizationInput,
  NativeLinkAuthorizationWindow,
} from "./remote-link-manager.js";

/** Main-only continuation. Neither provider tokens nor claim tickets reach renderer APIs. */
export interface PreparedAccountGitHubLink {
  authorizationUrl: string;
  continue(url: string): Promise<"connected" | "cancelled">;
  cancel(): void;
}
export type PrepareAccountGitHubLink = (
  signal: AbortSignal,
  authorized: () => boolean,
) => Promise<PreparedAccountGitHubLink>;

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("GitHub Link 授权已取消。"));
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("GitHub Link 授权已取消。"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 100);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Lazy, user-scoped Link authority. Account login never imports or adopts provider tokens. */
export function createAccountGitHubLinkPreparer(options: {
  createService(): LinkService;
  open(
    input: NativeLinkAuthorizationInput,
  ): NativeLinkAuthorizationWindow | Promise<NativeLinkAuthorizationWindow>;
}): PrepareAccountGitHubLink {
  let active: symbol | undefined;
  return async (signal, authorized) => {
    const allowed = () => {
      try {
        return !signal.aborted && authorized();
      } catch {
        return false;
      }
    };
    if (!allowed()) throw new Error("GitHub Link 授权已取消。");
    if (active) throw new Error("请先完成或取消当前 GitHub Link 授权。");
    const operation = Symbol();
    active = operation;
    const ownerId = `desktop-account-link:${randomUUID()}`;
    const context = { ownerId, authorize: allowed };
    let service: LinkService | undefined;
    let manager: ReturnType<typeof createNativeLinkAuthorizationManager> | undefined;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      signal.removeEventListener("abort", cancel);
      try {
        manager?.close();
      } catch {
        /* Cleanup failure cannot change an adopted connection or retain the active reservation. */
      } finally {
        try {
          service?.close();
        } catch {
          /* The caller is already cancelled; never turn successful login into cleanup failure. */
        } finally {
          if (active === operation) active = undefined;
        }
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      service = options.createService();
      manager = createNativeLinkAuthorizationManager({ service, open: options.open });
      await service.refreshRemoteCatalog(context);
      const provider = service.snapshot().providers.find((entry) => entry.id === "github");
      const mode = provider?.authModes?.find(
        (entry) => entry.available && entry.kind === "redirect" && entry.methodId === "remote-link",
      );
      if (!mode) throw new Error("此桌面端尚未配置 GitHub Link 连接。");
      const job = await manager.prepare(
        context,
        randomUUID(),
        {
          providerId: "github",
          methodId: mode.methodId,
          label: provider!.displayName,
          expectedRevision: null,
        },
        mode.id,
      );
      if (cancelled || !allowed() || job.state !== "pending" || job.step?.kind !== "redirect")
        throw new Error("GitHub Link 授权已取消。");
      const native = manager;
      let continued = false;
      return {
        authorizationUrl: job.step.authorizationUrl,
        async continue(url) {
          if (cancelled || !allowed()) return "cancelled";
          if (continued) throw new Error("GitHub Link 授权已继续，请等待授权结果。");
          continued = true;
          try {
            let result = await native.resume(context, job.id, url);
            while (result.state === "pending") {
              await wait(signal);
              if (cancelled || !allowed()) return "cancelled";
              result = await native.get(context, job.id);
            }
            if (result.state === "connected") return "connected";
            if (result.state === "cancelled") return "cancelled";
            throw new Error("GitHub Link 授权未完成，请在 Link 设置中重新连接。");
          } catch (error) {
            if (cancelled || !allowed()) return "cancelled";
            throw error;
          } finally {
            cancel();
          }
        },
        cancel,
      };
    } catch (error) {
      cancel();
      throw error;
    }
  };
}
