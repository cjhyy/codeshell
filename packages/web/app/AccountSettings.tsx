import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import {
  AccountWebError,
  parseAccountOverview,
  type AccountOverview,
  type WebsiteAccount,
  validWebsiteAccount,
} from "./account-api.js";
import type { WebsiteRoute } from "./website-routes.js";

function useAccountData<T>(path: string | null) {
  const { request } = useAccountSession();
  const [value, setValue] = React.useState<T>();
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(!!path);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setValue(undefined);
    setError("");
    setLoading(!!path);
    if (path)
      void request<T>(path, "GET", undefined, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setValue(next);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    return () => controller.abort();
  }, [path, request, revision]);
  return { value, error, loading, reload: () => setRevision((previous) => previous + 1) };
}
function Notice({ error, status }: { error?: string; status?: string }) {
  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="website-notice" role="status">
          {status}
        </p>
      ) : null}
    </>
  );
}
const date = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 ? new Date(value).toLocaleString() : "—";
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function AccountSettings({
  route,
}: {
  route: Exclude<WebsiteRoute, { kind: "workbench" }>;
}) {
  const account = useAccountSession();
  const data = useAccountData<unknown>("/overview");
  let overview: AccountOverview | undefined,
    validation = "";
  if (data.value && account.session?.account) {
    try {
      overview = parseAccountOverview(data.value, account.session.account.id);
    } catch (cause) {
      validation = (cause as Error).message;
    }
  }
  const isAdmin =
    overview?.capabilities.admin === true && account.session?.account?.role === "admin";
  return (
    <section className="website-settings-content">
      <Notice error={data.error || validation} />
      {data.loading ? <p role="status">正在读取账号设置…</p> : null}
      {data.error || validation ? (
        <button className="website-button" onClick={data.reload}>
          重试读取
        </button>
      ) : null}
      {overview && route.kind === "account" ? (
        <>
          {route.section === "profile" ? (
            <ProfileSettings key={overview.account.id} profile={overview.account} />
          ) : null}
          {route.section === "security" ? <SecuritySettings overview={overview} /> : null}
          {route.section === "sessions" ? (
            <SessionSettings enabled={overview.capabilities.sessions} />
          ) : null}
          {route.section === "connections" ? (
            <ConnectionSettings overview={overview} reload={data.reload} />
          ) : null}
        </>
      ) : null}
      {overview && route.kind === "admin" ? (
        isAdmin ? (
          <AdminSettings section={route.section} />
        ) : (
          <p role="alert">当前账号没有管理员权限。</p>
        )
      ) : null}
    </section>
  );
}

