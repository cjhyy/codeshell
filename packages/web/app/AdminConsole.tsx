import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import { AccountWebError, parseAccountOverview } from "./account-api.js";
import type { AdminSection, WebsiteRoute } from "./website-routes.js";
import {
  adminActions,
  adminListPath,
  emptyAdminFilters,
  parseAdminAudit,
  parseAdminSummary,
  parseAdminUsers,
  validAdminUser,
  type AdminFilters,
  type AdminUser,
} from "./admin-data.js";
import "./admin-console.css";

function useAdminData<T>(path: string | null, parse: (value: unknown) => T) {
  const { request, restore, session } = useAccountSession();
  const identity = `${session?.account?.id}:${session?.session?.id}`;
  const [revision, setRevision] = React.useState(0);
  const key = `${identity}:${path}:${revision}`;
  const [result, setResult] = React.useState<{ key: string; value?: T; error?: string }>();
  const parser = React.useRef(parse);
  parser.current = parse;
  React.useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void request<unknown>(path, "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key, value: parser.current(value) });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setResult({ key, error: cause instanceof Error ? cause.message : "读取失败，请重试。" });
        if (cause instanceof AccountWebError && cause.status === 403) void restore();
      });
    return () => controller.abort();
  }, [path, key, request, restore]);
  const current = result?.key === key ? result : undefined;
  return {
    value: current?.value,
    error: current?.error,
    loading: !!path && !current,
    reload: () => setRevision((value) => value + 1),
  };
}

const date = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const titles = { summary: "概览", users: "账号管理", audit: "操作记录" };

export function AdminConsole({
  section,
  go,
}: {
  section: AdminSection;
  go: (route: WebsiteRoute) => void;
}) {
  const account = useAccountSession();
  const administrator = account.session?.account?.role === "admin";
  const data = useAdminData(administrator ? "/overview" : null, (value) =>
    parseAccountOverview(value, account.session!.account!.id),
  );
  if (!administrator || (data.value && !data.value.capabilities.admin))
    return (
      <section className="admin-console">
        <div className="admin-empty">
          <h1>无法访问管理后台</h1>
          <p role="alert">当前账号没有管理员权限。</p>
          <button
            className="website-button"
            onClick={() => go({ kind: "account", section: "profile" })}
          >
            返回账号设置
          </button>
        </div>
      </section>
    );
  return (
    <section className="admin-console" aria-label="管理后台内容">
      {data.loading ? <p role="status">正在验证管理员权限…</p> : null}
      {data.error ? <LoadError error={data.error} retry={data.reload} /> : null}
      {data.value?.capabilities.admin ? (
        <AdminContent
          key={`${account.session?.account?.id}:${account.session?.session?.id}:${section}`}
          section={section}
          go={go}
        />
      ) : null}
    </section>
  );
}

function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="admin-message">
      <p role="alert" className="form-error">
        {error}
      </p>
      <button className="website-button" onClick={retry}>
        重试读取
      </button>
    </div>
  );
}
function Heading({ section, children }: { section: AdminSection; children?: React.ReactNode }) {
  return (
    <header className="admin-heading">
      <div>
        <p className="website-eyebrow">CODESHELL / 管理后台</p>
        <h1>{titles[section]}</h1>
        <p className="website-muted">
          {
            {
              summary: "了解账号与登录情况，快速处理日常管理。",
              users: "查找账号、管理访问权限与登录会话。",
              audit: "查看管理员对账号和登录会话的操作。",
            }[section]
          }
        </p>
      </div>
      {children}
    </header>
  );
}
function AdminContent({
  section,
  go,
}: {
  section: AdminSection;
  go: (route: WebsiteRoute) => void;
}) {
  return section === "summary" ? <Summary go={go} /> : section === "users" ? <Users /> : <Audit />;
}
function Summary({ go }: { go: (route: WebsiteRoute) => void }) {
  const data = useAdminData("/admin/summary", parseAdminSummary);
  return (
    <>
      <Heading section="summary">
        <button className="website-button" disabled={data.loading} onClick={data.reload}>
          刷新
        </button>
      </Heading>
      {data.error ? <LoadError error={data.error} retry={data.reload} /> : null}
      {data.loading ? <p role="status">正在读取系统概览…</p> : null}
      {data.value ? (
        <>
          <div className="admin-statistics">
            {[
              ["账号总数", data.value.users.total, "所有已注册账号"],
              ["正常账号", data.value.users.active, "可登录并使用服务"],
              ["已停用账号", data.value.users.disabled, "已限制账号访问"],
              ["管理员", data.value.users.administrators, "具有后台管理权限"],
              ["有效登录会话", data.value.sessions.active, "尚未过期或被撤销"],
              ["操作记录", data.value.auditEvents, "累计管理操作"],
            ].map(([label, value, hint]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{Number(value).toLocaleString("zh-CN")}</strong>
                <small>{hint}</small>
              </article>
            ))}
          </div>
          <div className="admin-shortcuts">
            <article>
              <h2>管理账号</h2>
              <p>按用户名、昵称或账号 ID 搜索，筛选状态与角色。</p>
              <button
                className="website-button primary"
                onClick={() => go({ kind: "admin", section: "users" })}
              >
                进入账号管理 →
              </button>
            </article>
            <article>
              <h2>查看操作记录</h2>
              <p>核对停用、恢复账号和撤销会话的操作人及时间。</p>
              <button
                className="website-button"
                onClick={() => go({ kind: "admin", section: "audit" })}
              >
                查看操作记录 →
              </button>
            </article>
          </div>
        </>
      ) : null}
    </>
  );
}

