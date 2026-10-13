import React from "react";
import { AuthGate } from "./AuthGate.js";
import { App } from "./App.js";
import { ProjectsGate } from "./ProjectsGate.js";
import { EnvironmentApiContext } from "./EnvironmentMenu.js";
import { AccountSessionProvider, useAccountSession } from "./AccountSessionProvider.js";
import { AccountSettings } from "./AccountSettings.js";
import { WebsiteLogin } from "./WebsiteLogin.js";
import {
  detectWebsiteCloud,
  logoutWebsiteCloudSession,
  matchesWebsiteTarget,
  parseWebsiteCloudSession,
  type WebsiteCloudCapability,
} from "./website-cloud.js";
import { parseWebsiteRoute, websiteRouteUrl, type WebsiteRoute } from "./website-routes.js";
import type { CloudManagementSession } from "./auth.js";
import "./website.css";
import { withAccountCookieLock } from "./account-cookie-lock.js";
import { parseAccountSession } from "./account-api.js";

export function WebsiteEntry({ setupToken }: { setupToken: string }) {
  const [capability, setCapability] = React.useState<WebsiteCloudCapability | null>();
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
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
  }, [retry]);
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
}: {
  go: (route: WebsiteRoute) => void;
  logout: () => void;
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
          <button onClick={() => go({ kind: "admin", section: "users" })}>管理控制台</button>
        ) : null}
        <button disabled={account.busy} onClick={logout}>
          退出登录
        </button>
      </div>
    </details>
  );
}

function WebsiteShell({ capability }: { capability: WebsiteCloudCapability }) {
  const account = useAccountSession();
  const [route, setRoute] = React.useState(() => parseWebsiteRoute(new URL(window.location.href)));
  const [cloudGrant, setCloudGrant] = React.useState<{
    session: CloudManagementSession;
    identity: string;
  } | null>(null);
  const [cloudError, setCloudError] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const revision = React.useRef(0);
  const identity = account.session?.authenticated
    ? `${account.session.account!.id}:${account.session.session!.id}`
    : null;
  const cloudSession = cloudGrant?.identity === identity ? cloudGrant.session : null;
  const target = account.session?.cloudTarget;
  const accountId = account.session?.account?.id;
  const go = (next: WebsiteRoute) => {
    window.history.pushState(null, "", websiteRouteUrl(next, new URL(window.location.href)));
    setRoute(next);
    account.clearError();
    if (account.oauthPending) account.cancelGithub();
  };
  React.useEffect(() => {
    const pop = () => {
      setRoute(parseWebsiteRoute(new URL(window.location.href)));
      if (account.oauthPending) account.cancelGithub();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [account.oauthPending]);
  React.useEffect(() => {
    const epoch = ++revision.current;
    const controller = new AbortController();
    setCloudGrant(null);
    setCloudError("");
    setConnecting(false);
    if (!identity || !accountId) return () => controller.abort();
    if (!target) {
      setCloudError("当前账号尚未分配云端环境。你仍可管理账号设置。");
      return () => controller.abort();
    }
    if (!matchesWebsiteTarget(capability, target, window.location.origin)) {
      setCloudError("云端环境与账号服务配置不一致，请联系管理员。");
      return () => controller.abort();
    }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (controller.signal.aborted || epoch !== revision.current) return;
      setConnecting(true);
      setCloudError("");
      try {
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
    identity,
    target?.cloudOrigin,
    target?.installationId,
    target?.accountOrigin,
    capability,
    account.request,
    attempt,
  ]);

  const logout = () => {
    const expected = cloudSession;
    revision.current++;
    setCloudGrant(null);
    void account
      .logout()
      .then((confirmed) => {
        if (confirmed && expected) return logoutWebsiteCloudSession(expected);
      })
      .catch(() => {});
  };
  if (!account.session?.authenticated) return <WebsiteLogin />;
  const menu = <WebsiteAccountMenu go={go} logout={logout} />;
  const settings = route.kind !== "workbench";
  const administrator = account.session.account?.role === "admin";
  return (
    <EnvironmentApiContext.Provider value="/api/v1/cloud-browser/environment">
      {cloudSession ? (
        <div hidden={settings} className="website-workbench-root">
          <ProjectsGate
            key={identity}
            allowLegacy={false}
            autoEnterSingle
            startCreatedProject
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
                  <WebsiteAccountMenu go={go} logout={() => navigation.guard(logout)} />
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
            <h1>{connecting ? "正在打开工作空间…" : "连接你的工作空间"}</h1>
            <p
              role={cloudError ? "alert" : "status"}
              className={cloudError ? "form-error" : "website-muted"}
            >
              {cloudError || "正在验证账号与云端环境。"}
            </p>
            {cloudError ? (
              <button
                className="website-button"
                onClick={() => setAttempt((previous) => previous + 1)}
              >
                重新连接
              </button>
            ) : null}
            <button className="ghost" onClick={() => go({ kind: "account", section: "profile" })}>
              账号设置
            </button>
          </section>
        </main>
      ) : null}
      {settings ? (
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
                <p className="website-eyebrow">管理控制台</p>
                <nav aria-label="管理控制台">
                  {(
                    [
                      ["users", "用户管理"],
                      ["summary", "系统统计"],
                      ["audit", "操作记录"],
                    ] as const
                  ).map(([section, label]) => (
                    <button
                      key={section}
                      aria-current={
                        route.kind === "admin" && route.section === section ? "page" : undefined
                      }
                      onClick={() => go({ kind: "admin", section })}
                    >
                      {label}
                    </button>
                  ))}
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
