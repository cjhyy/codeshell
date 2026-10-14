import React from "react";
import type {
  AddLinkedFileSourcesInput,
  LinkedFileSourceSnapshot,
} from "../../shared/linked-file-sources";
import type { TrackedProject } from "../projects";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SimpleSelect } from "@/components/ui/simple-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../i18n";

const lines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

const optionText = (value: string) => (
  <span className="block max-w-[min(22rem,70vw)] truncate" title={value}>
    {value}
  </span>
);

/** Save exact file references from existing connections; selection never reads content. */
export function LinkedFileSourcesDialog({
  projects,
  initialProjectId,
  onClose,
  onAdded,
}: {
  projects: TrackedProject[];
  initialProjectId?: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useT();
  const [projectId, setProjectId] = React.useState(
    initialProjectId ?? (projects.length === 1 ? projects[0].id : ""),
  );
  const [snapshot, setSnapshot] = React.useState<LinkedFileSourceSnapshot | null>(null);
  const [connectionId, setConnectionId] = React.useState("");
  const [repository, setRepository] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [repo, setRepo] = React.useState("");
  const [paths, setPaths] = React.useState("");
  const [ref, setRef] = React.useState("");
  const [figma, setFigma] = React.useState("");
  const [selectedFiles, setSelectedFiles] = React.useState<Set<string>>(() => new Set());
  const [priority, setPriority] = React.useState<"normal" | "high">("high");
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const active = React.useRef(true);
  const saveLock = React.useRef(false);
  const validProject = projects.some((item) => item.id === projectId);
  const currentProject = React.useRef<string | null>(null);
  currentProject.current = validProject ? projectId : null;
  React.useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);
  const clearFiles = () => {
    setRepository("");
    setOwner("");
    setRepo("");
    setPaths("");
    setRef("");
    setFigma("");
    setSelectedFiles(new Set());
  };
  const load = React.useCallback(async () => {
    const request = ++generation.current;
    setSnapshot(null);
    setConnectionId("");
    clearFiles();
    setError(null);
    if (!validProject) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.codeshell.linkedFileSources.snapshot(projectId);
      if (!active.current || request !== generation.current || currentProject.current !== projectId)
        return;
      setSnapshot(next);
      setConnectionId(next.connections[0]?.id ?? "");
    } catch (cause) {
      if (active.current && request === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (active.current && request === generation.current) setLoading(false);
    }
  }, [projectId, validProject]);
  React.useEffect(() => {
    void load();
  }, [load]);
  const connection = snapshot?.connections.find((item) => item.id === connectionId);
  const files: AddLinkedFileSourcesInput["files"] = [];
  if (connection?.selection === "github-file") {
    const [selectedOwner, selectedRepo] = connection.resourceRestricted
      ? repository.split("/")
      : [owner.trim(), repo.trim()];
    const grantedRepository =
      !connection.resourceRestricted || connection.resources.some((item) => item.id === repository);
    if (grantedRepository && selectedOwner && selectedRepo) {
      for (const path of lines(paths))
        files.push({
          kind: "github-file",
          owner: selectedOwner,
          repo: selectedRepo,
          path,
          ...(ref.trim() ? { ref: ref.trim() } : {}),
        });
    }
  } else if (connection?.selection === "figma-file") {
    for (const item of connection.resources) {
      if (selectedFiles.has(item.id))
        files.push({ kind: "figma-file", fileUrlOrKey: item.id, label: item.label });
    }
    if (!connection.resourceRestricted)
      for (const fileUrlOrKey of lines(figma)) files.push({ kind: "figma-file", fileUrlOrKey });
  }
  const close = () => {
    if (!saveLock.current) {
      generation.current += 1;
      onClose();
    }
  };
  const add = async () => {
    if (
      saveLock.current ||
      !active.current ||
      loading ||
      !connection ||
      !validProject ||
      files.length > 100 ||
      !files.length
    )
      return;
    saveLock.current = true;
    setBusy(true);
    setError(null);
    const request = generation.current;
    try {
      await window.codeshell.linkedFileSources.add(projectId, {
        connectionId: connection.id,
        expectedRevision: connection.revision,
        files,
        priority,
      });
      if (!active.current || request !== generation.current || currentProject.current !== projectId)
        return;
      onAdded();
      onClose();
    } catch (cause) {
      if (active.current && request === generation.current && currentProject.current === projectId)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveLock.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto" showClose={!busy}>
        <DialogHeader>
          <DialogTitle>{t("sourceCollections.linkedFiles.title")}</DialogTitle>
          <DialogDescription>{t("sourceCollections.linkedFiles.hint")}</DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t("sourceCollections.linkedFiles.project")}</span>
          <SimpleSelect
            value={validProject ? projectId : ""}
            ariaLabel={t("sourceCollections.linkedFiles.project")}
            disabled={busy}
            placeholder={t("sourceCollections.linkedFiles.chooseProject")}
            onChange={(value) => {
              if (!saveLock.current) setProjectId(value);
            }}
            options={projects.map((item) => ({
              value: item.id,
              label: optionText(item.displayName ?? item.name),
              description: optionText(item.path),
            }))}
          />
        </label>
        {loading && (
          <p className="text-xs text-muted-foreground">
            {t("sourceCollections.linkedFiles.loading")}
          </p>
        )}
        {error && (
          <div role="alert" className="space-y-2 text-xs text-status-err">
            <p>{error}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={() => void (snapshot ? add() : load())}
            >
              {t("sourceCollections.linkedFiles.retry")}
            </Button>
            {snapshot && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                {t("sourceCollections.linkedFiles.reload")}
              </Button>
            )}
          </div>
        )}
        {snapshot && (
          <>
            {snapshot.connections.length ? (
              <label className="space-y-1 text-xs text-muted-foreground">
                <span>{t("sourceCollections.linkedFiles.connection")}</span>
                <SimpleSelect
                  value={connectionId}
                  ariaLabel={t("sourceCollections.linkedFiles.connection")}
                  disabled={busy}
                  onChange={(value) => {
                    if (saveLock.current) return;
                    clearFiles();
                    setConnectionId(value);
                    setError(null);
                  }}
                  options={snapshot.connections.map((item) => ({
                    value: item.id,
                    label: optionText(item.label),
                    description: optionText(item.accountLabel ?? item.providerId),
                  }))}
                />
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("sourceCollections.linkedFiles.empty")}
              </p>
            )}
            {connection?.selection === "github-file" && (
              <fieldset disabled={busy} className="space-y-3">
                {connection.resourceRestricted ? (
                  <label className="block space-y-1 text-xs text-muted-foreground">
                    <span>{t("sourceCollections.linkedFiles.repository")}</span>
                    <SimpleSelect
                      value={repository}
                      ariaLabel={t("sourceCollections.linkedFiles.repository")}
                      disabled={busy}
                      placeholder={t("sourceCollections.linkedFiles.chooseRepository")}
                      onChange={(value) => {
                        if (value !== repository) {
                          setPaths("");
                          setRef("");
                        }
                        setRepository(value);
                      }}
                      options={connection.resources.map((item) => ({
                        value: item.id,
                        label: optionText(item.label),
                        description: optionText(item.id),
                      }))}
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{t("sourceCollections.linkedFiles.owner")}</span>
                      <Input
                        name="linked-file-owner"
                        maxLength={100}
                        value={owner}
                        disabled={busy}
                        onChange={(event) => setOwner(event.target.value)}
                        placeholder="owner"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{t("sourceCollections.linkedFiles.repository")}</span>
                      <Input
                        name="linked-file-repo"
                        maxLength={100}
                        value={repo}
                        disabled={busy}
                        onChange={(event) => setRepo(event.target.value)}
                        placeholder="repository"
                      />
                    </label>
                  </div>
                )}
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>{t("sourceCollections.linkedFiles.paths")}</span>
                  <Textarea
                    name="linked-file-paths"
                    maxLength={200000}
                    value={paths}
                    disabled={busy}
                    onChange={(event) => setPaths(event.target.value)}
                    placeholder={"docs/guide.md\nREADME.md"}
                    rows={4}
                  />
                  <span className="block">{t("sourceCollections.linkedFiles.pathsHint")}</span>
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  <span>{t("sourceCollections.linkedFiles.ref")}</span>
                  <Input
                    name="linked-file-ref"
                    maxLength={300}
                    value={ref}
                    disabled={busy}
                    onChange={(event) => setRef(event.target.value)}
                  />
                </label>
              </fieldset>
            )}
            {connection?.selection === "figma-file" && (
              <fieldset disabled={busy} className="space-y-3">
                {connection.resources.length > 0 && (
                  <div className="max-h-52 space-y-2 overflow-y-auto rounded-md border border-border p-3">
                    {connection.resources.map((item) => (
                      <label key={item.id} className="flex items-start gap-2 text-sm">
                        <Checkbox
                          aria-label={item.label}
                          data-linked-file-id={item.id}
                          disabled={busy}
                          checked={selectedFiles.has(item.id)}
                          onCheckedChange={(checked) =>
                            setSelectedFiles((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(item.id);
                              else next.delete(item.id);
                              return next;
                            })
                          }
                        />
                        <span className="min-w-0 break-words">{item.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                {!connection.resourceRestricted && (
                  <label className="block space-y-1 text-xs text-muted-foreground">
                    <span>{t("sourceCollections.linkedFiles.figma")}</span>
                    <Textarea
                      name="linked-file-figma"
                      maxLength={100000}
                      value={figma}
                      disabled={busy}
                      onChange={(event) => setFigma(event.target.value)}
                      placeholder="https://www.figma.com/design/…"
                      rows={3}
                    />
                  </label>
                )}
                <p className="text-xs text-muted-foreground">
                  {t("sourceCollections.linkedFiles.figmaHint")}
                </p>
              </fieldset>
            )}
            {(["document-content-unavailable", "file-selection-unavailable"] as const).map(
              (reason) => {
                const names = snapshot.limitations
                  .filter((item) => item.reason === reason)
                  .map((item) => item.label);
                return names.length ? (
                  <p key={reason} className="text-xs text-muted-foreground">
                    {t(
                      reason === "document-content-unavailable"
                        ? "sourceCollections.linkedFiles.limitation"
                        : "sourceCollections.linkedFiles.unavailable",
                      { names: names.join("、") },
                    )}
                  </p>
                ) : null;
              },
            )}
          </>
        )}
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t("sourceCollections.linkedFiles.priority")}</span>
          <SimpleSelect<"normal" | "high">
            value={priority}
            ariaLabel={t("sourceCollections.linkedFiles.priority")}
            disabled={busy}
            onChange={setPriority}
            options={[
              { value: "high", label: t("sourceCollections.linkedFiles.high") },
              { value: "normal", label: t("sourceCollections.linkedFiles.normal") },
            ]}
          />
          <span className="block">{t("sourceCollections.linkedFiles.priorityHint")}</span>
        </label>
        {files.length > 100 && (
          <p role="alert" className="text-xs text-status-err">
            {t("sourceCollections.linkedFiles.tooMany")}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            {t("sourceCollections.cancel")}
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              loading ||
              !validProject ||
              !connection ||
              files.length === 0 ||
              files.length > 100
            }
            onClick={() => void add()}
          >
            {busy ? t("sourceCollections.working") : t("sourceCollections.linkedFiles.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
