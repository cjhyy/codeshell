import { EnvironmentMenu } from "./EnvironmentMenu.js";
import React from "react";
import { App } from "./App.js";
import { ProjectsGate } from "./ProjectsGate.js";
import { CloudAccountControls } from "./CloudAccountControls.js";
import {
  ApiError,
  InvalidAuthStatusError,
  post,
  readAuthStatus,
  type AuthSession,
  type AuthStatus,
  type CloudManagementSession,
} from "./auth.js";

type GateState =
  | "checking"
  | "setup"
  | "login"
  | "cloud-login"
  | "authenticated"
  | "legacy"
  | "error";

export function AuthGate({ setupToken }: { setupToken: string }) {
  const [state, setState] = React.useState<GateState>("checking");
  const [session, setSession] = React.useState<AuthSession | undefined>();
  const [cloudSession, setCloudSession] = React.useState<CloudManagementSession>();
  const [cloudMode, setCloudMode] = React.useState(false);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("");
  const [token, setToken] = React.useState(setupToken);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [logoutError, setLogoutError] = React.useState("");
  const logoutPending = React.useRef(false);
  const cloudModeRef = React.useRef(false);
  const mounted = React.useRef(false);
  const authRevision = React.useRef(0);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const acceptStatus = React.useCallback((status: AuthStatus | null) => {
    if (!mounted.current) return;
    cloudModeRef.current = status?.mode === "cloud-account";
    setCloudMode(cloudModeRef.current);
    setCloudSession(status?.cloudSession);
    setSession(status?.session);
    setState(
      status === null
        ? "legacy"
        : status.mode === "cloud-account"
          ? status.authenticated
            ? "authenticated"
            : "cloud-login"
          : !status.initialized
            ? "setup"
            : status.authenticated
              ? "authenticated"
              : "login",
    );
    setBusy(false);
    setError("");
    if (status?.initialized) setToken("");
  }, []);

  const authLost = React.useCallback(() => {
    if (!mounted.current) return;
    authRevision.current++;
    setSession(undefined);
    setCloudSession(undefined);
    setState(cloudModeRef.current ? "cloud-login" : "login");
    setPassword("");
    setError(
      cloudModeRef.current
        ? "Cloud 管理登录已失效，请从桌面 Cloud 管理器重新打开。"
        : "登录已过期或此设备已被撤销，请重新登录。",
    );
  }, []);

  const check = React.useCallback(async () => {
    if (logoutPending.current) return;
    const revision = ++authRevision.current;
    try {
      const status = await readAuthStatus();
      // An origin that declared Account ownership cannot downgrade to Hub/legacy
      // authority during a restart, upgrade or stale service-worker response.
      if (
        revision === authRevision.current &&
        cloudModeRef.current &&
        status?.mode !== "cloud-account"
      ) {
        authLost();
        return;
      }
      if (revision === authRevision.current) acceptStatus(status);
    } catch (cause) {
      if (!mounted.current || revision !== authRevision.current) return;
      if (
        cloudModeRef.current &&
        ((cause instanceof ApiError && cause.status === 401) ||
          cause instanceof InvalidAuthStatusError)
      ) {
        authLost();
        return;
      }
      // A server restart must not erase an active view or its unsent draft.
      if (stateRef.current === "authenticated" || stateRef.current === "legacy") return;
      setState("error");
      setError(cause instanceof Error ? cause.message : "无法连接服务端");
    }
  }, [acceptStatus, authLost]);

  React.useEffect(() => {
    mounted.current = true;
    void check();
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  React.useEffect(() => {
    if (!cloudSession) return;
    const timer = setTimeout(authLost, Math.max(0, cloudSession.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [cloudSession, authLost]);

  const logoutCloud = async () => {
    if (logoutPending.current || !cloudModeRef.current) return;
    logoutPending.current = true;
    const revision = ++authRevision.current;
    setBusy(true);
    setLogoutError("");
    try {
      const result = await post<{ revoked?: boolean }>("/api/v1/auth/logout");
      if (!mounted.current || revision !== authRevision.current) return;
      if (result.revoked !== true) throw new Error("Cloud 退出尚未确认。");
      authLost();
      setError("此 Cloud 工作台已退出。请从桌面 Cloud 管理器重新打开。");
    } catch (cause) {
      if (!mounted.current || revision !== authRevision.current) return;
      if (cause instanceof ApiError && cause.status === 401) authLost();
      else setLogoutError("未能确认退出此 Cloud 工作台，请重试。也可关闭此页并在桌面撤销登录。");
    } finally {
      logoutPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || cloudModeRef.current) return;
    const revision = ++authRevision.current;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ authenticated: boolean; session: AuthSession }>(
        `/api/v1/auth/${state === "setup" ? "setup" : "login"}`,
        {
          username: username.trim(),
          password,
          deviceName: deviceName.trim() || undefined,
          ...(state === "setup" ? { token: token.trim() } : {}),
        },
      );
      if (!mounted.current || revision !== authRevision.current) return;
      if (!result.authenticated) throw new Error("登录失败，请重试。");
      setPassword("");
      setToken("");
      acceptStatus({ initialized: true, authenticated: true, session: result.session });
    } catch (cause) {
      if (!mounted.current || revision !== authRevision.current) return;
      setError(cause instanceof Error ? cause.message : "登录失败，请重试。");
      if (cause instanceof ApiError && cause.status === 409) void check();
    } finally {
      if (mounted.current && revision === authRevision.current) setBusy(false);
    }
  };

  if (state === "authenticated") {
    const controls = cloudMode
      ? {
          pending: busy,
          error: logoutError,
          onLogout: () => void logoutCloud(),
          accountOrigin: cloudSession?.accountOrigin,
        }
      : undefined;
    return (
      <ProjectsGate
        key={
          cloudSession
            ? `${cloudSession.audience}:${cloudSession.installationId}:${cloudSession.managementEpoch}:${cloudSession.accountOrigin}:${cloudSession.accountId}:${cloudSession.id}`
            : session?.id
        }
        onAuthLost={authLost}
        allowLegacy={!cloudMode}
        accountControl={controls ? <CloudAccountControls {...controls} /> : undefined}
      >
        {(project, onBack) => (
          <App
            session={session}
            hub
            onAuthLost={authLost}
            onCheckAuth={check}
            projectName={project?.name}
            onBackToProjects={onBack}
            cloudAccount={controls}
          />
        )}
      </ProjectsGate>
    );
  }
  if (state === "legacy") {
    return <App session={session} hub={false} onAuthLost={authLost} onCheckAuth={check} />;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <EnvironmentMenu discover={false} />
        <div className="auth-brand">
          CodeShell <span>{cloudMode ? "Cloud" : "Hub"}</span>
        </div>
        {state === "checking" ? <p role="status">正在连接你的工作空间…</p> : null}
        {state === "error" ? (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <button className="send" onClick={() => void check()}>
              重试连接
            </button>
          </>
        ) : null}
        {state === "cloud-login" ? (
          <>
            <h1>请从桌面 Cloud 管理器登录</h1>
            <p>在 CodeShell 桌面端登录云账号，再从 Cloud 管理器打开这个工作台。</p>
            {error ? <p role="status">{error}</p> : null}
            <button className="send" onClick={() => void check()}>
              重新检查 Cloud 登录
            </button>
          </>
        ) : null}
        {state === "setup" || state === "login" ? (
          <form onSubmit={(event) => void submit(event)}>
            <h1>{state === "setup" ? "创建管理员账号" : "登录工作空间"}</h1>
            <p>
              {state === "setup"
                ? "首次启动需要服务端提供的初始化令牌。创建后，可在其他设备使用此账号登录。"
                : "连接服务端，继续你的会话与任务。"}
            </p>
            {state === "setup" ? (
              <label>
                初始化令牌
                <input
                  type="password"
                  autoComplete="off"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            ) : null}
            <label>
              用户名
              <input
                autoComplete="username"
                required
                maxLength={64}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete={state === "setup" ? "new-password" : "current-password"}
                required
                maxLength={256}
                minLength={state === "setup" ? 12 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {state === "setup" ? <small>密码至少 12 个字符。</small> : null}
            <label>
              设备名称 <span>（可选）</span>
              <input
                autoComplete="off"
                maxLength={100}
                placeholder="例如：我的笔记本"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
              />
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="send" type="submit" disabled={busy}>
              {busy ? "正在连接…" : state === "setup" ? "创建并进入" : "登录"}
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}
