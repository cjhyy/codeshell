import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "../ui/ToastProvider";
import { useConfirm, usePrompt } from "../ui/DialogProvider";
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
  const prompt = usePrompt();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [busy, setBusy] = useState(false);
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

  /** 逐条「AI 可自动取用」开关:写回 autoUseByAI(只改元数据,保留 secret)。 */
  const toggleAiUse = async (c: MaskedCredentialView, next: boolean) => {
    setBusy(true);
    try {
      await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { autoUseByAI: next });
      load();
      toast({
        message: next
          ? t("ext.token.aiAutoUseOnToast", { label: c.label })
          : t("ext.token.aiAutoUseOffToast", { label: c.label }),
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 逐条「暴露为环境变量」开关:开 → 问变量名(默认按 id 推导大写下划线)写回 exposeAsEnv;
   * 关 → 清空 exposeAsEnv(传 ""，patchMeta 写入空串即不再注入)。
   */
  const toggleExposeEnv = async (c: MaskedCredentialView, next: boolean) => {
    if (next) {
      const suggested = c.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const name = await prompt({
        title: t("ext.token.exposeEnvTitle"),
        message: t("ext.token.exposeEnvMessage"),
        defaultValue: suggested,
      });
      if (name === null) return;
      const v = name.trim();
      if (!v) return;
      setBusy(true);
      try {
        await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { exposeAsEnv: v });
        load();
        toast({ message: t("ext.token.exposeEnvOnToast", { name: v }) });
      } finally {
        setBusy(false);
      }
    } else {
      setBusy(true);
      try {
        await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { exposeAsEnv: "" });
        load();
        toast({ message: t("ext.token.exposeEnvOffToast", { label: c.label }) });
      } finally {
        setBusy(false);
      }
    }
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
          <Card key={c.id} className="space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
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
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void del(c.id)}>
                {t("ext.token.delete")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                <Switch
                  checked={c.autoUseByAI === true}
                  disabled={busy}
                  onCheckedChange={(next) => void toggleAiUse(c, next)}
                />
                {t("ext.token.aiAutoUse")}
              </label>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                <Switch
                  checked={!!c.exposeAsEnv}
                  disabled={busy}
                  onCheckedChange={(next) => void toggleExposeEnv(c, next)}
                />
                {t("ext.token.exposeEnvToggle")}
              </label>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
