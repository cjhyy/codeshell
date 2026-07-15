import React from "react";
import { ArrowLeft, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TrackedProject } from "../projects";
import { projectLabel } from "../projects";
import { useT } from "../i18n";
import { CapabilitiesOverviewSection } from "../settings/CapabilitiesOverviewSection";
import { ProfileSection } from "../settings/ProfileSection";
import { DataSourcesSection } from "./DataSourcesSection";

interface Props {
  cwd: string;
  project: TrackedProject;
  onBack: () => void;
}

function ProjectInstructionsSection({ cwd }: { cwd: string }) {
  const { t } = useT();
  const [exists, setExists] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setExists(null);
    setError(null);
    void window.codeshell
      .fileExists(cwd, "CLAUDE.md")
      .then((next) => {
        if (!cancelled) setExists(next);
      })
      .catch((caught) => {
        if (!cancelled) {
          setExists(false);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      await window.codeshell.openInEditor("CLAUDE.md", cwd);
      setExists(await window.codeshell.fileExists(cwd, "CLAUDE.md"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t("projectConfig.instructions.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("projectConfig.instructions.subtitle")}</p>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            aria-hidden
          >
            <FileText size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t("projectConfig.instructions.fileName")}
            </p>
            {exists === null ? (
              <p className="text-xs text-muted-foreground">
                {t("projectConfig.instructions.checking")}
              </p>
            ) : (
              <Badge variant={exists ? "success" : "secondary"}>
                {exists
                  ? t("projectConfig.instructions.exists")
                  : t("projectConfig.instructions.missing")}
              </Badge>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={opening} onClick={() => void open()}>
          {t("projectConfig.instructions.open")}
        </Button>
      </div>
    </section>
  );
}

/** Full-page project-scoped settings. Global connection definitions remain in Connections. */
export function ProjectConfigPage({ cwd, project, onBack }: Props) {
  const { t } = useT();
  const label = projectLabel(project);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-6 max-[720px]:px-4">
        <header className="space-y-3">
          <Button variant="ghost" size="sm" className="w-fit gap-1.5" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("projectConfig.back")}
          </Button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t("projectConfig.title")} · {label}
            </h1>
            <p className="text-sm text-muted-foreground">{t("projectConfig.subtitle")}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={cwd}>
              {cwd}
            </p>
          </div>
        </header>

        <DataSourcesSection cwd={cwd} />
        <ProfileSection cwd={cwd} />
        <ProjectInstructionsSection cwd={cwd} />
        <CapabilitiesOverviewSection projects={[project]} initialProjectPath={cwd} />
      </div>
    </div>
  );
}
