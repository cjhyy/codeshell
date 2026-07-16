import React from "react";
import {
  ArrowLeft,
  Blocks,
  Database,
  FileText,
  FolderCog,
  LayoutDashboard,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import { cn } from "@/lib/utils";
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

type ProjectSection = "overview" | "sources" | "profile" | "instructions" | "capabilities";

interface ProjectSectionDefinition {
  id: ProjectSection;
  label: string;
  description: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
}

const PROJECT_CONFIG_LAST_SECTION_KEY = "codeshell:project-config:last-section";

function storedProjectSection(): ProjectSection {
  if (typeof window === "undefined") return "overview";
  try {
    const stored = window.localStorage.getItem(PROJECT_CONFIG_LAST_SECTION_KEY);
    return ["overview", "sources", "profile", "instructions", "capabilities"].includes(stored ?? "")
      ? (stored as ProjectSection)
      : "overview";
  } catch {
    return "overview";
  }
}

interface InstructionFileDefinition {
  name: "CODESHELL.md" | "CLAUDE.md" | "AGENTS.md";
  label: string;
  description: string;
  primary?: boolean;
}

function ProjectInstructionsSection({ cwd }: { cwd: string }) {
  const { t } = useT();
  const files: InstructionFileDefinition[] = [
    {
      name: "CODESHELL.md",
      label: t("projectConfig.instructions.primaryLabel"),
      description: t("projectConfig.instructions.primaryDescription"),
      primary: true,
    },
    {
      name: "CLAUDE.md",
      label: t("projectConfig.instructions.claudeLabel"),
      description: t("projectConfig.instructions.claudeDescription"),
    },
    {
      name: "AGENTS.md",
      label: t("projectConfig.instructions.agentsLabel"),
      description: t("projectConfig.instructions.agentsDescription"),
    },
  ];
  const [exists, setExists] = React.useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(files.map((file) => [file.name, null])),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setExists(Object.fromEntries(files.map((file) => [file.name, null])));
    setError(null);
    void Promise.all(
      files.map(async (file) => [file.name, await window.codeshell.fileExists(cwd, file.name)]),
    )
      .then((entries) => {
        if (!cancelled) setExists(Object.fromEntries(entries));
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const open = async (fileName: string) => {
    setOpening(fileName);
    setError(null);
    try {
      await window.codeshell.openInEditor(fileName, cwd);
      const next = await window.codeshell.fileExists(cwd, fileName);
      setExists((current) => ({ ...current, [fileName]: next }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOpening(null);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t("projectConfig.instructions.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("projectConfig.instructions.subtitle")}
        </p>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {files.map((file) => (
          <div
            key={file.name}
            className="flex flex-wrap items-center justify-between gap-3 bg-background px-3 py-3"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span
                className={cn(
                  "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md",
                  file.primary ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                <FileText size={17} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-sm font-medium text-foreground">{file.name}</p>
                  {file.primary ? (
                    <Badge variant="secondary">
                      {t("projectConfig.instructions.primaryBadge")}
                    </Badge>
                  ) : null}
                  {exists[file.name] === null ? (
                    <span className="text-xs text-muted-foreground">
                      {t("projectConfig.instructions.checking")}
                    </span>
                  ) : (
                    <Badge variant={exists[file.name] ? "success" : "secondary"}>
                      {exists[file.name]
                        ? t("projectConfig.instructions.exists")
                        : t("projectConfig.instructions.missing")}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  <span className="font-medium text-foreground">{file.label}</span>
                  {" · "}
                  {file.description}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={opening !== null}
              onClick={() => void open(file.name)}
            >
              {opening === file.name
                ? t("projectConfig.instructions.opening")
                : exists[file.name]
                  ? t("projectConfig.instructions.open")
                  : t("projectConfig.instructions.create")}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectOverview({
  sections,
  onSelect,
}: {
  sections: ProjectSectionDefinition[];
  onSelect: (section: ProjectSection) => void;
}) {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">{t("projectConfig.overview.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("projectConfig.overview.subtitle")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections
          .filter(({ id }) => id !== "overview")
          .map(({ id, label, description, Icon }) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              className="h-auto min-h-28 items-start justify-start gap-3 whitespace-normal p-4 text-left"
              onClick={() => onSelect(id)}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{label}</span>
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                  {description}
                </span>
              </span>
            </Button>
          ))}
      </div>
    </div>
  );
}

/** Full-page project-scoped settings. Global connection definitions remain in Connections. */
export function ProjectConfigPage({ cwd, project, onBack }: Props) {
  const { t } = useT();
  const label = projectLabel(project);
  const sections: ProjectSectionDefinition[] = [
    {
      id: "overview",
      label: t("projectConfig.nav.overview"),
      description: t("projectConfig.nav.overviewDescription"),
      Icon: LayoutDashboard,
    },
    {
      id: "sources",
      label: t("projectConfig.nav.sources"),
      description: t("projectConfig.nav.sourcesDescription"),
      Icon: Database,
    },
    {
      id: "profile",
      label: t("projectConfig.nav.profile"),
      description: t("projectConfig.nav.profileDescription"),
      Icon: UserRound,
    },
    {
      id: "instructions",
      label: t("projectConfig.nav.instructions"),
      description: t("projectConfig.nav.instructionsDescription"),
      Icon: FileText,
    },
    {
      id: "capabilities",
      label: t("projectConfig.nav.capabilities"),
      description: t("projectConfig.nav.capabilitiesDescription"),
      Icon: Blocks,
    },
  ];
  const [active, setActive] = React.useState<ProjectSection>(storedProjectSection);
  const activeSection = sections.find((section) => section.id === active) ?? sections[0];

  React.useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_CONFIG_LAST_SECTION_KEY, active);
    } catch {
      // Storage can be unavailable; navigation still works for this visit.
    }
  }, [active]);

  return (
    <div className="flex h-full bg-background max-[720px]:flex-col">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-3 pt-4 max-[720px]:hidden">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 w-full justify-start gap-1.5 px-2 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft size={14} />
          {t("projectConfig.back")}
        </Button>
        <div className="mb-4 px-2">
          <div className="flex items-center gap-2">
            <FolderCog className="size-4 shrink-0 text-primary" aria-hidden />
            <p className="truncate text-sm font-semibold" title={label}>
              {label}
            </p>
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={cwd}>
            {cwd}
          </p>
        </div>
        <nav className="space-y-1" aria-label={t("projectConfig.nav.ariaLabel")}>
          {sections.map(({ id, label: sectionLabel, Icon }) => (
            <Button
              key={id}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "h-9 w-full justify-start gap-2 px-2 text-sm font-normal",
                active === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
              )}
              aria-current={active === id ? "page" : undefined}
              onClick={() => setActive(id)}
            >
              <Icon className="size-4" aria-hidden />
              <span className="truncate">{sectionLabel}</span>
            </Button>
          ))}
        </nav>
      </aside>

      <div className="hidden shrink-0 border-b border-border bg-card p-2 max-[720px]:flex max-[720px]:items-center max-[720px]:gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("projectConfig.back")}
          onClick={onBack}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <SimpleSelect<ProjectSection>
          value={active}
          ariaLabel={t("projectConfig.nav.ariaLabel")}
          className="min-w-0 flex-1"
          options={sections.map(({ id, label: sectionLabel }) => ({
            value: id,
            label: sectionLabel,
          }))}
          onChange={setActive}
        />
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-10 pt-8 max-[720px]:px-4 max-[720px]:pt-5">
        <div className="mx-auto w-full max-w-5xl">
          <header className="mb-6 border-b border-border pb-4">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("projectConfig.title")}
              </span>
              <Badge variant="secondary">{label}</Badge>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {activeSection.label}
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {activeSection.description}
            </p>
          </header>

          {active === "overview" ? (
            <ProjectOverview sections={sections} onSelect={setActive} />
          ) : active === "sources" ? (
            <DataSourcesSection cwd={cwd} />
          ) : active === "profile" ? (
            <ProfileSection cwd={cwd} />
          ) : active === "instructions" ? (
            <ProjectInstructionsSection cwd={cwd} />
          ) : (
            <CapabilitiesOverviewSection projects={[project]} initialProjectPath={cwd} />
          )}
        </div>
      </main>
    </div>
  );
}
