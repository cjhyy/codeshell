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
      toast({ message: "请填平台域名(地址栏)和账号名", variant: "error" });
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

  /**
   * 弹窗登录(推荐,Google/YouTube 也能登):开独立登录窗 → 用户登录点保存 → 读 cookie。
   * 登录态校验没过给软提示;账号名优先用抓到的用户名,抓不到回退到表单里填的账号名。
   */
  const loginCapture = async () => {
    const raw = url.trim();
    if (!raw) {
      toast({ message: "请先填登录页 URL(或平台域名)", variant: "error" });
      return;
    }
    const fullUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const d = normalizeDomain(raw.replace(/^https?:\/\//, ""));
    const platform = platformOf(d);
    setBusy(true);
    try {
      const res = await window.codeshell.credentials.loginCapture({ url: fullUrl, platform });
      if (!res.ok) {
        if (!res.cancelled) toast({ message: res.error ?? "登录未完成", variant: "error" });
        return;
      }
      // 账号名:抓到的用户名 > 表单填的 > 占位
      const accountName = res.suggestedLabel || label.trim() || "账号";
      if (!res.loginCheck.ok) {
        const miss = res.loginCheck.missing?.length ? `(缺 ${res.loginCheck.missing.join(", ")})` : "";
        const proceed = await confirm({
          title: "似乎未登录成功",
          message: `没检测到 ${res.domain} 的登录态${miss},仍要保存吗?`,
          detail: "可能是没真正登录,或该站的登录特征未被识别。保存后若 AI 用着报错,回来「重拓」即可。",
          confirmLabel: "仍然保存",
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
      toast({ message: `已保存「${accountName}」(${res.jar.length} 个 cookie)` });
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
          填登录页地址 → 弹出独立登录窗(Google/YouTube 等内置浏览器登不上的站也能登)→ 登录后点窗口里的
          「我已登录,保存」→ 自动存成一个具名账号(用完即焚的无痕会话,识别到用户名会自动命名)。
          同一平台可存多个账号,随时「切换」回浏览器;AI 抓取/下载按账号取用(会弹审批)。
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>登录页地址 / 平台域名</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com"
            />
          </div>
          <div className="space-y-1">
            <Label>账号名(可留空,自动识别)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="账号A" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void loginCapture()}>
            {busy ? "处理中…" : "弹窗登录并保存"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void capture()}
            title="从内置浏览器分区拓取(适合已在内置浏览器登录过的站,如小红书)"
          >
            从内置浏览器拓取
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          已在内置浏览器登录过(如小红书)→ 填平台域名后用「从内置浏览器拓取」即可,无需弹窗。
        </p>
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
