export interface CloudAccountControlsProps {
  pending: boolean;
  error: string;
  onLogout: () => void;
  accountOrigin?: string;
}

/** The Account portal authorizes independently. Never forward a Cloud credential. */
export function accountProfileUrl(origin?: string): string | undefined {
  if (!origin || origin.length > 2048) return;
  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return;
    return `${url.origin}/api/v1/account/manage`;
  } catch {
    return;
  }
}

/** Cloud-scoped logout; Account sign-out and legacy Hub devices live elsewhere. */
export function CloudAccountControls({
  pending,
  error,
  onLogout,
  accountOrigin,
}: CloudAccountControlsProps) {
  const profileUrl = accountProfileUrl(accountOrigin);
  return (
    <div className="cloud-account-controls">
      <span>Cloud 工作台</span>
      {profileUrl ? (
        <a className="library-button" href={profileUrl} target="_blank" rel="noopener noreferrer">
          账号资料
        </a>
      ) : (
        <button className="library-button" disabled title="此工作台尚未提供账号服务地址">
          账号资料
        </button>
      )}
      <button className="library-button" disabled={pending} onClick={onLogout}>
        {pending ? "正在退出…" : "退出此 Cloud 工作台"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
