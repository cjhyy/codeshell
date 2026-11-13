import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import {
  createBrowserPasskey,
  parsePasskeyCeremony,
  passkeyFailure,
  PASSKEY_EXPLANATION,
  requirePasskey,
  type PasskeyRequest,
} from "./passkey-browser.js";

interface PasskeyEntry {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
}
interface PasskeyList {
  passkeys: PasskeyEntry[];
  bootstrap: { password: boolean; github: boolean };
}
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function parsePasskeys(value: unknown): PasskeyList {
  const list = value as PasskeyList | undefined;
  if (
    !list ||
    !Array.isArray(list.passkeys) ||
    list.passkeys.length > 64 ||
    typeof list.bootstrap?.password !== "boolean" ||
    typeof list.bootstrap.github !== "boolean" ||
    !list.passkeys.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        /^[A-Za-z0-9_-]{1,2048}$/.test(item.id) &&
        typeof item.name === "string" &&
        item.name.trim() &&
        [...item.name].length <= 80 &&
        !/[\p{Cc}\p{Cs}]/u.test(item.name) &&
        Number.isSafeInteger(item.createdAt) &&
        item.createdAt >= 0 &&
        (item.lastUsedAt === undefined ||
          (Number.isSafeInteger(item.lastUsedAt) && item.lastUsedAt >= 0)),
    ) ||
    new Set(list.passkeys.map((item) => item.id)).size !== list.passkeys.length
  )
    throw new Error("Passkey 列表无效，请刷新后重试。");
  return list;
}
function bootstrapProof(value: unknown): string {
  const result = value as { bootstrapProof?: unknown; expiresAt?: number } | undefined;
  if (
    !result ||
    !opaque(result.bootstrapProof) ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt! <= Date.now() ||
    result.expiresAt! > Date.now() + 10 * 60000
  )
    throw new Error("身份验证已失效，请重新验证。");
  return result.bootstrapProof;
}
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function githubBootstrap(request: PasskeyRequest, signal: AbortSignal): Promise<string> {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("请允许此页打开 GitHub 验证窗口后重试。");
  popup.opener = null;
  let receipt: string | undefined;
  const codeVerifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const close = () => popup.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    const codeChallenge = encode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
    );
    signal.throwIfAborted();
    const start = await request<{
      authorizationUrl: string;
      receipt: string;
      expiresAt: number;
      pollIntervalMs: number;
    }>("/github/start", "POST", { mode: "passkey-bootstrap", codeChallenge }, signal);
    if (opaque(start?.receipt)) receipt = start.receipt;
    signal.throwIfAborted();
    const url = new URL(start.authorizationUrl);
    if (
      url.origin !== "https://github.com" ||
      url.pathname !== "/login/oauth/authorize" ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.get("code_challenge") !== codeChallenge ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.get("scope") !== "read:user" ||
      !receipt ||
      !Number.isSafeInteger(start.expiresAt) ||
      start.expiresAt <= Date.now() ||
      start.expiresAt > Date.now() + 15 * 60000
    )
      throw new Error("GitHub 验证请求无效，请重新发起。");
    popup.location.href = url.href;
    while (Date.now() < start.expiresAt) {
      signal.throwIfAborted();
      const result = await request<{ status?: string }>(
        "/github/poll",
        "POST",
        { receipt, codeVerifier },
        signal,
      );
      signal.throwIfAborted();
      if (result.status !== "pending") return bootstrapProof(result);
      if (popup.closed) throw new Error("GitHub 验证窗口已关闭，请重试。");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          Math.min(5000, Math.max(1000, start.pollIntervalMs || 1000)),
        );
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("GitHub 验证已超时，请重试。");
  } finally {
    signal.removeEventListener("abort", close);
    close();
    if (receipt) void request("/github/cancel", "POST", { receipt, codeVerifier }).catch(() => {});
  }
}