function ProfileSettings({ profile }: { profile: WebsiteAccount }) {
  const account = useAccountSession();
  const [displayName, setDisplayName] = React.useState(profile.displayName);
  const [username, setUsername] = React.useState(profile.username);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const live = React.useRef(true);
  React.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const nickname = displayName.trim().normalize("NFC"),
      name = username.trim().toLowerCase();
    if (
      !nickname ||
      [...nickname].length > 64 ||
      /[\p{Cc}\p{Cs}\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(nickname)
    ) {
      setError("昵称须为 1–64 个字符，且不能包含控制字符。");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(name)) {
      setError("用户名须为 3–64 位字母、数字、点、下划线或连字符。");
      return;
    }
    const patch = {
      ...(nickname === profile.displayName ? {} : { displayName: nickname }),
      ...(name === profile.username ? {} : { username: name }),
    };
    if (busy || !Object.keys(patch).length) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const value = await account.request<{ account: WebsiteAccount }>("/profile", "PATCH", patch);
      if (value.account?.id !== profile.id)
        throw new AccountWebError("账号资料结果无效，请刷新后重试。");
      await account.restore();
      if (live.current) setStatus("账号资料已保存。");
    } catch (cause) {
      if (live.current) setError((cause as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <>
      <SettingsHeading
        title="账号资料"
        description="昵称用于显示，用户名用于密码登录，分别修改。"
      />
      <form className="website-settings-card" onSubmit={(event) => void save(event)}>
        <label>
          昵称
          <input
            autoComplete="nickname"
            value={displayName}
            maxLength={128}
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label>
          登录用户名
          <input
            autoComplete="username"
            value={username}
            maxLength={64}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
          <small>修改用户名后，请使用新的用户名登录。昵称不会自动变化。</small>
        </label>
        <button className="website-button primary" type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存修改"}
        </button>
        <Notice error={error} status={status} />
      </form>
    </>
  );
}

function SettingsHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="website-settings-heading">
      <p className="website-eyebrow">设置</p>
      <h1>{title}</h1>
      <p className="website-muted">{description}</p>
    </header>
  );
}
function SecuritySettings({ overview }: { overview: AccountOverview }) {
  const { request } = useAccountSession();
  const [currentPassword, setCurrent] = React.useState("");
  const [newPassword, setNext] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const controller = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => controller.current?.abort(), []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !overview.capabilities.passwordChange) return;
    setError("");
    if (newPassword.length < 12 || newPassword.length > 1024) {
      setError("新密码须为 12–1024 个字符。");
      return;
    }
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (!window.confirm("修改密码后，其他登录会话及其设备授权将退出。继续修改吗？")) return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setStatus("");
    try {
      await request("/password", "POST", { currentPassword, newPassword }, operation.signal);
      if (!operation.signal.aborted) {
        setCurrent("");
        setNext("");
        setConfirmation("");
        setStatus("密码已修改，其他登录会话已退出。");
      }
    } catch (cause) {
      if (!operation.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!operation.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <SettingsHeading title="安全" description="管理密码与账号登录方式。" />
      <div className="website-settings-card">
        <h2>密码</h2>
        {overview.capabilities.passwordChange ? (
          <form onSubmit={(event) => void save(event)}>
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                maxLength={1024}
                value={currentPassword}
                disabled={busy}
                onChange={(event) => setCurrent(event.target.value)}
                required
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={newPassword}
                disabled={busy}
                onChange={(event) => setNext(event.target.value)}
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
                required
              />
            </label>
            <button className="website-button" disabled={busy} type="submit">
              修改密码
            </button>
          </form>
        ) : (
          <p className="website-muted">此账号使用 GitHub 登录，尚未设置密码。请继续使用 GitHub。</p>
        )}
        <Notice error={error} status={status} />
      </div>
    </>
  );
}