function Pagination({
  cursors,
  next,
  busy,
  setCursors,
}: {
  cursors: Array<string | null>;
  next?: string | null;
  busy: boolean;
  setCursors: React.Dispatch<React.SetStateAction<Array<string | null>>>;
}) {
  return (
    <div className="admin-pagination">
      <span>第 {cursors.length} 页</span>
      <div>
        <button
          className="website-button"
          disabled={busy || cursors.length === 1}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          上一页
        </button>
        <button
          className="website-button"
          disabled={busy || !next}
          onClick={() => next && setCursors((value) => [...value, next])}
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function Users() {
  const account = useAccountSession();
  const [draft, setDraft] = React.useState<AdminFilters>(emptyAdminFilters);
  const [filters, setFilters] = React.useState<AdminFilters>(emptyAdminFilters);
  const [cursors, setCursors] = React.useState<Array<string | null>>([null]);
  const data = useAdminData(adminListPath("users", cursors.at(-1)!, filters), parseAdminUsers);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const operation = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => operation.current?.abort(), []);
  const change = async (user: AdminUser, sessions = false) => {
    if (
      operation.current ||
      !window.confirm(
        sessions
          ? `退出 @${user.username} 的所有登录会话？${user.id === account.session?.account?.id ? "你也将退出当前登录。" : "该账号需要重新登录。"}`
          : user.disabled
            ? `恢复 @${user.username} 的账号访问？`
            : `停用 @${user.username}？现有登录会话也会被撤销。`,
      )
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await account.request<{ user?: unknown; ok?: boolean; revoked?: number }>(
        `/admin/users/${user.id}${sessions ? "/revoke-sessions" : ""}`,
        sessions ? "POST" : "PATCH",
        sessions ? {} : { disabled: !user.disabled },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        sessions
          ? result.ok !== true || !Number.isSafeInteger(result.revoked) || result.revoked! < 0
          : !validAdminUser(result.user) ||
            result.user.id !== user.id ||
            result.user.disabled !== !user.disabled
      )
        throw new Error("操作结果尚未确认，请刷新列表核对。");
      setStatus(
        sessions
          ? `已退出 @${user.username} 的登录会话。`
          : `已${user.disabled ? "恢复" : "停用"} @${user.username}。`,
      );
      if (sessions && user.id === account.session?.account?.id) await account.restore();
      else {
        setCursors([null]);
        data.reload();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "操作未完成，请重试。");
        if (cause instanceof AccountWebError && cause.status === 403) void account.restore();
      }
    } finally {
      if (!controller.signal.aborted) {
        operation.current = null;
        setBusy(false);
      }
    }
  };
  const reset = () => {
    setDraft(emptyAdminFilters);
    setFilters(emptyAdminFilters);
    setCursors([null]);
    setError("");
    setStatus("");
    data.reload();
  };
  return (
    <>
      <Heading section="users">
        <button
          className="website-button"
          disabled={busy || data.loading}
          onClick={() => {
            setCursors([null]);
            data.reload();
          }}
        >
          刷新
        </button>
      </Heading>
      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setFilters({ ...draft, q: draft.q.trim() });
          setCursors([null]);
          setError("");
          setStatus("");
          data.reload();
        }}
      >
        <label className="admin-search" htmlFor="admin-search">
          搜索账号
          <input
            id="admin-search"
            type="search"
            placeholder="用户名、昵称或账号 ID"
            maxLength={128}
            value={draft.q}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, q: event.target.value })}
          />
        </label>
        <label htmlFor="admin-status">
          账号状态
          <select
            id="admin-status"
            value={draft.status}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value as AdminFilters["status"] })
            }
          >
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已停用</option>
          </select>
        </label>
        <label htmlFor="admin-role">
          账号角色
          <select
            id="admin-role"
            value={draft.role}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, role: event.target.value as AdminFilters["role"] })
            }
          >
            <option value="">全部角色</option>
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button type="submit" className="website-button primary" disabled={busy}>
          搜索
        </button>
        <button type="button" className="website-button" disabled={busy} onClick={reset}>
          重置
        </button>
      </form>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="website-notice">
          {status}
        </p>
      ) : null}
      {data.error ? <LoadError error={data.error} retry={data.reload} /> : null}
      {data.loading ? <p role="status">正在读取账号…</p> : null}
      {data.value ? (
        <>
          <p className="admin-scroll-hint website-hint">左右滑动表格可查看完整信息与操作。</p>
          <div className="admin-results">
            <span>本页 {data.value.users.length} 个账号</span>
            <span>停用账号会同时撤销其登录会话</span>
          </div>
          {data.value.users.length ? (
            <div className="admin-table-scroll" role="region" aria-label="账号列表" tabIndex={0}>
              <table className="admin-table">
                <thead>
                  <tr>
                    {["账号", "角色", "状态", "登录会话", "注册时间", "操作"].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.value.users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <div className="admin-account">
                          <span className="admin-avatar" aria-hidden="true">
                            {Array.from(user.displayName)[0]}
                          </span>
                          <div>
                            <strong>{user.displayName}</strong>
                            <span>
                              @{user.username}
                              {user.id === account.session?.account?.id ? " · 当前账号" : ""}
                            </span>
                          </div>
                        </div>
                        <code className="admin-account-id">{user.id}</code>
                      </td>
                      <td>
                        <span className={`admin-badge ${user.role === "admin" ? "is-admin" : ""}`}>
                          {user.role === "admin" ? "管理员" : "成员"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`admin-badge ${user.disabled ? "is-disabled" : "is-active"}`}
                        >
                          {user.disabled ? "已停用" : "正常"}
                        </span>
                      </td>
                      <td>{user.sessionCount}</td>
                      <td className="admin-date">{date(user.createdAt)}</td>
                      <td>
                        <div className="admin-row-actions">
                          {user.id !== account.session?.account?.id && user.role !== "admin" ? (
                            <button
                              className={`website-button ${user.disabled ? "" : "admin-danger"}`}
                              disabled={busy}
                              onClick={() => void change(user)}
                            >
                              {user.disabled ? "恢复" : "停用"}
                            </button>
                          ) : (
                            <span className="website-hint">受保护账号</span>
                          )}
                          <button
                            className="website-button"
                            disabled={busy || !user.sessionCount}
                            onClick={() => void change(user, true)}
                          >
                            退出会话
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="admin-empty">
              <h2>没有匹配的账号</h2>
              <p>试试其他关键词，或重置筛选查看全部账号。</p>
              <button className="website-button" disabled={busy} onClick={reset}>
                重置筛选
              </button>
            </div>
          )}
          <Pagination
            cursors={cursors}
            setCursors={setCursors}
            next={data.value.nextCursor}
            busy={busy || data.loading}
          />
        </>
      ) : null}
    </>
  );
}

