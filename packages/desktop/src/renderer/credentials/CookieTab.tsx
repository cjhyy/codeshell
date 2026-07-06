import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Separator } from "@/components/ui/separator";
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
 *  2. 从内置浏览器全量拓取:把你平时用的内置浏览器面板(persist:browser)里**所有**已登录
 *     cookie 整包存成一条凭证(适合已在面板登过的站)。
 *
 * 账号卡片:切换 / 编辑(重命名)/ 重新登录 / 删除;逐条「AI 可自动取用」「AI 可自动注入浏览器」
 * 开关 + 逐条「切换策略」(清空再注入 / 只覆盖同名)。
 */
export function CookieTab({ cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [urlHistory, setUrlHistory] = useState<string[]>(() => readUrlHistory());

  const load = useCallback(() => {
    void window.codeshell.credentials.list(cwd).then((all) =>
      setItems(all.filter((c) => c.type === "cookie")),
    );
  }, [cwd]);
  useEffect(load, [load]);

  /** platform__slug(label):同一平台多账号不撞键;slug 只保留安全字符。 */
  const buildId = (platform: string, name: string): string => {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${platform}__${slug || "account"}`;
  };

  /** 主域:从用户输入里取「站点名」当 platform(去协议 / www. / 端口 / 路径)。 */
  const normalizeDomain = (raw: string): string =>
    raw.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];

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
    fixed?: { id: string; label: string; autoUseByAI?: boolean; autoInjectByAI?: boolean; switchMode?: SwitchMode };
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
        toast({ message: t("ext.cookie.emptyJarAfterLogin", { domain: res.domain }), variant: "error" });
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
        meta: { platform, domain: res.domain, scope: "all", switchMode: opts.fixed?.switchMode ?? "clear" },
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

  /** 从内置浏览器面板(persist:browser)全量拓取已登录 cookie，存成一条凭证。 */
  const captureFromBrowser = async () => {
    const name = await prompt({
      title: t("ext.cookie.captureBrowserTitle"),
      message: t("ext.cookie.captureBrowserMessage"),
      defaultValue: "",
    });
    if (name === null) return;
    const accountName = name.trim() || t("ext.cookie.defaultAccountName");
    setBusy(true);
    try {
      const { jar, count } = await window.codeshell.credentials.captureAllCookies();
      if (count === 0) {
        toast({ message: t("ext.cookie.noCookieAtAll"), variant: "error" });
        return;
      }
      await window.codeshell.credentials.save(cwd, "user", {
        id: buildId("browser", accountName),
        type: "cookie",
        label: accountName,
        secret: JSON.stringify(jar),
        meta: { platform: "browser", scope: "all", switchMode: "clear" },
      });
      toast({ message: t("ext.cookie.capturedAllToast", { label: accountName, count }) });
      load();
    } finally {
      setBusy(false);
    }
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
    const merge = c.meta?.switchMode === "merge";
    const ok = await confirm({
      title: t("ext.cookie.switchTitle"),
      message: t("ext.cookie.switchMessage", { label: c.label }),
      detail: merge ? t("ext.cookie.switchDetailMerge") : t("ext.cookie.switchDetailClear"),
      confirmLabel: t("ext.cookie.switchConfirm"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { count } = await window.codeshell.credentials.restoreCookieToBrowser(cwd, c.id);
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
    fields: { autoUseByAI?: boolean; autoInjectByAI?: boolean; meta?: MaskedCredentialView["meta"] },
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
      next ? t("ext.cookie.aiAutoUseOnToast", { label: c.label }) : t("ext.cookie.aiAutoUseOffToast", { label: c.label }),
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
    if (!(await confirm({ message: t("ext.cookie.deleteConfirm", { label: c.label }), destructive: true })))
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

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">{t("ext.cookie.intro")}</p>
        <div className="space-y-1">
          <Label>{t("ext.cookie.urlLabel")}</Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("ext.cookie.urlPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void loginCapture();
            }}
          />
          {urlHistory.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {urlHistory.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setUrl(h)}
                  title={t("ext.cookie.historyChipTip")}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button disabled={busy} onClick={() => void loginCapture()}>
          {busy ? t("ext.cookie.processing") : t("ext.cookie.loginAndSave")}
        </Button>

        <Separator className="my-1" />

        {/* 第二条独立路径:从内置浏览器面板全量拓取,和弹窗登录不是一回事,单列出来防歧义。 */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">{t("ext.cookie.browserSectionTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("ext.cookie.captureFromBrowserTitle")}</p>
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void captureFromBrowser()}
          >
            {t("ext.cookie.captureFromBrowser")}
          </Button>
        </div>
      </Card>

      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("ext.cookie.emptyAccounts")}</p>
        )}
        {[...groups.entries()].map(([platform, accounts]) => (
          <div key={platform} className="space-y-2">
            <h3 className="text-sm font-medium">{platform}</h3>
            {accounts.map((c) => (
              <Card key={c.id} className="space-y-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{c.label}</span>
                      {/* 「全量/混合」徽章只标从内置浏览器分区拓的(platform=browser,真混多站)。
                          弹窗登录虽也 scope=all,但用的是全新隔离 session、抓出来只是该站自己的
                          子域,实际很干净,不标徽章免误导。 */}
                      {c.meta?.scope === "all" && c.meta?.platform === "browser" && (
                        <Badge variant="info" className="shrink-0">
                          {t("ext.cookie.scopeBadgeAll")}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.meta?.domain ?? c.id}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void switchTo(c)}>
                      {t("ext.cookie.actionSwitch")}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void rename(c)}>
                      {t("ext.cookie.actionEdit")}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void relogin(c)}>
                      {t("ext.cookie.actionRepull")}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void del(c)}>
                      {t("ext.cookie.actionDelete")}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={c.autoUseByAI === true}
                      disabled={busy}
                      onCheckedChange={(next) => toggleAiUse(c, next)}
                    />
                    {t("ext.cookie.aiAutoUse")}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={c.autoInjectByAI === true}
                      disabled={busy}
                      onCheckedChange={(next) => toggleAiInject(c, next)}
                    />
                    {t("ext.cookie.aiAutoInject")}
                  </label>
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {t("ext.cookie.switchModeLabel")}
                    <SimpleSelect
                      value={c.meta?.switchMode === "merge" ? "merge" : "clear"}
                      onChange={(v) => setSwitchMode(c, v as SwitchMode)}
                      options={[
                        { value: "clear", label: t("ext.cookie.switchModeClear") },
                        { value: "merge", label: t("ext.cookie.switchModeMerge") },
                      ]}
                      size="sm"
                    />
                  </label>
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
