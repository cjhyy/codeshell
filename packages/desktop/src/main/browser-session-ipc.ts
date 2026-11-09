import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { externalRuntimeBrowserBucket } from "./external-runtime-browser-bucket.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { migrateCredentialStore } from "./credential-migration.js";
import { RendererBrowserSessionAccess } from "./renderer-browser-session-access.js";
import {
  createRendererBrowserSessionEventAccess,
  resolvePersistedBrowserSession,
  browserPartitionForBucket,
} from "./renderer-browser-session-ipc-authority.js";
import {
  bucketForSession,
  guestRecordForId,
  listGuestSessions,
  registerAttachedGuestMetadata,
  registerSessionBucket,
  sessionIdsForBucket,
} from "./browser-driver/active-guest.js";
import {
  browserRuntime,
  builtInBrowserHandoffGrants,
  chromeExtensionRuntimeService,
  interactiveBrowserRuntimeOwner,
  parseBuiltInBrowserGrantLifetime,
  registerPanelAccessResponses,
  type ChromeNativeRegistrationResult,
} from "./browser-runtime/index.js";
import { dlog } from "./desktop-logger.js";
import {
  listCookieDomains,
  getCookiesForDomain,
  captureCookieJar,
  captureAllCookies,
  captureAllCookiesFromSessions,
} from "./credentials-service.js";
import { resolveCookieCredentialForBrowser } from "./credential-action.js";
import { restoreCookieCredentialToBrowser } from "./cookie-credential-browser.js";
import { loginAndCaptureCookies } from "./credentials-login/index.js";
import { assertDesktopSessionId } from "./session-validation.js";

export interface BrowserSessionIpcDeps {
  mainWindows: Set<BrowserWindow>;
  bridge: () => AgentBridge | null;
  chromeNativeRegistration: () => ChromeNativeRegistrationResult | undefined;
}

