import React from "react";
import { App } from "./App.js";
import { ProjectsGate } from "./ProjectsGate.js";
import { ApiError, post, readAuthStatus, type AuthSession, type AuthStatus } from "./auth.js";

type GateState = "checking" | "setup" | "login" | "authenticated" | "legacy" | "error";

export function AuthGate({ setupToken }: { setupToken: string }) {
  const [state, setState] = React.useState<GateState>("checking");
  const [session, setSession] = React.useState<AuthSession | undefined>();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("");
  const [token, setToken] = React.useState(setupToken);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(false);
  const authRevision = React.useRef(0);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const acceptStatus = React.useCallback((status: AuthStatus | null) => {
    if (!mounted.current) return;
    setSession(status?.session);
    setState(
      status === null
        ? "legacy"
        : !status.initialized
          ? "setup"
          : status.authenticated
            ? "authenticated"
            : "login",
    );
    setError("");
    if (status?.initialized) setToken("");
  }, []);

  const check = React.useCallback(async () => {
    const revision = ++authRevision.current;
    try {
      const status = await readAuthStatus();
      if (revision === authRevision.current) acceptStatus(status);
    } catch (cause) {
      if (!mounted.current || revision !== authRevision.current) return;
      // A server restart must not erase an active view or its unsent draft.
      if (stateRef.current === "authenticated" || stateRef.current === "legacy") return;
      setState("error");
      setError(cause instanceof Error ? cause.message : "无法连接服务端");
    }
  }, [acceptStatus]);

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

  const authLost = React.useCallback(() => {
    authRevision.current++;
    setSession(undefined);
    setState("login");
    setPassword("");
    setError("登录已过期或此设备已被撤销，请重新登录。");
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    authRevision.current++;
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
      if (!result.authenticated) throw new Error("登录失败，请重试。");
      authRevision.current++;
      setPassword("");
      setToken("");
      acceptStatus({ initialized: true, authenticated: true, session: result.session });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请重试。");
      if (cause instanceof ApiError && cause.status === 409) void check();
    } finally {
      setBusy(false);
    }
  };

  if (state === "authenticated") {
    return (
      <ProjectsGate onAuthLost={authLost}>
        {(project, onBack) => (
          <App
            session={session}
            hub
            onAuthLost={authLost}
            onCheckAuth={check}
            projectName={project?.name}
            onBackToProjects={onBack}
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
        <div className="auth-brand">
          CodeShell <span>Hub</span>
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
