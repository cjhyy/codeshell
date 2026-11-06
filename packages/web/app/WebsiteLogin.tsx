import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";

export function WebsiteLogin({
  registration = false,
  desktopLogin = false,
}: {
  registration?: boolean;
  desktopLogin?: boolean;
}) {
  const account = useAccountSession();
  const [register, setRegister] = React.useState(registration);
  const [username, setUsername] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [validation, setValidation] = React.useState("");
  React.useEffect(() => {
    if (
      register &&
      account.ready &&
      !account.registrationAllowed &&
      !account.loginCapabilitiesLoading &&
      !account.loginCapabilitiesError
    ) {
      setRegister(false);
      setValidation("");
      setConfirmation("");
    }
  }, [
    register,
    account.ready,
    account.registrationAllowed,
    account.loginCapabilitiesLoading,
    account.loginCapabilitiesError,
  ]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setValidation("");
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(username.trim())) {
      setValidation("用户名须为 3–64 位字母、数字、点、下划线或连字符。");
      return;
    }
    if (password.length < 12 || password.length > 1024) {
      setValidation("密码须为 12–1024 个字符。");
      return;
    }
    if (register && password !== confirmation) {
      setValidation("两次输入的密码不一致。");
      return;
    }
    const nickname = displayName.trim().normalize("NFC");
    if (register && (!nickname || [...nickname].length > 64 || /[\p{Cc}\p{Cs}]/u.test(nickname))) {
      setValidation("昵称须为 1–64 个字符，且不能包含控制字符。");
      return;
    }
    if (
      await account.signIn(register ? "register" : "login", {
        username: username.trim().toLowerCase(),
        password,
        ...(register ? { displayName: nickname } : {}),
      })
    ) {
      setPassword("");
      setConfirmation("");
    }
  };
  return (
    <main className="website-login">
      <header className="website-brand">
        CodeShell <span>工作台</span>
      </header>
      <div className="website-welcome">
        <section className="website-introduction">
          <p className="website-eyebrow">给想法一个开始</p>
          <h1>
            从一句话，
            <br />
            到真正完成。
          </h1>
          <p>
            与 CodeShell 对话，让 Agent 帮你处理任务。
            <br />
            项目、工具与历史记录，都在你的工作空间。
          </p>
          <div className="website-features">
            <p>
              <strong>继续你的工作</strong>
              <span>随时回到对话、任务和项目文件。</span>
            </p>
            <p>
              <strong>选择执行环境</strong>
              <span>任务在你选定的工作区里运行。</span>
            </p>
            <p>
              <strong>按需连接工具</strong>
              <span>GitHub 登录身份与数据访问授权分别管理。</span>
            </p>
          </div>
        </section>
        <section className="auth-card website-auth" aria-labelledby="website-login-title">
          <p className="website-eyebrow">欢迎来到 CodeShell</p>
          <h2 id="website-login-title">
            {register ? "创建你的账号" : desktopLogin ? "登录 CodeShell 电脑端" : "继续你的工作"}
          </h2>
          <p className="website-muted">
            {desktopLogin
              ? "先登录网页账号，再确认要登录的电脑。此页面会保留你的电脑登录请求。"
              : registration
                ? "创建账号后，返回 CodeShell 客户端登录。"
                : "登录后进入你的工作台。"}
          </p>
          {registration &&
          account.ready &&
          !account.loginCapabilitiesLoading &&
          !account.loginCapabilitiesError &&
          !account.registrationAllowed ? (
            <p role="status" className="website-hint">
              当前服务未开放注册，可使用已有账号登录。
            </p>
          ) : null}
          <button
            className="website-button website-wide"
            disabled={account.busy || account.loginCapabilitiesLoading || !account.githubEnabled}
            onClick={() => void account.github("login")}
          >
            使用 GitHub 继续
          </button>
          <p className="website-hint">首次使用 GitHub 登录会按服务设置创建账号。</p>
          {account.loginCapabilitiesLoading ? <p role="status">正在读取登录方式…</p> : null}
          {account.loginCapabilitiesError ? (
            <div>
              <p role="alert" className="form-error">
                {account.loginCapabilitiesError}
              </p>
              <button
                className="website-button"
                disabled={account.loginCapabilitiesLoading}
                onClick={() => void account.refreshLoginCapabilities()}
              >
                重试读取登录方式
              </button>
            </div>
          ) : null}
          <div className="website-divider">或使用用户名和密码</div>
          <form onSubmit={(event) => void submit(event)}>
            {register ? (
              <label>
                昵称
                <input
                  maxLength={128}
                  autoComplete="nickname"
                  value={displayName}
                  disabled={account.busy}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="显示给你的名字"
                  required
                />
              </label>
            ) : null}
            <label>
              用户名
              <input
                maxLength={64}
                autoComplete="username"
                value={username}
                disabled={account.busy}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                maxLength={1024}
                autoComplete={register ? "new-password" : "current-password"}
                value={password}
                disabled={account.busy}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {register ? (
              <label>
                确认密码
                <input
                  type="password"
                  maxLength={1024}
                  autoComplete="new-password"
                  value={confirmation}
                  disabled={account.busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                />
              </label>
            ) : null}
            <button
              className="send website-wide"
              disabled={
                account.busy ||
                !account.ready ||
                (register && (account.loginCapabilitiesLoading || !account.registrationAllowed))
              }
              type="submit"
            >
              {account.busy ? "正在连接…" : register ? "创建账号" : "登录"}
            </button>
          </form>
          {account.registrationAllowed ? (
            <button
              className="ghost website-wide"
              disabled={account.busy || account.loginCapabilitiesLoading}
              onClick={() => {
                setRegister(!register);
                setConfirmation("");
                setValidation("");
                account.clearError();
              }}
            >
              {register ? "已有账号？登录" : "没有账号？创建账号"}
            </button>
          ) : null}
          {account.oauthPending ? (
            <button className="ghost website-wide" onClick={account.cancelGithub}>
              取消 GitHub 授权
            </button>
          ) : null}
          {account.status ? (
            <p role="status" className="website-hint">
              {account.status}
            </p>
          ) : null}
          {validation || account.error ? (
            <p role="alert" className="form-error">
              {validation || account.error}
            </p>
          ) : null}
          {!account.ready && !account.busy ? (
            <button className="website-button" onClick={() => void account.restore()}>
              重试连接
            </button>
          ) : null}
        </section>
      </div>
      <footer className="website-login-footer">CodeShell · 让工作继续</footer>
    </main>
  );
}

/** This page finishes only a website session. Native clients log in separately. */
export function WebsiteRegistration() {
  const account = useAccountSession();
  if (!account.session?.authenticated) return <WebsiteLogin registration />;
  return (
    <main className="website-login">
      <section className="auth-card website-auth">
        <h1>账号已就绪</h1>
        <p>{account.session.account?.displayName}</p>
        <p>请返回 CodeShell 客户端，使用此账号登录。</p>
        <a className="website-button" href="/">
          继续使用网页版
        </a>
        <button className="ghost" disabled={account.busy} onClick={() => void account.logout()}>
          退出当前网页账号
        </button>
        {account.error ? <p role="alert">{account.error}</p> : null}
      </section>
    </main>
  );
}
