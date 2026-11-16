import React from "react";
import { AuthGate } from "./AuthGate.js";
import { App } from "./App.js";
import { ProjectsGate } from "./ProjectsGate.js";
import { EnvironmentApiContext } from "./EnvironmentMenu.js";
import { AccountSessionProvider, useAccountSession } from "./AccountSessionProvider.js";
import { AccountSettings } from "./AccountSettings.js";
import { AdminConsole } from "./AdminConsole.js";
import { WebsiteLogin, WebsiteRegistration } from "./WebsiteLogin.js";
import { accountFeatureMessage, useAccountFeature } from "./useAccountFeature.js";
import {
  detectWebsiteCloud,
  logoutWebsiteCloudSession,
  matchesWebsiteTarget,
  parseWebsiteCloudSession,
  type WebsiteCloudCapability,
} from "./website-cloud.js";
import {
  isRegistrationRoute,
  isPublicWebsiteOrigin,
  parseWebsiteRoute,
  safeWebsiteReturn,
  websiteAuthUrl,
  websiteRouteUrl,
  websiteCloudSelected,
  type WebsiteRoute,
} from "./website-routes.js";
import type { CloudManagementSession } from "./auth.js";
import "./website.css";
import { withAccountCookieLock } from "./account-cookie-lock.js";
import { parseAccountSession } from "./account-api.js";
import { DesktopLoginPage, desktopLoginRequest } from "./DesktopLogin.js";
import { DesktopRemoteAccessPage, desktopRemoteAccessRequest } from "./DesktopRemoteAccess.js";
import { WebsiteHome } from "./WebsiteHome.js";
import { WebsiteDestinations } from "./WebsiteDestinations.js";
import { validProjectId } from "./api-context.js";
import type { WorkbenchNavigation } from "./workbench-types.js";

function WebsiteRedirect({ to }: { to: string }) {
  React.useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <main className="auth-page">
      <p role="status">正在打开页面…</p>
      <a href={to}>继续</a>
    </main>
  );
}

function WebsiteSignIn({ url }: { url: URL }) {
  const account = useAccountSession();
  const destination = safeWebsiteReturn(url.searchParams.get("returnTo"), url.origin);
  if (account.session?.authenticated) return <WebsiteRedirect to={destination} />;
  return (
    <WebsiteLogin
      websiteAuth={url.pathname.replace(/\/$/, "") === "/signup" ? "signup" : "login"}
      destination={destination}
    />
  );
}

function WebsiteRequireSignIn() {
  const account = useAccountSession();
  if (!account.ready || account.busy)
    return (
      <main className="auth-page">
        <p role="status">正在读取登录状态…</p>
        {account.error ? (
          <>
            <p role="alert">{account.error}</p>
            <button className="website-button" onClick={() => void account.restore()}>
              重试连接
            </button>
          </>
        ) : null}
      </main>
    );
  const url = new URL(window.location.href);
  return (
    <WebsiteRedirect
      to={websiteAuthUrl("login", safeWebsiteReturn(url.pathname + url.search, url.origin))}
    />
  );
}

