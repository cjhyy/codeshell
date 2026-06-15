import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

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
    void window.codeshell
      .getTrust(repoPath)
      .then((t) => {
        if (cancelled) return;
        setUnknown(t === "unknown");
      })
      .catch((err) => {
        if (!cancelled) console.error("getTrust failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  if (!repoPath || !unknown) return null;

  const decide = async (level: "trusted" | "untrusted") => {
    setPending(true);
    try {
      await window.codeshell.setTrust(repoPath, level);
      onDecide(level);
      setUnknown(false);
    } catch (err) {
      console.error("setTrust failed", err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-lg rounded-md border bg-popover p-5 text-popover-foreground shadow-2xl">
        <h2 className="mb-2 text-lg font-semibold">信任此项目？</h2>
        <div className="mb-3 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{repoPath}</div>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          Agent 会在此目录读写文件、运行命令。只信任你确认安全的项目。
          未信任项目仍可对话，但所有写工具调用会被拒绝。
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="default"
            disabled={pending}
            onClick={() => void decide("untrusted")}
          >
            仅查看（拒绝写工具）
          </Button>
          <Button
            variant="solid"
            disabled={pending}
            onClick={() => void decide("trusted")}
          >
            信任并继续
          </Button>
        </div>
      </div>
    </div>
  );
}
