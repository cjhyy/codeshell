import React from "react";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";

interface InstructionFileDefinition {
  name: "CODESHELL.md" | "CLAUDE.md" | "AGENTS.md";
  label: string;
  description: string;
  primary?: boolean;
}

export function ProjectInstructionsSection({ cwd }: { cwd: string }) {
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
