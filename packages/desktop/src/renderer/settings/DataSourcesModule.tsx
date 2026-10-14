import React from "react";
import { useT } from "../i18n";
import { projectLabel, type TrackedProject } from "../projects";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import { DataSourceCatalogSection } from "../credentials/DataSourceCatalogSection";
import { LinkedFileSourcesDialog } from "../credentials/LinkedFileSourcesDialog";
import { DataSourcesSection } from "../project-config/DataSourcesSection";

interface Props {
  scope: "user" | "project";
  projectId: string | null;
  projects: TrackedProject[];
  onManageCollections?: () => void;
  onOpenProject?: (projectId: string) => void;
  onManageConnections?: () => void;
  returnProjectId?: string | null;
}

/** Global definitions are reusable; exact references and priority belong to a project. */
export function DataSourcesModule(props: Props) {
  return (
    <DataSourcesModuleContent
      key={props.scope === "project" ? `project:${props.projectId}` : "user"}
      {...props}
    />
  );
}

function DataSourcesModuleContent({
  scope,
  projectId,
  projects,
  onManageCollections,
  onOpenProject,
  onManageConnections,
  returnProjectId,
}: Props) {
  const { t } = useT();
  const [choosingFiles, setChoosingFiles] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const project = projects.find((item) => item.id === projectId);
  const returnProject = projects.find((item) => item.id === returnProjectId);
  const selectedProject = projects.find((item) => item.id === selectedProjectId);
  if (scope === "project" && !project) return null;
  return (
    <div className="flex flex-col gap-4" data-data-sources-module={scope}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {scope === "user" && (
            <h2 className="text-base font-semibold">{t("sourceCollections.workflow.library")}</h2>
          )}
          <p className="text-xs text-muted-foreground">
            {t(
              scope === "project"
                ? "sourceCollections.linkedFiles.priorityHint"
                : "sourceCollections.globalHint",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {scope === "project" && (
            <Button type="button" size="sm" onClick={() => setChoosingFiles(true)}>
              {t("sourceCollections.linkedFiles.title")}
            </Button>
          )}
          {scope === "project" && onManageConnections && (
            <Button type="button" variant="outline" size="sm" onClick={onManageConnections}>
              {t("sourceCollections.workflow.manageConnections")}
            </Button>
          )}
        </div>
      </div>
      {scope === "user" && onOpenProject && (
        <section
          className="space-y-3 rounded-lg border border-border bg-card p-4"
          data-source-project-navigation
        >
          <div>
            <h3 className="text-sm font-medium">{t("sourceCollections.workflow.projectAccess")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sourceCollections.workflow.projectAccessHint")}
            </p>
          </div>
          {returnProject && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpenProject(returnProject.id)}
            >
              {t("sourceCollections.workflow.returnProject", {
                project: projectLabel(returnProject),
              })}
            </Button>
          )}
          {projects.length ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                <span>{t("sourceCollections.linkedFiles.project")}</span>
                <SimpleSelect
                  size="sm"
                  value={selectedProject?.id ?? ""}
                  ariaLabel={t("sourceCollections.workflow.chooseProject")}
                  placeholder={t("sourceCollections.workflow.chooseProject")}
                  onChange={setSelectedProjectId}
                  options={projects.map((item) => ({
                    value: item.id,
                    label: projectLabel(item),
                    description: item.path,
                  }))}
                />
              </label>
              <Button
                type="button"
                size="sm"
                disabled={!selectedProject}
                onClick={() => selectedProject && onOpenProject(selectedProject.id)}
              >
                {t("sourceCollections.workflow.openProject")}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("sourceCollections.workflow.noProjects")}
            </p>
          )}
        </section>
      )}
      {scope === "project" ? (
        <DataSourcesSection
          key={`${projectId}:${revision}`}
          projectId={projectId!}
          onManageCollections={onManageCollections}
        />
      ) : (
        <DataSourceCatalogSection key={revision} onManageConnections={onManageConnections} />
      )}
      {choosingFiles && scope === "project" && project && (
        <LinkedFileSourcesDialog
          projects={[project]}
          initialProjectId={project.id}
          onClose={() => setChoosingFiles(false)}
          onAdded={() => setRevision((value) => value + 1)}
        />
      )}
    </div>
  );
}
