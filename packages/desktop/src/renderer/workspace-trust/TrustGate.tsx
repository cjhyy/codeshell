import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";

interface Props {
  projectPath: string | null;
  onDecide: (level: "trusted" | "untrusted") => void;
}

interface TrustRisks {
  permissionRules: number;
  envKeys: string[];
  hooks: number;
  mcpServers: string[];
  setupScripts: boolean;
}

export function TrustGate({ projectPath, onDecide }: Props) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [risks, setRisks] = useState<TrustRisks | null>(null);

  useEffect(() => {
    setUnknown(false);
    setRisks(null);
    if (!projectPath) return;
    let cancelled = false;
    void window.codeshell
      .getTrust(projectPath)
      .then((tr) => {
        if (cancelled) return;
        setUnknown(tr === "unknown");
        // Fetch the risk summary only when we'll actually prompt.
        if (tr === "unknown") {
          void window.codeshell
            .getTrustRisks(projectPath)
            .then((r) => {
              if (!cancelled) setRisks(r);
            })
            .catch(() => {
              /* best-effort; dialog still works without the summary */
            });
        }
      })
      .catch((err) => {
        if (!cancelled) console.error("getTrust failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (!projectPath || !unknown) return null;

  const riskLines: string[] = [];
  if (risks) {
    if (risks.permissionRules > 0)
      riskLines.push(t("auto.trust.riskPermissions", { n: risks.permissionRules }));
    if (risks.envKeys.length > 0)
      riskLines.push(t("auto.trust.riskEnv", { keys: risks.envKeys.join(", ") }));
    if (risks.hooks > 0) riskLines.push(t("auto.trust.riskHooks", { n: risks.hooks }));
    if (risks.mcpServers.length > 0)
      riskLines.push(t("auto.trust.riskMcp", { names: risks.mcpServers.join(", ") }));
    if (risks.setupScripts) riskLines.push(t("auto.trust.riskSetup"));
  }

  const decide = async (level: "trusted" | "untrusted") => {
    setPending(true);
    try {
      await window.codeshell.setTrust(projectPath, level);
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
        <div className="mb-3 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
          {projectPath}
        </div>
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{t("auto.trust.body")}</p>
        {risks &&
          (riskLines.length > 0 ? (
            <div className="mb-4 rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2">
              <p className="mb-1.5 text-xs font-medium text-foreground">
                {t("auto.trust.risksTitle")}
              </p>
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {riskLines.map((line, i) => (
                  <li key={i} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mb-4 text-xs text-muted-foreground">{t("auto.trust.risksNone")}</p>
          ))}
        <div className="flex justify-end gap-2">
          <Button variant="default" disabled={pending} onClick={() => void decide("untrusted")}>
            {t("auto.trust.viewOnly")}
          </Button>
          <Button variant="solid" disabled={pending} onClick={() => void decide("trusted")}>
            {t("auto.trust.trustContinue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