/** Renderer browser-session ownership, built-in/Chrome runtime grants and cookie credential capture routes. */
export function registerBrowserSessionIpc(deps: BrowserSessionIpcDeps) {
  const { mainWindows } = deps;
  function assertRendererSessionAccess(sessionId: unknown, senderWebContentsId: number): string {
    assertDesktopSessionId(sessionId);
    const bridge = deps.bridge();
    if (!bridge?.hasKnownSession(sessionId)) {
      throw new Error("browser operation requires a live CodeShell task");
    }
    const ownerId = bridge.panelOwnerWebContentsId(sessionId);
    // Headless/mobile sessions intentionally have no panel owner and may be
    // presented by a desktop window. Once a session has an owner, however, a
    // second window must never rebind or control its browser capability.
    if (ownerId !== undefined && ownerId !== senderWebContentsId) {
      throw new Error("browser operation belongs to another window");
    }
    return sessionId;
  }

  const deletingBrowserSessions = new Set<string>();
  const rendererBrowserSessionAccess = new RendererBrowserSessionAccess({
    bridge: () => deps.bridge(),
    windowForSender: (senderId) =>
      [...mainWindows].find(
        (window) => !window.isDestroyed() && window.webContents.id === senderId,
      ) ?? null,
    resolvePersistedSession: resolvePersistedBrowserSession,
    bucketForSession,
    registerSessionBucket,
  });

  const prepareRendererBrowserSession = createRendererBrowserSessionEventAccess(
    rendererBrowserSessionAccess,
    (sessionId) => deletingBrowserSessions.has(sessionId),
  );

  function requireRendererBrowserPartition(bucket: unknown, senderWebContentsId: number): string {
    const partition = browserPartitionForBucket(bucket);
    if (!partition || typeof bucket !== "string") {
      throw new Error("a bounded browser bucket is required");
    }
    const sessionIds = sessionIdsForBucket(bucket);
    const authorized = sessionIds.some((sessionId) => {
      if (deletingBrowserSessions.has(sessionId)) return false;
      try {
        rendererBrowserSessionAccess.assertAccess(sessionId, senderWebContentsId);
        return true;
      } catch {
        return false;
      }
    });
    if (!authorized) throw new Error("browser bucket belongs to another window");
    return partition;
  }

  ipcMain.on(
    "browser:register-session-bucket",
    async (event, payload: { sessionId?: unknown; bucket?: unknown; partition?: unknown }) => {
      try {
        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
        const bucket = typeof payload?.bucket === "string" ? payload.bucket : "";
        const partition = typeof payload?.partition === "string" ? payload.partition : undefined;
        if (!sessionId || !bucket || bucket.length > 512 || bucket.includes("\0")) return;
        if (partition !== undefined && (partition.length > 1_024 || partition.includes("\0")))
          return;
        const { bucket: existingBucket } = await prepareRendererBrowserSession(
          event,
          sessionId,
          bucket,
        );
        if (!existingBucket) throw new Error("browser Session has no Main-owned bucket");
        if (existingBucket !== bucket) {
          // External runtimes intentionally own an isolated browser partition.
          // A late renderer effect must never rebind it to the visible session
          // bucket; ignore that stale registration instead of emitting a noisy
          // error after the external runtime has already started successfully.
          if (existingBucket === externalRuntimeBrowserBucket(sessionId)) return;
          throw new Error(
            `renderer attempted to rebind session ${sessionId} from ${existingBucket} to ${bucket}`,
          );
        }
        registerSessionBucket(sessionId, bucket, partition);
      } catch (err) {
        dlog("browser", "register_session_bucket_failed", { error: String(err) });
      }
    },
  );

  ipcMain.on(
    "browser:guest-attached",
    async (
      e,
      payload: {
        guestId?: unknown;
        bucket?: unknown;
        partition?: unknown;
        engineSessionId?: unknown;
      },
    ) => {
      try {
        const guestId =
          typeof payload?.guestId === "number" ? payload.guestId : Number(payload?.guestId);
        const bucket = typeof payload?.bucket === "string" ? payload.bucket : "";
        const partition = typeof payload?.partition === "string" ? payload.partition : "";
        if (
          !Number.isSafeInteger(guestId) ||
          guestId <= 0 ||
          !bucket ||
          bucket.length > 512 ||
          bucket.includes("\0") ||
          !partition ||
          partition.length > 1_024 ||
          partition.includes("\0")
        ) {
          return;
        }
        const ownerWindow = BrowserWindow.fromWebContents(e.sender);
        if (!ownerWindow) return;
        if (payload?.engineSessionId !== undefined) {
          await prepareRendererBrowserSession(e, payload.engineSessionId, bucket);
        }
        registerAttachedGuestMetadata({
          guestId,
          bucket,
          partition,
          engineSessionId:
            typeof payload?.engineSessionId === "string" ? payload.engineSessionId : undefined,
          windowId: ownerWindow.id,
          source: "panel",
        });
      } catch (err) {
        dlog("browser", "guest_attached_failed", { error: String(err) });
      }
    },
  );

  ipcMain.handle("browser-runtime:grant-built-in", async (e, payload: Record<string, unknown>) => {
    const guestId =
      typeof payload?.guestId === "number" ? payload.guestId : Number(payload?.guestId);
    if (!Number.isSafeInteger(guestId) || guestId <= 0) {
      throw new Error("browser handoff requires an existing conversation and browser tab");
    }
    const { sessionId, assertCurrent } = await prepareRendererBrowserSession(
      e,
      payload?.sessionId,
      guestRecordForId(guestId)?.bucket,
    );
    const ownerWindow = BrowserWindow.fromWebContents(e.sender);
    if (!ownerWindow) throw new Error("browser handoff requires an owning window");
    const status = builtInBrowserHandoffGrants.grant({
      sessionId,
      guestId,
      sourceWindowId: ownerWindow.id,
      assertCurrent,
      lifetime: parseBuiltInBrowserGrantLifetime(payload.lifetime, payload.ttlMs),
      ttlMs:
        typeof payload.ttlMs === "number" &&
        Number.isSafeInteger(payload.ttlMs) &&
        payload.ttlMs > 0
          ? payload.ttlMs
          : undefined,
    });
    // Switching targets is explicit. Dispose the independent runtime target so
    // there is never a second browser silently continuing in the background.
    chromeExtensionRuntimeService.forgetSession(sessionId);
    browserRuntime.close(interactiveBrowserRuntimeOwner(sessionId));
    return status;
  });

  registerPanelAccessResponses(ipcMain, (sender) => BrowserWindow.fromWebContents(sender)?.id);
  ipcMain.handle("browser-runtime:revoke-built-in", async (event, rawSessionId: unknown) => {
    const { sessionId } = await prepareRendererBrowserSession(event, rawSessionId);
    builtInBrowserHandoffGrants.revoke(sessionId);
    return builtInBrowserHandoffGrants.status(sessionId);
  });

  ipcMain.handle("browser-runtime:handoff-status", async (event, rawSessionId: unknown) => {
    const { sessionId } = await prepareRendererBrowserSession(event, rawSessionId);
    return builtInBrowserHandoffGrants.status(sessionId);
  });

  ipcMain.handle(
    "browser-runtime:chrome-begin-pairing",
    async (event, payload: { sessionId?: unknown; label?: unknown }) => {
      const sessionId = assertRendererSessionAccess(payload?.sessionId, event.sender.id);
      await prepareRendererBrowserSession(event, sessionId);
      if (
        payload?.label !== undefined &&
        (typeof payload.label !== "string" ||
          payload.label.length > 200 ||
          payload.label.includes("\0"))
      ) {
        throw new Error("Chrome pairing label is invalid");
      }
      return chromeExtensionRuntimeService.beginPairing(
        sessionId,
        typeof payload.label === "string" ? payload.label : undefined,
      );
    },
  );

  ipcMain.handle("browser-runtime:chrome-status", async (event, rawSessionId: unknown) => {
    const { sessionId } = await prepareRendererBrowserSession(event, rawSessionId);
    return chromeExtensionRuntimeService.status(sessionId);
  });

  ipcMain.handle("browser-runtime:chrome-revoke", async (event, rawSessionId: unknown) => {
    const sessionId = assertRendererSessionAccess(rawSessionId, event.sender.id);
    await prepareRendererBrowserSession(event, sessionId);
    return chromeExtensionRuntimeService.revoke(sessionId);
  });

  ipcMain.handle("browser-runtime:chrome-installation", () => ({
    ...(deps.chromeNativeRegistration() ?? {
      installed: false,
      manifestPaths: [],
      extensionPath: app.isPackaged
        ? join(process.resourcesPath, "packages", "desktop", "resources", "chrome-extension")
        : join(app.getAppPath(), "resources", "chrome-extension"),
      detail: "Chrome bridge is still starting",
    }),
  }));

  ipcMain.handle("credentials:cookieDomains", async (event, bucket?: string) =>
    listCookieDomains(requireRendererBrowserPartition(bucket, event.sender.id)),
  );
  ipcMain.handle("credentials:cookiePreview", async (event, domain: string, bucket?: string) => {
    if (
      typeof domain !== "string" ||
      !domain.trim() ||
      domain.length > 253 ||
      domain.includes("\0")
    ) {
      throw new Error("credentials:cookiePreview requires a bounded domain");
    }
    // Preview only: just count the cookies in the partition. No lease file is
    // materialized here — the actual cookies.txt is created on demand by the
    // (deferred) UseGate when a tool call is approved.
    const cookies = await getCookiesForDomain(
      domain.trim(),
      requireRendererBrowserPartition(bucket, event.sender.id),
    );
    return { count: cookies.length };
  });
  // 第二期:按域拓取 cookie jar(renderer 拿去组装成 cookie 凭证存进 CredentialStore)。
  ipcMain.handle("credentials:captureCookieJar", async (event, domain: string, bucket?: string) => {
    if (
      typeof domain !== "string" ||
      !domain.trim() ||
      domain.length > 253 ||
      domain.includes("\0")
    ) {
      throw new Error("credentials:captureCookieJar requires a domain");
    }
    const jar = await captureCookieJar(
      domain.trim(),
      requireRendererBrowserPartition(bucket, event.sender.id),
    );
    return { jar, count: jar.length };
  });
  // 第二期+:全量拓取当前 chat session 的浏览器分区所有 cookie(不按域过滤)。
  ipcMain.handle("credentials:captureAllCookies", async (event, bucket?: string) => {
    const jar = await captureAllCookies(requireRendererBrowserPartition(bucket, event.sender.id));
    return { jar, count: jar.length };
  });
  // 第二期+:兜底拓取所有当前活着的浏览器面板 session,去重合并。
  ipcMain.handle("credentials:captureAllCookiesAllSessions", async () => {
    return captureAllCookiesFromSessions(listGuestSessions());
  });
  // 第二期:切换账号 — 把某条 cookie 凭证的 jar 导回当前会话浏览器分区覆盖当前登录态,
  // 然后广播 browser:reload 让浏览器面板刷新成该账号身份。
  ipcMain.handle(
    "credentials:restoreCookieToBrowser",
    async (event, cwd: string, id: string, bucket?: string) => {
      const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : "";
      if (typeof id !== "string" || !id || id.length > 512 || id.includes("\0"))
        throw new Error("credentials:restoreCookieToBrowser requires id");
      const partition = requireRendererBrowserPartition(bucket, event.sender.id);
      await migrateCredentialStore(authorizedCwd || undefined);
      const resolved = resolveCookieCredentialForBrowser(authorizedCwd || undefined, id, "full");
      if (!resolved.ok) throw new Error(resolved.error);
      const { count } = await restoreCookieCredentialToBrowser({
        targetSession: partition,
        sessionCwd: authorizedCwd || undefined,
        credentialId: id,
        credentialScope: "full",
        resolved,
      });
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("browser:reload", { bucket });
      }
      return { count };
    },
  );
  // 第二期+:独立窗口登录抓 cookie(解决内置 webview 登不上 Google/YouTube)。
  // 开临时分区登录窗 → 用户点保存 → 读 cookie + 用户名 + 校验 → 关窗销毁分区。
  // 只产出 jar/建议名/校验,存凭证由渲染层走 credentials:save。
  ipcMain.handle(
    "credentials:loginCapture",
    async (_e, req: { url: string; platform?: string; fullCapture?: boolean }) => {
      if (!req || typeof req.url !== "string" || !req.url.trim()) {
        throw new Error("credentials:loginCapture requires a url");
      }
      return loginAndCaptureCookies({
        url: req.url.trim(),
        platform: req.platform,
        fullCapture: req.fullCapture === true,
      });
    },
  );
  return { assertRendererSessionAccess, deletingBrowserSessions, rendererBrowserSessionAccess };
}
