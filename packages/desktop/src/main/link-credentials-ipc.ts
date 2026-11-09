import { linkConnectionMetadata } from "@cjhyy/code-shell-link";
import { registerRemoteLinkIpc } from "./remote-link-ipc.js";
import type { CaptureLinkAccountAccess } from "./link-account-access.js";
import { createFigmaMcpLinkAdapter } from "./figma-mcp-link.js";
import { BrowserWindow, clipboard, ipcMain, shell } from "electron";
import {
  CredentialStore,
  isRemoteLinkCredential,
  type Credential,
  type CredentialScope,
  getCliLinkStatus,
  isCliLinkProvider,
  type CliLinkProviderId,
} from "@cjhyy/code-shell-core";
import { AgentBridge } from "./agent-bridge.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { McpOAuthService, type McpOAuthLoginInput } from "./mcp-oauth-service.js";
import { listDesktopLinkProviders } from "./link-provider-catalog.js";
import { createDesktopLinkConnections } from "./link-connections.js";
import {
  isLocalBrowserLinkProvider,
  LinkDeviceOAuthBroker,
  type LocalBrowserAuthToken,
} from "./link-device-oauth.js";
import {
  installManagedLinkCli,
  managedCliInstallStatus,
  type ManagedCliInstallResult,
} from "./link-cli-installer.js";
import { migrateCredentialStore } from "./credential-migration.js";
import { cookieCredentialAutoRefresh } from "./cookie-credential-auto-refresh.js";

export interface LinkCredentialIpcDeps {
  mainWindows: Set<BrowserWindow>;
  bridge: () => AgentBridge | null;
  linkDeviceOAuthBroker: LinkDeviceOAuthBroker;
  managedCliInstallJobs: Map<string, Promise<ManagedCliInstallResult>>;
  getMcpOAuthService: () => McpOAuthService;
  normalizeMcpOAuthLoginInput: (raw: unknown) => McpOAuthLoginInput;
  captureLinkAccount: CaptureLinkAccountAccess;
}

