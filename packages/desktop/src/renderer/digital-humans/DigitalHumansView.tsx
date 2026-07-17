import React from "react";
import {
  Brain,
  Check,
  Download,
  GitFork,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UsersRound,
} from "lucide-react";
import type { DigitalHumanTeam, DigitalHumanTeamMode } from "@cjhyy/code-shell-pet";
import type { DigitalHumanProfileImportPreview } from "../../shared/digital-human-profile-transfer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { DigitalHumanEditorDialog } from "./DigitalHumanEditorDialog";
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSelection,
} from "./types";
import { useDigitalHumanOperations, useDigitalHumansLibrary } from "./useDigitalHumansLibrary";

interface Props {
  activeProjectPath: string | null;
  currentSelection?: DigitalHumanSelection | null;
  onUse: (selection: DigitalHumanSelection) => void;
  onClearSelection?: () => void;
  confirmDelete?: (request: DigitalHumanDeleteRequest) => Promise<boolean>;
}

export interface DigitalHumanDeleteRequest {
  kind: "profile" | "team";
  id: string;
  label: string;
  clearsCurrentSelection: boolean;
  clearsProjectDefault: boolean;
}

function capabilityCount(profile: DigitalHumanProfileEntry): number {
  return (
    profile.plugins.length + profile.skills.length + profile.mcp.length + profile.agents.length
  );
}

function modeKey(mode: DigitalHumanTeamMode): "auto" | "divide" | "compare" {
  return mode;
}