export function WebsiteEntry({ setupToken }: { setupToken: string }) {
  const url = new URL(window.location.href);
  const registration = isRegistrationRoute(url);
  const desktopLogin = url.pathname === "/desktop-login" || url.pathname === "/desktop-login/";
  const desktopRemote = url.pathname === "/remote-access" || url.pathname === "/remote-access/";
  const publicWebsite = isPublicWebsiteOrigin(url) && !setupToken;
  const publicHome = publicWebsite && url.pathname === "/";
  const publicAuth =
    publicWebsite && ["/login", "/login/", "/signup", "/signup/"].includes(url.pathname);
  const publicAccountPage = publicWebsite && parseWebsiteRoute(url).kind !== "workbench";
  const [capability, setCapability] = React.useState<WebsiteCloudCapability | null>();
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (
      registration ||
      desktopLogin ||
      desktopRemote ||
      publicHome ||
      publicAuth ||
      publicAccountPage
    )
      return;
    const controller = new AbortController();
    setError("");
    void detectWebsiteCloud(globalThis.fetch, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCapability(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "无法连接工作台，请重试。");
      });
    return () => controller.abort();
  }, [retry, registration, desktopLogin, desktopRemote, publicHome, publicAuth, publicAccountPage]);
  if (publicHome) {
    // Older desktop/project links explicitly selected a project at /. Keep
    // those selections usable without turning an ordinary homepage visit into login.
    if (validProjectId(url.searchParams.get("project")))
      return <WebsiteRedirect to={websiteRouteUrl({ kind: "workbench" }, url)} />;
    return <WebsiteHome />;
  }
  if (publicAuth)
    return (
      <AccountSessionProvider>
        <WebsiteSignIn url={url} />
      </AccountSessionProvider>
    );
  if (desktopLogin)
    return (
      <AccountSessionProvider>
        <DesktopLoginPage request={desktopLoginRequest(url)} />
      </AccountSessionProvider>
    );
  if (desktopRemote)
    return (
      <AccountSessionProvider>
        <DesktopRemoteAccessPage request={desktopRemoteAccessRequest(url)} />
      </AccountSessionProvider>
    );
  if (registration)
    return (
      <AccountSessionProvider>
        <WebsiteRegistration />
      </AccountSessionProvider>
    );
  if (publicAccountPage)
    return (
      <AccountSessionProvider>
        <WebsiteShell />
      </AccountSessionProvider>
    );
  if (capability === null) return <AuthGate setupToken={setupToken} />;
  if (capability)
    return (
      <AccountSessionProvider>
        <WebsiteShell capability={capability} />
      </AccountSessionProvider>
    );
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>CodeShell</h1>
        {error ? (
          <>
            <p role="alert" className="form-error">
              {error}
            </p>
            <button className="send" onClick={() => setRetry((previous) => previous + 1)}>
              重试连接
            </button>
          </>
        ) : (
          <p role="status">正在连接工作台…</p>
        )}
      </section>
    </main>
  );
}

function WebsiteAccountMenu({
  go,
  logout,
  chooseDestination,
  goHome = () => window.location.assign("/"),
}: {
  go: (route: WebsiteRoute) => void;
  logout: () => void;
  chooseDestination: () => void;
  goHome?: () => void;
}) {
  const account = useAccountSession();
  const user = account.session?.account;
  return (
    <details className="website-account-menu">
      <summary aria-label="打开账号菜单">
        <span aria-hidden="true">{(user?.displayName || "C").slice(0, 1)}</span>
      </summary>
      <div className="website-account-popover">
        <strong>{user?.displayName}</strong>
        <small>@{user?.username}</small>
        <button onClick={chooseDestination}>切换云端或电脑</button>
        <button
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            go({ kind: "account", section: "profile" });
          }}
        >
          账号设置
        </button>
        <button
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            go({ kind: "account", section: "connections" });
          }}
        >
          连接
        </button>
        {user?.role === "admin" ? (
          <button
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              go({ kind: "admin", section: "summary" });
            }}
          >
            管理后台
          </button>
        ) : null}
        {isPublicWebsiteOrigin(new URL(window.location.href)) ? (
          <button onClick={goHome}>返回官网</button>
        ) : null}
        <button disabled={account.busy} onClick={logout}>
          退出登录
        </button>
      </div>
    </details>
  );
}

function WebsiteRuntimeAccountMenu({
  navigation,
  register,
  go,
  logout,
  chooseDestination,
}: {
  navigation: WorkbenchNavigation;
  register: (guard: WorkbenchNavigation["leaveWorkspace"] | null) => void;
  go: (route: WebsiteRoute) => void;
  logout: () => void;
  chooseDestination: () => void;
}) {
  React.useLayoutEffect(() => {
    register(navigation.leaveWorkspace);
    return () => register(null);
  }, [navigation.leaveWorkspace, register]);
  return (
    <WebsiteAccountMenu
      go={go}
      logout={() => navigation.leaveWorkspace(logout)}
      chooseDestination={() => navigation.leaveWorkspace(chooseDestination)}
    />
  );
}

