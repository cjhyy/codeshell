import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";
import type { MaskedCredentialView } from "./types";
import { useT } from "../i18n/I18nProvider";

/**
 * Cookie 账号凭证(凭证模块第二期)。
 *
 * 流程:在内置浏览器登录某平台某账号 → 这里输平台主域 + 账号名 → 按域拓取该域(含子域)的
 * cookie,存成一条具名 cookie 凭证(id = 平台__账号名,同一域可存多个账号)。
 *
 * 每条凭证三个动作:
 *  - 切换:把该账号的 cookie 导回浏览器覆盖当前登录态,在内置浏览器以该账号身份浏览。
 *  - 重拓:重新登录后重新拓取覆盖 jar(处理 cookie 过期)。
 *  - 删除。
 *
 * AI 抓取/下载(yt-dlp 等)经 UseCredential 工具按凭证 id 取用(走审批门),不在此页。
 */
export function CookieTab({ cwd }: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
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

  const capture = async () => {
    const d = normalizeDomain(url.replace(/^https?:\/\//, ""));
    if (!d || !label.trim()) {
      toast({ message: t("ext.cookie.needDomainAndAccount"), variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const { jar, count } = await window.codeshell.credentials.captureCookieJar(d);
      if (count === 0) {
        toast({
          message: t("ext.cookie.noCookieYet", { domain: d }),
          variant: "error",
        });
        return;
      }
      const platform = platformOf(d);
      await window.codeshell.credentials.save(cwd, "user", {
        id: buildId(platform, label),
        type: "cookie",
        label: label.trim(),
        secret: JSON.stringify(jar),
        meta: { platform, domain: d },
      });
      toast({ message: t("ext.cookie.savedToast", { label: label.trim(), count }) });
      setLabel("");
      load();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 弹窗登录(推荐,Google/YouTube 也能登):开独立登录窗 → 用户登录点保存 → 读 cookie。
   * 登录态校验没过给软提示;账号名优先用抓到的用户名,抓不到回退到表单里填的账号名。
   */
  const loginCapture = async () => {
    const raw = url.trim();
    if (!raw) {
      toast({ message: t("ext.cookie.needLoginUrl"), variant: "error" });
      return;
    }
    const fullUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const d = normalizeDomain(raw.replace(/^https?:\/\//, ""));
    const platform = platformOf(d);
    setBusy(true);
    try {
      const res = await window.codeshell.credentials.loginCapture({ url: fullUrl, platform });
      if (!res.ok) {
        if (!res.cancelled)
          toast({ message: res.error ?? t("ext.cookie.loginNotDone"), variant: "error" });
        return;
      }
      // 0 cookie 硬拒:不让用户存空/无效凭证(对齐设计 §7 + 内置浏览器拓取路径的 count===0 硬停)。
      if (res.jar.length === 0) {
        toast({ message: t("ext.cookie.emptyJarAfterLogin", { domain: res.domain }), variant: "error" });
        return;
      }
      // 账号名:抓到的用户名 > 表单填的 > 占位
      const accountName = res.suggestedLabel || label.trim() || t("ext.cookie.defaultAccountName");
      if (!res.loginCheck.ok) {
        const miss = res.loginCheck.missing?.length
          ? t("ext.cookie.notLoggedInMissing", { missing: res.loginCheck.missing.join(", ") })
          : "";
        const proceed = await confirm({
          title: t("ext.cookie.notLoggedInTitle"),
          message: t("ext.cookie.notLoggedInMessage", { domain: res.domain, miss }),
          detail: t("ext.cookie.notLoggedInDetail"),
          confirmLabel: t("ext.cookie.notLoggedInConfirm"),
        });
        if (!proceed) return;
      }
      await window.codeshell.credentials.save(cwd, "user", {
        id: buildId(platform, accountName),
        type: "cookie",
        label: accountName,
        secret: JSON.stringify(res.jar),
        meta: { platform, domain: res.domain },
      });
      toast({ message: t("ext.cookie.savedToast", { label: accountName, count: res.jar.length }) });
      setLabel("");
      load();
    } finally {
      setBusy(false);
    }
  };

  const repull = async (c: MaskedCredentialView) => {
    const d = c.meta?.domain;
    if (!d) {
      toast({ message: t("ext.cookie.repullNoDomain"), variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const { jar, count } = await window.codeshell.credentials.captureCookieJar(d);
      if (count === 0) {
        toast({ message: t("ext.cookie.repullNoCookie", { domain: d }), variant: "error" });
        return;
      }
      await window.codeshell.credentials.save(cwd, "user", {
        id: c.id,
        type: "cookie",
        label: c.label,
        secret: JSON.stringify(jar),
        meta: { platform: c.meta?.platform, domain: d },
      });
      toast({ message: t("ext.cookie.repulledToast", { label: c.label, count }) });
      load();
    } finally {
      setBusy(false);
    }
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
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void loginCapture()}>
            {busy ? t("ext.cookie.processing") : t("ext.cookie.loginAndSave")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void capture()}
            title={t("ext.cookie.captureFromBrowserTitle")}
          >
            {t("ext.cookie.captureFromBrowser")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("ext.cookie.captureHint")}</p>
      </Card>

      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("ext.cookie.emptyAccounts")}</p>
        )}
        {[...groups.entries()].map(([platform, accounts]) => (
          <div key={platform} className="space-y-2">
            <h3 className="text-sm font-medium">{platform}</h3>
            {accounts.map((c) => (
              <Card key={c.id} className="flex items-center justify-between p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.label}</div>
                  <div className="text-xs text-muted-foreground">{c.meta?.domain ?? c.id}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void switchTo(c)}>
                    {t("ext.cookie.actionSwitch")}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void repull(c)}>
                    {t("ext.cookie.actionRepull")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void del(c)}>
                    {t("ext.cookie.actionDelete")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
