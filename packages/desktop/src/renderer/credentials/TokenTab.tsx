import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";
import type { MaskedCredentialView } from "./types";

/**
 * Token / Link credential CRUD. The same form serves both (kind switches the
 * value label + the optional appUrl field). Credentials persist user-scope via
 * the credentials.* IPC bridge; the secret is write-only (list returns masked).
 */
export function TokenTab({ cwd, kind }: { cwd: string; kind: "token" | "link" }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [exposeAsEnv, setExposeAsEnv] = useState("");
  const [appUrl, setAppUrl] = useState("");

  const load = useCallback(() => {
    void window.codeshell.credentials.list(cwd).then((all) =>
      setItems(all.filter((c) => c.type === kind)),
    );
  }, [cwd, kind]);
  useEffect(load, [load]);

  const save = async () => {
    if (!id.trim() || !label.trim()) {
      toast({ message: t("ext.token.idRequired"), variant: "error" });
      return;
    }
    await window.codeshell.credentials.save(cwd, "user", {
      id: id.trim(),
      type: kind,
      label: label.trim(),
      secret: secret || undefined,
      exposeAsEnv: exposeAsEnv.trim() || undefined,
      meta: kind === "link" && appUrl.trim() ? { appUrl: appUrl.trim() } : undefined,
    });
    toast({ message: t("ext.token.saved") });
    setId("");
    setLabel("");
    setSecret("");
    setExposeAsEnv("");
    setAppUrl("");
    load();
  };

  const del = async (cid: string) => {
    if (!(await confirm({ message: t("ext.token.deleteConfirm", { id: cid }), destructive: true }))) return;
    await window.codeshell.credentials.remove(cwd, "user", cid);
    load();
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("ext.token.idLabel")}</Label>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder={t("ext.token.idPlaceholder")} />
          </div>
          <div className="space-y-1">
            <Label>{t("ext.token.nameLabel")}</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("ext.token.namePlaceholder")} />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{kind === "token" ? t("ext.token.tokenValueLabel") : t("ext.token.linkValueLabel")}</Label>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </div>
        {kind === "link" && (
          <div className="space-y-1">
            <Label>{t("ext.token.appUrlLabel")}</Label>
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://..." />
          </div>
        )}
        <div className="space-y-1">
          <Label>{t("ext.token.exposeEnvLabel")}</Label>
          <Input
            value={exposeAsEnv}
            onChange={(e) => setExposeAsEnv(e.target.value)}
            placeholder="FIGMA_TOKEN"
          />
        </div>
        <Button onClick={() => void save()}>{t("ext.token.save")}</Button>
      </Card>

      <div className="space-y-2">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {kind === "token" ? t("ext.token.emptyTokens") : t("ext.token.emptyLinks")}
          </p>
        )}
        {items.map((c) => (
          <Card key={c.id} className="flex items-center justify-between p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">
                {c.label} <span className="text-xs text-muted-foreground">({c.id})</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {c.hasSecret ? c.secretHint : t("ext.token.noSecret")}
                {c.exposeAsEnv ? ` · env: ${c.exposeAsEnv}` : ""}
                {c.meta?.appUrl ? ` · ${c.meta.appUrl}` : ""}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void del(c.id)}>
              {t("ext.token.delete")}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
