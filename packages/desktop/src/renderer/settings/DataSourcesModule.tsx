import React from "react";
import { useT } from "../i18n";
import { DataSourceCatalogSection } from "../credentials/DataSourceCatalogSection";
import { DataSourcesSection } from "../project-config/DataSourcesSection";

interface Props {
  scope: "user" | "project";
  projectPath: string | null;
}

/**
 * 设置中心「数据源」模块。全局 scope = 连接目录(与凭证页共享同一组件,
 * 单一数据源);项目 scope = 该项目的绑定与上传(复用项目配置组件)。
 */
export function DataSourcesModule({ scope, projectPath }: Props) {
  const { t } = useT();
  if (scope === "project") {
    if (!projectPath) return null;
    return <DataSourcesSection cwd={projectPath} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("settingsX.dataSources.globalHint")}</p>
      <DataSourceCatalogSection />
    </div>
  );
}
