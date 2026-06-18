import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { LINK_CATALOG, type LinkIntegration } from "./link-catalog";

/**
 * Link tab = 三方集成市场(Codex 风格)。按分类列出第三方应用卡片(品牌标 + 名字 +
 * 一句话描述 + 「添加」按钮)。
 *
 * Phase 1(本期):静态壳,目录写死在 link-catalog.ts,点「添加」只给「即将开放」提示。
 * 后续:每个集成接后台服务,配 skill + 官方 MCP 读写该三方的数据。
 *
 * 注:cwd 暂未用到(后端接入后用于按项目保存集成连接),保留入参签名不变。
 */
export function LinkTab(_props: { cwd: string }) {
  const { t } = useT();
  const toast = useToast();

  const onAdd = (item: LinkIntegration) => {
    toast({ message: t("ext.link.comingSoonToast", { name: item.name }) });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("ext.link.intro")}</p>

      {LINK_CATALOG.map((cat) => (
        <section key={cat.id} className="space-y-2">
          <h3 className="text-sm font-semibold">{t(cat.titleKey)}</h3>
          <div className="space-y-1">
            {cat.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-accent/50"
              >
                <div
                  className={
                    "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white " +
                    item.brandColor
                  }
                  aria-hidden
                >
                  {item.brandText}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{item.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t(item.descKey)}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onAdd(item)}
                >
                  {t("ext.link.add")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
