import React from "react";
import { useT } from "../i18n";
import type { TrackedProject } from "../projects";
import { Button } from "@/components/ui/button";
import { DataSourceCatalogSection } from "../credentials/DataSourceCatalogSection";
import { LinkedFileSourcesDialog } from "../credentials/LinkedFileSourcesDialog";
import { DataSourcesSection } from "../project-config/DataSourcesSection";

interface Props {
  scope: "user" | "project";
  projectId: string | null;
  projects: TrackedProject[];
  onManageCollections?: () => void;
}

/** Global definitions are reusable; exact references and priority belong to a project. */
export function DataSourcesModule({ scope, projectId, projects, onManageCollections }: Props) {
  const { t } = useT();
  const [choosingFiles, setChoosingFiles] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => setChoosingFiles(false), [scope, projectId]);
  if (scope === "project" && !projectId) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(
            scope === "project"
              ? "sourceCollections.linkedFiles.priorityHint"
              : "sourceCollections.globalHint",
          )}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setChoosingFiles(true)}>
          {t("sourceCollections.linkedFiles.title")}
        </Button>
      </div>
      {scope === "project" ? (
        <DataSourcesSection
          key={`${projectId}:${revision}`}
          projectId={projectId!}
          onManageCollections={onManageCollections}
        />
      ) : (
        <DataSourceCatalogSection key={revision} />
      )}
      {choosingFiles && (
        <LinkedFileSourcesDialog
          key={`${scope}:${projectId ?? "global"}`}
          projects={projects}
          initialProjectId={scope === "project" ? projectId : null}
          onClose={() => setChoosingFiles(false)}
          onAdded={() => setRevision((value) => value + 1)}
        />
      )}
    </div>
  );
}
