import {
  app,
  BrowserWindow,
  shell,
  type IpcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import {
  createLinkService,
  type LinkConnectionInput,
  type LinkAuthorizationResponse,
  type LinkAuthorizationDiagnosticSink,
  type LinkAuthorization,
  type LinkOperationContext,
  type HostLinkOAuthAdapter,
} from "@cjhyy/code-shell-server/links";
import { createNativeRemoteLinkManager } from "./remote-link-manager.js";
import { openNativeLinkAuthorization } from "./remote-link-window.js";
import { desktopRemoteLinkConfiguration } from "./desktop-remote-link-configuration.js";
import { createAccountGitHubLinkPreparer } from "./account-github-link.js";
import { dlog } from "./desktop-logger.js";
import {
  requireLinkAccountAccess,
  type CaptureLinkAccountAccess,
  type LinkAccountAccessLease,
} from "./link-account-access.js";

const logAuthorizationDiagnostic: LinkAuthorizationDiagnosticSink = (diagnostic) =>
  dlog("main", "link.authorization", { ...diagnostic });

/** Window-owned authorization managers retire on navigation and destruction. */
export function registerRemoteLinkIpc(deps: {
  ipcMain: Pick<IpcMain, "handle">;
  requireRendererProjectPath: (cwd: string) => Promise<string>;
  isMainWindow: (contents: WebContents) => boolean;
  withMutation: <T>(cwd: string, write: () => Promise<T>) => Promise<T>;
  onChanged: () => void;
  hostOAuthAdapters?: () => readonly HostLinkOAuthAdapter[];
  captureAccount?: CaptureLinkAccountAccess;
}) {
  const { ipcMain, requireRendererProjectPath } = deps;
  const accountAvailable = () => {
    try {
      requireLinkAccountAccess(deps.captureAccount);
      return true;
    } catch {
      return false;
    }
  };
  const prepareGitHubLink = createAccountGitHubLinkPreparer({
    createService: () =>
      createLinkService({
        onAuthorizationDiagnostic: logAuthorizationDiagnostic,
        remoteLink: () => desktopRemoteLinkConfiguration(process.env, app.isPackaged),
        reuseRemoteConnection: true,
        withMutation: (write) => deps.withMutation("", write),
        onChanged: deps.onChanged,
      }),
    open: openNativeLinkAuthorization,
  });
  const nativeLinkOwners = new WeakMap<
    Electron.WebContents,
    {
      id: string;
      managers: Map<string, ReturnType<typeof createNativeRemoteLinkManager>>;
    }
  >();
  type Manager = ReturnType<typeof createNativeRemoteLinkManager>;
  interface RemoteAuthorizationAccess {
    requestId: string;
    jobId?: string;
    lease: LinkAccountAccessLease;
    detach(): void;
    dispose(): void;
  }
  const remoteAccess = new WeakMap<Manager, Set<RemoteAuthorizationAccess>>();
  const withAccount = (
    context: LinkOperationContext,
    lease: LinkAccountAccessLease,
  ): LinkOperationContext => ({
    ownerId: context.ownerId,
    signal: context.signal ? AbortSignal.any([context.signal, lease.signal]) : lease.signal,
    authorize: async () => {
      lease.signal.throwIfAborted();
      lease.current();
      if (!(await context.authorize())) return false;
      lease.current();
      return true;
    },
  });
  function trackRemoteAuthorization(
    manager: Manager,
    context: LinkOperationContext,
    requestId: string,
    legacy = false,
  ) {
    const lease = requireLinkAccountAccess(deps.captureAccount);
    const entries = remoteAccess.get(manager) ?? new Set<RemoteAuthorizationAccess>();
    remoteAccess.set(manager, entries);
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      // Cleanup uses the window authority, so account logout cannot prevent cancellation.
      if (legacy) manager.cancel(context, requestId);
      else void manager.authorization.cancel(context, requestId).catch(() => {});
      entry.detach();
    };
    const entry: RemoteAuthorizationAccess = {
      requestId,
      lease,
      detach: () => lease.signal.removeEventListener("abort", onAbort),
      dispose: () => {
        entry.detach();
        clearTimeout(timer);
        entries.delete(entry);
      },
    };
    entries.add(entry);
    lease.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(entry.dispose, 20 * 60_000);
    timer.unref?.();
    return {
      context: withAccount(context, lease),
      bind(job: LinkAuthorization) {
        entry.jobId = job.id;
        if (job.state !== "pending") entry.detach();
        const expires = Date.parse(job.expiresAt ?? job.redirect?.expiresAt ?? "");
        if (Number.isFinite(expires)) {
          clearTimeout(timer);
          timer = setTimeout(entry.dispose, Math.max(1, expires + 5 * 60_000 - Date.now()));
          timer.unref?.();
        }
        return job;
      },
      dispose: entry.dispose,
    };
  }
  function authorizationContext(manager: Manager, context: LinkOperationContext, id: string) {
    const entry = [...(remoteAccess.get(manager) ?? [])].find(
      (candidate) => candidate.jobId === id || candidate.requestId === id,
    );
    return entry ? withAccount(context, entry.lease) : context;
  }
  function settleAuthorization(manager: Manager, job: LinkAuthorization) {
    if (job.state === "pending") return;
    for (const entry of remoteAccess.get(manager) ?? []) if (entry.jobId === job.id) entry.detach();
  }
  async function nativeLinkContext(event: IpcMainInvokeEvent, rawCwd: string) {
    const allowed = () =>
      !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame &&
      deps.isMainWindow(event.sender);
    if (!allowed() || typeof rawCwd !== "string") throw new Error("Link 操作需要来自桌面主窗口。");
    const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
    if (!allowed()) throw new Error("Link 操作所属窗口已关闭或刷新。");
    let owner = nativeLinkOwners.get(event.sender);
    if (!owner) {
      owner = { id: `desktop-link:${randomUUID()}`, managers: new Map() };
      nativeLinkOwners.set(event.sender, owner);
      const close = () => {
        for (const manager of owner!.managers.values()) {
          for (const entry of remoteAccess.get(manager) ?? []) entry.dispose();
          remoteAccess.delete(manager);
          manager.close();
        }
        owner!.managers.clear();
        if (nativeLinkOwners.get(event.sender) === owner) nativeLinkOwners.delete(event.sender);
        event.sender.removeListener("did-start-navigation", navigate);
        event.sender.removeListener("destroyed", close);
      };
      const navigate = (
        _event: Electron.Event,
        _url: string,
        _inPlace: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame) close();
      };
      event.sender.on("did-start-navigation", navigate);
      event.sender.once("destroyed", close);
    }
    let manager = owner.managers.get(cwd);
    if (!manager) {
      if (owner.managers.size >= 64) throw new Error("打开的 Link 工作区过多，请重新打开窗口。");
      manager = createNativeRemoteLinkManager({
        service: createLinkService({
          onAuthorizationDiagnostic: logAuthorizationDiagnostic,
          cwd: cwd || undefined,
          remoteLink: () =>
            accountAvailable()
              ? desktopRemoteLinkConfiguration(process.env, app.isPackaged)
              : undefined,
          withMutation: (write) => deps.withMutation(cwd, write),
          onChanged: deps.onChanged,
          allowCliLogin: true,
          hostOAuthAdapters: deps.hostOAuthAdapters?.(),
        }),
        open: openNativeLinkAuthorization,
        onConnected: () => {
          if (!allowed() || nativeLinkOwners.get(event.sender) !== owner) return;
          const window = BrowserWindow.fromWebContents(event.sender);
          if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          }
        },
      });
      owner.managers.set(cwd, manager);
    }
    const context = {
      ownerId: owner.id,
      authorize: async () => {
        if (!allowed() || nativeLinkOwners.get(event.sender) !== owner) return false;
        if (cwd && (await requireRendererProjectPath(cwd)) !== cwd) return false;
        return allowed() && nativeLinkOwners.get(event.sender) === owner;
      },
    };
    return { manager, context };
  }
  ipcMain.handle("links:remoteSnapshot", async (event, cwd: string, forceCatalog?: boolean) => {
    if (forceCatalog !== undefined && typeof forceCatalog !== "boolean")
      throw new Error("Link 目录刷新参数无效。");
    const { manager, context } = await nativeLinkContext(event, cwd);
    await manager.service.assertAuthorized(context);
    if (accountAvailable())
      await manager.service.refreshRemoteCatalog(context, forceCatalog === true);
    await manager.service.assertAuthorized(context);
    return manager.service.snapshot();
  });
  ipcMain.handle(
    "links:authorizationStart",
    async (
      event,
      cwd: string,
      requestId: string,
      input: LinkConnectionInput,
      authModeId: string,
    ) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      const remote =
        authModeId === "remote-link" || input?.methodId === "remote-link"
          ? trackRemoteAuthorization(manager, context, requestId)
          : undefined;
      let result: LinkAuthorization;
      try {
        result = await manager.authorization.start(
          remote?.context ?? context,
          requestId,
          input,
          authModeId,
        );
        remote?.bind(result);
      } catch (error) {
        remote?.dispose();
        throw error;
      }
      if (result.step?.kind === "device-code") {
        const url = new URL(result.step.verificationUriComplete ?? result.step.verificationUri);
        if (url.protocol === "https:" && !url.username && !url.password)
          void shell.openExternal(url.href).catch(() => {});
      }
      return result;
    },
  );
  ipcMain.handle("links:authorizationGet", async (event, cwd: string, id: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    const result = await manager.authorization.get(authorizationContext(manager, context, id), id);
    settleAuthorization(manager, result);
    return result;
  });
  ipcMain.handle(
    "links:authorizationRespond",
    async (event, cwd: string, id: string, response: LinkAuthorizationResponse) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      const result = await manager.authorization.respond(
        authorizationContext(manager, context, id),
        id,
        response,
      );
      settleAuthorization(manager, result);
      return result;
    },
  );
  ipcMain.handle("links:authorizationCancel", async (event, cwd: string, id: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    return manager.authorization.cancel(context, id);
  });
  ipcMain.handle("links:authorizationOpen", async (event, cwd: string, id: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    return manager.authorization.open(authorizationContext(manager, context, id), id);
  });
  ipcMain.handle(
    "links:remoteStart",
    async (event, cwd: string, requestId: string, input: LinkConnectionInput) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      const remote = trackRemoteAuthorization(manager, context, requestId, true);
      try {
        return remote.bind(await manager.start(remote.context, requestId, input));
      } catch (error) {
        remote.dispose();
        throw error;
      }
    },
  );
  ipcMain.handle("links:remoteCancel", async (event, cwd: string, requestId: string) => {
    const { manager, context } = await nativeLinkContext(event, cwd);
    return manager.cancel(context, requestId);
  });
  ipcMain.handle(
    "links:remoteRename",
    async (event, cwd: string, id: string, label: string, revision: string) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      return manager.service.rename(context, id, label, revision);
    },
  );
  ipcMain.handle(
    "links:remoteDisconnect",
    async (event, cwd: string, id: string, revision: string) => {
      const { manager, context } = await nativeLinkContext(event, cwd);
      return manager.service.disconnect(context, id, revision);
    },
  );
  return {
    prepareGitHubLink,
    /** Reuse the window's Link revisions without fetching a remote catalog or file content. */
    async storedSnapshot(event: IpcMainInvokeEvent, cwd: string) {
      const { manager, context } = await nativeLinkContext(event, cwd);
      await manager.service.assertAuthorized(context);
      return () => manager.service.snapshot();
    },
  };
}
