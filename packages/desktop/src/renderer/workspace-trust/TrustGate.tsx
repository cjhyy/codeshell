import React, { useEffect, useState } from "react";

interface Props {
  repoPath: string | null;
  onDecide: (level: "trusted" | "untrusted") => void;
}

export function TrustGate({ repoPath, onDecide }: Props) {
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);

  useEffect(() => {
    setUnknown(false);
    if (!repoPath) return;
    let cancelled = false;
    void window.codeshell.getTrust(repoPath).then((t) => {
      if (cancelled) return;
      setUnknown(t === "unknown");
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  if (!repoPath || !unknown) return null;

  const decide = async (level: "trusted" | "untrusted") => {
    setPending(true);
    await window.codeshell.setTrust(repoPath, level);
    onDecide(level);
    setPending(false);
    setUnknown(false);
  };

  return (
    <div className="trust-gate-backdrop">
      <div className="trust-gate">
        <h2 className="trust-gate-title">信任此项目？</h2>
        <div className="trust-gate-path">{repoPath}</div>
        <p className="trust-gate-body">
          Agent 会在此目录读写文件、运行命令。只信任你确认安全的项目。
          未信任项目仍可对话，但所有写工具调用会被拒绝。
        </p>
        <div className="trust-gate-actions">
          <button
            className="approval-btn deny"
            disabled={pending}
            onClick={() => void decide("untrusted")}
          >
            仅查看（拒绝写工具）
          </button>
          <button
            className="approval-btn approve"
            disabled={pending}
            onClick={() => void decide("trusted")}
          >
            信任并继续
          </button>
        </div>
      </div>
    </div>
  );
}
