import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  Cookie as CookieIcon,
  Globe2,
  History,
  LogIn,
  MonitorDown,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { useConfirm, usePrompt } from "../ui/DialogProvider";
import type { MaskedCredentialView } from "./types";
import { useT } from "../i18n/I18nProvider";

type SwitchMode = "clear" | "merge";

const URL_HISTORY_KEY = "codeshell:cookieLoginUrlHistory";
const URL_HISTORY_MAX = 10;

/** 读登录 URL 输入历史(localStorage,去重,最近优先)。坏数据兜底空数组。 */
function readUrlHistory(): string[] {
  try {
    const raw = localStorage.getItem(URL_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 把一条 URL 推到历史最前(去重),截到上限。返回新列表。 */
function pushUrlHistory(url: string): string[] {
  const u = url.trim();
  if (!u) return readUrlHistory();
  const next = [u, ...readUrlHistory().filter((x) => x !== u)].slice(0, URL_HISTORY_MAX);
  try {
    localStorage.setItem(URL_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return next;
}

/**
 * Cookie 账号凭证。两条抓取路径:
 *  1. 弹窗登录(主路径):开**全新隔离无痕窗**(非持久 login-<uuid>,登完即焚),用户现登 →
 *     抓该窗口**全量** cookie。因 session 干净,无需配域名/范围。只填登录地址(免 https,
 *     输过的地址以标签复用)。
 *  2. 从内置浏览器全量拓取:抓当前 chat session 的浏览器分区,或兜底抓所有活着的浏览器面板
 *     session,把 cookie 整包存成一条凭证(适合已在面板登过的站)。
 *
 * 账号卡片:切换 / 编辑(重命名)/ 重新登录 / 删除;逐条「AI 可自动取用」「AI 可自动注入浏览器」
 * 开关 + 逐条「切换策略」(清空再注入 / 只覆盖同名)。
 */
export function CookieTab({ cwd, activeBucket }: { cwd: string; activeBucket?: string | null }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [urlHistory, setUrlHistory] = useState<string[]>(() => readUrlHistory());

  const load = useCallback(() => {
    void window.codeshell.credentials
      .list(cwd)
      .then((all) => setItems(all.filter((c) => c.type === "cookie")));
  }, [cwd]);
  useEffect(load, [load]);

  /** platform__slug(label):同一平台多账号不撞键;slug 只保留安全字符。 */
  const buildId = (platform: string, name: string): string => {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `${platform}__${slug || "account"}`;
  };

  /** 主域:从用户输入里取「站点名」当 platform(去协议 / www. / 端口 / 路径)。 */
  const normalizeDomain = (raw: string): string =>
    raw
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0];

  const platformOf = (d: string): string => {
    const parts = d.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : d; // xiaohongshu.com → xiaohongshu
  };

  /**
   * 弹窗登录抓 cookie(主路径)。开全新隔离窗 → 用户登录点保存 → 抓**全量** cookie。
   * 因 session 干净,直接 fullCapture 不配域;不做登录态校验(全量 jar 跨域,按域判会误报)。
   * fixed 传入时为「重新登录」既有凭证(沿用 id / 不改名)。
   */
  const runLogin = async (opts: {
    rawUrl: string;
    fixed?: {
      id: string;
      label: string;
      autoUseByAI?: boolean;
      autoInjectByAI?: boolean;
      switchMode?: SwitchMode;
    };
  }): Promise<boolean> => {
    const raw = opts.rawUrl.trim();
    if (!raw) {
      toast({ message: t("ext.cookie.needLoginUrl"), variant: "error" });
      return false;
    }
    // 免 https:没带协议自动补 https://。
    const fullUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const d = normalizeDomain(raw);
    const platform = platformOf(d);
    setBusy(true);
    try {
      const res = await window.codeshell.credentials.loginCapture({
        url: fullUrl,
        platform,
        fullCapture: true,
      });
      if (!res.ok) {
        if (!res.cancelled)
          toast({ message: res.error ?? t("ext.cookie.loginNotDone"), variant: "error" });
        return false;
      }
      if (res.jar.length === 0) {
        toast({
          message: t("ext.cookie.emptyJarAfterLogin", { domain: res.domain }),
          variant: "error",
        });
        return false;
      }
      const accountName = opts.fixed
        ? opts.fixed.label
        : res.suggestedLabel || t("ext.cookie.defaultAccountName");
      const id = opts.fixed ? opts.fixed.id : buildId(platform, accountName);
      await window.codeshell.credentials.save(cwd, "user", {
        id,
        type: "cookie",
        label: accountName,
        secret: JSON.stringify(res.jar),
        autoUseByAI: opts.fixed?.autoUseByAI,
        autoInjectByAI: opts.fixed?.autoInjectByAI,
        meta: {
          platform,
          domain: res.domain,
          scope: "all",
          switchMode: opts.fixed?.switchMode ?? "merge",
        },
      });
      toast({
        message: t(opts.fixed ? "ext.cookie.repulledToast" : "ext.cookie.capturedAllToast", {
          label: accountName,
          count: res.jar.length,
        }),
      });
      load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** 顶部表单:新建账号(弹窗登录)。成功则记输入历史 + 清表单。 */
  const loginCapture = async () => {
    const raw = url.trim();
    const ok = await runLogin({ rawUrl: raw });
    if (ok) {
      setUrlHistory(pushUrlHistory(raw));
      setUrl("");
    }
  };

  const saveBrowserCapture = async (opts: {
    capture: () => Promise<{ jar: unknown[]; count: number }>;
    emptyMessage: string;
  }) => {
    const name = await prompt({
      title: t("ext.cookie.captureBrowserTitle"),
      message: t("ext.cookie.captureBrowserMessage"),
      defaultValue: "",
    });
    if (name === null) return;
    const accountName = name.trim() || t("ext.cookie.defaultAccountName");
    setBusy(true);
    try {
      const { jar, count } = await opts.capture();
      if (count === 0) {
        toast({ message: opts.emptyMessage, variant: "error" });
        return;
      }
      await window.codeshell.credentials.save(cwd, "user", {
        id: buildId("browser", accountName),
        type: "cookie",
        label: accountName,
        secret: JSON.stringify(jar),
        meta: { platform: "browser", scope: "all", switchMode: "merge" },
      });
      toast({ message: t("ext.cookie.capturedAllToast", { label: accountName, count }) });
      load();
    } finally {
      setBusy(false);
    }
  };

  /** 抓打开凭证页的当前 chat session 浏览器分区。 */
  const captureCurrentSessionFromBrowser = async () => {
    if (!activeBucket) {
      toast({ message: t("ext.cookie.noCookieCurrentSession"), variant: "error" });
      return;
    }
    await saveBrowserCapture({
      capture: () => window.codeshell.credentials.captureAllCookies(activeBucket),
      emptyMessage: t("ext.cookie.noCookieCurrentSession"),
    });
  };

  /** 抓所有当前活着的浏览器面板 session,去重合并。 */
  const captureAllSessionsFromBrowser = async () => {
    await saveBrowserCapture({
      capture: () => window.codeshell.credentials.captureAllCookiesAllSessions(),
      emptyMessage: t("ext.cookie.noCookieAllSessions"),
    });
  };

  /** 卡片「重新登录」:用原凭证的域重新弹窗登录,刷新过期 cookie(沿用其策略/开关)。 */
  const relogin = async (c: MaskedCredentialView) => {
    const d = c.meta?.domain;
    if (!d) {
      toast({ message: t("ext.cookie.repullNoDomain"), variant: "error" });
      return;
    }
    await runLogin({
      rawUrl: d,
      fixed: {
        id: c.id,
        label: c.label,
        autoUseByAI: c.autoUseByAI,
        autoInjectByAI: c.autoInjectByAI,
        switchMode: c.meta?.switchMode,
      },
    });
  };

  const switchTo = async (c: MaskedCredentialView) => {
    const merge = c.meta?.switchMode !== "clear";
    const ok = await confirm({
      title: t("ext.cookie.switchTitle"),
      message: t("ext.cookie.switchMessage", { label: c.label }),
      detail: merge ? t("ext.cookie.switchDetailMerge") : t("ext.cookie.switchDetailClear"),
      confirmLabel: t("ext.cookie.switchConfirm"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { count } = await window.codeshell.credentials.restoreCookieToBrowser(
        cwd,
        c.id,
        activeBucket ?? undefined,
      );
      toast({ message: t("ext.cookie.switchedToast", { label: c.label, count }) });
    } catch (e) {
      toast({ message: t("ext.cookie.switchFailed", { error: String(e) }), variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 编辑:重命名账号(id 不变,只改展示 label)。 */
  const rename = async (c: MaskedCredentialView) => {
    const next = await prompt({
      title: t("ext.cookie.renameTitle"),
      message: t("ext.cookie.renameMessage"),
      defaultValue: c.label,
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === c.label) return;
    setBusy(true);
    try {
      await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { label: trimmed });
      load();
    } finally {
      setBusy(false);
    }
  };

  /** 逐条 meta 开关/选择写回(只改元数据,保留 secret)。 */
  const patch = async (
    c: MaskedCredentialView,
    fields: {
      autoUseByAI?: boolean;
      autoInjectByAI?: boolean;
      meta?: MaskedCredentialView["meta"];
    },
    toastMsg?: string,
  ) => {
    setBusy(true);
    try {
      await window.codeshell.credentials.patchMeta(cwd, "user", c.id, fields);
      load();
      if (toastMsg) toast({ message: toastMsg });
    } finally {
      setBusy(false);
    }
  };

  const toggleAiUse = (c: MaskedCredentialView, next: boolean) =>
    void patch(
      c,
      { autoUseByAI: next },
      next
        ? t("ext.cookie.aiAutoUseOnToast", { label: c.label })
        : t("ext.cookie.aiAutoUseOffToast", { label: c.label }),
    );

  const toggleAiInject = (c: MaskedCredentialView, next: boolean) =>
    void patch(
      c,
      { autoInjectByAI: next },
      next
        ? t("ext.cookie.aiAutoInjectOnToast", { label: c.label })
        : t("ext.cookie.aiAutoInjectOffToast", { label: c.label }),
    );

  /** 切换策略:写回 meta.switchMode(保留其余 meta 字段)。 */
  const setSwitchMode = (c: MaskedCredentialView, mode: SwitchMode) =>
    void patch(c, { meta: { ...c.meta, switchMode: mode } });

  const del = async (c: MaskedCredentialView) => {
    if (
      !(await confirm({
        message: t("ext.cookie.deleteConfirm", { label: c.label }),
        destructive: true,
      }))
    )
      return;
    await window.codeshell.credentials.remove(cwd, "user", c.id);
    load();
  };

  // 按 platform 分组
  const groups = new Map<string, MaskedCredentialView[]>();
  for (const c of items) {
    const p = c.meta?.platform ?? c.meta?.domain ?? t("ext.cookie.otherGroup");
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(c);
  }

  const autoInjectCount = items.filter((item) => item.autoInjectByAI === true).length;

  return (
    <div className="space-y-5" data-cookie-page>
      <section className="credential-hero overflow-hidden rounded-2xl border border-border/70 px-5 py-6 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-600 shadow-sm dark:text-amber-400">
              <CookieIcon className="size-6" aria-hidden />
            </div>
            <div className="min-w-0 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-400">
                  {t("ext.cookie.eyebrow")}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-status-ok/25 bg-status-ok/8 px-2 py-0.5 text-[10px] font-medium text-status-ok">
                  <ShieldCheck className="size-3" aria-hidden />
                  {t("ext.cookie.localStorage")}
                </span>
              </div>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
                {t("ext.cookie.title")}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t("ext.cookie.description")}
              </p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2 lg:min-w-72">
            <CookieStat value={items.length} label={t("ext.cookie.accountCount")} />
            <CookieStat value={groups.size} label={t("ext.cookie.platformCount")} />
            <CookieStat value={autoInjectCount} label={t("ext.cookie.autoInjectCount")} />
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="cookie-add-title">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <LogIn className="size-4" aria-hidden />
          </div>
          <div>
            <h3 id="cookie-add-title" className="text-base font-semibold tracking-tight">
              {t("ext.cookie.addTitle")}
            </h3>
            <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("ext.cookie.addDescription")}
            </p>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="credential-card flex flex-col rounded-2xl border border-border/70 bg-card p-4 transition-all sm:p-5">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <Globe2 className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">{t("ext.cookie.loginMethodTitle")}</h4>
                  <span className="credential-status-ok">{t("ext.cookie.recommended")}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("ext.cookie.loginMethodDescription")}
                </p>
              </div>
            </div>

            <div className="mt-5 flex-1 space-y-2">
              <Label htmlFor="cookie-login-url">{t("ext.cookie.urlLabel")}</Label>
              <Input
                id="cookie-login-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t("ext.cookie.urlPlaceholder")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !busy) void loginCapture();
                }}
              />
              {urlHistory.length > 0 ? (
                <div className="flex items-start gap-2 pt-1">
                  <History className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="flex flex-wrap gap-1.5">
                    {urlHistory.map((historyUrl) => (
                      <Button
                        key={historyUrl}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 max-w-full rounded-full bg-muted/35 px-2 text-[11px] font-normal text-muted-foreground"
                        onClick={() => setUrl(historyUrl)}
                        title={t("ext.cookie.historyChipTip")}
                      >
                        <span className="truncate">{historyUrl}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <Button
              className="mt-5 w-full sm:w-auto sm:self-start"
              disabled={busy}
              onClick={() => void loginCapture()}
            >
              <LogIn className="size-4" aria-hidden />
              {busy ? t("ext.cookie.processing") : t("ext.cookie.loginAndSave")}
            </Button>
          </div>

          {/* 从内置浏览器抓取与隔离窗口登录是两条不同路径，保留为独立卡片。 */}
          <div className="credential-card flex flex-col rounded-2xl border border-border/70 bg-card p-4 transition-all sm:p-5">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <MonitorDown className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">{t("ext.cookie.browserMethodTitle")}</h4>
                  <span className="credential-status-muted">{t("ext.cookie.existingSession")}</span>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("ext.cookie.captureFromBrowserTitle")}
                </p>
              </div>
            </div>
            <div className="mt-5 flex-1 rounded-xl border border-border/55 bg-muted/30 p-3 text-[11px] leading-5 text-muted-foreground">
              <div className="flex items-start gap-2">
                <MonitorDown className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{t("ext.cookie.captureAllSessionsWarning")}</span>
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={busy}
                onClick={() => void captureCurrentSessionFromBrowser()}
              >
                {t("ext.cookie.captureCurrentSession")}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onClick={() => void captureAllSessionsFromBrowser()}
              >
                {t("ext.cookie.captureAllSessions")}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="cookie-accounts-title">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <UserRound className="size-4" aria-hidden />
            </div>
            <div>
              <h3 id="cookie-accounts-title" className="text-base font-semibold tracking-tight">
                {t("ext.cookie.accountsTitle")}
              </h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("ext.cookie.accountsDescription")}
              </p>
            </div>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
        </div>

        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-muted/15 px-5 py-10 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <CookieIcon className="size-5" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">{t("ext.cookie.emptyTitle")}</p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
              {t("ext.cookie.emptyAccounts")}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {[...groups.entries()].map(([platform, accounts]) => (
              <div key={platform} className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {platform}
                  </h4>
                  <span className="text-[10px] text-muted-foreground">{accounts.length}</span>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {accounts.map((c) => (
                    <article
                      key={c.id}
                      className="credential-card flex flex-col rounded-2xl border border-border/70 bg-card p-4 transition-all"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
                          <UserRound className="size-4.5" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <h5 className="truncate text-sm font-semibold" title={c.label}>
                              {c.label}
                            </h5>
                            {c.meta?.scope === "all" && c.meta?.platform === "browser" ? (
                              <Badge variant="info" className="shrink-0">
                                {t("ext.cookie.scopeBadgeAll")}
                              </Badge>
                            ) : null}
                          </div>
                          <p
                            className="mt-0.5 truncate text-[11px] text-muted-foreground"
                            title={c.meta?.domain ?? c.id}
                          >
                            {c.meta?.domain ?? c.id}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0"
                          disabled={busy}
                          onClick={() => void switchTo(c)}
                        >
                          {t("ext.cookie.actionSwitch")}
                        </Button>
                      </div>

                      <div className="mt-4 divide-y divide-border/55 rounded-xl border border-border/55 bg-muted/20 px-3">
                        <CookiePermissionSwitch
                          title={t("ext.cookie.aiAutoUse")}
                          description={t("ext.cookie.aiAutoUseDescription")}
                          checked={c.autoUseByAI === true}
                          disabled={busy}
                          onCheckedChange={(next) => toggleAiUse(c, next)}
                        />
                        <CookiePermissionSwitch
                          title={t("ext.cookie.aiAutoInject")}
                          description={t("ext.cookie.aiAutoInjectDescription")}
                          checked={c.autoInjectByAI === true}
                          disabled={busy}
                          onCheckedChange={(next) => toggleAiInject(c, next)}
                        />
                        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground">
                              {t("ext.cookie.switchModeLabel")}
                            </p>
                            <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                              {t("ext.cookie.switchModeDescription")}
                            </p>
                          </div>
                          <SimpleSelect
                            value={c.meta?.switchMode === "clear" ? "clear" : "merge"}
                            onChange={(value) => setSwitchMode(c, value as SwitchMode)}
                            options={[
                              { value: "clear", label: t("ext.cookie.switchModeClear") },
                              { value: "merge", label: t("ext.cookie.switchModeMerge") },
                            ]}
                            size="sm"
                          />
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t border-border/55 pt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void rename(c)}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                          {t("ext.cookie.actionEdit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void relogin(c)}
                        >
                          <RefreshCw className="size-3.5" aria-hidden />
                          {t("ext.cookie.actionRepull")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-status-err"
                          disabled={busy}
                          onClick={() => void del(c)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                          {t("ext.cookie.actionDelete")}
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CookieStat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5 backdrop-blur-sm">
      <div className="text-lg font-semibold leading-none tabular-nums text-foreground">{value}</div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground" title={label}>
        {label}
      </div>
    </div>
  );
}

function CookiePermissionSwitch({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-3">
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
