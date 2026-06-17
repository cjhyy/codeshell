import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

interface Props {
  repoPath: string | null;
  onDecide: (level: "trusted" | "untrusted") => void;
}

export function TrustGate({ repoPath, onDecide }: Props) {
  const { t } = useT();
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
        <h2 className="mb-2 text-lg font-semibold">{t("auto.trust.title")}</h2>
        <div className="mb-3 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{repoPath}</div>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          {t("auto.trust.body")}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="default"
            disabled={pending}
            onClick={() => void decide("untrusted")}
          >
            {t("auto.trust.viewOnly")}
          </Button>
          <Button
            variant="solid"
            disabled={pending}
            onClick={() => void decide("trusted")}
          >
            {t("auto.trust.trustContinue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
