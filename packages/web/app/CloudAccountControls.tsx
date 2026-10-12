export interface CloudAccountControlsProps {
  pending: boolean;
  error: string;
  onLogout: () => void;
}

/** Cloud-scoped logout; Account sign-out and legacy Hub devices live elsewhere. */
export function CloudAccountControls({ pending, error, onLogout }: CloudAccountControlsProps) {
  return (
    <div className="cloud-account-controls">
      <span>Cloud 工作台</span>
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
