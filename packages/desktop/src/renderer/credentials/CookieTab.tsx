import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";
import type { MaskedCredentialView } from "./types";

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
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<MaskedCredentialView[]>([]);
  const [domain, setDomain] = useState("");
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
    const d = normalizeDomain(domain);
    if (!d || !label.trim()) {
      toast({ message: "域名和账号名必填", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const { jar, count } = await window.codeshell.credentials.captureCookieJar(d);
      if (count === 0) {
        toast({
          message: `${d} 暂无 cookie。请先在内置浏览器登录该账号,再回来拓取。`,
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
      toast({ message: `已保存「${label.trim()}」(${count} 个 cookie)` });
      setLabel("");
      load();
    } finally {
      setBusy(false);
    }
  };

  const repull = async (c: MaskedCredentialView) => {
    const d = c.meta?.domain;
    if (!d) {
      toast({ message: "该凭证缺少域名信息,无法重拓", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const { jar, count } = await window.codeshell.credentials.captureCookieJar(d);
      if (count === 0) {
        toast({ message: `${d} 当前无 cookie,请先在浏览器重新登录`, variant: "error" });
        return;
      }
      await window.codeshell.credentials.save(cwd, "user", {
        id: c.id,
        type: "cookie",
        label: c.label,
        secret: JSON.stringify(jar),
        meta: { platform: c.meta?.platform, domain: d },
      });
      toast({ message: `已重拓「${c.label}」(${count} 个 cookie)` });
      load();
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async (c: MaskedCredentialView) => {
    const ok = await confirm({
      title: "切换账号",
      message: `将用「${c.label}」覆盖当前浏览器登录态?`,
      detail: "当前浏览器分区的 cookie 会被清空并替换成该账号的登录态(仅 cookie,不含其他本地存储)。",
      confirmLabel: "切换",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { count } = await window.codeshell.credentials.restoreCookieToBrowser(cwd, c.id);
      toast({ message: `已切换到「${c.label}」(导回 ${count} 个 cookie),浏览器已刷新` });
    } catch (e) {
      toast({ message: `切换失败: ${String(e)}`, variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const del = async (c: MaskedCredentialView) => {
    if (!(await confirm({ message: `删除账号凭证「${c.label}」?`, destructive: true }))) return;
    await window.codeshell.credentials.remove(cwd, "user", c.id);
    load();
  };

  // 按 platform 分组
  const groups = new Map<string, MaskedCredentialView[]>();
  for (const c of items) {
    const p = c.meta?.platform ?? c.meta?.domain ?? "其他";
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(c);
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          先在内置浏览器登录目标账号,再在这里按平台域名把当前登录态存成一个具名账号。同一平台可存多个账号,
          随时「切换」回浏览器以该账号身份浏览;AI 抓取/下载时按账号取用(会弹审批)。
        </p>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.xiaohongshu.com" />
          <Button
            variant="secondary"
            onClick={() => {
              if (!url.trim()) return;
              void window.codeshell.openBrowserPopout(url.trim());
            }}
          >
            打开浏览器登录
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>平台域名</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="xiaohongshu.com" />
          </div>
          <div className="space-y-1">
            <Label>账号名</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="账号A" />
          </div>
        </div>
        <Button disabled={busy} onClick={() => void capture()}>
          {busy ? "处理中…" : "保存当前登录态"}
        </Button>
      </Card>

      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            暂无账号凭证。登录一个账号后,在上方填平台域名 + 账号名保存。
          </p>
        )}
        {[...groups.entries()].map(([platform, accounts]) => (
          <div key={platform} className="space-y-2">
            <h3 className="text-sm font-medium">{platform}</h3>
            {accounts.map((c) => (
              <Card key={c.id} className="flex items-center justify-between p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.meta?.domain ?? c.id}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void switchTo(c)}>
                    切换
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void repull(c)}>
                    重拓
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void del(c)}>
                    删除
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
