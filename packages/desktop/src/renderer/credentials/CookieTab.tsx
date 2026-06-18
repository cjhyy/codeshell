import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SimpleSelect } from "@/components/ui/simple-select";
import { useToast } from "../ui/ToastProvider";
import { useConfirm, usePrompt } from "../ui/DialogProvider";
import type { MaskedCredentialView } from "./types";
import { useT } from "../i18n/I18nProvider";

type Scope = "domain" | "all";

/**
 * Cookie 账号凭证 —— 唯一抓取路径是「弹窗登录」(开独立无痕窗现登,抓完即焚)。
 *
 * 三块:
 *  1. 登录抓取:填登录页地址 + 抓取范围(仅当前域 / 整个会话全量),点「弹窗登录并保存」。
 *     全量用于登录态跨域、按域抓不全的站(如小红书)。
 *  2. 账号卡片:每张可切换 / 编辑(重命名)/ 重新登录 / 删除,带逐条「AI 可自动取用」开关。
 *  3. 切换语义=先清空整分区 cookie 再整包导回(干净换号,见后端 restoreCookiesToBrowser)。
 *
 * (注:旧「从内置浏览器拓取」入口已删 —— 它读的是 codeshell 内置浏览器分区、需先在那登一遍,
 *  不如弹窗登录一步到位;重新登录也走同一条弹窗路径。)
 *
 * AI 抓取/下载经 UseCredential 工具按凭证 id 取用,逐条开关或全局总闸决定是否免审批。
 */
