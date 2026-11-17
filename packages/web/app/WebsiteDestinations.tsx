import React from "react";
import { useAccountSession } from "./AccountSessionProvider.js";
import { useAccountFeature } from "./useAccountFeature.js";
import {
  parseWebsiteComputers,
  websiteComputerClaim,
  type WebsiteComputer,
} from "./website-devices.js";
import "./website-destinations.css";
import { websiteRouteUrl } from "./website-routes.js";
import {
  requirePasskey,
  passkeyFailure,
  PASSKEY_SETTINGS_URL,
  PASSKEY_EXPLANATION,
} from "./passkey-browser.js";

function DestinationIcon({
  kind,
  size = 20,
}: {
  kind: "cloud" | "computer" | "refresh" | "open";
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "cloud" ? (
        <path d="M7 18a5 5 0 1 1 1-9.9A7 7 0 0 1 21 11a3.5 3.5 0 0 1-1 7H7Z" />
      ) : kind === "computer" ? (
        <>
          <rect x="3" y="3" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 16v5" />
        </>
      ) : kind === "refresh" ? (
        <>
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
        </>
      ) : (
        <path d="M6 18 18 6M6 6h12v12" />
      )}
    </svg>
  );
}

export function WebsiteDestinations({
  onCloud,
  accountControl,
  requestedComputer,
}: {
  onCloud: () => void;
  accountControl: React.ReactNode;
  /** Public ID only. Authorization always comes from the current account and Passkey. */
  requestedComputer?: string | null;
}) {
  const account = useAccountSession();
  const cloud = useAccountFeature("cloud.projects");
  const directory = useAccountFeature("devices.directory");
  const phone = useAccountFeature("relay.phone");
  const identity = `${account.session?.account?.id}:${account.session?.session?.id}`;
  const [computers, setComputers] = React.useState<WebsiteComputer[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [directoryError, setDirectoryError] = React.useState("");
  const [opening, setOpening] = React.useState<string | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const pendingOpen = React.useRef<AbortController | null>(null);
  const generation = React.useRef(0);
  const availableComputers = React.useRef<WebsiteComputer[]>([]);
  const openingTarget = React.useRef<WebsiteComputer | null>(null);
  React.useEffect(() => {
    const epoch = ++generation.current;
    const controller = new AbortController();
    pendingOpen.current?.abort();
    pendingOpen.current = null;
    setOpening(null);
    setComputers([]);
    availableComputers.current = [];
    openingTarget.current = null;
    setError("");
    setDirectoryError("");
    setLoading(directory.state === "ready" && requestedComputer !== null);
    if (directory.state !== "ready" || requestedComputer === null) return () => controller.abort();
    let active = false;
    const load = async () => {
      if (active) return;
      active = true;
      try {
        const value = await account.request("/remote-hosts", "GET", undefined, controller.signal);
        const next = parseWebsiteComputers(value, window.location.origin);
        if (!controller.signal.aborted && epoch === generation.current) {
          const available = next.filter((host) => !host.revoked);
          availableComputers.current = available;
          setComputers(available);
          setDirectoryError("");
          const selected = openingTarget.current;
          if (
            selected &&
            !available.some(
              (host) =>
                host.hostId === selected.hostId &&
                host.environmentId === selected.environmentId &&
                host.publicOrigin === selected.publicOrigin &&
                host.online,
            )
          ) {
            pendingOpen.current?.abort();
            pendingOpen.current = null;
            openingTarget.current = null;
            setOpening(null);
            setError("这台电脑已离线或授权发生变化，请确认状态后重新连接。");
          }
        }
      } catch {
        if (!controller.signal.aborted && epoch === generation.current)
          setDirectoryError("暂时无法读取电脑列表，请重试。不会自动切换云端或电脑。");
      } finally {
        active = false;
        if (!controller.signal.aborted && epoch === generation.current) setLoading(false);
      }
    };
    void load();
    // Desktop enrollment may finish just after browser approval redirects here.
    const timer = setInterval(() => void load(), 15000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      controller.abort();
      pendingOpen.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [identity, directory.state, refresh, account.request, requestedComputer]);

  async function openComputer(host: WebsiteComputer) {
    if (pendingOpen.current || !host.online || host.revoked || phone.state !== "ready") return;
    const controller = new AbortController();
    pendingOpen.current = controller;
    openingTarget.current = host;
    const epoch = generation.current;
    setOpening(host.hostId);
    setError("");
    try {
      const proof = await requirePasskey(
        account.request,
        "remote-access",
        host.hostId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const value = await account.request(
        `/remote-hosts/${host.hostId}/client-access`,
        "POST",
        { client: "browser", stepUpToken: proof.stepUpToken },
        controller.signal,
      );
      const destination = websiteComputerClaim(value, host);
      if (
        !controller.signal.aborted &&
        epoch === generation.current &&
        account.workspaceActive(identity) &&
        availableComputers.current.some(
          (current) =>
            current.hostId === host.hostId &&
            current.environmentId === host.environmentId &&
            current.publicOrigin === host.publicOrigin &&
            current.online &&
            !current.revoked,
        )
      )
        window.location.assign(destination);
    } catch (cause) {
      if (!controller.signal.aborted && epoch === generation.current)
        setError(passkeyFailure(cause));
    } finally {
      if (pendingOpen.current === controller) {
        pendingOpen.current = null;
        openingTarget.current = null;
        setOpening(null);
      }
    }
  }

  const selected = computers.find((host) => host.hostId === requestedComputer);
  const passkeySettings = websiteRouteUrl(
    { kind: "account", section: "security" },
    new URL(window.location.href),
  );
  if (requestedComputer !== undefined) {
    const unavailable =
      requestedComputer === null
        ? "电脑链接无效，请返回桌面端重新打开。"
        : directory.state !== "ready"
          ? directory.state === "pending"
            ? "账号服务暂时无法连接，请稍后重试。"
            : "当前账号服务尚未开放电脑连接。"
          : loading || directoryError
            ? ""
            : !selected
              ? "当前账号里找不到这台电脑。请在右上角确认账号，或返回桌面端重新打开。"
              : !selected.online
                ? "这台电脑暂时无法连接。请让它保持在线，并开启允许远程访问。"
                : phone.state !== "ready"
                  ? "远程访问暂不可用，请稍后重试。"
                  : "";
    return (
      <main className="website-destinations">
        <header className="website-destinations-header">
          <a className="website-brand" href="/">
            CodeShell
          </a>
          {accountControl}
        </header>
        <section className="website-destinations-content" aria-labelledby="computer-heading">
          <p className="website-eyebrow">连接电脑</p>
          <h1 id="computer-heading">{selected?.name ?? "打开电脑"}</h1>
          <p className="website-muted">
            验证后直接进入这台电脑的工作台，继续原来的聊天，也可以直接开始新对话，无需先选项目。
          </p>
          {loading ? <p role="status">正在确认所选电脑…</p> : null}
          {directoryError || error || unavailable ? (
            <p role="alert" className="form-error">
              {directoryError || error || unavailable}
            </p>
          ) : null}
          {selected ? (
            <article className="website-destination-card">
              <span className="website-destination-icon">
                <DestinationIcon kind="computer" size={24} />
              </span>
              <div>
                <h2>{selected.name}</h2>
                <p className={selected.online ? "website-computer-online" : ""}>
                  {selected.online ? "在线" : "暂不可连接"}
                </p>
              </div>
              <button
                className="website-button primary"
                disabled={
                  !selected.online || !!opening || phone.state !== "ready" || !!directoryError
                }
                onClick={() => void openComputer(selected)}
              >
                {opening ? "正在验证并连接…" : "使用指纹连接"}
              </button>
            </article>
          ) : null}
          {opening ? (
            <p role="status" className="website-hint">
              请完成当前设备的身份验证，随后会打开这台电脑原有的聊天。
            </p>
          ) : null}
          <p className="website-hint">
            {PASSKEY_EXPLANATION} <a href={passkeySettings}>管理 Passkey</a>
          </p>
          <div className="website-computer-entry-actions">
            {requestedComputer !== null ? (
              <button
                className="website-button"
                disabled={loading || !!opening}
                onClick={() => {
                  setRefresh((value) => value + 1);
                  if (directory.state !== "ready" || phone.state !== "ready")
                    void account.restore();
                }}
              >
                <DestinationIcon kind="refresh" size={15} /> 刷新状态
              </button>
            ) : null}
            <a href="/app?target=choose">选择其他电脑</a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="website-destinations">
      <header className="website-destinations-header">
        <a className="website-brand" href="/">
          CodeShell
        </a>
        {accountControl}
      </header>
      <section className="website-destinations-content" aria-labelledby="destination-heading">
        <p className="website-eyebrow">远程工作台</p>
        <h1 id="destination-heading">选择云端或电脑</h1>
        <p className="website-muted">
          在云端开始工作，或连接你已登录的电脑，继续使用那里的项目和工具，无需重新创建工作区。
        </p>
        <p className="website-hint">
          连接电脑时，{PASSKEY_EXPLANATION} <a href={PASSKEY_SETTINGS_URL}>管理 Passkey</a>
        </p>
        <article className="website-destination-card website-cloud-destination">
          <span className="website-destination-icon">
            <DestinationIcon kind="cloud" size={24} />
          </span>
          <div>
            <h2>云端</h2>
            <p>
              {cloud.state === "ready"
                ? "使用云端项目，电脑离线时也能工作。"
                : "当前服务尚未开放云端功能。"}
            </p>
          </div>
          <button
            className="website-button primary"
            disabled={cloud.state !== "ready" || !!opening}
            onClick={onCloud}
          >
            进入云端 <DestinationIcon kind="open" size={15} />
          </button>
        </article>
        <div className="website-computers-heading">
          <div>
            <h2>我的电脑</h2>
            <p className="website-muted">
              在这台电脑的 CodeShell 桌面端登录同一账号，即可在这里看到它。
            </p>
          </div>
          <button
            className="website-button"
            aria-label="刷新电脑列表"
            disabled={loading || !!opening || directory.state !== "ready"}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <DestinationIcon kind="refresh" size={15} /> 刷新
          </button>
        </div>
        {directoryError || error ? (
          <p role="alert" className="form-error">
            {directoryError || error}
          </p>
        ) : null}
        {loading ? (
          <p role="status" className="website-muted">
            正在读取电脑…
          </p>
        ) : null}
        {directory.state !== "ready" ? (
          <p className="website-computers-empty">
            {directory.state === "pending"
              ? "账号服务暂时无法连接，请刷新页面后重试。"
              : "当前服务尚未开放电脑连接。"}
          </p>
        ) : !loading && !computers.length && !directoryError ? (
          <div className="website-computers-empty">
            <DestinationIcon kind="computer" size={25} />
            <h3>还没有登录的电脑</h3>
            <p>在这台电脑的 CodeShell 桌面端登录同一账号，即可在这里看到它。</p>
          </div>
        ) : (
          <ul className="website-computers-list">
            {computers.map((host) => (
              <li className="website-destination-card" key={host.hostId}>
                <span className="website-destination-icon">
                  <DestinationIcon kind="computer" size={21} />
                </span>
                <div>
                  <h3>{host.name}</h3>
                  <p className={host.online && !host.revoked ? "website-computer-online" : ""}>
                    {host.revoked
                      ? "已撤销"
                      : host.online
                        ? "在线"
                        : "暂不可连接 · 未开启远程控制或电脑离线"}
                  </p>
                </div>
                <button
                  className="website-button"
                  disabled={!host.online || host.revoked || !!opening || phone.state !== "ready"}
                  aria-label={`连接 ${host.name}`}
                  onClick={() => void openComputer(host)}
                >
                  {opening === host.hostId ? "正在连接…" : "连接电脑"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="website-hint">
          连接电脑前，请在桌面端打开“允许远程访问这台电脑”。连接时在当前设备用 Passkey
          确认，无需在目标电脑逐次点击允许。
        </p>
      </section>
    </main>
  );
}
