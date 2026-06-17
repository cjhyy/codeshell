import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";

/**
 * Cookie登录态桥接入口。Cookie 不存进凭证库 —— 登录态本就常驻 persist:browser
 * 分区,用时现抓成临时 cookies.txt(Cookie Lease)。这里只列出已有登录态的域名 +
 * 提供「在浏览器打开登陆」入口 + 预览可桥接的 cookie 数量。
 */
export function CookieTab() {
  const { t } = useT();
  const toast = useToast();
  const [domains, setDomains] = useState<string[]>([]);
  const [url, setUrl] = useState("");

  const load = () => void window.codeshell.credentials.cookieDomains().then(setDomains);
  useEffect(load, []);

  const preview = async (domain: string) => {
    const { count } = await window.codeshell.credentials.cookiePreview(domain);
    toast({ message: t("ext.cookie.previewToast", { domain, count }) });
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t("ext.cookie.intro")}
        </p>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.xiaohongshu.com"
          />
          <Button
            onClick={() => {
              if (!url.trim()) return;
              void window.codeshell.openBrowserPopout(url.trim());
            }}
          >
            {t("ext.cookie.openLogin")}
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("ext.cookie.domainsTitle")}</h3>
        <Button variant="ghost" size="sm" onClick={load}>
          {t("ext.cookie.refresh")}
        </Button>
      </div>
      <div className="space-y-2">
        {domains.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("ext.cookie.emptyDomains")}</p>
        )}
        {domains.map((d) => (
          <Card key={d} className="flex items-center justify-between p-3">
            <span className="truncate font-mono text-sm">{d}</span>
            <Button variant="ghost" size="sm" onClick={() => void preview(d)}>
              {t("ext.cookie.previewCount")}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