export function PasskeySettings() {
  const account = useAccountSession();
  const identity = `${account.session?.account?.id}:${account.session?.session?.id}`;
  return <PasskeySettingsContent key={identity} />;
}
function PasskeySettingsContent() {
  const account = useAccountSession();
  const [list, setList] = React.useState<PasskeyList>();
  const [name, setName] = React.useState("我的 Passkey");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [listError, setListError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [revision, refresh] = React.useState(0);
  const [readyToCreate, setReadyToCreate] = React.useState(false);
  const preparedBootstrap = React.useRef<{ proof: string; expiresAt: number } | null>(null);
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => pending.current?.abort(), []);
  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    void account
      .request("/passkeys", "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setList(parsePasskeys(value));
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setListError(`未能读取最新 Passkey 列表。${passkeyFailure(cause)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account.request, revision]);
  const reload = () => {
    setList(undefined);
    setError("");
    setLoading(true);
    refresh((value) => value + 1);
  };
  const run = async (work: (signal: AbortSignal) => Promise<string>) => {
    if (pending.current || account.busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const message = await work(controller.signal);
      if (!controller.signal.aborted) {
        setStatus(message);
        reload();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(passkeyFailure(cause));
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const add = (method: "password" | "github" | "passkey" | "prepared") => {
    const currentPassword = password;
    setPassword("");
    void run(async (signal) => {
      let proof: { stepUpToken: string } | { bootstrapProof: string };
      if (list?.passkeys.length) {
        const verified = await requirePasskey(
          account.request,
          "passkey-add",
          account.session!.account!.id,
          signal,
        );
        proof = { stepUpToken: verified.stepUpToken };
      } else if (method === "github") {
        const verified = await githubBootstrap(account.request, signal);
        signal.throwIfAborted();
        preparedBootstrap.current = { proof: verified, expiresAt: Date.now() + 60000 };
        setReadyToCreate(true);
        return "GitHub 身份验证完成。点击“创建 Passkey”，继续系统验证。";
      } else if (method === "prepared") {
        const prepared = preparedBootstrap.current;
        preparedBootstrap.current = null;
        setReadyToCreate(false);
        if (!prepared || prepared.expiresAt <= Date.now())
          throw new Error("身份验证已过期，请重新通过 GitHub 验证。");
        proof = { bootstrapProof: prepared.proof };
      } else
        proof = {
          bootstrapProof: bootstrapProof(
            await account.request(
              "/passkeys/bootstrap/password",
              "POST",
              { currentPassword },
              signal,
            ),
          ),
        };
      signal.throwIfAborted();
      const options = parsePasskeyCeremony(
        await account.request(
          "/passkeys/registration/options",
          "POST",
          { name: name.trim(), ...proof },
          signal,
        ),
      );
      const response = await createBrowserPasskey(options.optionsJSON, signal);
      signal.throwIfAborted();
      setStatus("系统验证已完成，正在确认服务器保存…");
      try {
        const result = await account.request<{ verified?: boolean }>(
          "/passkeys/registration/verify",
          "POST",
          { ceremonyId: options.ceremonyId, response },
          signal,
        );
        if (result.verified !== true) throw new Error("服务器尚未确认保存结果。");
      } catch (cause) {
        if (!signal.aborted) setList(undefined);
        throw new Error(
          `系统验证已完成，但尚未确认 Passkey 已保存到此账号。${passkeyFailure(cause)} 请重试读取列表确认结果；系统中可能保留了尚未关联此账号的凭据。`,
          { cause },
        );
      }
      return "Passkey 已保存到此账号。连接电脑时可使用系统验证，无需另设远程口令。";
    });
  };
  const remove = (item: PasskeyEntry) => {
    if (!window.confirm(`移除 Passkey「${item.name}」？之后不能再用它确认远程操作。`)) return;
    void run(async (signal) => {
      const proof = await requirePasskey(account.request, "passkey-delete", item.id, signal);
      const result = await account.request<{ ok?: boolean }>(
        `/passkeys/${encodeURIComponent(item.id)}`,
        "DELETE",
        { stepUpToken: proof.stepUpToken },
        signal,
      );
      if (result.ok !== true) throw new Error("服务器尚未确认移除结果，请刷新列表。");
      return "Passkey 已移除。";
    });
  };
  return (
    <section className="website-settings-card" aria-labelledby="passkey-title">
      <h2 id="passkey-title">Passkey</h2>
      <p>
        所属账号：{account.session?.account?.displayName}（@{account.session?.account?.username}）
      </p>
      <p>{PASSKEY_EXPLANATION} 连接电脑和批准新的桌面端登录时都会验证。</p>
      <p className="website-hint">
        系统验证完成后，还需服务器确认保存。下方列表显示此账号已保存的 Passkey。
      </p>
      {loading ? <p role="status">正在读取 Passkey…</p> : null}
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
      {listError ? (
        <p className="form-error" role="alert">
          {listError}
        </p>
      ) : null}
      {!loading && !list ? (
        <button className="website-button" onClick={reload}>
          重试读取
        </button>
      ) : null}
      {list ? (
        <>
          {list.passkeys.length ? (
            <div className="website-list">
              {list.passkeys.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <p>添加于 {new Date(item.createdAt).toLocaleString()}</p>
                  </div>
                  <button
                    className="website-button"
                    disabled={busy || list.passkeys.length === 1}
                    onClick={() => remove(item)}
                  >
                    移除
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="website-muted">尚未添加 Passkey。首次添加需要重新验证账号身份。</p>
          )}
          {list.passkeys.length === 1 ? (
            <p className="website-hint">请先添加另一把 Passkey，再移除最后一把。</p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              add(list.passkeys.length ? "passkey" : "password");
            }}
          >
            <label>
              Passkey 名称
              <input
                value={name}
                maxLength={80}
                disabled={busy}
                required
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：我的 MacBook"
              />
            </label>
            {!list.passkeys.length && list.bootstrap.password && !readyToCreate ? (
              <label>
                验证账号密码
                <input
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  minLength={12}
                  maxLength={1024}
                  disabled={busy}
                  required
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : null}
            <div className="website-action-row">
              {!readyToCreate && (list.passkeys.length || list.bootstrap.password) ? (
                <button
                  className="website-button primary"
                  disabled={busy || account.busy || !name.trim()}
                  type="submit"
                >
                  {busy ? "正在处理…" : "添加 Passkey"}
                </button>
              ) : null}
              {readyToCreate ? (
                <button
                  className="website-button primary"
                  type="button"
                  disabled={busy || account.busy || !name.trim()}
                  onClick={() => add("prepared")}
                >
                  创建 Passkey
                </button>
              ) : null}
              {!readyToCreate && !list.passkeys.length && list.bootstrap.github ? (
                <button
                  className="website-button"
                  type="button"
                  disabled={busy || account.busy || !name.trim()}
                  onClick={() => add("github")}
                >
                  通过 GitHub 验证并添加
                </button>
              ) : null}
              {busy ? (
                <button
                  className="website-button"
                  type="button"
                  onClick={() => {
                    pending.current?.abort();
                    pending.current = null;
                    preparedBootstrap.current = null;
                    setReadyToCreate(false);
                    setBusy(false);
                    setStatus("已取消，可重新发起。");
                  }}
                >
                  取消
                </button>
              ) : null}
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
