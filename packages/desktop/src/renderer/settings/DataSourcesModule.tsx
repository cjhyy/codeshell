import React from "react";
import { useT } from "../i18n";
import { DataSourceCatalogSection } from "../credentials/DataSourceCatalogSection";
import { DataSourcesSection } from "../project-config/DataSourcesSection";

interface Props {
  scope: "user" | "project";
  projectId: string | null;
}

/**
 * Global scope owns reusable collections and advanced sources; project scope
 * saves explicit references and retains existing project-local uploads.
 */
export function DataSourcesModule({ scope, projectId }: Props) {
  const { t } = useT();
  if (scope === "project") {
    if (!projectId) return null;
    return <DataSourcesSection projectId={projectId} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("sourceCollections.globalHint")}</p>
      <DataSourceCatalogSection />
    </div>
  );
}