function Audit() {
  const [cursors, setCursors] = React.useState<Array<string | null>>([null]);
  const data = useAdminData(adminListPath("audit", cursors.at(-1)!), parseAdminAudit);
  return (
    <>
      <Heading section="audit">
        <button
          className="website-button"
          disabled={data.loading}
          onClick={() => {
            setCursors([null]);
            data.reload();
          }}
        >
          刷新
        </button>
      </Heading>
      {data.error ? <LoadError error={data.error} retry={data.reload} /> : null}
      {data.loading ? <p role="status">正在读取操作记录…</p> : null}
      {data.value ? (
        <>
          {data.value.events.length ? (
            <div className="admin-audit">
              {data.value.events.map((event) => (
                <article key={event.id}>
                  <div
                    className={`admin-audit-mark ${event.action === "admin.account.disabled" ? "admin-danger" : ""}`}
                    aria-hidden="true"
                  >
                    {event.action === "admin.account.disabled"
                      ? "−"
                      : event.action === "admin.account.enabled"
                        ? "+"
                        : "↪"}
                  </div>
                  <div>
                    <h2>{adminActions[event.action]}</h2>
                    <dl>
                      <div>
                        <dt>操作人</dt>
                        <dd>
                          <code>{event.actorId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>目标账号</dt>
                        <dd>
                          <code>{event.targetId}</code>
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <time dateTime={new Date(event.createdAt).toISOString()}>
                    {date(event.createdAt)}
                  </time>
                </article>
              ))}
            </div>
          ) : (
            <div className="admin-empty">
              <h2>暂无操作记录</h2>
              <p>管理员停用、恢复账号或撤销会话后，操作会显示在这里。</p>
            </div>
          )}
          <Pagination
            cursors={cursors}
            setCursors={setCursors}
            next={data.value.nextCursor}
            busy={data.loading}
          />
        </>
      ) : null}
    </>
  );
}