export function DigitalHumansView({
  activeProjectPath,
  currentSelection,
  onUse,
  onClearSelection,
  confirmDelete,
}: Props) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { profiles, catalog, teams, availableSkills, status, error, refresh } =
    useDigitalHumansLibrary(activeProjectPath);
  const operations = useDigitalHumanOperations(refresh);
  const [query, setQuery] = React.useState("");
  const [teamEditor, setTeamEditor] = React.useState<{ team?: DigitalHumanTeam } | null>(null);
  const [editor, setEditor] = React.useState<{ profile?: DigitalHumanProfileEntry } | null>(null);
  const [importPreview, setImportPreview] = React.useState<DigitalHumanProfileImportPreview | null>(
    null,
  );
  const [importPickerBusy, setImportPickerBusy] = React.useState(false);
  const importPickerLock = React.useRef(false);

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    opts: { name: string; successMessage?: string },
  ): Promise<boolean> => {
    const result = await operations.run(key, action);
    if (!result.ok && !result.duplicate) {
      toast({
        message: t("digitalHumans.actionFailed", {
          name: opts.name,
          message: result.error instanceof Error ? result.error.message : String(result.error),
        }),
        variant: "error",
      });
      return false;
    }
    if (!result.ok) return false;
    if (opts.successMessage) toast({ message: opts.successMessage });
    return true;
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (profile: { name: string; label: string; description?: string }) =>
    !normalizedQuery ||
    [profile.name, profile.label, profile.description ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery),
    );
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  const visibleCatalog = catalog.filter(matches);
  const visibleProfiles = profiles.filter(matches);
  const visibleTeams = teams.filter((team) =>
    matches({ name: team.id, label: team.name, description: team.description }),
  );

  const requestDelete = async (request: DigitalHumanDeleteRequest): Promise<boolean> => {
    if (confirmDelete) return confirmDelete(request);
    const detail = [
      request.clearsProjectDefault ? t("digitalHumans.delete.clearsProjectDefault") : null,
      request.clearsCurrentSelection ? t("digitalHumans.delete.clearsCurrentSelection") : null,
      request.kind === "profile" ? t("digitalHumans.delete.profileMemoryWarning") : null,
    ]
      .filter(Boolean)
      .join(" ");
    return confirm({
      title: t(`digitalHumans.delete.${request.kind}Title`, { name: request.label }),
      message: t(`digitalHumans.delete.${request.kind}Message`, { name: request.label }),
      ...(detail ? { detail } : {}),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
  };

  const deleteProfileEntry = async (profile: DigitalHumanProfileEntry) => {
    const clearsCurrentSelection =
      currentSelection?.kind === "single" && currentSelection.id === profile.name;
    const accepted = await requestDelete({
      kind: "profile",
      id: profile.name,
      label: profile.label,
      clearsCurrentSelection,
      clearsProjectDefault: profile.active,
    });
    if (!accepted) return;
    const deleted = await run(
      `delete-profile:${profile.name}`,
      () =>
        window.codeshell.deleteProfile(profile.name, {
          ...(activeProjectPath ? { cwd: activeProjectPath } : {}),
          ...(profile.active ? { clearActiveProject: true } : {}),
        }),
      { name: profile.label },
    );
    if (deleted && clearsCurrentSelection) onClearSelection?.();
  };

  const deleteTeamEntry = async (team: DigitalHumanTeam) => {
    const clearsCurrentSelection =
      currentSelection?.kind === "team" && currentSelection.id === team.id;
    const accepted = await requestDelete({
      kind: "team",
      id: team.id,
      label: team.name,
      clearsCurrentSelection,
      clearsProjectDefault: false,
    });
    if (!accepted) return;
    const deleted = await run(
      `delete-team:${team.id}`,
      () => window.codeshell.deleteDigitalHumanTeam(team.id),
      { name: team.name },
    );
    if (deleted && clearsCurrentSelection) onClearSelection?.();
  };

  const pickProfileDefinitionImport = async () => {
    if (importPickerLock.current) return;
    importPickerLock.current = true;
    setImportPickerBusy(true);
    try {
      const result = await window.codeshell.pickProfileDefinitionImport();
      if (!result.canceled) setImportPreview(result.preview);
    } catch (caught) {
      toast({
        message: t("digitalHumans.actionFailed", {
          name: t("digitalHumans.transfer.importDefinition"),
          message: caught instanceof Error ? caught.message : String(caught),
        }),
        variant: "error",
      });
    } finally {
      importPickerLock.current = false;
      setImportPickerBusy(false);
    }
  };

  const confirmProfileOverwrite = (preview: DigitalHumanProfileImportPreview) =>
    confirm({
      title: t("digitalHumans.transfer.overwriteTitle", { name: preview.label }),
      message: t("digitalHumans.transfer.overwriteMessage", {
        label: preview.label,
        id: preview.name,
      }),
      detail: t("digitalHumans.transfer.overwriteDetail"),
      confirmLabel: t("digitalHumans.transfer.overwrite"),
      destructive: true,
    });

  const commitProfileDefinitionImport = async () => {
    if (!importPreview) return;
    const preview = importPreview;
    const result = await operations.run(`import-profile:${preview.name}`, async () => {
      let overwrite = false;
      if (preview.alreadyExists) {
        if (!(await confirmProfileOverwrite(preview))) return { canceled: true } as const;
        overwrite = true;
      }

      let committed = await window.codeshell.importReviewedProfileDefinition({
        reviewToken: preview.reviewToken,
        ...(overwrite ? { overwrite: true } : {}),
      });
      if (!committed.ok && committed.alreadyExists && !overwrite) {
        if (!(await confirmProfileOverwrite(preview))) return { canceled: true } as const;
        committed = await window.codeshell.importReviewedProfileDefinition({
          reviewToken: preview.reviewToken,
          overwrite: true,
        });
      }
      return { canceled: false, committed } as const;
    });
    if (!result.ok) {
      if (!result.duplicate) {
        toast({
          message: t("digitalHumans.actionFailed", {
            name: preview.label,
            message: result.error instanceof Error ? result.error.message : String(result.error),
          }),
          variant: "error",
        });
      }
      return;
    }
    if (result.value.canceled) return;
    if (!result.value.committed.ok) {
      toast({
        message: t("digitalHumans.transfer.overwriteRequired", {
          name: result.value.committed.label,
        }),
        variant: "error",
      });
      return;
    }
    setImportPreview(null);
    toast({
      message: t("digitalHumans.transfer.imported", {
        name: result.value.committed.label,
      }),
    });
  };

  const exportProfileEntry = async (profile: DigitalHumanProfileEntry) => {
    const result = await operations.run(`export-profile:${profile.name}`, () =>
      window.codeshell.exportProfileDefinition(profile.name),
    );
    if (!result.ok) {
      if (!result.duplicate) {
        toast({
          message: t("digitalHumans.actionFailed", {
            name: profile.label,
            message: result.error instanceof Error ? result.error.message : String(result.error),
          }),
          variant: "error",
        });
      }
      return;
    }
    if (!result.value.canceled) {
      toast({
        message: t("digitalHumans.transfer.exported", {
          name: result.value.label,
          file: result.value.fileName,
        }),
      });
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="border-b border-border/70 px-6 py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <UsersRound size={18} aria-hidden="true" />
              </span>
              <h1 className="text-xl font-semibold tracking-tight">{t("digitalHumans.title")}</h1>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("digitalHumans.subtitle")}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void pickProfileDefinitionImport()}
              disabled={importPickerBusy}
            >
              {importPickerBusy ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : (
                <Upload size={14} aria-hidden="true" />
              )}
              {t("digitalHumans.transfer.importDefinition")}
            </Button>
            <Button size="sm" onClick={() => setEditor({})}>
              <Plus size={14} aria-hidden="true" />
              {t("digitalHumans.editor.create")}
            </Button>
            <div className="relative w-full sm:w-72">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder={t("digitalHumans.search")}
                aria-label={t("digitalHumans.searchLabel")}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-6xl">
          {status === "loading" ? (
            <EmptyState
              Icon={Loader2}
              iconClassName="animate-spin"
              title={t("digitalHumans.loading")}
              description={t("digitalHumans.loadingDescription")}
            />
          ) : status === "error" ? (
            <ErrorState
              error={error ?? t("digitalHumans.loadFailed")}
              onRetry={() => void refresh()}
            />
          ) : (
            <>
              {error ? (
                <div
                  className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-status-err/30 bg-status-err/5 px-3 py-2 text-sm text-status-err"
                  role="alert"
                >
                  <span>{error}</span>
                  <Button size="sm" variant="outline" onClick={() => void refresh()}>
                    <RefreshCw size={13} aria-hidden="true" />
                    {t("digitalHumans.retry")}
                  </Button>
                </div>
              ) : null}
              {status === "refreshing" ? (
                <div
                  className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"
                  role="status"
                >
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  {t("digitalHumans.refreshing")}
                </div>
              ) : null}
              <Tabs defaultValue="market">
                <TabsList>
                  <TabsTrigger value="market">{t("digitalHumans.tabs.market")}</TabsTrigger>
                  <TabsTrigger value="mine">{t("digitalHumans.tabs.mine")}</TabsTrigger>
                  <TabsTrigger value="teams">{t("digitalHumans.tabs.teams")}</TabsTrigger>
                </TabsList>

                <TabsContent value="market" className="mt-5">
                  <div className="mb-4 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                    <Sparkles size={14} className="shrink-0 text-primary" aria-hidden="true" />
                    {t("digitalHumans.marketHint")}
                  </div>
                  {visibleCatalog.length === 0 ? (
                    <SearchEmptyState />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {visibleCatalog.map((entry) => (
                        <CatalogCard
                          key={entry.name}
                          entry={entry}
                          busy={operations.isBusy(`install:${entry.name}`)}
                          onInstall={() =>
                            void run(
                              `install:${entry.name}`,
                              () => window.codeshell.installCatalogProfile(entry.name),
                              {
                                name: entry.label,
                                successMessage: t("digitalHumans.installDone", {
                                  name: entry.label,
                                }),
                              },
                            )
                          }
                          onUse={() =>
                            onUse({ kind: "single", id: entry.name, label: entry.label })
                          }
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="mine" className="mt-5">
                  {profiles.length === 0 ? (
                    <EmptyState
                      Icon={Brain}
                      title={t("digitalHumans.empty.title")}
                      description={t("digitalHumans.empty.description")}
                    />
                  ) : visibleProfiles.length === 0 ? (
                    <SearchEmptyState />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {visibleProfiles.map((profile) => (
                        <ProfileCard
                          key={profile.name}
                          profile={profile}
                          hasProject={Boolean(activeProjectPath)}
                          busy={
                            operations.isBusy(`profile:${profile.name}`) ||
                            operations.isBusy(`delete-profile:${profile.name}`) ||
                            operations.isBusy(`export-profile:${profile.name}`)
                          }
                          onUse={() =>
                            onUse({ kind: "single", id: profile.name, label: profile.label })
                          }
                          onEdit={() => setEditor({ profile })}
                          onExport={() => void exportProfileEntry(profile)}
                          onDelete={() => void deleteProfileEntry(profile)}
                          onToggleDefault={() => {
                            if (!activeProjectPath) return;
                            void run(
                              `profile:${profile.name}`,
                              () =>
                                profile.active
                                  ? window.codeshell.deactivateProfile(activeProjectPath)
                                  : window.codeshell.activateProfile(
                                      activeProjectPath,
                                      profile.name,
                                    ),
                              { name: profile.label },
                            );
                          }}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="teams" className="mt-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium">{t("digitalHumans.team.title")}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("digitalHumans.team.description")}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Button
                        size="sm"
                        onClick={() => setTeamEditor({})}
                        disabled={profiles.length < 2}
                      >
                        <Plus size={14} aria-hidden="true" />
                        {t("digitalHumans.team.create")}
                      </Button>
                      {profiles.length < 2 ? (
                        <p className="max-w-xs text-right text-xs text-muted-foreground">
                          {t("digitalHumans.team.needMembers")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {teams.length === 0 ? (
                    <EmptyState
                      Icon={GitFork}
                      title={t("digitalHumans.team.emptyTitle")}
                      description={
                        profiles.length < 2
                          ? t("digitalHumans.team.needMembers")
                          : t("digitalHumans.team.emptyDescription")
                      }
                    />
                  ) : visibleTeams.length === 0 ? (
                    <SearchEmptyState />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {visibleTeams.map((team) => (
                        <TeamCard
                          key={team.id}
                          team={team}
                          memberLabels={team.members.map(
                            (member) => profileByName.get(member)?.label ?? member,
                          )}
                          busy={operations.isBusy(`delete-team:${team.id}`)}
                          onUse={() =>
                            onUse({
                              kind: "team",
                              id: team.id,
                              label: team.name,
                              members: team.members,
                              mode: team.mode,
                            })
                          }
                          onEdit={() => setTeamEditor({ team })}
                          onDelete={() => void deleteTeamEntry(team)}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>

      <DigitalHumanEditorDialog
        open={editor !== null}
        profile={editor?.profile}
        existingIds={profiles.map((profile) => profile.name)}
        skills={availableSkills}
        busy={operations.isBusy("save-profile")}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSave={(profile) => {
          void (async () => {
            const saved = await run("save-profile", () => window.codeshell.saveProfile(profile), {
              name: profile.label,
            });
            if (saved) setEditor(null);
          })();
        }}
      />

      <ProfileDefinitionImportDialog
        preview={importPreview}
        busy={importPreview ? operations.isBusy(`import-profile:${importPreview.name}`) : false}
        onOpenChange={(open) => {
          if (!open) setImportPreview(null);
        }}
        onImport={() => void commitProfileDefinitionImport()}
      />

      <TeamDialog
        open={teamEditor !== null}
        team={teamEditor?.team}
        profiles={profiles}
        busy={operations.isBusy("save-team")}
        onOpenChange={(open) => {
          if (!open) setTeamEditor(null);
        }}
        onSave={(team) => {
          void (async () => {
            const saved = await run(
              "save-team",
              () => window.codeshell.saveDigitalHumanTeam(team),
              { name: team.name },
            );
            if (saved) setTeamEditor(null);
          })();
        }}
      />
    </section>
  );
}

function ProfileDefinitionImportDialog({
  preview,
  busy,
  onOpenChange,
  onImport,
}: {
  preview: DigitalHumanProfileImportPreview | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: () => void;
}) {
  const { t } = useT();
  if (!preview) return null;
  const counts = preview.capabilityCounts;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("digitalHumans.transfer.previewTitle")}</DialogTitle>
          <DialogDescription>{t("digitalHumans.transfer.previewDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="rounded-lg border border-border/70 bg-muted/20 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-base font-semibold">{preview.label}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{preview.name}</p>
              </div>
              {preview.alreadyExists ? (
                <Badge variant="warning">{t("digitalHumans.transfer.alreadyExists")}</Badge>
              ) : null}
            </div>
            {preview.description ? (
              <p className="mt-3 text-sm leading-5 text-muted-foreground">{preview.description}</p>
            ) : null}
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("digitalHumans.transfer.sourceFile")}
              </dt>
              <dd className="mt-1 break-all font-medium">{preview.sourceFileName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("digitalHumans.transfer.basePreset")}
              </dt>
              <dd className="mt-1 font-medium">{preview.basePreset}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("digitalHumans.transfer.version")}
              </dt>
              <dd className="mt-1 font-medium">
                {preview.version ?? t("digitalHumans.transfer.notSpecified")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("digitalHumans.transfer.portableMemory")}
              </dt>
              <dd className="mt-1 font-medium">
                {preview.portableMemory
                  ? t("digitalHumans.transfer.enabled")
                  : t("digitalHumans.transfer.disabled")}
              </dd>
            </div>
          </dl>

          <div className="rounded-lg border border-border/70 px-4 py-3">
            <p className="text-sm font-medium">
              {t("digitalHumans.transfer.capabilities", { count: counts.total })}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("digitalHumans.transfer.capabilityBreakdown", {
                plugins: counts.plugins,
                skills: counts.skills,
                mcp: counts.mcp,
                agents: counts.agents,
              })}
            </p>
          </div>

          <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {t("digitalHumans.transfer.definitionOnlyNotice")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onImport} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t("digitalHumans.transfer.importing")
              : t("digitalHumans.transfer.confirmImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CatalogCard({
  entry,
  busy,
  onInstall,
  onUse,
}: {
  entry: DigitalHumanCatalogEntry;
  busy: boolean;
  onInstall: () => void;
  onUse: () => void;
}) {
  const { t } = useT();
  return (
    <Card className="flex min-h-56 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{entry.label}</CardTitle>
          {entry.installed ? (
            <Badge variant="success">
              <Check size={11} className="mr-1" aria-hidden="true" />
              {t("digitalHumans.installed")}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">{entry.description}</p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        {entry.tags.map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="gap-2">
        {entry.installed ? (
          <Button size="sm" onClick={onUse}>
            {t("digitalHumans.use")}
          </Button>
        ) : (
          <Button size="sm" onClick={onInstall} disabled={busy}>
            {busy ? t("digitalHumans.installing") : t("digitalHumans.install")}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function ProfileCard({
  profile,
  hasProject,
  busy,
  onUse,
  onEdit,
  onExport,
  onDelete,
  onToggleDefault,
}: {
  profile: DigitalHumanProfileEntry;
  hasProject: boolean;
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
  onToggleDefault: () => void;
}) {
  const { t } = useT();
  const count = capabilityCount(profile);
  return (
    <Card className="flex min-h-56 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{profile.label}</CardTitle>
          {profile.active ? <Badge variant="accent">{t("digitalHumans.current")}</Badge> : null}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {profile.description ?? t("digitalHumans.noDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        <Badge variant="secondary">{profile.basePreset}</Badge>
        {count > 0 ? (
          <Badge variant="secondary">{t("digitalHumans.capabilityCount", { count })}</Badge>
        ) : null}
        {profile.portableMemory ? (
          <Badge variant="secondary">{t("digitalHumans.portableMemory")}</Badge>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="min-w-0 flex-1"
            onClick={onUse}
            disabled={busy}
            title={t("digitalHumans.useHint")}
          >
            {t("digitalHumans.use")}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            <Pencil size={13} aria-hidden="true" />
            {t("digitalHumans.editor.edit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onExport}
            disabled={busy}
            title={t("digitalHumans.transfer.exportDefinitionHint")}
          >
            <Download size={13} aria-hidden="true" />
            {t("digitalHumans.transfer.exportDefinition")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            aria-label={t("digitalHumans.delete.profileButton", { name: profile.label })}
            title={t("digitalHumans.delete.profileButton", { name: profile.label })}
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-end justify-between gap-3 border-t border-border/70 pt-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium text-foreground">
              {t("digitalHumans.projectDefaultLabel")}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {hasProject
                ? t("digitalHumans.setProjectDefaultHint")
                : t("digitalHumans.pickProject")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={onToggleDefault}
            disabled={!hasProject || busy}
          >
            {profile.active
              ? t("digitalHumans.clearDefault")
              : t("digitalHumans.setProjectDefault")}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function TeamCard({
  team,
  memberLabels,
  busy,
  onUse,
  onEdit,
  onDelete,
}: {
  team: DigitalHumanTeam;
  memberLabels: string[];
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  return (
    <Card className="flex min-h-52 flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">{team.name}</CardTitle>
          <Badge variant="info">{t(`digitalHumans.team.mode.${modeKey(team.mode)}`)}</Badge>
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {team.description ?? t("digitalHumans.team.defaultDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5">
        {memberLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        <Button size="sm" onClick={onUse} disabled={busy}>
          <Sparkles size={14} aria-hidden="true" />
          {t("digitalHumans.team.use")}
        </Button>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
            <Pencil size={13} aria-hidden="true" />
            {t("digitalHumans.team.edit")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            disabled={busy}
            aria-label={t("digitalHumans.delete.teamButton", { name: team.name })}
            title={t("digitalHumans.delete.teamButton", { name: team.name })}
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

export function createDigitalHumanTeamId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `team-${Date.now().toString(36)}-${random}`;
}

export function useDigitalHumanTeamDraft(
  open: boolean,
  team: DigitalHumanTeam | undefined,
  profiles: DigitalHumanProfileEntry[],
) {
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [mode, setMode] = React.useState<DigitalHumanTeamMode>("auto");
  const [members, setMembers] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    if (!open) return;
    setId(team?.id ?? createDigitalHumanTeamId());
    setName(team?.name ?? "");
    setDescription(team?.description ?? "");
    setMode(team?.mode ?? "auto");
    setMembers(new Set(team?.members ?? []));
  }, [open, team]);

  const toggleMember = React.useCallback((memberId: string) => {
    setMembers((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }, []);

  const knownMembers = new Set(profiles.map((profile) => profile.name));
  const missingMembers = [...members].filter((member) => !knownMembers.has(member));
  const canSave =
    Boolean(id) && Boolean(name.trim()) && members.size >= 2 && missingMembers.length === 0;
  const toTeam = (): DigitalHumanTeam | null =>
    canSave
      ? {
          id,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          members: [...members],
          mode,
        }
      : null;

  return {
    id,
    name,
    setName,
    description,
    setDescription,
    mode,
    setMode,
    members,
    toggleMember,
    missingMembers,
    canSave,
    toTeam,
  };
}

export function TeamDialog({
  open,
  team,
  profiles,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  team?: DigitalHumanTeam;
  profiles: DigitalHumanProfileEntry[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (team: DigitalHumanTeam) => void;
}) {
  const { t } = useT();
  const {
    name,
    setName,
    description,
    setDescription,
    mode,
    setMode,
    members,
    toggleMember,
    missingMembers,
    canSave: draftCanSave,
    toTeam,
  } = useDigitalHumanTeamDraft(open, team, profiles);
  const memberOptions = [
    ...profiles.map((profile) => ({
      id: profile.name,
      label: profile.label,
      missing: false,
    })),
    ...missingMembers.map((member) => ({ id: member, label: member, missing: true })),
  ];
  const canSave = draftCanSave && !busy;
  const submit = () => {
    if (!canSave) return;
    const value = toTeam();
    if (value) onSave(value);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {team
              ? t("digitalHumans.team.dialogEditTitle")
              : t("digitalHumans.team.dialogCreateTitle")}
          </DialogTitle>
          <DialogDescription>
            {team
              ? t("digitalHumans.team.dialogEditDescription")
              : t("digitalHumans.team.dialogCreateDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="digital-human-team-name">{t("digitalHumans.team.name")}</Label>
              <Input
                id="digital-human-team-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("digitalHumans.team.namePlaceholder")}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="digital-human-team-description">
                {t("digitalHumans.team.descriptionLabel")}
              </Label>
              <Input
                id="digital-human-team-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("digitalHumans.team.descriptionPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="digital-human-team-mode">{t("digitalHumans.team.modeLabel")}</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as DigitalHumanTeamMode)}
              >
                <SelectTrigger
                  id="digital-human-team-mode"
                  aria-label={t("digitalHumans.team.modeLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("digitalHumans.team.mode.auto")}</SelectItem>
                  <SelectItem value="divide">{t("digitalHumans.team.mode.divide")}</SelectItem>
                  <SelectItem value="compare">{t("digitalHumans.team.mode.compare")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("digitalHumans.team.members")}</legend>
              <div className="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {memberOptions.map((profile) => {
                  const selected = members.has(profile.id);
                  return (
                    <Button
                      key={profile.id}
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-auto justify-start px-3 py-2",
                        selected && "border-primary/50 bg-primary/5",
                      )}
                      aria-pressed={selected}
                      aria-label={t("digitalHumans.team.memberToggle", {
                        name: profile.label,
                        state: selected
                          ? t("digitalHumans.team.memberSelected")
                          : t("digitalHumans.team.memberNotSelected"),
                      })}
                      onClick={() => toggleMember(profile.id)}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded border border-border",
                          selected && "border-primary bg-primary text-primary-foreground",
                        )}
                      >
                        {selected ? <Check size={11} aria-hidden="true" /> : null}
                      </span>
                      <span className="truncate">{profile.label}</span>
                      {profile.missing ? (
                        <Badge variant="warning">{t("digitalHumans.team.memberMissing")}</Badge>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("digitalHumans.team.memberCount", { count: members.size })}
              </p>
              {missingMembers.length > 0 ? (
                <p className="text-xs text-status-err" role="alert">
                  {t("digitalHumans.team.removeMissingMembers")}
                </p>
              ) : null}
            </fieldset>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {busy ? t("digitalHumans.team.saving") : t("digitalHumans.team.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SearchEmptyState() {
  const { t } = useT();
  return (
    <EmptyState
      Icon={Search}
      title={t("digitalHumans.noSearchResults")}
      description={t("digitalHumans.noSearchResultsDescription")}
    />
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useT();
  return (
    <Card role="alert">
      <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-status-err/10 text-status-err">
          <RefreshCw size={20} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-medium">{t("digitalHumans.loadFailed")}</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{error}</p>
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden="true" />
          {t("digitalHumans.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  Icon,
  title,
  description,
  iconClassName,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
  iconClassName?: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon size={20} className={iconClassName} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
