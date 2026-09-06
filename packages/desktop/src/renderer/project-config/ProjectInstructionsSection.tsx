import React from "react";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";

const FILE_NAMES = ["CODESHELL.md", "CLAUDE.md", "AGENTS.md"] as const;
type InstructionName = (typeof FILE_NAMES)[number];
interface InstructionFileDefinition {
  name: InstructionName;
  label: string;
  description: string;
  primary?: boolean;
}
const unknownFiles = () =>
  Object.fromEntries(FILE_NAMES.map((name) => [name, null])) as Record<
    InstructionName,
    boolean | null
  >;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ProjectInstructionsSection({
  projectId,
  rootId,
  cwd,
}: {
  projectId: string;
  rootId: string;
  cwd: string;
}) {
  const { t } = useT();
  const headingId = React.useId();
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
  const [exists, setExists] = React.useState(unknownFiles);
  const [checking, setChecking] = React.useState(true);
  const [checkAttempt, setCheckAttempt] = React.useState(0);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [openError, setOpenError] = React.useState<{
    name: InstructionName;
    message: string;
  } | null>(null);
  const [opening, setOpening] = React.useState<InstructionName | null>(null);
  const openingRef = React.useRef<InstructionName | null>(null);
  const targetVersion = React.useRef(0);

  React.useEffect(() => {
    const version = ++targetVersion.current;
    setExists(unknownFiles());
    setChecking(true);
    setLoadError(null);
    setOpenError(null);
    setOpening(null);
    openingRef.current = null;
    void Promise.all(
      FILE_NAMES.map(async (name) => [
        name,
        await window.codeshell.projectFileExists(projectId, rootId, name),
      ]),
    )
      .then((entries) => {
        if (version === targetVersion.current) setExists(Object.fromEntries(entries));
      })
      .catch((error) => {
        if (version === targetVersion.current) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (version === targetVersion.current) setChecking(false);
      });
    return () => {
      targetVersion.current += 1;
    };
  }, [cwd, projectId, rootId, checkAttempt]);

  const open = async (fileName: InstructionName) => {
    if (openingRef.current || checking || exists[fileName] === null) return;
    const version = targetVersion.current;
    openingRef.current = fileName;
    setOpening(fileName);
    setOpenError(null);
    try {
      await window.codeshell.openInEditor(fileName, cwd);
      if (version !== targetVersion.current) return;
      const next = await window.codeshell.projectFileExists(projectId, rootId, fileName);
      if (version === targetVersion.current)
        setExists((current) => ({ ...current, [fileName]: next }));
    } catch (error) {
      if (version === targetVersion.current)
        setOpenError({ name: fileName, message: errorMessage(error) });
    } finally {
      if (version === targetVersion.current) {
        openingRef.current = null;
        setOpening(null);
      }
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={checking}
      className="min-w-0 space-y-4 rounded-2xl border border-border/70 bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={headingId} className="text-base font-semibold text-foreground">
            {t("projectConfig.instructions.title")}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {t("projectConfig.instructions.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0 rounded-lg text-muted-foreground aria-disabled:opacity-50"
          aria-disabled={checking || opening !== null}
          onClick={() => {
            if (!checking && !openingRef.current) setCheckAttempt((current) => current + 1);
          }}
        >
          <RefreshCw size={14} aria-hidden className={checking ? "animate-spin" : undefined} />
          {t("projectConfig.instructions.retry")}
        </Button>
      </div>
      {loadError && (
        <p
          role="alert"
          className="break-words rounded-xl border border-status-err/20 bg-status-err/5 p-3 text-sm text-status-err [overflow-wrap:anywhere]"
        >
          {t("projectConfig.instructions.checkFailed", { error: loadError })}
        </p>
      )}
      <ul className="min-w-0 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
        {files.map((file) => (
          <li key={file.name} className="min-w-0 bg-background/60 p-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl",
                    file.primary ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                  aria-hidden
                >
                  <FileText size={17} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-all font-mono text-sm font-medium text-foreground">
                      {file.name}
                    </h3>
                    {file.primary && (
                      <Badge variant="secondary">
                        {t("projectConfig.instructions.primaryBadge")}
                      </Badge>
                    )}
                    {exists[file.name] === null ? (
                      <span className="text-xs text-muted-foreground">
                        {t(
                          checking
                            ? "projectConfig.instructions.checking"
                            : "projectConfig.instructions.unknown",
                        )}
                      </span>
                    ) : (
                      <Badge variant={exists[file.name] ? "success" : "secondary"}>
                        {t(
                          exists[file.name]
                            ? "projectConfig.instructions.exists"
                            : "projectConfig.instructions.missing",
                        )}
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
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-lg"
                disabled={opening !== null || checking || exists[file.name] === null}
                aria-label={t(
                  exists[file.name] === false
                    ? "projectConfig.instructions.createNamed"
                    : "projectConfig.instructions.openNamed",
                  { name: file.name },
                )}
                onClick={() => void open(file.name)}
              >
                {opening === file.name && (
                  <Loader2 size={14} aria-hidden className="animate-spin" />
                )}
                {t(
                  opening === file.name
                    ? "projectConfig.instructions.opening"
                    : exists[file.name] === false
                      ? "projectConfig.instructions.create"
                      : "projectConfig.instructions.open",
                )}
              </Button>
            </div>
            {openError?.name === file.name && (
              <p
                role="alert"
                className="mt-3 break-words text-sm text-status-err [overflow-wrap:anywhere]"
              >
                {t("projectConfig.instructions.openFailed", {
                  name: file.name,
                  error: openError.message,
                })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