function WebsiteShell({ capability }: { capability?: WebsiteCloudCapability }) {
  const account = useAccountSession();
  const cloudFeature = useAccountFeature("cloud.projects");
  const [route, setRoute] = React.useState(() => parseWebsiteRoute(new URL(window.location.href)));
  const [cloudSelected, setCloudSelected] = React.useState(() =>
    websiteCloudSelected(new URL(window.location.href)),
  );
  const [cloudGrant, setCloudGrant] = React.useState<{
    session: CloudManagementSession;
    identity: string;
  } | null>(null);
  const cloudGrantRef = React.useRef(cloudGrant);
  cloudGrantRef.current = cloudGrant;
  const [cloudError, setCloudError] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const revision = React.useRef(0);
  const workspaceLeaveGuard = React.useRef<WorkbenchNavigation["leaveWorkspace"] | null>(null);
  const registerLeaveGuard = React.useCallback(
    (guard: WorkbenchNavigation["leaveWorkspace"] | null) => {
      workspaceLeaveGuard.current = guard;
    },
    [],
  );
  const leaveWorkspace = (action: () => void) =>
    workspaceLeaveGuard.current ? workspaceLeaveGuard.current(action) : action();
  const identity = account.session?.authenticated
    ? `${account.session.account!.id}:${account.session.session!.id}`
    : null;
  const cloudSession = cloudGrant?.identity === identity ? cloudGrant.session : null;
  const target = account.session?.cloudTarget;
  const accountId = account.session?.account?.id;
  // Once mounted, route-only navigation must not cancel an in-flight renewal:
  // cancellation after its cookie write would revoke the still-active workspace.
  const cloudAdmissionNeeded =
    cloudSelected &&
    (route.kind === "workbench" ||
      !!(
        cloudSession &&
        cloudFeature.state === "ready" &&
        cloudSession.audience === target?.cloudOrigin &&
        cloudSession.accountOrigin === target?.accountOrigin &&
        cloudSession.installationId === target?.installationId
      ));
  const go = (next: WebsiteRoute) => {
    window.history.pushState(null, "", websiteRouteUrl(next, new URL(window.location.href)));
    setRoute(next);
    account.clearError();
    if (account.oauthPending) account.cancelGithub();
  };
  const selectDestination = (cloud: boolean) => {
    const current = new URL(window.location.href);
    const next = new URL(websiteRouteUrl({ kind: "workbench" }, current), current);
    next.searchParams.set("target", cloud ? "cloud" : "choose");
    window.history.pushState(null, "", next.pathname + next.search);
    setCloudSelected(cloud);
    setRoute({ kind: "workbench" });
    account.clearError();
  };
  React.useEffect(() => {
    const pop = () => {
      const url = new URL(window.location.href);
      const next = parseWebsiteRoute(url);
      setRoute(next);
      // Account/admin routes keep the selected workspace and its renewal alive.
      // Only returning to a workbench URL changes the execution destination.
      if (next.kind === "workbench") setCloudSelected(websiteCloudSelected(url));
      if (account.oauthPending) account.cancelGithub();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [account.oauthPending]);
  React.useEffect(() => {
    const epoch = ++revision.current;
    const controller = new AbortController();
    // Direct account/admin visits need no Cloud admission. A mounted workspace,
    // however, stays alive behind these pages: keep renewing its authority so
    // background requests cannot expire and unmount its drafts or leave guard.
    const previous = cloudGrantRef.current;
    const retainedGrant =
      cloudSelected &&
      previous?.identity === identity &&
      cloudFeature.state === "ready" &&
      previous.session.audience === target?.cloudOrigin &&
      previous.session.accountOrigin === target?.accountOrigin &&
      previous.session.installationId === target?.installationId
        ? previous
        : null;
    setCloudGrant(retainedGrant);
    if (!cloudAdmissionNeeded) return () => controller.abort();
    setCloudError("");
    setConnecting(false);
    if (!identity || !accountId || !cloudSelected) return () => controller.abort();
    if (cloudFeature.state !== "ready") return () => controller.abort();
    if (!target) {
      setCloudError("当前账号尚未分配云端环境。你仍可管理账号设置。");
      return () => controller.abort();
    }
    if (cloudFeature.params?.cloudOrigin !== target.cloudOrigin) {
      setCloudError("云端地址与当前账号配置不一致，请刷新后重试。");
      return () => controller.abort();
    }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (controller.signal.aborted || epoch !== revision.current) return;
      setConnecting(true);
      setCloudError("");
      try {
        const confirmedCapability =
          capability ?? (await detectWebsiteCloud(globalThis.fetch, controller.signal));
        if (
          !confirmedCapability ||
          !matchesWebsiteTarget(confirmedCapability, target, window.location.origin)
        )
          throw new Error("云端环境与账号服务配置不一致，请联系管理员。");
        if (controller.signal.aborted || epoch !== revision.current) return;
        const ticket = await account.request<{
          ticket: string;
          expiresAt: number;
          cloudOrigin: string;
          installationId: string;
          accountOrigin: string;
        }>("/cloud-tickets", "POST", {}, controller.signal);
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket) ||
          !Number.isSafeInteger(ticket.expiresAt) ||
          ticket.expiresAt <= Date.now() ||
          ticket.expiresAt > Date.now() + 61000 ||
          ticket.cloudOrigin !== target.cloudOrigin ||
          ticket.accountOrigin !== target.accountOrigin ||
          ticket.installationId !== target.installationId
        )
          throw new Error("云端授权目标无效，请联系管理员。");
        const next = await withAccountCookieLock(async () => {
          if (controller.signal.aborted || epoch !== revision.current)
            throw new Error("账号状态已改变。");
          const fresh = parseAccountSession(await account.request("/session"));
          if (!fresh.authenticated || `${fresh.account!.id}:${fresh.session!.id}` !== identity) {
            void account.restore();
            throw new Error("其他页面已切换账号，请重新连接。");
          }
          const response = await fetch("/api/v1/cloud-browser/session", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticket: ticket.ticket }),
          });
          if (!response.ok) throw new Error("云端工作区登录未完成，请重试连接。");
          const result = parseWebsiteCloudSession(await response.json(), target, accountId);
          if (controller.signal.aborted || epoch !== revision.current) {
            await fetch("/api/v1/cloud-browser/logout", {
              method: "POST",
              credentials: "include",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(10000),
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            throw new Error("账号状态已改变。");
          }
          return result;
        });
        if (!controller.signal.aborted && epoch === revision.current) {
          setCloudGrant({ session: next, identity: identity! });
          refreshTimer = setTimeout(
            () => void connect(),
            Math.max(1000, next.expiresAt - Date.now() - 30000),
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted && epoch === revision.current) {
          setCloudGrant(null);
          setCloudError(cause instanceof Error ? cause.message : "无法连接云端工作区，请重试。");
        }
      } finally {
        if (!controller.signal.aborted && epoch === revision.current) setConnecting(false);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(refreshTimer);
    };
  }, [
    cloudAdmissionNeeded,
    identity,
    target?.cloudOrigin,
    target?.installationId,
    target?.accountOrigin,
    capability,
    account.request,
    cloudFeature.state,
    cloudFeature.params?.cloudOrigin,
    cloudSelected,
    attempt,
  ]);

  const logout = () => {
    const expected = cloudSession;
    setLoggingOut(true);
    revision.current++;
    setCloudGrant(null);
    void account
      .logout()
      .then((confirmed) => {
        if (confirmed && expected) return logoutWebsiteCloudSession(expected);
      })
      .catch(() => {})
      .finally(() => setLoggingOut(false));
  };
  if (loggingOut)
    return (
      <main className="auth-page">
        <p role="status">正在退出登录…</p>
      </main>
    );
  if (!account.session?.authenticated)
    return isPublicWebsiteOrigin(new URL(window.location.href)) ? (
      <WebsiteRequireSignIn />
    ) : (
      <WebsiteLogin />
    );
  const menu = (
    <WebsiteAccountMenu
      go={go}
      logout={() => leaveWorkspace(logout)}
      chooseDestination={() => leaveWorkspace(() => selectDestination(false))}
    />
  );
  const settings = route.kind !== "workbench";
  const administrator = account.session.account?.role === "admin";
  return (
    <EnvironmentApiContext.Provider value="/api/v1/cloud-browser/environment">
      {!settings && !cloudSelected ? (
        <WebsiteDestinations
          key={identity}
          accountControl={menu}
          onCloud={() => selectDestination(true)}
        />
      ) : cloudSession && cloudFeature.state === "ready" ? (
        <div hidden={settings} className="website-workbench-root">
          <ProjectsGate
            key={identity}
            allowLegacy={false}
            autoEnterSingle
            startCreatedProject
            onSkipSetup={() => selectDestination(false)}
            canRequest={() => account.workspaceActive(identity!)}
            onAuthLost={() => {
              setCloudGrant(null);
              setAttempt((previous) => previous + 1);
            }}
            accountControl={menu}
          >
            {(project, back) => (
              <App
                hub
                onAuthLost={() => {
                  setCloudGrant(null);
                  setAttempt((previous) => previous + 1);
                }}
                projectName={project?.name}
                onBackToProjects={back}
                cloudAccount={{
                  pending: account.busy,
                  error: "",
                  onLogout: logout,
                  accountOrigin: target?.accountOrigin,
                }}
                renderAccountControl={(navigation) => (
                  <WebsiteRuntimeAccountMenu
                    navigation={navigation}
                    register={registerLeaveGuard}
                    go={go}
                    logout={logout}
                    chooseDestination={() => selectDestination(false)}
                  />
                )}
              />
            )}
          </ProjectsGate>
        </div>
      ) : !settings ? (
        <main className="website-environment-empty">
          <header className="website-brand">CodeShell {menu}</header>
          <section>
            <p className="website-eyebrow">你的工作台</p>
            <h1>
              {cloudFeature.state === "hidden"
                ? "你的账号"
                : connecting
                  ? "正在打开工作空间…"
                  : "连接你的工作空间"}
            </h1>
            <p
              role={cloudError ? "alert" : "status"}
              className={cloudError ? "form-error" : "website-muted"}
            >
              {accountFeatureMessage(cloudFeature) ||
                cloudError ||
                (cloudFeature.state === "hidden"
                  ? "在账号设置中管理你的资料与登录状态。"
                  : "正在验证账号与云端环境。")}
            </p>
            {cloudError && cloudFeature.state === "ready" ? (
              <button
                className="website-button"
                onClick={() => setAttempt((previous) => previous + 1)}
              >
                重新连接
              </button>
            ) : null}
            {cloudFeature.state === "pending" ? (
              <button className="website-button" onClick={() => void account.restore()}>
                重试连接账号服务
              </button>
            ) : null}
            <button className="website-button" onClick={() => selectDestination(false)}>
              选择云端或其他电脑
            </button>
            <button className="ghost" onClick={() => go({ kind: "account", section: "profile" })}>
              账号设置
            </button>
          </section>
        </main>
      ) : null}
      {route.kind === "admin" ? (
        <div className="website-settings-shell website-admin-shell">
          <aside className="website-settings-nav website-admin-nav">
            <a
              className="website-brand"
              href="/"
              onClick={(event) => {
                event.preventDefault();
                leaveWorkspace(() => window.location.assign("/"));
              }}
            >
              CodeShell
            </a>
            <p className="website-eyebrow">管理后台</p>
            <nav aria-label="管理后台">
              {(
                [
                  ["summary", "概览"],
                  ["users", "账号管理"],
                  ["audit", "操作记录"],
                ] as const
              ).map(([section, label]) => (
                <button
                  key={section}
                  aria-current={route.section === section ? "page" : undefined}
                  onClick={() => go({ kind: "admin", section })}
                >
                  {label}
                </button>
              ))}
            </nav>
            <button className="website-back" onClick={() => go({ kind: "workbench" })}>
              ← 返回工作台
            </button>
            <div className="website-settings-avatar">{menu}</div>
          </aside>
          <main className="website-admin-main">
            <AdminConsole key={`${identity}:${route.section}`} section={route.section} go={go} />
          </main>
        </div>
      ) : route.kind === "account" ? (
        <div className="website-settings-shell">
          <aside className="website-settings-nav">
            <button className="website-back" onClick={() => go({ kind: "workbench" })}>
              ← 返回工作台
            </button>
            <p className="website-eyebrow">账号设置</p>
            <nav aria-label="账号设置">
              {(
                [
                  ["profile", "账号资料"],
                  ["security", "安全"],
                  ["sessions", "登录会话"],
                  ["connections", "连接"],
                ] as const
              ).map(([section, label]) => (
                <button
                  key={section}
                  aria-current={
                    route.kind === "account" && route.section === section ? "page" : undefined
                  }
                  onClick={() => go({ kind: "account", section })}
                >
                  {label}
                </button>
              ))}
            </nav>
            {administrator ? (
              <>
                <p className="website-eyebrow">管理员</p>
                <nav aria-label="管理入口">
                  <button onClick={() => go({ kind: "admin", section: "summary" })}>
                    管理后台 ↗
                  </button>
                </nav>
              </>
            ) : null}
            <div className="website-settings-avatar">{menu}</div>
          </aside>
          <main>
            <AccountSettings key={`${identity}:${route.kind}:${route.section}`} route={route} />
          </main>
        </div>
      ) : null}
    </EnvironmentApiContext.Provider>
  );
}