export function CookieTab({ cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<Scope>("domain");
  const [busy, setBusy] = useState(false);

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

  /** 主域:从用户输入里取 eTLD+1 的「站点名」当 platform(去 www. / 端口 / 路径)。 */
  const normalizeDomain = (raw: string): string =>
    raw.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];

  const platformOf = (d: string): string => {
    const parts = d.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : d; // xiaohongshu.com → xiaohongshu
  };

  /**
   * 弹窗登录抓 cookie(唯一抓取路径)。开独立登录窗 → 用户登录点保存 → 读 cookie。
   * fixed 传入时为「重新登录」既有凭证(沿用其域 / 范围 / id,不改名);否则是新建。
   * 返回是否成功(供调用方决定 toast / 清表单)。
   */
  const runLogin = async (opts: {
    rawUrl: string;
    scope: Scope;
    fixed?: { id: string; label: string; autoUseByAI?: boolean };
  }): Promise<boolean> => {
    const raw = opts.rawUrl.trim();
    if (!raw) {
      toast({ message: t("ext.cookie.needLoginUrl"), variant: "error" });
      return false;
    }
    const fullUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const d = normalizeDomain(raw.replace(/^https?:\/\//, ""));
    const platform = platformOf(d);
    const isAll = opts.scope === "all";
    setBusy(true);
    try {
      const res = await window.codeshell.credentials.loginCapture({
        url: fullUrl,
        platform,
        fullCapture: isAll,
      });
      if (!res.ok) {
        if (!res.cancelled)
          toast({ message: res.error ?? t("ext.cookie.loginNotDone"), variant: "error" });
        return false;
      }
      // 0 cookie 硬拒:不让用户存空/无效凭证。
      if (res.jar.length === 0) {
        toast({ message: t("ext.cookie.emptyJarAfterLogin", { domain: res.domain }), variant: "error" });
        return false;
      }
      // 全量模式不做登录态校验(jar 跨域,evaluateLoginState 按目标域判会误报)。
      if (!isAll && !res.loginCheck.ok) {
        const miss = res.loginCheck.missing?.length
          ? t("ext.cookie.notLoggedInMissing", { missing: res.loginCheck.missing.join(", ") })
          : "";
        const proceed = await confirm({
          title: t("ext.cookie.notLoggedInTitle"),
          message: t("ext.cookie.notLoggedInMessage", { domain: res.domain, miss }),
          detail: t("ext.cookie.notLoggedInDetail"),
          confirmLabel: t("ext.cookie.notLoggedInConfirm"),
        });
        if (!proceed) return false;
      }
      // 重新登录:沿用原 id / label / AI 开关;新建:抓到的用户名 > 表单填的 > 占位。
      const accountName = opts.fixed
        ? opts.fixed.label
        : res.suggestedLabel || label.trim() || t("ext.cookie.defaultAccountName");
      const id = opts.fixed ? opts.fixed.id : buildId(platform, accountName);
      await window.codeshell.credentials.save(cwd, "user", {
        id,
        type: "cookie",
        label: accountName,
        secret: JSON.stringify(res.jar),
        autoUseByAI: opts.fixed?.autoUseByAI,
        meta: { platform, domain: res.domain, scope: opts.scope },
      });
      const msgKey = opts.fixed
        ? "ext.cookie.repulledToast"
        : isAll
          ? "ext.cookie.capturedAllToast"
          : "ext.cookie.savedToast";
      toast({ message: t(msgKey, { label: accountName, count: res.jar.length }) });
      load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** 顶部表单:新建账号(弹窗登录)。 */
  const loginCapture = async () => {
    const ok = await runLogin({ rawUrl: url, scope });
    if (ok) setLabel("");
  };

  /** 卡片「重新登录」:用原凭证的域 + 范围重新弹窗登录,刷新过期 cookie。 */
  const relogin = async (c: MaskedCredentialView) => {
    const d = c.meta?.domain;
    if (!d) {
      toast({ message: t("ext.cookie.repullNoDomain"), variant: "error" });
      return;
    }
    await runLogin({
      rawUrl: d,
      scope: c.meta?.scope === "all" ? "all" : "domain",
      fixed: { id: c.id, label: c.label, autoUseByAI: c.autoUseByAI },
    });
  };

  const switchTo = async (c: MaskedCredentialView) => {
    const ok = await confirm({
      title: t("ext.cookie.switchTitle"),
      message: t("ext.cookie.switchMessage", { label: c.label }),
      detail: t("ext.cookie.switchDetail"),
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

  /** 编辑:重命名账号(id 不变,只改展示 label —— 切换/取用都按 id,改名安全)。 */
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

  /** 逐条「AI 可自动取用」开关:写回凭证 autoUseByAI(只改元数据,保留 secret)。 */
  const toggleAiUse = async (c: MaskedCredentialView, next: boolean) => {
    setBusy(true);
    try {
      await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { autoUseByAI: next });
      load();
      toast({
        message: next
          ? t("ext.cookie.aiAutoUseOnToast", { label: c.label })
          : t("ext.cookie.aiAutoUseOffToast", { label: c.label }),
      });
    } finally {
      setBusy(false);
    }
  };

  /** 逐条「AI 可自动注入浏览器」开关:写回凭证 autoInjectByAI。 */
  const toggleAiInject = async (c: MaskedCredentialView, next: boolean) => {
    setBusy(true);
    try {
      await window.codeshell.credentials.patchMeta(cwd, "user", c.id, { autoInjectByAI: next });
      load();
      toast({
        message: next
          ? t("ext.cookie.aiAutoInjectOnToast", { label: c.label })
          : t("ext.cookie.aiAutoInjectOffToast", { label: c.label }),
      });
    } finally {
      setBusy(false);
    }
  };

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
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("ext.cookie.urlLabel")}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("ext.cookie.urlPlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("ext.cookie.accountLabel")}</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("ext.cookie.accountPlaceholder")}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t("ext.cookie.scopeLabel")}</Label>
          <SimpleSelect
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { value: "domain", label: t("ext.cookie.scopeDomain"), description: t("ext.cookie.scopeDomainDesc") },
              { value: "all", label: t("ext.cookie.scopeAll"), description: t("ext.cookie.scopeAllDesc") },
            ]}
            size="sm"
          />
        </div>
        <Button disabled={busy} onClick={() => void loginCapture()}>
          {busy ? t("ext.cookie.processing") : t("ext.cookie.loginAndSave")}
        </Button>
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
                      {c.meta?.scope === "all" && (
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
                      onCheckedChange={(next) => void toggleAiUse(c, next)}
                    />
                    {t("ext.cookie.aiAutoUse")}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={c.autoInjectByAI === true}
                      disabled={busy}
                      onCheckedChange={(next) => void toggleAiInject(c, next)}
                    />
                    {t("ext.cookie.aiAutoInject")}
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
