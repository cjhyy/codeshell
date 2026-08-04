import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Braces,
  KeyRound,
  LockKeyhole,
  Plus,
  ShieldCheck,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { useConfirm, usePrompt } from "../ui/DialogProvider";
import { useT } from "../i18n/I18nProvider";
import type { MaskedCredentialView } from "./types";

/**
 * Standalone Permission Token credential CRUD. Link authorization has its own
 * provider-aware page and never passes through this generic token form.
 * Secrets persist user-scope and list calls only return masked metadata.
 */
export function TokenTab({ cwd }: { cwd: string }) {
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

  const load = useCallback(() => {
    void window.codeshell.credentials
      .list(cwd)
      .then((all) => setItems(all.filter((c) => c.type === "token")));
  }, [cwd]);
  useEffect(load, [load]);

  const save = async () => {
    if (!id.trim() || !label.trim()) {
      toast({ message: t("ext.token.idRequired"), variant: "error" });
      return;
    }
    await window.codeshell.credentials.save(cwd, "user", {
      id: id.trim(),
      type: "token",
      label: label.trim(),
      secret: secret || undefined,
      exposeAsEnv: exposeAsEnv.trim() || undefined,
    });
    toast({ message: t("ext.token.saved") });
    setId("");
    setLabel("");
    setSecret("");
    setExposeAsEnv("");
    load();
  };

  const del = async (cid: string) => {
    if (!(await confirm({ message: t("ext.token.deleteConfirm", { id: cid }), destructive: true })))
      return;
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
      const suggested = c.id
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
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

  const autoUseCount = items.filter((item) => item.autoUseByAI === true).length;
  const envCount = items.filter((item) => Boolean(item.exposeAsEnv)).length;

  return (
    <div className="space-y-5" data-token-page>
      <section className="credential-hero overflow-hidden rounded-2xl border border-border/70 px-5 py-6 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-violet-500/20 bg-violet-500/10 text-violet-600 shadow-sm dark:text-violet-400">
              <KeyRound className="size-6" aria-hidden />
            </div>
            <div className="min-w-0 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-600 dark:text-violet-400">
                  {t("ext.token.eyebrow")}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-status-ok/25 bg-status-ok/8 px-2 py-0.5 text-[10px] font-medium text-status-ok">
                  <ShieldCheck className="size-3" aria-hidden />
                  {t("ext.token.localStorage")}
                </span>
              </div>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
                {t("ext.token.title")}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t("ext.token.description")}
              </p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 lg:min-w-72">
            <CredentialStat value={items.length} label={t("ext.token.storedCount")} />
            <CredentialStat value={autoUseCount} label={t("ext.token.autoUseCount")} />
            <CredentialStat value={envCount} label={t("ext.token.envCount")} />
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="token-create-title">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Plus className="size-4" aria-hidden />
          </div>
          <div>
            <h3 id="token-create-title" className="text-base font-semibold tracking-tight">
              {t("ext.token.createTitle")}
            </h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t("ext.token.createDescription")}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="token-id">{t("ext.token.idLabel")}</Label>
              <Input
                id="token-id"
                value={id}
                onChange={(event) => setId(event.target.value)}
                placeholder={t("ext.token.idPlaceholder")}
              />
              <p className="text-[11px] leading-4 text-muted-foreground">
                {t("ext.token.referenceHelp")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="token-name">{t("ext.token.nameLabel")}</Label>
              <Input
                id="token-name"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("ext.token.namePlaceholder")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="token-secret">{t("ext.token.tokenValueLabel")}</Label>
              <div className="relative">
                <LockKeyhole
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="token-secret"
                  type="password"
                  className="pl-9"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="token-env">{t("ext.token.exposeEnvLabel")}</Label>
              <div className="relative">
                <SquareTerminal
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="token-env"
                  className="pl-9 font-mono"
                  value={exposeAsEnv}
                  onChange={(event) => setExposeAsEnv(event.target.value)}
                  placeholder="FIGMA_TOKEN"
                />
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex max-w-2xl items-start gap-2 text-[11px] leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-status-ok" aria-hidden />
              {t("ext.token.securityNote")}
            </p>
            <Button className="shrink-0" onClick={() => void save()}>
              <Plus className="size-4" aria-hidden />
              {t("ext.token.save")}
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="token-list-title">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Braces className="size-4" aria-hidden />
            </div>
            <div>
              <h3 id="token-list-title" className="text-base font-semibold tracking-tight">
                {t("ext.token.listTitle")}
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("ext.token.listDescription")}
              </p>
            </div>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </div>

        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/15 px-5 py-10 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <KeyRound className="size-5" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">{t("ext.token.emptyTitle")}</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              {t("ext.token.emptyTokens")}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((c) => (
              <article
                key={c.id}
                className="credential-card flex flex-col rounded-2xl border border-border/70 bg-card p-4 transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
                      <KeyRound className="size-4.5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-semibold" title={c.label}>
                        {c.label}
                      </h4>
                      <p
                        className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                        title={c.id}
                      >
                        {c.id}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground hover:text-status-err"
                    disabled={busy}
                    onClick={() => void del(c.id)}
                    title={t("ext.token.delete")}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    <span className="sr-only">{t("ext.token.delete")}</span>
                  </Button>
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  <span
                    className={c.hasSecret ? "credential-status-ok" : "credential-status-muted"}
                  >
                    {c.hasSecret ? t("ext.token.secretStored") : t("ext.token.noSecret")}
                  </span>
                  {c.exposeAsEnv ? (
                    <span className="credential-status-muted font-mono">env · {c.exposeAsEnv}</span>
                  ) : null}
                </div>
                <div className="mt-3 min-h-9 rounded-xl border border-border/55 bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                  {c.hasSecret ? c.secretHint : t("ext.token.secretMissing")}
                  {c.meta?.appUrl ? ` · ${c.meta.appUrl}` : ""}
                </div>

                <div className="mt-4 divide-y divide-border/55 border-t border-border/55">
                  <PermissionSwitch
                    icon={ShieldCheck}
                    title={t("ext.token.aiAutoUse")}
                    description={t("ext.token.aiAutoUseDescription")}
                    checked={c.autoUseByAI === true}
                    disabled={busy}
                    onCheckedChange={(next) => void toggleAiUse(c, next)}
                  />
                  <PermissionSwitch
                    icon={SquareTerminal}
                    title={t("ext.token.exposeEnvToggle")}
                    description={t("ext.token.exposeEnvDescription")}
                    checked={Boolean(c.exposeAsEnv)}
                    disabled={busy}
                    onCheckedChange={(next) => void toggleExposeEnv(c, next)}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CredentialStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-sm">
      <div className="text-lg font-semibold leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground" title={label}>
        {label}
      </div>
    </div>
  );
}

function PermissionSwitch({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  icon: typeof ShieldCheck;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-3 first:pt-3 last:pb-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  );
}