/** Credential listing/mutation, local/CLI/browser Link connections and MCP OAuth routes. */
export function registerLinkCredentialIpc(deps: LinkCredentialIpcDeps) {
  const {
    mainWindows,
    linkDeviceOAuthBroker,
    managedCliInstallJobs,
    getMcpOAuthService,
    normalizeMcpOAuthLoginInput,
    captureLinkAccount,
  } = deps;
  ipcMain.handle("credentials:list", async (_e, cwd: string) => {
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
    await migrateCredentialStore(authorizedCwd || undefined);
    const store = new CredentialStore(authorizedCwd || undefined);
    const projectIds = new Set(store.list("project").map((credential) => credential.id));
    return store.listMasked().map((credential) => ({
      ...credential,
      meta: credential.meta ? linkConnectionMetadata(credential.meta) : undefined,
      storeScope: projectIds.has(credential.id) ? "project" : "user",
    }));
  });
  ipcMain.handle(
    "credentials:save",
    async (_e, cwd: string, scope: CredentialScope, cred: Credential) => {
      const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
      assertGenericCredentialMutation(authorizedCwd, cred.id);
      if (isRemoteLinkCredential(cred)) throw new Error("远程 Link 连接必须通过授权创建。");
      if (cred.meta?.recordSchemaVersion === 2) {
        const {
          linkExecutionRuntime: _runtime,
          linkExecutionBackend: _backend,
          linkAuthSource: _source,
          ...meta
        } = cred.meta;
        cred = { ...cred, meta };
      }
      new CredentialStore(authorizedCwd || undefined).save(scope, cred);
      cookieCredentialAutoRefresh.detachForCredential(authorizedCwd || undefined, cred.id, scope);
      deps.bridge()?.pushCredentialSnapshot(authorizedCwd || undefined);
    },
  );
  ipcMain.handle(
    "credentials:remove",
    async (_e, cwd: string, scope: CredentialScope, id: string) => {
      const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
      assertGenericCredentialMutation(authorizedCwd, id);
      new CredentialStore(authorizedCwd || undefined).remove(scope, id);
      cookieCredentialAutoRefresh.detachForCredential(authorizedCwd || undefined, id, scope);
      deps.bridge()?.pushCredentialSnapshot(authorizedCwd || undefined);
    },
  );
  ipcMain.handle("links:listLocalProviders", () => listDesktopLinkProviders());

  const remoteLinkIpc = registerRemoteLinkIpc({
    ipcMain,
    requireRendererProjectPath,
    isMainWindow: (sender) =>
      [...mainWindows].some((win) => !win.isDestroyed() && win.webContents === sender),
    withMutation: (cwd, write) => {
      const bridge = deps.bridge();
      return bridge ? bridge.withWebConfigurationMutation(cwd, write) : write();
    },
    onChanged: () => deps.bridge()?.notifyWebConfigurationChanged(),
    captureAccount: captureLinkAccount,
    hostOAuthAdapters: () => [
      createFigmaMcpLinkAdapter({
        oauth: getMcpOAuthService(),
        openExternal: (url) => shell.openExternal(url),
      }),
    ],
  });

  function assertGenericCredentialMutation(cwd: string, id: string) {
    const credential = new CredentialStore(cwd || undefined).resolve(id);
    if (credential && isRemoteLinkCredential(credential))
      throw new Error("请在 Link 页的独立服务连接中管理或断开此连接，以同步撤销远端授权。");
  }

  async function persistLocalLinkCredential(input: {
    cwd: string;
    providerId: string;
    methodId: string;
    label: string;
    token: string;
    browserOAuthToken?: LocalBrowserAuthToken;
    existingId: string;
    authSource: "manual-token" | "browser-oauth";
  }) {
    const connections = createDesktopLinkConnections({
      cwd: input.cwd || undefined,
      onChanged: () => deps.bridge()?.notifyWebConfigurationChanged(),
    });
    try {
      return await connections.connectLocal(input);
    } finally {
      connections.close();
    }
  }

  async function persistCliLinkCredential(input: {
    cwd: string;
    providerId: CliLinkProviderId;
    methodId: string;
    label: string;
    existingId: string;
    loginIfNeeded: boolean;
  }) {
    const connections = createDesktopLinkConnections({
      cwd: input.cwd || undefined,
      onChanged: () => deps.bridge()?.notifyWebConfigurationChanged(),
    });
    try {
      return await connections.connectCli(input);
    } finally {
      connections.close();
    }
  }

  ipcMain.handle("links:cliStatus", async (_e, rawProviderId: unknown, rawCwd: unknown) => {
    const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
    const cwd =
      typeof rawCwd === "string" && rawCwd ? await requireRendererProjectPath(rawCwd) : undefined;
    if (!isCliLinkProvider(providerId)) throw new Error("Unsupported CLI Link provider");
    return getCliLinkStatus(providerId, { cwd });
  });

  ipcMain.handle("links:cliInstallStatus", (_e, rawProviderId: unknown) => {
    const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
    return managedCliInstallStatus(providerId);
  });

  ipcMain.handle("links:installCli", async (_e, rawProviderId: unknown) => {
    const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
    if (!isCliLinkProvider(providerId)) throw new Error("Unsupported CLI Link provider");
    const current = managedCliInstallJobs.get(providerId);
    if (current) return current;
    const job = installManagedLinkCli(providerId).finally(() => {
      managedCliInstallJobs.delete(providerId);
    });
    managedCliInstallJobs.set(providerId, job);
    return job;
  });

  ipcMain.handle("links:browserAuthStatus", (_e, rawProviderId: unknown) => {
    const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
    if (!isLocalBrowserLinkProvider(providerId)) {
      throw new Error("Unsupported browser-login Link provider");
    }
    return linkDeviceOAuthBroker.status(providerId);
  });

  ipcMain.handle("links:startBrowserAuth", async (_e, rawProviderId: unknown) => {
    const providerId = typeof rawProviderId === "string" ? rawProviderId.trim() : "";
    if (!isLocalBrowserLinkProvider(providerId)) {
      throw new Error("Unsupported browser-login Link provider");
    }
    const prompt = await linkDeviceOAuthBroker.start(providerId);
    clipboard.writeText(prompt.userCode);
    try {
      await shell.openExternal(prompt.verificationUriComplete ?? prompt.verificationUri);
    } catch (error) {
      linkDeviceOAuthBroker.cancel(prompt.attemptId);
      throw new Error("Could not open the provider authorization page", { cause: error });
    }
    return { ...prompt, codeCopied: true };
  });

  ipcMain.handle("links:completeBrowserAuth", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("links:completeBrowserAuth requires a connection request");
    }
    const input = raw as Record<string, unknown>;
    const attemptId = typeof input.attemptId === "string" ? input.attemptId.trim() : "";
    const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
    const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
    const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
    const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
    if (!attemptId || !isLocalBrowserLinkProvider(providerId)) {
      throw new Error("Invalid browser-login Link attempt");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) {
      throw new Error("Invalid local Link connection method");
    }
    if (label.length > 200) throw new Error("Connection label is too long");
    const token = await linkDeviceOAuthBroker.complete(attemptId);
    if (token.providerId !== providerId) {
      throw new Error("Browser-login provider does not match the connection request");
    }
    return persistLocalLinkCredential({
      cwd,
      providerId,
      methodId,
      label,
      token: token.accessToken,
      browserOAuthToken: token,
      existingId,
      authSource: "browser-oauth",
    });
  });

  ipcMain.handle("links:cancelBrowserAuth", (_e, rawAttemptId: unknown) => {
    const attemptId = typeof rawAttemptId === "string" ? rawAttemptId.trim() : "";
    return attemptId ? linkDeviceOAuthBroker.cancel(attemptId) : false;
  });

  ipcMain.handle("links:connectCli", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("links:connectCli requires a connection request");
    }
    const input = raw as Record<string, unknown>;
    const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
    const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
    const rawProviderId = typeof input.providerId === "string" ? input.providerId.trim() : "";
    const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
    const loginIfNeeded = input.loginIfNeeded === true;
    if (!isCliLinkProvider(rawProviderId)) throw new Error("Unsupported CLI Link provider");
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) throw new Error("Invalid Link method");
    if (label.length > 200) throw new Error("Connection label is too long");

    return persistCliLinkCredential({
      cwd,
      providerId: rawProviderId,
      methodId,
      label,
      existingId,
      loginIfNeeded,
    });
  });

  ipcMain.handle("links:connectLocal", async (_e, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("links:connectLocal requires a connection request");
    }
    const input = raw as Record<string, unknown>;
    const rawCwd = typeof input.cwd === "string" ? input.cwd : "";
    const cwd = rawCwd ? await requireRendererProjectPath(rawCwd) : "";
    const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
    const methodId = typeof input.methodId === "string" ? input.methodId.trim() : "";
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const existingId = typeof input.existingId === "string" ? input.existingId.trim() : "";
    if (!providerId || !methodId || !token) {
      throw new Error("Provider, connection method, and token are required");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(methodId)) {
      throw new Error("Invalid local Link connection method");
    }
    if (label.length > 200) throw new Error("Connection label is too long");
    if (token.length > 16_384) throw new Error("Token is too long");

    return persistLocalLinkCredential({
      cwd,
      providerId,
      methodId,
      label,
      token,
      existingId,
      authSource: "manual-token",
    });
  });
  // 只改元数据(label/autoUseByAI/meta),保留 secret —— UI 的编辑/AI 开关用,避免清空 jar。
  ipcMain.handle(
    "credentials:patchMeta",
    async (
      _e,
      cwd: string,
      scope: CredentialScope,
      id: string,
      fields: {
        label?: string;
        exposeAsEnv?: string;
        autoUseByAI?: boolean;
        autoInjectByAI?: boolean;
        meta?: unknown;
      },
    ) => {
      const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
      if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0")) {
        throw new Error("credentials:patchMeta requires id");
      }
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        throw new Error("credentials:patchMeta requires fields");
      }
      assertGenericCredentialMutation(authorizedCwd, id);
      new CredentialStore(authorizedCwd || undefined).patch(scope, id, fields as never);
      if (
        fields.meta &&
        typeof fields.meta === "object" &&
        "autoRefreshFromBrowser" in fields.meta
      ) {
        if (fields.meta.autoRefreshFromBrowser === true) {
          cookieCredentialAutoRefresh.requestRefreshForCredential(
            authorizedCwd || undefined,
            id,
            scope,
          );
        } else {
          cookieCredentialAutoRefresh.cancelRefreshForCredential(
            authorizedCwd || undefined,
            id,
            scope,
          );
        }
      }
      deps.bridge()?.pushCredentialSnapshot(authorizedCwd || undefined);
    },
  );
  ipcMain.handle("mcpOAuth:login", (_e, raw: unknown) => {
    const input = normalizeMcpOAuthLoginInput(raw);
    if (input.credentialId) assertGenericCredentialMutation("", input.credentialId);
    return getMcpOAuthService().login(input);
  });
  ipcMain.handle("mcpOAuth:refresh", (_e, credentialId: unknown) => {
    if (typeof credentialId !== "string" || !credentialId) {
      throw new Error("mcpOAuth:refresh requires credentialId");
    }
    assertGenericCredentialMutation("", credentialId);
    return getMcpOAuthService().refresh(credentialId);
  });
  ipcMain.handle("mcpOAuth:logout", (_e, credentialId: unknown) => {
    if (typeof credentialId !== "string" || !credentialId) {
      throw new Error("mcpOAuth:logout requires credentialId");
    }
    assertGenericCredentialMutation("", credentialId);
    return getMcpOAuthService().logout(credentialId);
  });
  return { remoteLinkIpc };
}