interface LoginSession {
  id: string;
  deviceName: string;
  kind: string;
  createdAt: number;
  expiresAt: number;
  current: boolean;
}
function SessionSettings({ enabled }: { enabled: boolean }) {
  const account = useAccountSession();
  const data = useAccountData<{ sessions: LoginSession[]; total: number; hasMore: boolean }>(
    enabled ? "/sessions" : null,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const revoke = async (item?: LoginSession) => {
    if (
      busy ||
      !window.confirm(
        item?.current
          ? "退出当前登录？未发送内容会被清除。"
          : item
            ? "退出此登录会话？其派生设备授权也会撤销。"
            : "退出其他所有登录会话及其设备授权？",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await account.request(
        item ? `/sessions/${item.id}` : "/sessions/revoke-others",
        item ? "DELETE" : "POST",
        item ? undefined : {},
      );
      if (item?.current) await account.restore();
      else if (alive.current) data.reload();
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const valid =
    data.value &&
    Array.isArray(data.value.sessions) &&
    data.value.sessions.length <= 64 &&
    data.value.sessions.every(
      (item) =>
        uuid(item.id) &&
        typeof item.deviceName === "string" &&
        typeof item.current === "boolean" &&
        Number.isSafeInteger(item.expiresAt),
    );
  return (
    <>
      <SettingsHeading
        title="登录会话"
        description="查看账号的有效登录，退出不再使用的设备或浏览器。"
      />
      {!enabled ? (
        <p>当前服务尚未开放登录会话管理。</p>
      ) : (
        <>
          <div className="website-action-row">
            <button className="website-button" disabled={busy} onClick={data.reload}>
              刷新
            </button>
            <button className="website-button" disabled={busy} onClick={() => void revoke()}>
              退出其他会话
            </button>
          </div>
          <Notice
            error={
              error ||
              data.error ||
              (data.value && !valid ? "会话列表数据无效，请刷新后重试。" : "")
            }
          />
          {data.loading ? <p role="status">正在读取登录会话…</p> : null}
          {valid ? (
            <>
              <p className="website-hint">
                {data.value!.hasMore
                  ? `显示最近 ${data.value!.sessions.length} 个登录会话，共 ${data.value!.total} 个。`
                  : `共 ${data.value!.total ?? data.value!.sessions.length} 个有效登录。`}
              </p>
              <div className="website-list">
                {data.value!.sessions.map((item) => (
                  <article key={item.id}>
                    <div>
                      <strong>{item.deviceName}</strong>
                      {item.current ? <span className="website-tag">当前登录</span> : null}
                      <p>
                        创建于 {date(item.createdAt)} · 有效期至 {date(item.expiresAt)}
                      </p>
                    </div>
                    <button
                      className="website-button"
                      disabled={busy}
                      onClick={() => void revoke(item)}
                    >
                      退出
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

interface LinkConnection {
  id: string;
  provider: string;
  account: { id: string; login?: string; label?: string };
  revoked: boolean;
}
interface LinkGrant {
  id: string;
  connectionId: string;
  client: { id: string; name: string };
  scopes: string[];
  resources: string[];
  revoked: boolean;
}
function ConnectionSettings({
  overview,
  reload,
}: {
  overview: AccountOverview;
  reload: () => void;
}) {
  const account = useAccountSession();
  const data = useAccountData<{ connections: LinkConnection[]; grants: LinkGrant[] }>(
    overview.capabilities.links ? "/links" : null,
  );
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const controller = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => controller.current?.abort(), []);
  const revoke = async (kind: "connections" | "grants", id: string) => {
    if (
      busy ||
      !window.confirm(
        kind === "connections" ? "撤销这个数据连接及相关授权？" : "撤销这个工具授权？",
      )
    )
      return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError("");
    try {
      const result = await account.request<{ revoked: boolean }>(
        `/links/${kind}/${id}`,
        "DELETE",
        undefined,
        operation.signal,
      );
      if (result.revoked !== true)
        throw new AccountWebError("数据授权撤销尚未确认，请刷新后重试。");
      if (!operation.signal.aborted) data.reload();
    } catch (cause) {
      if (!operation.signal.aborted) setError((cause as Error).message);
    } finally {
      if (!operation.signal.aborted) setBusy(false);
    }
  };
  const valid =
    data.value &&
    Array.isArray(data.value.connections) &&
    data.value.connections.length <= 512 &&
    Array.isArray(data.value.grants) &&
    data.value.grants.length <= 4096 &&
    data.value.connections.every(
      (item) =>
        uuid(item.id) &&
        typeof item.provider === "string" &&
        typeof item.revoked === "boolean" &&
        typeof item.account?.id === "string" &&
        (item.account.label === undefined || typeof item.account.label === "string") &&
        (item.account.login === undefined || typeof item.account.login === "string"),
    ) &&
    data.value.grants.every(
      (item) =>
        uuid(item.id) &&
        uuid(item.connectionId) &&
        typeof item.client?.name === "string" &&
        typeof item.revoked === "boolean" &&
        Array.isArray(item.scopes) &&
        item.scopes.every((scope) => typeof scope === "string") &&
        Array.isArray(item.resources) &&
        item.resources.every((resource) => typeof resource === "string"),
    );
  const rows = valid
    ? [
        ...data
          .value!.connections.filter((item) => !item.revoked)
          .map((item) => ({
            kind: "connections" as const,
            id: item.id,
            title: item.account.label || item.account.login || item.provider,
            description: `${item.provider} · 数据连接`,
          })),
        ...data
          .value!.grants.filter((item) => !item.revoked)
          .map((item) => ({
            kind: "grants" as const,
            id: item.id,
            title: item.client.name,
            description: `权限：${item.scopes.join("、")} · 资源：${item.resources.join("、")}`,
          })),
      ]
    : [];
  return (
    <>
      <SettingsHeading title="连接" description="GitHub 登录身份与工具的数据访问授权分别管理。" />
      <div className="website-settings-card">
        <div className="website-setting-line">
          <div>
            <h2>GitHub 登录身份</h2>
            <p className="website-muted">用于登录 CodeShell，不代表已授权仓库访问。</p>
          </div>
          <span className="website-tag">
            {overview.security.githubLinked ? "已关联" : "未关联"}
          </span>
        </div>
        {!overview.security.githubLinked && account.githubEnabled ? (
          <button
            className="website-button"
            disabled={account.busy}
            onClick={() => void account.github("link").then(reload)}
          >
            关联 GitHub 登录身份
          </button>
        ) : null}
        {account.oauthPending ? (
          <button className="website-button" onClick={account.cancelGithub}>
            取消关联
          </button>
        ) : null}
        <button className="ghost" disabled={account.busy} onClick={reload}>
          刷新登录方式
        </button>
        <Notice error={account.error} status={account.status} />
      </div>
      <h2>Link 数据连接</h2>
      {!overview.capabilities.links ? (
        <p className="website-muted">当前服务尚未开放数据连接管理。</p>
      ) : (
        <>
          <button className="website-button" disabled={busy} onClick={data.reload}>
            刷新数据连接
          </button>
          <Notice
            error={
              error ||
              data.error ||
              (data.value && !valid ? "数据连接列表无效，请刷新后重试。" : "")
            }
          />
          {valid ? (
            <div className="website-list">
              {rows.map((item) => (
                <article key={`${item.kind}:${item.id}`}>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                  </div>
                  <button
                    className="website-button"
                    disabled={busy}
                    onClick={() => void revoke(item.kind, item.id)}
                  >
                    撤销
                  </button>
                </article>
              ))}
              {!rows.length ? <p className="website-muted">还没有数据连接。</p> : null}
            </div>
          ) : null}
        </>
      )}
      <p className="website-hint">退出登录不会自动撤销已有 Link 数据授权。</p>
    </>
  );
}

interface AdminUser extends WebsiteAccount {
  disabled: boolean;
  createdAt: number;
  sessionCount: number;
}
function AdminSettings({ section }: { section: "users" | "summary" | "audit" }) {
  const account = useAccountSession();
  const [cursor, setCursor] = React.useState<string | null>(null);
  const data = useAccountData<any>(
    section === "summary"
      ? "/admin/summary"
      : `/admin/${section}?limit=30${cursor ? `&cursor=${cursor}` : ""}`,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const controller = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => controller.current?.abort(), []);
  const change = async (user: AdminUser, sessions = false) => {
    if (
      busy ||
      !window.confirm(
        sessions
          ? `退出 ${user.username} 的所有登录会话？`
          : `${user.disabled ? "恢复" : "停用"}账号 ${user.username}？`,
      )
    )
      return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError("");
    try {
      await account.request(
        `/admin/users/${user.id}${sessions ? "/revoke-sessions" : ""}`,
        sessions ? "POST" : "PATCH",
        sessions ? {} : { disabled: !user.disabled },
        operation.signal,
      );
      if (!operation.signal.aborted) data.reload();
    } catch (cause) {
      if (!operation.signal.aborted) {
        setError((cause as Error).message);
        if (cause instanceof AccountWebError && cause.status === 403) void account.restore();
      }
    } finally {
      if (!operation.signal.aborted) setBusy(false);
    }
  };
  const nextCursor = uuid(data.value?.nextCursor) ? data.value.nextCursor : null;
  const paginationValid = data.value?.nextCursor === null || uuid(data.value?.nextCursor);
  const users =
    section === "users" &&
    Array.isArray(data.value?.users) &&
    data.value.users.length <= 30 &&
    paginationValid &&
    data.value.users.every(
      (item: AdminUser) =>
        validWebsiteAccount(item) &&
        typeof item.disabled === "boolean" &&
        Number.isSafeInteger(item.createdAt) &&
        item.createdAt >= 0 &&
        Number.isSafeInteger(item.sessionCount) &&
        item.sessionCount >= 0,
    )
      ? (data.value.users as AdminUser[])
      : null;
  const events =
    section === "audit" &&
    Array.isArray(data.value?.events) &&
    data.value.events.length <= 30 &&
    paginationValid &&
    data.value.events.every(
      (item: any) =>
        uuid(item.id) &&
        uuid(item.actorId) &&
        uuid(item.targetId) &&
        ["admin.account.disabled", "admin.account.enabled", "admin.sessions.revoked"].includes(
          item.action,
        ),
    )
      ? (data.value.events as Array<{
          id: string;
          actorId: string;
          targetId: string;
          action: string;
          createdAt: number;
        }>)
      : null;
  const summary =
    section === "summary" &&
    data.value?.users &&
    [
      data.value.users.total,
      data.value.users.active,
      data.value.users.disabled,
      data.value.users.administrators,
      data.value.sessions?.active,
      data.value.auditEvents,
    ].every((item) => Number.isSafeInteger(item) && item >= 0)
      ? data.value
      : null;
  return (
    <>
      <SettingsHeading
        title={section === "users" ? "用户管理" : section === "summary" ? "系统统计" : "操作记录"}
        description="管理员控制台 · 权限由服务端核验。"
      />
      <button
        className="website-button"
        disabled={busy}
        onClick={() => {
          setCursor(null);
          data.reload();
        }}
      >
        刷新
      </button>
      <Notice error={error || data.error} />
      {data.loading ? <p role="status">正在读取…</p> : null}
      {users ? (
        <div className="website-list">
          {users.map((user) => (
            <article key={user.id}>
              <div>
                <strong>{user.displayName}</strong>
                <p>
                  @{user.username} · {user.role === "admin" ? "管理员" : "成员"} ·{" "}
                  {user.disabled ? "已停用" : "正常"}
                </p>
                <p>
                  {user.sessionCount} 个登录会话 · 创建于 {date(user.createdAt)}
                </p>
              </div>
              <div className="website-action-row">
                {user.role !== "admin" && user.id !== account.session?.account?.id ? (
                  <button
                    className="website-button"
                    disabled={busy}
                    onClick={() => void change(user)}
                  >
                    {user.disabled ? "恢复" : "停用"}
                  </button>
                ) : null}
                <button
                  className="website-button"
                  disabled={busy}
                  onClick={() => void change(user, true)}
                >
                  退出会话
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {events ? (
        <div className="website-list">
          {events.map((item) => (
            <article key={item.id}>
              <div>
                <strong>
                  {
                    {
                      "admin.account.disabled": "停用账号",
                      "admin.account.enabled": "恢复账号",
                      "admin.sessions.revoked": "撤销登录会话",
                    }[item.action]
                  }
                </strong>
                <p>
                  操作人 {item.actorId} · 目标 {item.targetId}
                </p>
                <p>{date(item.createdAt)}</p>
              </div>
            </article>
          ))}
          {!events.length ? <p className="website-muted">暂无操作记录。</p> : null}
        </div>
      ) : null}
      {summary ? (
        <div className="website-statistics">
          {[
            ["账号总数", summary.users.total],
            ["正常账号", summary.users.active],
            ["停用账号", summary.users.disabled],
            ["管理员", summary.users.administrators],
            ["有效登录", summary.sessions.active],
            ["审计事件", summary.auditEvents],
          ].map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>
      ) : null}
      {data.value && !users && !events && !summary ? (
        <p role="alert">管理员数据无效，请刷新后重试。</p>
      ) : null}
      {nextCursor ? (
        <button
          className="website-button"
          disabled={busy || data.loading}
          onClick={() => setCursor(nextCursor)}
        >
          下一页
        </button>
      ) : null}
    </>
  );
}
