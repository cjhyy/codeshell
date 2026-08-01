import React from "react";
import {
  Brain,
  Check,
  ChevronRight,
  Code2,
  Download,
  Eye,
  GitFork,
  MoreHorizontal,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT,
  DIGITAL_HUMAN_TEAM_MEMBER_MAX,
  DIGITAL_HUMAN_TEAM_MEMBER_MIN,
  DIGITAL_HUMAN_TEAM_NAME_LIMIT,
  DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT,
  type DigitalHumanTeam,
  type DigitalHumanTeamMode,
} from "../../shared/digital-human-team";
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
import { Textarea } from "@/components/ui/textarea";
import { SimpleSelect } from "@/components/ui/simple-select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { DigitalHumanEditorDialog } from "./DigitalHumanEditorDialog";
import { DigitalHumanMemoryDialog } from "./DigitalHumanMemoryDialog";
import { ensureDigitalHumanRequirements } from "./profileRequirements";
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSelection,
  DigitalHumanSkillEntry,
  CuratedDigitalHumanTeam,
} from "./types";
import {
  digitalHumanMissingSkillNames,
  digitalHumanNamedProjectRequirementSkillNames,
  hasDigitalHumanCatchAllSkillRequirement,
  normalizeDigitalHumanSkillRepo,
} from "./types";
import { CURATED_DIGITAL_HUMAN_TEAMS, profileSamplePrompts } from "./marketplace";
import { useDigitalHumanOperations, useDigitalHumansLibrary } from "./useDigitalHumansLibrary";

interface Props {
  activeProjectPath: string | null;
  onUse: (selection: DigitalHumanSelection, starterPrompt?: string) => void;
  confirmDelete?: (request: DigitalHumanDeleteRequest) => Promise<boolean>;
  /** Jump to settings › digital humans, where repos are managed in full. */
  onOpenSettings?: () => void;
  /**
   * A digital human was removed from the library. The host must drop the binding
   * from its Session index too: a Session that never ran has no engine state, so
   * the backend's unbind cannot reach it, and opening it later would send a
   * profile that no longer exists.
   */
  onProfileDeleted?: (name: string) => void;
}

export interface DigitalHumanDeleteRequest {
  kind: "profile" | "team";
  id: string;
  label: string;
  clearsCurrentSelection: boolean;
  clearsProjectDefault: boolean;
}

type DigitalHumanCategory = DigitalHumanCatalogEntry["category"];
type MarketKind = "single" | "team";
type DigitalHumanTab = "mine" | "teams" | "market";
type DigitalHumanDetail =
  | { kind: "catalog"; entry: DigitalHumanCatalogEntry }
  | { kind: "profile"; profile: DigitalHumanProfileEntry }
  | { kind: "team"; team: DigitalHumanTeam }
  | { kind: "curated-team"; team: CuratedDigitalHumanTeam };

function capabilityCount(profile: DigitalHumanProfileEntry): number {
  return (
    profile.plugins.length + profile.skills.length + profile.mcp.length + profile.agents.length
  );
}

function sameMembers(left: Set<string>, right: string[]): boolean {
  return left.size === right.length && right.every((member) => left.has(member));
}

export function DigitalHumansView({
  activeProjectPath,
  onUse,
  confirmDelete,
  onOpenSettings,
  onProfileDeleted,
}: Props) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { profiles, catalog, teams, availableSkills, status, error, refresh } =
    useDigitalHumansLibrary(activeProjectPath);
  const operations = useDigitalHumanOperations(refresh);
  const [query, setQuery] = React.useState("");
  const [activeTab, setActiveTab] = React.useState<DigitalHumanTab>("mine");
  const [marketKind, setMarketKind] = React.useState<MarketKind>("single");
  const [detail, setDetail] = React.useState<DigitalHumanDetail | null>(null);
  const [teamEditor, setTeamEditor] = React.useState<{ team?: DigitalHumanTeam } | null>(null);
  const [editor, setEditor] = React.useState<{ profile?: DigitalHumanProfileEntry } | null>(null);
  const [memoryProfile, setMemoryProfile] = React.useState<DigitalHumanProfileEntry | null>(null);
  const [importPreview, setImportPreview] = React.useState<DigitalHumanProfileImportPreview | null>(
    null,
  );
  const [importPickerBusy, setImportPickerBusy] = React.useState(false);
  const importPickerLock = React.useRef(false);
  const [selectionBusy, setSelectionBusy] = React.useState(false);
  const selectionLock = React.useRef(false);
  const [editorSaveFlowBusy, setEditorSaveFlowBusy] = React.useState(false);
  const [editorInstallFlowBusy, setEditorInstallFlowBusy] = React.useState(false);
  const editorSaveFlowLock = React.useRef(false);

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
  const visibleCatalog = catalog.filter(
    (entry) =>
      matches(entry) ||
      // Tags stay searchable — they just no longer get their own filter bar.
      entry.tags.some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const visibleProfiles = profiles.filter(matches);
  const visibleTeams = teams.filter((team) =>
    matches({ name: team.id, label: team.name, description: team.description }),
  );
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
  const visibleCuratedTeams = CURATED_DIGITAL_HUMAN_TEAMS.filter(
    (team) =>
      !normalizedQuery ||
      [team.id, team.name, team.description, ...team.tags, ...team.members].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery),
      ),
  );

  /**
   * Nothing is shipped in the market at all (as opposed to a filter hiding
   * everything). The bundled catalog and curated teams are both intentionally
   * empty now, so the whole browse UI would be chrome over a void.
   */
  const marketIsEmpty = catalog.length === 0 && CURATED_DIGITAL_HUMAN_TEAMS.length === 0;

  // How many digital-human repos are registered. Purely informational on this
  // page (the full manager lives in settings), so a failed read is ignored.
  const [repoCount, setRepoCount] = React.useState(0);
  const refreshRepoCount = React.useCallback(async () => {
    try {
      setRepoCount((await window.codeshell.listProfileRepos()).length);
    } catch {
      // The catalog itself remains usable when only this informational count
      // cannot be read.
    }
  }, []);
  React.useEffect(() => {
    void refreshRepoCount();
  }, [catalog.length, refreshRepoCount]);

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
    // Preflight first: deleteProfile throws when a team or Session still binds
    // the profile, but that lands AFTER the user confirmed, as a raw English
    // error listing session ids. Explain it up front instead.
    try {
      const preview = await window.codeshell.previewProfileDeletion(
        profile.name,
        activeProjectPath ?? undefined,
      );
      if (!preview.canDelete) {
        const reasons = [
          preview.blockingTeams.length
            ? t("digitalHumans.delete.blockedByTeams", {
                teams: preview.blockingTeams.join("、"),
              })
            : null,
          preview.blockingSessions.length
            ? [
                t("digitalHumans.delete.blockedBySessions", {
                  count: preview.blockingSessions.length,
                }),
                // Name them: "still bound to 3 sessions" leaves the user with no
                // way to find which conversations to unbind.
                ...preview.blockingSessions.map((session) => {
                  const label = session.title ?? session.id;
                  const where = session.workspace
                    ? ` — ${session.workspace.split("/").pop() ?? session.workspace}`
                    : "";
                  return `  · ${label}${where}`;
                }),
              ].join("\n")
            : null,
        ].filter(Boolean);
        // Offer the way through instead of a dead end: unbinding is safe (the
        // Sessions survive), so make it one confirmed action rather than manual
        // work across every blocking conversation.
        const forced = await confirm({
          title: t("digitalHumans.delete.blockedTitle", { name: profile.label }),
          message: reasons.join("\n"),
          detail: t("digitalHumans.delete.forceDetail"),
          confirmLabel: t("digitalHumans.delete.forceConfirm"),
          destructive: true,
        });
        if (!forced) return;
        await run(
          `delete-profile:${profile.name}`,
          async () => {
            const result = await window.codeshell.forceDeleteProfile(
              profile.name,
              activeProjectPath ?? undefined,
            );
            const notes = [
              result.unboundSessions.length
                ? t("digitalHumans.delete.forceUnbound", {
                    count: result.unboundSessions.length,
                  })
                : null,
              result.updatedTeams.length
                ? t("digitalHumans.delete.forceTeamsUpdated", {
                    teams: result.updatedTeams.join("、"),
                  })
                : null,
              result.removedTeams.length
                ? t("digitalHumans.delete.forceTeamsRemoved", {
                    teams: result.removedTeams.join("、"),
                  })
                : null,
            ].filter(Boolean);
            onProfileDeleted?.(profile.name);
            if (notes.length > 0) toast({ message: notes.join(" · ") });
          },
          { name: profile.label },
        );
        return;
      }
    } catch {
      // Preflight is advisory — if it fails, fall through to the normal path
      // and let the backend be the authority.
    }

    const clearsCurrentSelection = false;
    const accepted = await requestDelete({
      kind: "profile",
      id: profile.name,
      label: profile.label,
      clearsCurrentSelection,
      clearsProjectDefault: profile.active,
    });
    if (!accepted) return;
    if (
      await run(
        `delete-profile:${profile.name}`,
        () =>
          window.codeshell.deleteProfile(profile.name, {
            ...(activeProjectPath ? { cwd: activeProjectPath } : {}),
            ...(profile.active ? { clearActiveProject: true } : {}),
          }),
        { name: profile.label },
      )
    ) {
      // Also on the plain path: the backend only unbinds Sessions that reached
      // disk, so the renderer index can still hold the deleted profile.
      onProfileDeleted?.(profile.name);
    }
  };

  const deleteTeamEntry = async (team: DigitalHumanTeam) => {
    const clearsCurrentSelection = false;
    const accepted = team.localOverride
      ? await confirm({
          title: t("digitalHumans.team.restoreSourceTitle"),
          message: t("digitalHumans.team.restoreSourceMessage", {
            name: team.name,
            repo: team.sourceRepo ?? "",
          }),
          detail: t("digitalHumans.team.restoreSourceDetail"),
          confirmLabel: t("digitalHumans.team.restoreSource"),
          destructive: true,
        })
      : await requestDelete({
          kind: "team",
          id: team.id,
          label: team.name,
          clearsCurrentSelection,
          clearsProjectDefault: false,
        });
    if (!accepted) return;
    await run(`delete-team:${team.id}`, () => window.codeshell.deleteDigitalHumanTeam(team.id), {
      name: team.name,
    });
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

  /**
   * 数字人声明的 skill/工具依赖，在启用前补齐。
   *
   * 安装会克隆远程仓库并跑 `npx skills add`，属于执行远程代码，必须先把「将要
   * 发生什么」摊给用户看。返回 false 表示用户取消，调用方应中止启用。
   * 依赖安装失败会阻断启用：继续创建一个已知缺能力的 Session，只会把安装错误
   * 推迟成模型调用 `/skill` 时更难理解的失败。
   */
  const ensureProfileRequirements = async (name: string): Promise<boolean> => {
    return ensureDigitalHumanRequirements({
      name,
      projectPath: activeProjectPath,
      api: window.codeshell,
      confirm,
      toast,
      t,
    });
  };

  /**
   * Starting work must satisfy dependencies too, not just "set as project default".
   *
   * A digital human whose `requires` were never installed is exactly the shell
   * this feature exists to prevent: a real session bound to `video-director`
   * called `/hyperframes` and got "Skill not found", then flailed with Glob
   * before giving up. Starting work is the *common* entry point, so gating only the
   * default toggle left the main path unguarded. Downloading a definition is
   * deliberately excluded: it only adds an editable library entry and must not
   * create a Session or execute the definition's Skill installers.
   *
   * Teams resolve every member: skills install per project (two projects are
   * genuinely two installs), and members usually share requirements, so the
   * second pass finds them already present and skips.
   */
  const ensureSelectionRequirements = async (
    selection: DigitalHumanSelection,
  ): Promise<boolean> => {
    const names = selection.kind === "single" ? [selection.id] : selection.members;
    // Install any member missing from the library FIRST. A team definition names
    // members the user may never have downloaded individually — starting it still
    // created their Sessions, and the lead's first SendMessageToSession then died
    // with "Workspace profile … is unavailable". Starting a team must bring the
    // whole roster.
    // A local team may come from a repo before each member has been downloaded,
    // so the start action resolves that roster here, immediately before use.
    const installedNames = new Set(profiles.map((profile) => profile.name));
    const missing = names.filter((name) => !installedNames.has(name));
    for (const name of missing) {
      const entry = catalog.find((candidate) => candidate.name === name);
      if (!entry) {
        toast({
          message: t("digitalHumans.team.memberUnavailable", { name }),
          variant: "error",
        });
        return false;
      }
      if (
        !(await run(`install:${name}`, () => window.codeshell.installCatalogProfile(name), {
          name: entry.label,
        }))
      ) {
        return false;
      }
    }
    if (missing.length > 0) await refresh();

    for (const name of names) {
      if (!(await ensureProfileRequirements(name))) return false;
    }
    return true;
  };

  /** Single choke point: every start-using path goes through the dependency gate. */
  const useSelection = (selection: DigitalHumanSelection, starterPrompt?: string): void => {
    if (selectionLock.current) return;
    selectionLock.current = true;
    setSelectionBusy(true);
    void (async () => {
      try {
        if (!(await ensureSelectionRequirements(selection))) return;
        onUse(selection, starterPrompt);
      } finally {
        selectionLock.current = false;
        setSelectionBusy(false);
      }
    })();
  };

  const commitProfileDefinitionImport = async () => {
    if (!importPreview) return;
    const preview = importPreview;
    const result = await operations.run(`import-profile:${preview.name}`, async () => {
      let overwrite = false;
      if (preview.alreadyExists) {
        if (!(await confirmProfileOverwrite(preview))) return { canceled: true } as const;
        overwrite = true;
      }

      let committed = await window.codeshell.importReviewedProfileDefinition(
        {
          reviewToken: preview.reviewToken,
          ...(overwrite ? { overwrite: true } : {}),
        },
        activeProjectPath ?? undefined,
      );
      if (!committed.ok && committed.alreadyExists && !overwrite) {
        if (!(await confirmProfileOverwrite(preview))) return { canceled: true } as const;
        committed = await window.codeshell.importReviewedProfileDefinition(
          {
            reviewToken: preview.reviewToken,
            overwrite: true,
          },
          activeProjectPath ?? undefined,
        );
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

  /**
   * Marketplace actions are download-only. They never create a Session and
   * never install Skill requirements; both happen later from My digital humans
   * when the user explicitly chooses Start using.
   */
  const downloadCatalogEntry = async (entry: DigitalHumanCatalogEntry): Promise<void> => {
    if (entry.installed) {
      setDetail(null);
      setActiveTab("mine");
      return;
    }
    const downloaded = await run(
      `install:${entry.name}`,
      () => window.codeshell.installCatalogProfile(entry.name),
      {
        name: entry.label,
        successMessage: t("digitalHumans.installDone", { name: entry.label }),
      },
    );
    if (!downloaded) return;
    setDetail(null);
    setActiveTab("mine");
  };

  const downloadCuratedTeam = async (blueprint: CuratedDigitalHumanTeam): Promise<void> => {
    const existingTeam = teams.find((team) => team.id === blueprint.id);
    if (existingTeam) {
      setDetail(null);
      setActiveTab("teams");
      return;
    }

    const installed = await run(
      `install-team:${blueprint.id}`,
      async () => {
        for (const member of blueprint.members) {
          const entry = catalogByName.get(member);
          if (!entry) throw new Error(`Missing bundled digital human: ${member}`);
          if (!entry.installed) await window.codeshell.installCatalogProfile(member);
        }
        await window.codeshell.saveDigitalHumanTeam({
          id: blueprint.id,
          name: blueprint.name,
          description: blueprint.description,
          members: [...blueprint.members],
          mode: blueprint.mode,
        });
      },
      {
        name: blueprint.name,
        successMessage: t("digitalHumans.team.installDone", { name: blueprint.name }),
      },
    );
    if (!installed) return;
    setDetail(null);
    setActiveTab("teams");
  };

  const launchDetail = (starterPrompt?: string): void => {
    if (!detail) return;
    if (detail.kind === "catalog") {
      void downloadCatalogEntry(detail.entry);
      return;
    }
    if (detail.kind === "curated-team") {
      void downloadCuratedTeam(detail.team);
      return;
    }
    if (detail.kind === "profile") {
      useSelection(
        { kind: "single", id: detail.profile.name, label: detail.profile.label },
        starterPrompt,
      );
      return;
    }
    useSelection(
      {
        kind: "team",
        id: detail.team.id,
        label: detail.team.name,
        members: detail.team.members,
        mode: detail.team.mode,
        team: detail.team,
      },
      starterPrompt,
    );
  };

  const detailBusy =
    selectionBusy ||
    (detail?.kind === "catalog"
      ? operations.isBusy(`install:${detail.entry.name}`)
      : detail?.kind === "curated-team"
        ? operations.isBusy(`install-team:${detail.team.id}`)
        : false);
  const activeProfile = profiles.find((profile) => profile.active);
  const activeProjectName =
    activeProjectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("digitalHumans.workspace.none");
  const activeSection =
    activeTab === "mine"
      ? {
          title: t("digitalHumans.sections.mineTitle"),
          description: t("digitalHumans.sections.mineDescription"),
          count: visibleProfiles.length,
        }
      : activeTab === "teams"
        ? {
            title: t("digitalHumans.sections.teamsTitle"),
            description: t("digitalHumans.sections.teamsDescription"),
            count: visibleTeams.length,
          }
        : {
            title: t("digitalHumans.sections.marketTitle"),
            description: t("digitalHumans.sections.marketDescription"),
            count: marketKind === "single" ? visibleCatalog.length : visibleCuratedTeams.length,
          };

  return (
    <section className="digital-human-page-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto w-full max-w-7xl">
          <header className="digital-human-hero relative overflow-hidden rounded-2xl border border-border/70 px-5 py-5 sm:px-7 sm:py-6">
            <div className="relative z-10 flex flex-col justify-between gap-6 xl:flex-row xl:items-end">
              <div className="max-w-2xl">
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                  {t("digitalHumans.eyebrow")}
                </p>
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
                    <UsersRound size={20} aria-hidden="true" />
                  </span>
                  <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                    {t("digitalHumans.title")}
                  </h1>
                </div>
                <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                  {t("digitalHumans.subtitle")}
                </p>
              </div>

              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <dl className="grid grid-cols-3 gap-5 border-y border-border/60 py-3 sm:border-y-0 sm:border-r sm:py-0 sm:pr-5">
                  <HeroMetric value={profiles.length} label={t("digitalHumans.metrics.people")} />
                  <HeroMetric value={teams.length} label={t("digitalHumans.metrics.teams")} />
                  <HeroMetric value={repoCount} label={t("digitalHumans.metrics.sources")} />
                </dl>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void pickProfileDefinitionImport()}
                    disabled={importPickerBusy}
                    className="bg-background/70"
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
                </div>
              </div>
            </div>
          </header>

          {status === "loading" ? (
            <div className="mt-5 rounded-xl border border-border/70 bg-card/80">
              <EmptyState
                Icon={Loader2}
                iconClassName="animate-spin"
                title={t("digitalHumans.loading")}
                description={t("digitalHumans.loadingDescription")}
              />
            </div>
          ) : status === "error" ? (
            <div className="mt-5 rounded-xl border border-border/70 bg-card/80">
              <ErrorState
                error={error ?? t("digitalHumans.loadFailed")}
                onRetry={() => void refresh()}
              />
            </div>
          ) : (
            <Tabs
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as DigitalHumanTab)}
              className="mt-5 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start"
            >
              <aside className="w-full shrink-0 lg:sticky lg:top-0 lg:w-56">
                <TabsList
                  className="digital-human-nav grid h-auto w-full grid-cols-3 gap-1 rounded-xl border-border/70 bg-card/85 p-1.5 shadow-sm lg:flex lg:flex-col"
                  aria-label={t("digitalHumans.navigationLabel")}
                >
                  <TabsTrigger
                    value="mine"
                    className="digital-human-nav-item h-11 justify-start gap-2.5 px-3"
                  >
                    <UserRound size={15} aria-hidden="true" />
                    <span className="min-w-0 truncate">{t("digitalHumans.tabs.mine")}</span>
                    <span className="ml-auto hidden text-xs tabular-nums text-muted-foreground lg:inline">
                      {profiles.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="teams"
                    className="digital-human-nav-item h-11 justify-start gap-2.5 px-3"
                  >
                    <UsersRound size={15} aria-hidden="true" />
                    <span className="min-w-0 truncate">{t("digitalHumans.tabs.teams")}</span>
                    <span className="ml-auto hidden text-xs tabular-nums text-muted-foreground lg:inline">
                      {teams.length}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="market"
                    className="digital-human-nav-item h-11 justify-start gap-2.5 px-3"
                  >
                    <Sparkles size={15} aria-hidden="true" />
                    <span className="min-w-0 truncate">{t("digitalHumans.tabs.market")}</span>
                    <span className="ml-auto hidden text-xs tabular-nums text-muted-foreground lg:inline">
                      {catalog.length + CURATED_DIGITAL_HUMAN_TEAMS.length}
                    </span>
                  </TabsTrigger>
                </TabsList>

                <div className="mt-3 hidden rounded-xl border border-border/70 bg-card/70 p-4 lg:block">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {t("digitalHumans.workspace.title")}
                  </p>
                  <p className="mt-2 truncate text-sm font-medium" title={activeProjectPath ?? ""}>
                    {activeProjectName}
                  </p>
                  <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        activeProfile ? "bg-status-ok" : "bg-muted-foreground/35",
                      )}
                      aria-hidden="true"
                    />
                    <p className="min-w-0 truncate text-xs text-muted-foreground">
                      {activeProfile
                        ? t("digitalHumans.workspace.default", { name: activeProfile.label })
                        : t("digitalHumans.workspace.unassigned")}
                    </p>
                  </div>
                </div>
              </aside>

              <div className="min-w-0 flex-1 rounded-xl border border-border/70 bg-card/85 p-4 shadow-sm sm:p-5">
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

                <div className="mb-5 flex flex-col justify-between gap-3 border-b border-border/60 pb-4 lg:flex-row lg:items-end">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold tracking-tight">
                        {activeSection.title}
                      </h2>
                      <Badge variant="secondary">{activeSection.count}</Badge>
                    </div>
                    <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                      {activeSection.description}
                    </p>
                  </div>
                  <div className="relative w-full shrink-0 sm:w-64">
                    <Search
                      size={15}
                      className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      className="bg-background/80 pl-9"
                      placeholder={t("digitalHumans.search")}
                      aria-label={t("digitalHumans.searchLabel")}
                    />
                  </div>
                </div>

                <TabsContent value="market" className="mt-0">
                  {/* Adding a repo belongs here, not only in settings: this is
                      the page where you notice the market is empty. */}
                  <AddRepoRow
                    onAdded={() => {
                      void refresh();
                      // A valid repo may contain zero valid definitions, so a
                      // catalog-length effect alone cannot keep this count fresh.
                      void refreshRepoCount();
                    }}
                    repoCount={repoCount}
                    onManage={onOpenSettings}
                  />
                  {marketIsEmpty ? (
                    // Nothing is shipped at all — a "browse (0)" heading over an
                    // empty grid is chrome. Show only where to get one.
                    <CatalogEmptyState
                      onImport={() => void pickProfileDefinitionImport()}
                      onCreate={() => setEditor({})}
                      importBusy={importPickerBusy}
                    />
                  ) : (
                    <>
                      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold tracking-tight">
                              {t("digitalHumans.market.browseTitle")}
                            </h3>
                            <Badge variant="secondary">
                              {marketKind === "single"
                                ? visibleCatalog.length
                                : visibleCuratedTeams.length}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {t("digitalHumans.market.browseDescription")}
                          </p>
                        </div>
                        <div className="flex rounded-md border border-border/80 bg-muted/30 p-0.5">
                          <Button
                            type="button"
                            size="sm"
                            variant={marketKind === "single" ? "secondary" : "ghost"}
                            className="h-7"
                            onClick={() => setMarketKind("single")}
                          >
                            <UserRound size={13} aria-hidden="true" />
                            {t("digitalHumans.market.singles")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={marketKind === "team" ? "secondary" : "ghost"}
                            className="h-7"
                            onClick={() => setMarketKind("team")}
                            data-testid="digital-human-market-teams"
                          >
                            <UsersRound size={13} aria-hidden="true" />
                            {t("digitalHumans.market.groups")}
                          </Button>
                        </div>
                      </div>

                      {marketKind === "single" ? (
                        visibleCatalog.length === 0 ? (
                          // Reachable only when a filter/search hid everything —
                          // the "nothing shipped" case short-circuits above.
                          <SearchEmptyState />
                        ) : (
                          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                            {visibleCatalog.map((entry) => (
                              <CatalogCard
                                key={entry.name}
                                entry={entry}
                                busy={selectionBusy || operations.isBusy(`install:${entry.name}`)}
                                onDetails={() => setDetail({ kind: "catalog", entry })}
                                onDownload={() => void downloadCatalogEntry(entry)}
                              />
                            ))}
                          </div>
                        )
                      ) : visibleCuratedTeams.length === 0 ? (
                        <SearchEmptyState />
                      ) : (
                        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {visibleCuratedTeams.map((team) => (
                            <CuratedTeamCard
                              key={team.id}
                              team={team}
                              catalogByName={catalogByName}
                              installed={teams.some((candidate) => candidate.id === team.id)}
                              busy={selectionBusy || operations.isBusy(`install-team:${team.id}`)}
                              onDetails={() => setDetail({ kind: "curated-team", team })}
                              onDownload={() => void downloadCuratedTeam(team)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </TabsContent>

                <TabsContent value="mine" className="mt-0">
                  {profiles.length === 0 ? (
                    <LibraryEmptyState
                      onCreate={() => setEditor({})}
                      onImport={() => void pickProfileDefinitionImport()}
                      importBusy={importPickerBusy}
                    />
                  ) : visibleProfiles.length === 0 ? (
                    <SearchEmptyState />
                  ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {visibleProfiles.map((profile) => (
                        <ProfileCard
                          key={profile.name}
                          profile={profile}
                          missingSkillCount={
                            digitalHumanMissingSkillNames(
                              profile.skills,
                              profile.requires,
                              availableSkills,
                            ).length
                          }
                          requirementsNeedReview={hasDigitalHumanCatchAllSkillRequirement(
                            profile.requires,
                          )}
                          hasProject={Boolean(activeProjectPath)}
                          busy={
                            selectionBusy ||
                            operations.isBusy(`profile:${profile.name}`) ||
                            operations.isBusy(`delete-profile:${profile.name}`)
                          }
                          onUse={() =>
                            useSelection({ kind: "single", id: profile.name, label: profile.label })
                          }
                          onDetails={() => setDetail({ kind: "profile", profile })}
                          onEdit={() => setEditor({ profile })}
                          onMemory={() => setMemoryProfile(profile)}
                          onDelete={() => void deleteProfileEntry(profile)}
                          onToggleDefault={() => {
                            if (!activeProjectPath) return;
                            void run(
                              `profile:${profile.name}`,
                              async () => {
                                if (profile.active) {
                                  return window.codeshell.deactivateProfile(activeProjectPath);
                                }
                                // 补齐依赖后再启用，否则数字人声明的 skill 在这台
                                // 机器上并不存在，启用了也是空壳。
                                if (!(await ensureProfileRequirements(profile.name))) return;
                                return window.codeshell.activateProfile(
                                  activeProjectPath,
                                  profile.name,
                                );
                              },
                              { name: profile.label },
                            );
                          }}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="teams" className="mt-0">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">{t("digitalHumans.team.title")}</h3>
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
                          busy={selectionBusy || operations.isBusy(`delete-team:${team.id}`)}
                          onUse={() =>
                            useSelection({
                              kind: "team",
                              id: team.id,
                              label: team.name,
                              members: team.members,
                              mode: team.mode,
                              team,
                            })
                          }
                          onDetails={() => setDetail({ kind: "team", team })}
                          onEdit={() => setTeamEditor({ team })}
                          onManageSource={team.sourceRepo ? onOpenSettings : undefined}
                          onDelete={() => void deleteTeamEntry(team)}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>
              </div>
            </Tabs>
          )}
        </div>
      </div>

      <DigitalHumanEditorDialog
        open={editor !== null}
        profile={editor?.profile}
        existingIds={profiles.map((profile) => profile.name)}
        skills={availableSkills.filter((skill) => skill.source !== "project")}
        projectSkills={availableSkills.filter((skill) => skill.source === "project")}
        projectPath={activeProjectPath}
        busy={editorSaveFlowBusy || operations.isBusy("save-profile")}
        installing={editorInstallFlowBusy}
        onRequirementsInstalled={refresh}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSave={(profile, options) => {
          if (editorSaveFlowLock.current) return;
          editorSaveFlowLock.current = true;
          setEditorSaveFlowBusy(true);
          setEditorInstallFlowBusy(Boolean(options?.installRequirements));
          void (async () => {
            try {
              const saved = await run(
                "save-profile",
                () => window.codeshell.saveProfile(profile, activeProjectPath ?? undefined),
                { name: profile.label },
              );
              if (!saved) return;
              if (options?.installRequirements) {
                if (await ensureProfileRequirements(profile.name)) {
                  setEditor(null);
                } else {
                  // Saving the new source succeeded even when install review was
                  // cancelled or installation failed. Refresh the editor's
                  // baseline so closing it does not claim those saved changes
                  // are still unsaved, and expose the normal retry action.
                  setEditor((current) =>
                    current
                      ? {
                          profile: {
                            ...profile,
                            active: current.profile?.active ?? false,
                          },
                        }
                      : current,
                  );
                }
                return;
              }
              setEditor(null);
            } finally {
              editorSaveFlowLock.current = false;
              setEditorSaveFlowBusy(false);
              setEditorInstallFlowBusy(false);
            }
          })();
        }}
      />

      <DigitalHumanMemoryDialog
        profile={memoryProfile}
        enabling={
          memoryProfile ? operations.isBusy(`enable-profile-memory:${memoryProfile.name}`) : false
        }
        onEnable={
          memoryProfile
            ? () => {
                const profile = memoryProfile;
                void (async () => {
                  const { active: _active, ...definition } = profile;
                  const result = await operations.run(`enable-profile-memory:${profile.name}`, () =>
                    window.codeshell.saveProfile(
                      { ...definition, portableMemory: true },
                      activeProjectPath ?? undefined,
                    ),
                  );
                  if (!result.ok) {
                    if (!result.duplicate) {
                      toast({
                        message: t("digitalHumans.actionFailed", {
                          name: profile.label,
                          message:
                            result.error instanceof Error
                              ? result.error.message
                              : String(result.error),
                        }),
                        variant: "error",
                      });
                    }
                    return;
                  }
                  setMemoryProfile((current) =>
                    current?.name === profile.name ? { ...current, portableMemory: true } : current,
                  );
                  await refresh();
                  toast({
                    message: t("digitalHumans.memory.enabled", { name: profile.label }),
                    variant: "success",
                  });
                })();
              }
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) setMemoryProfile(null);
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

      <DigitalHumanDetailDialog
        detail={detail}
        profiles={profiles}
        catalog={catalog}
        teams={teams}
        availableSkills={availableSkills}
        busy={detailBusy}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        onLaunch={(starterPrompt) => launchDetail(starterPrompt)}
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

function categoryTone(category: DigitalHumanCategory): string {
  if (category === "product") return "bg-primary/10 text-primary";
  if (category === "design") return "bg-status-warn/10 text-status-warn";
  if (category === "engineering") return "bg-status-running/10 text-status-running";
  return "bg-status-ok/10 text-status-ok";
}

function identityTone(id: string): string {
  const tones = [
    "border-primary/15 bg-primary/10 text-primary",
    "border-status-running/15 bg-status-running/10 text-status-running",
    "border-status-ok/15 bg-status-ok/10 text-status-ok",
    "border-status-warn/15 bg-status-warn/10 text-status-warn",
  ];
  const seed = [...id].reduce((total, character) => total + character.charCodeAt(0), 0);
  return tones[seed % tones.length]!;
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  return label.trim().slice(0, 2).toUpperCase();
}

function DigitalHumanAvatar({
  id,
  label,
  category,
  team = false,
  className,
}: {
  id: string;
  label: string;
  category?: DigitalHumanCategory;
  team?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-transparent text-xs font-semibold shadow-sm",
        category ? categoryTone(category) : identityTone(id),
        className,
      )}
      data-digital-human-avatar={id}
      aria-hidden="true"
    >
      {team ? <UsersRound size={18} /> : initials(label)}
    </span>
  );
}

function CatalogCard({
  entry,
  busy,
  onDetails,
  onDownload,
}: {
  entry: DigitalHumanCatalogEntry;
  busy: boolean;
  onDetails: () => void;
  onDownload: () => void;
}) {
  const { t } = useT();
  return (
    <Card
      className="digital-human-card group flex min-h-52 flex-col overflow-hidden transition-all"
      data-digital-human-card={entry.name}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar id={entry.name} label={entry.label} category={entry.category} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="truncate text-sm">{entry.label}</CardTitle>
              {entry.installed ? (
                <Badge variant="success" className="shrink-0">
                  <Check size={11} className="mr-1" aria-hidden="true" />
                  {t("digitalHumans.installed")}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {t(`digitalHumans.market.category.${entry.category}`)}
              {/* Provenance matters once entries come from user-added repos —
                  the user should see whose definition they are installing. */}
              {entry.sourceRepo ? ` · ${entry.sourceRepo}` : ""}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {entry.description}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5 pb-3">
        {entry.tags.map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="justify-between gap-2 border-t border-border/60 bg-muted/15 p-3.5">
        <Button size="sm" variant="ghost" className="px-2" onClick={onDetails}>
          {t("digitalHumans.market.details")}
          <ChevronRight size={13} aria-hidden="true" />
        </Button>
        <Button size="sm" onClick={onDownload} disabled={busy}>
          {entry.installed ? (
            <ChevronRight size={13} aria-hidden="true" />
          ) : (
            <Download size={13} aria-hidden="true" />
          )}
          {busy
            ? t("digitalHumans.downloading")
            : entry.installed
              ? t("digitalHumans.viewDownloaded")
              : t("digitalHumans.download")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function CuratedTeamCard({
  team,
  catalogByName,
  installed,
  busy,
  onDetails,
  onDownload,
}: {
  team: CuratedDigitalHumanTeam;
  catalogByName: Map<string, DigitalHumanCatalogEntry>;
  installed: boolean;
  busy: boolean;
  onDetails: () => void;
  onDownload: () => void;
}) {
  const { t } = useT();
  return (
    <Card
      className="digital-human-card group flex min-h-60 flex-col overflow-hidden transition-all"
      data-curated-team-card={team.id}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar id={team.id} label={team.name} category={team.category} team />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="truncate text-sm">{team.name}</CardTitle>
              {installed ? <Badge variant="success">{t("digitalHumans.installed")}</Badge> : null}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {team.members.length} {t("digitalHumans.market.members")}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {team.description}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 pb-3">
        <div className="flex -space-x-1.5" aria-label={t("digitalHumans.team.members")}>
          {team.members.map((member) => {
            const entry = catalogByName.get(member);
            return (
              <DigitalHumanAvatar
                key={member}
                id={member}
                label={entry?.label ?? member}
                category={entry?.category}
                className="h-8 w-8 rounded-lg border-2 border-card text-[10px]"
              />
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {team.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      </CardContent>
      <CardFooter className="justify-between gap-2 border-t border-border/60 bg-muted/15 p-3.5">
        <Button size="sm" variant="ghost" className="px-2" onClick={onDetails}>
          {t("digitalHumans.market.details")}
          <ChevronRight size={13} aria-hidden="true" />
        </Button>
        <Button size="sm" onClick={onDownload} disabled={busy}>
          {installed ? (
            <ChevronRight size={13} aria-hidden="true" />
          ) : (
            <Download size={13} aria-hidden="true" />
          )}
          {busy
            ? t("digitalHumans.downloading")
            : installed
              ? t("digitalHumans.viewDownloadedTeam")
              : t("digitalHumans.downloadTeam")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ProfileCard({
  profile,
  missingSkillCount,
  requirementsNeedReview,
  hasProject,
  busy,
  onUse,
  onDetails,
  onEdit,
  onMemory,
  onDelete,
  onToggleDefault,
}: {
  profile: DigitalHumanProfileEntry;
  missingSkillCount: number;
  requirementsNeedReview: boolean;
  hasProject: boolean;
  busy: boolean;
  onUse: () => void;
  onDetails: () => void;
  onEdit: () => void;
  onMemory: () => void;
  onDelete: () => void;
  onToggleDefault: () => void;
}) {
  const { t } = useT();
  const count = capabilityCount(profile);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };
  return (
    <Card
      data-digital-human-card={profile.name}
      className={cn(
        "digital-human-card group flex min-h-64 flex-col overflow-hidden transition-all",
        profile.active && "border-primary/35",
      )}
    >
      <CardHeader className="p-5 pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar
            id={profile.name}
            label={profile.label}
            className="h-12 w-12 rounded-xl text-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="line-clamp-2 pt-0.5 text-base leading-5">
                {profile.label}
              </CardTitle>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge variant="success">
                  <Check size={11} className="mr-1" aria-hidden="true" />
                  {t("digitalHumans.localInstalled")}
                </Badge>
                {profile.active ? (
                  <Badge variant="accent" className="border border-primary/15">
                    {t("digitalHumans.current")}
                  </Badge>
                ) : null}
              </div>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {profile.name}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {profile.description ?? t("digitalHumans.noDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5 px-5 pb-4">
        {count > 0 ? (
          <Badge variant="secondary">{t("digitalHumans.capabilityCount", { count })}</Badge>
        ) : null}
        {profile.skills.length > 0 || requirementsNeedReview ? (
          <Badge variant={missingSkillCount > 0 || requirementsNeedReview ? "warning" : "success"}>
            {missingSkillCount > 0
              ? t("digitalHumans.skillReadiness.missing", { count: missingSkillCount })
              : requirementsNeedReview
                ? t("digitalHumans.skillReadiness.review")
                : t("digitalHumans.skillReadiness.ready")}
          </Badge>
        ) : null}
        {profile.portableMemory ? (
          <Badge variant="secondary">{t("digitalHumans.portableMemory")}</Badge>
        ) : null}
      </CardContent>
      {/* One primary action; everything else collapses into an overflow menu.
          The old footer put 7 controls in a row — 4 of them same-weight icon
          buttons — so nothing read as the thing you were meant to click. */}
      <CardFooter className="items-center gap-2 border-t border-border/60 bg-muted/15 p-3.5">
        <Button
          size="sm"
          className="flex-1"
          onClick={onUse}
          disabled={busy}
          title={t("digitalHumans.useHint")}
        >
          <Sparkles size={13} aria-hidden="true" />
          {t("digitalHumans.summon")}
        </Button>
        {/* These actions can open a Dialog (details/edit/memory/delete).
            A modal Radix menu keeps document pointer events locked while its
            Dialog mounts and can leave the page inert after the Dialog closes. */}
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0"
              disabled={busy}
              aria-label={t("digitalHumans.moreActions", { name: profile.label })}
              title={t("digitalHumans.moreActions", { name: profile.label })}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          {menuOpen ? (
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => runMenuAction(onDetails)}>
                <ChevronRight size={13} aria-hidden="true" />
                {t("digitalHumans.market.details")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runMenuAction(onEdit)}>
                <Pencil size={13} aria-hidden="true" />
                {t("digitalHumans.editor.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runMenuAction(onMemory)}>
                <Brain size={13} aria-hidden="true" />
                {t("digitalHumans.memory.button")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => runMenuAction(onToggleDefault)}
                disabled={!hasProject}
              >
                <Check size={13} aria-hidden="true" />
                {profile.active
                  ? t("digitalHumans.clearDefault")
                  : t("digitalHumans.setProjectDefault")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-status-err focus:text-status-err"
                onSelect={() => runMenuAction(onDelete)}
              >
                <Trash2 size={13} aria-hidden="true" />
                {t("common.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          ) : null}
        </DropdownMenu>
      </CardFooter>
    </Card>
  );
}

function TeamCard({
  team,
  memberLabels,
  busy,
  onUse,
  onDetails,
  onEdit,
  onManageSource,
  onDelete,
}: {
  team: DigitalHumanTeam;
  memberLabels: string[];
  busy: boolean;
  onUse: () => void;
  onDetails: () => void;
  onEdit: () => void;
  onManageSource?: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };
  return (
    <Card
      data-digital-human-team-card={team.id}
      className="digital-human-card group flex min-h-60 flex-col overflow-hidden transition-all"
    >
      <CardHeader className="p-5 pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar
            id={team.id}
            label={team.name}
            team
            className="h-12 w-12 rounded-xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="line-clamp-2 pt-0.5 text-base leading-5">{team.name}</CardTitle>
              <Badge variant="info" className="shrink-0">
                {team.lead
                  ? t("digitalHumans.team.leadConfigured")
                  : t("digitalHumans.team.parallel")}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {memberLabels.length} {t("digitalHumans.market.members")}
              {team.sourceRepo ? ` · ${team.sourceRepo}` : ""}
              {team.localOverride ? ` · ${t("digitalHumans.team.localOverride")}` : ""}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {team.description ?? t("digitalHumans.team.defaultDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5 px-5 pb-4">
        {memberLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="gap-2 border-t border-border/60 bg-muted/15 p-3.5">
        <Button size="sm" className="min-w-28 flex-1" onClick={onUse} disabled={busy}>
          <Sparkles size={14} aria-hidden="true" />
          {t("digitalHumans.summonTeam")}
        </Button>
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0"
              disabled={busy}
              aria-label={t("digitalHumans.moreActions", { name: team.name })}
              title={t("digitalHumans.moreActions", { name: team.name })}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          {menuOpen ? (
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => runMenuAction(onDetails)}>
                <ChevronRight size={13} aria-hidden="true" />
                {t("digitalHumans.market.details")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => runMenuAction(onEdit)}>
                <Pencil size={13} aria-hidden="true" />
                {team.sourceRepo ? t("digitalHumans.team.customize") : t("digitalHumans.team.edit")}
              </DropdownMenuItem>
              {team.sourceRepo && onManageSource ? (
                <DropdownMenuItem onSelect={() => runMenuAction(onManageSource)}>
                  <RefreshCw size={13} aria-hidden="true" />
                  {t("digitalHumans.team.manageSource")}
                </DropdownMenuItem>
              ) : null}
              {!team.sourceRepo || team.localOverride ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-status-err focus:text-status-err"
                    onSelect={() => runMenuAction(onDelete)}
                  >
                    {team.localOverride ? (
                      <RefreshCw size={13} aria-hidden="true" />
                    ) : (
                      <Trash2 size={13} aria-hidden="true" />
                    )}
                    {team.localOverride
                      ? t("digitalHumans.team.restoreSource")
                      : t("common.delete")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          ) : null}
        </DropdownMenu>
      </CardFooter>
    </Card>
  );
}

function DigitalHumanDetailDialog({
  detail,
  profiles,
  catalog,
  teams,
  availableSkills,
  busy,
  onOpenChange,
  onLaunch,
}: {
  detail: DigitalHumanDetail | null;
  profiles: DigitalHumanProfileEntry[];
  catalog: DigitalHumanCatalogEntry[];
  teams: DigitalHumanTeam[];
  availableSkills: DigitalHumanSkillEntry[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (starterPrompt?: string) => void;
}) {
  const { t } = useT();
  if (!detail) return null;

  const marketplaceMode = detail.kind === "catalog" || detail.kind === "curated-team";
  const installedTeam =
    detail.kind === "curated-team" ? teams.find((team) => team.id === detail.team.id) : undefined;
  const describeTeamMethod = (
    team: Pick<DigitalHumanTeam, "lead" | "playbook"> | undefined,
  ): string => {
    if (!team?.lead) return t("digitalHumans.team.parallelDescription");
    return team.playbook
      ? t("digitalHumans.team.leadPlaybookDescription")
      : t("digitalHumans.team.leadDescription");
  };
  const view = (() => {
    if (detail.kind === "catalog") {
      return {
        id: detail.entry.name,
        label: detail.entry.label,
        description: detail.entry.description ?? t("digitalHumans.noDescription"),
        category: detail.entry.category as DigitalHumanCategory | undefined,
        tags: detail.entry.tags,
        prompts: detail.entry.samplePrompts,
        installed: detail.entry.installed,
        team: false,
        members: [] as string[],
        lead: undefined as string | undefined,
        playbook: undefined as string | undefined,
        method: detail.entry.mainInstruction,
        requires: detail.entry.requires,
        capabilityCount: capabilityCount({ ...detail.entry, active: false }),
        capabilities: {
          skills: detail.entry.skills,
          plugins: detail.entry.plugins,
          mcp: detail.entry.mcp,
          agents: detail.entry.agents,
        },
      };
    }
    if (detail.kind === "profile") {
      return {
        id: detail.profile.name,
        label: detail.profile.label,
        description: detail.profile.description ?? t("digitalHumans.noDescription"),
        category: undefined,
        tags: [
          ...detail.profile.skills.slice(0, 3),
          ...(detail.profile.portableMemory ? [t("digitalHumans.portableMemory")] : []),
        ],
        prompts: profileSamplePrompts(detail.profile),
        installed: true,
        team: false,
        members: [] as string[],
        lead: undefined as string | undefined,
        playbook: undefined as string | undefined,
        method: detail.profile.mainInstruction,
        requires: detail.profile.requires,
        capabilityCount: capabilityCount(detail.profile),
        capabilities: {
          skills: detail.profile.skills,
          plugins: detail.profile.plugins,
          mcp: detail.profile.mcp,
          agents: detail.profile.agents,
        },
      };
    }
    if (detail.kind === "curated-team") {
      return {
        id: detail.team.id,
        label: installedTeam?.name ?? detail.team.name,
        description: installedTeam?.description ?? detail.team.description,
        category: detail.team.category as DigitalHumanCategory | undefined,
        tags: detail.team.tags,
        prompts: detail.team.samplePrompts,
        installed: Boolean(installedTeam),
        team: true,
        members: installedTeam?.members ?? detail.team.members,
        lead: installedTeam?.lead,
        playbook: installedTeam?.playbook,
        method: describeTeamMethod(installedTeam),
        requires: undefined,
        capabilityCount: 0,
        capabilities: { skills: [], plugins: [], mcp: [], agents: [] },
      };
    }
    return {
      id: detail.team.id,
      label: detail.team.name,
      description: detail.team.description ?? t("digitalHumans.team.defaultDescription"),
      category: undefined,
      tags: [
        detail.team.lead
          ? t("digitalHumans.team.leadConfigured")
          : t("digitalHumans.team.parallel"),
        ...(detail.team.sourceRepo ? [detail.team.sourceRepo] : []),
      ],
      prompts: [
        t("digitalHumans.detail.teamPrompt", { name: detail.team.name }),
        t("digitalHumans.detail.teamReviewPrompt", { name: detail.team.name }),
      ],
      installed: true,
      team: true,
      members: detail.team.members,
      lead: detail.team.lead,
      playbook: detail.team.playbook,
      method: describeTeamMethod(detail.team),
      requires: undefined,
      capabilityCount: 0,
      capabilities: { skills: [], plugins: [], mcp: [], agents: [] },
    };
  })();

  const profileById = new Map(profiles.map((profile) => [profile.name, profile]));
  const catalogById = new Map(catalog.map((entry) => [entry.name, entry]));
  const availableSkillByName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const missingCapabilitySkillNames = new Set(
    digitalHumanMissingSkillNames(view.capabilities.skills, view.requires, availableSkills),
  );
  const namedProjectRequirementSkills = digitalHumanNamedProjectRequirementSkillNames(
    view.requires,
  );
  const capabilityGroups = [
    {
      id: "skills",
      label: t("digitalHumans.detail.capabilityGroup.skills"),
      values: view.capabilities.skills,
    },
    {
      id: "plugins",
      label: t("digitalHumans.detail.capabilityGroup.plugins"),
      values: view.capabilities.plugins,
    },
    {
      id: "mcp",
      label: t("digitalHumans.detail.capabilityGroup.mcp"),
      values: view.capabilities.mcp,
    },
    {
      id: "agents",
      label: t("digitalHumans.detail.capabilityGroup.agents"),
      values: view.capabilities.agents,
    },
  ].filter((group) => group.values.length > 0);
  const memberEntries = view.members.map((id) => ({
    id,
    label: profileById.get(id)?.label ?? catalogById.get(id)?.label ?? id,
    category: catalogById.get(id)?.category,
  }));
  const primaryLabel = marketplaceMode
    ? view.team
      ? view.installed
        ? t("digitalHumans.viewDownloadedTeam")
        : t("digitalHumans.downloadTeam")
      : view.installed
        ? t("digitalHumans.viewDownloaded")
        : t("digitalHumans.download")
    : view.team
      ? t("digitalHumans.summonTeam")
      : t("digitalHumans.summon");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto p-0">
        <div className="border-b border-border/70 bg-muted/20 px-6 py-5 pr-12">
          <DialogHeader>
            <div className="flex items-start gap-4">
              <DigitalHumanAvatar
                id={view.id}
                label={view.label}
                category={view.category}
                team={view.team}
                className="h-14 w-14 rounded-2xl text-sm"
              />
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex flex-wrap items-center gap-2 text-xl">
                  {view.label}
                  <Badge variant={view.team ? "info" : "secondary"}>
                    {view.team ? t("digitalHumans.market.group") : t("digitalHumans.market.single")}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="mt-1.5 flex flex-wrap items-center gap-2">
                  {view.category ? (
                    <span>{t(`digitalHumans.market.category.${view.category}`)}</span>
                  ) : null}
                  {view.installed ? (
                    <span className="inline-flex items-center gap-1 text-status-ok">
                      <Check size={12} aria-hidden="true" />
                      {t("digitalHumans.installed")}
                    </span>
                  ) : null}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="space-y-6 px-6 pb-1 pt-5">
          <section>
            <h3 className="text-sm font-semibold">{t("digitalHumans.detail.capabilityIntro")}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{view.description}</p>
          </section>

          <section>
            <h3 className="text-sm font-semibold">{t("digitalHumans.detail.strengths")}</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {view.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="px-2.5 py-1">
                  {tag}
                </Badge>
              ))}
            </div>
          </section>

          {view.team ? (
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t("digitalHumans.detail.teamMembers")}</h3>
                <Badge variant="accent">{t("digitalHumans.detail.petLeads")}</Badge>
              </div>
              <div className="mt-2 divide-y divide-border/60 rounded-lg border border-border/70">
                {memberEntries.map((member) => (
                  <div key={member.id} className="flex items-center gap-3 px-3 py-2.5">
                    <DigitalHumanAvatar
                      id={member.id}
                      label={member.label}
                      category={member.category}
                      className="h-8 w-8 rounded-lg text-[10px]"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {member.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {member.id === view.lead
                        ? t("digitalHumans.detail.leadRole")
                        : t("digitalHumans.detail.memberRole")}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{view.method}</p>
              {view.playbook ? (
                <div className="mt-3 rounded-lg border border-primary/15 bg-primary/5 p-3">
                  <p className="text-xs font-semibold">{t("digitalHumans.detail.playbookTitle")}</p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                    {view.playbook}
                  </p>
                </div>
              ) : null}
            </section>
          ) : (
            <>
              <section>
                <h3 className="text-sm font-semibold">{t("digitalHumans.detail.workMethod")}</h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <DetailPrinciple
                    Icon={UserRound}
                    title={t("digitalHumans.detail.role")}
                    description={t("digitalHumans.detail.roleDescription")}
                  />
                  <DetailPrinciple
                    Icon={Eye}
                    title={t("digitalHumans.detail.method")}
                    description={view.method || t("digitalHumans.detail.methodDescription")}
                  />
                  <DetailPrinciple
                    Icon={Code2}
                    title={t("digitalHumans.detail.tools")}
                    description={
                      view.capabilityCount > 0
                        ? t("digitalHumans.detail.toolsDescription", {
                            count: view.capabilityCount,
                          })
                        : t("digitalHumans.detail.toolsEmptyDescription")
                    }
                  />
                </div>
              </section>

              {capabilityGroups.length > 0 ? (
                <section>
                  <h3 className="text-sm font-semibold">
                    {t("digitalHumans.detail.configuredCapabilities")}
                  </h3>
                  <div className="mt-2 divide-y divide-border/60 rounded-lg border border-border/70">
                    {capabilityGroups.map((group) => (
                      <div
                        key={group.id}
                        className="grid gap-2 px-3 py-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]"
                      >
                        <p className="pt-1 text-xs font-medium text-muted-foreground">
                          {group.label}
                        </p>
                        <div className="flex min-w-0 flex-wrap gap-1.5">
                          {group.values.map((name) => {
                            const skill =
                              group.id === "skills" ? availableSkillByName.get(name) : null;
                            const skillState =
                              group.id !== "skills"
                                ? null
                                : missingCapabilitySkillNames.has(name) &&
                                    namedProjectRequirementSkills.has(name) &&
                                    skill
                                  ? "projectMissing"
                                  : missingCapabilitySkillNames.has(name)
                                    ? "missing"
                                    : skill?.enabled === false
                                      ? "disabled"
                                      : skill
                                        ? "installed"
                                        : "missing";
                            return (
                              <Badge
                                key={`${group.id}:${name}`}
                                variant={
                                  skillState === "missing" || skillState === "projectMissing"
                                    ? "warning"
                                    : skillState === "installed"
                                      ? "success"
                                      : "secondary"
                                }
                                className="max-w-full gap-1.5 px-2.5 py-1"
                              >
                                <span className="truncate">{name}</span>
                                {skillState ? (
                                  <span className="font-normal opacity-75">
                                    · {t(`digitalHumans.detail.skillState.${skillState}`)}
                                  </span>
                                ) : null}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}

          <section>
            <div className="flex items-center gap-2">
              <MessageSquareText size={15} className="text-primary" aria-hidden="true" />
              <h3 className="text-sm font-semibold">{t("digitalHumans.detail.tryTasks")}</h3>
            </div>
            <div className="mt-2 space-y-2">
              {view.prompts.map((prompt) =>
                marketplaceMode ? (
                  <div
                    key={prompt}
                    className="rounded-md border border-border/70 bg-muted/15 px-3 py-2.5"
                  >
                    <span className="line-clamp-2 text-sm font-normal leading-5">{prompt}</span>
                  </div>
                ) : (
                  <Button
                    key={prompt}
                    type="button"
                    variant="outline"
                    className="h-auto w-full justify-between gap-4 whitespace-normal px-3 py-2.5 text-left"
                    onClick={() => onLaunch(prompt)}
                    disabled={busy}
                  >
                    <span className="line-clamp-2 flex-1 text-sm font-normal leading-5">
                      {prompt}
                    </span>
                    <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
                  </Button>
                ),
              )}
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 border-t border-border/70 bg-background p-4">
          <Button className="w-full" size="lg" onClick={() => onLaunch()} disabled={busy}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : marketplaceMode ? (
              view.installed ? (
                <ChevronRight size={15} aria-hidden="true" />
              ) : (
                <Download size={15} aria-hidden="true" />
              )
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}
            {busy
              ? marketplaceMode
                ? t("digitalHumans.downloading")
                : t("digitalHumans.preparing")
              : primaryLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailPrinciple({
  Icon,
  title,
  description,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon size={14} aria-hidden="true" />
      </span>
      <p className="mt-2 text-xs font-semibold">{title}</p>
      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
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
  const [members, setMembers] = React.useState<Set<string>>(() => new Set());
  const [lead, setLead] = React.useState("");
  const [playbook, setPlaybook] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setId(team?.id ?? createDigitalHumanTeamId());
    setName(team?.name ?? "");
    setDescription(team?.description ?? "");
    setMembers(new Set(team?.members ?? []));
    setLead(team?.lead ?? "");
    setPlaybook(team?.playbook ?? "");
  }, [open, team]);

  const toggleMember = React.useCallback((memberId: string) => {
    setMembers((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else if (next.size < DIGITAL_HUMAN_TEAM_MEMBER_MAX) next.add(memberId);
      return next;
    });
  }, []);

  const knownMembers = new Set(profiles.map((profile) => profile.name));
  const missingMembers = [...members].filter((member) => !knownMembers.has(member));
  // There is no mode picker in this dialog: an edited team keeps whatever mode
  // it was created with, and a new one is always "auto". So mode is derived,
  // never form state, and can never make the form dirty.
  const mode: DigitalHumanTeamMode = team?.mode ?? "auto";
  const dirty = team
    ? name !== team.name ||
      description !== (team.description ?? "") ||
      !sameMembers(members, team.members) ||
      lead !== (team.lead ?? "") ||
      playbook !== (team.playbook ?? "")
    : Boolean(name || description || members.size > 0 || lead || playbook);
  const canSave =
    Boolean(id) &&
    Boolean(name.trim()) &&
    name.trim().length <= DIGITAL_HUMAN_TEAM_NAME_LIMIT &&
    description.trim().length <= DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT &&
    playbook.trim().length <= DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT &&
    members.size >= DIGITAL_HUMAN_TEAM_MEMBER_MIN &&
    members.size <= DIGITAL_HUMAN_TEAM_MEMBER_MAX &&
    missingMembers.length === 0;
  const toTeam = (): DigitalHumanTeam | null =>
    canSave
      ? {
          id,
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          members: [...members],
          mode,
          // A lead dropped from the roster must not be persisted — the schema
          // rejects a lead outside `members`, and it could never be reached.
          ...(lead && members.has(lead) ? { lead } : {}),
          ...(playbook.trim() ? { playbook: playbook.trim() } : {}),
        }
      : null;

  return {
    id,
    name,
    setName,
    lead,
    setLead,
    playbook,
    setPlaybook,
    description,
    setDescription,
    members,
    toggleMember,
    missingMembers,
    dirty,
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
  const confirm = useConfirm();
  const {
    name,
    setName,
    description,
    setDescription,
    members,
    toggleMember,
    missingMembers,
    lead,
    setLead,
    playbook,
    setPlaybook,
    dirty,
    canSave: draftCanSave,
    toTeam,
  } = useDigitalHumanTeamDraft(open, team, profiles);
  const selectedMembers = React.useMemo(() => [...members], [members]);
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
  const requestClose = (next: boolean) => {
    if (!next && busy) return;
    if (next || !dirty) {
      onOpenChange(next);
      return;
    }
    void confirm({
      title: t("digitalHumans.team.discardTitle"),
      message: t("digitalHumans.team.discardMessage"),
      confirmLabel: t("digitalHumans.team.discard"),
      destructive: true,
    }).then((accepted) => {
      if (accepted) onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent showClose={!busy}>
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
                maxLength={DIGITAL_HUMAN_TEAM_NAME_LIMIT}
                autoFocus
              />
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                {name.length}/{DIGITAL_HUMAN_TEAM_NAME_LIMIT}
              </p>
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
                maxLength={DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT}
              />
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                {description.length}/{DIGITAL_HUMAN_TEAM_DESCRIPTION_LIMIT}
              </p>
            </div>
            {/* `mode` (auto/divide/compare) is gone from the UI: it never reached
                any runtime logic — all three produced identical Sessions. The lead
                plus a written playbook is what actually drives collaboration. The
                field is still persisted so existing team files keep parsing. */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("digitalHumans.team.members")}</legend>
              <div className="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {memberOptions.map((profile) => {
                  const selected = members.has(profile.id);
                  const additionBlocked =
                    !selected && members.size >= DIGITAL_HUMAN_TEAM_MEMBER_MAX;
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
                      disabled={additionBlocked}
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
                {t("digitalHumans.team.memberCount", {
                  count: members.size,
                  min: DIGITAL_HUMAN_TEAM_MEMBER_MIN,
                  max: DIGITAL_HUMAN_TEAM_MEMBER_MAX,
                })}
              </p>
              {members.size >= DIGITAL_HUMAN_TEAM_MEMBER_MAX ? (
                <p className="text-xs text-status-warn">
                  {t("digitalHumans.team.memberLimit", {
                    max: DIGITAL_HUMAN_TEAM_MEMBER_MAX,
                  })}
                </p>
              ) : null}
              {missingMembers.length > 0 ? (
                <p className="text-xs text-status-err" role="alert">
                  {t("digitalHumans.team.removeMissingMembers")}
                </p>
              ) : null}
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor="digital-human-team-lead">{t("digitalHumans.team.leadLabel")}</Label>
              <SimpleSelect
                ariaLabel={t("digitalHumans.team.leadLabel")}
                value={selectedMembers.includes(lead) ? lead : ""}
                onChange={setLead}
                placeholder={t("digitalHumans.team.noLead")}
                options={[
                  { value: "", label: t("digitalHumans.team.noLead") },
                  ...memberOptions
                    .filter((profile) => selectedMembers.includes(profile.id))
                    .map((profile) => ({ value: profile.id, label: profile.label })),
                ]}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {t("digitalHumans.team.leadHint")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="digital-human-team-playbook">
                {t("digitalHumans.team.playbookLabel")}
              </Label>
              <Textarea
                id="digital-human-team-playbook"
                value={playbook}
                onChange={(event) => setPlaybook(event.target.value)}
                rows={4}
                maxLength={DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT}
                placeholder={t("digitalHumans.team.playbookPlaceholder")}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {lead && selectedMembers.includes(lead)
                  ? t("digitalHumans.team.playbookHint")
                  : t("digitalHumans.team.playbookNeedsLead")}
              </p>
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                {playbook.length}/{DIGITAL_HUMAN_TEAM_PLAYBOOK_LIMIT}
              </p>
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => requestClose(false)}
            >
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

function HeroMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-14 flex-col">
      <dt className="order-2 mt-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
        {label}
      </dt>
      <dd className="order-1 text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}

function LibraryEmptyState({
  onCreate,
  onImport,
  importBusy,
}: {
  onCreate: () => void;
  onImport: () => void;
  importBusy: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/15 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary shadow-sm">
        <Brain size={21} aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-base font-semibold">{t("digitalHumans.empty.title")}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
        {t("digitalHumans.empty.description")}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={onCreate}>
          <Plus size={14} aria-hidden="true" />
          {t("digitalHumans.editor.create")}
        </Button>
        <Button size="sm" variant="outline" onClick={onImport} disabled={importBusy}>
          {importBusy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload size={14} aria-hidden="true" />
          )}
          {t("digitalHumans.transfer.importDefinition")}
        </Button>
      </div>
    </div>
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

/**
 * The bundled catalog now ships empty on purpose (the 8 starters had no
 * capability difference). Say where digital humans come from instead of
 * showing "no search results", which reads as a broken filter.
 */
/**
 * Inline "add a digital-human repo" row on the market tab.
 *
 * The repo manager lives in settings, but requiring a trip through the settings
 * tree to get a first digital human made the market a dead end — the empty
 * state could only *describe* where to go. Adding one from here is the whole
 * point of the page.
 */
function AddRepoRow({
  onAdded,
  repoCount,
  onManage,
}: {
  onAdded: () => void;
  repoCount: number;
  onManage?: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const addLock = React.useRef(false);
  const normalizedRepo = normalizeDigitalHumanSkillRepo(input);
  const repoInvalid = input.trim().length > 0 && normalizedRepo === null;

  const add = async () => {
    if (!normalizedRepo || addLock.current) return;
    addLock.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await window.codeshell.addProfileRepo(normalizedRepo);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInput("");
      toast({
        message: t("digitalHumans.repos.added", { count: result.entry.count }),
        variant: "success",
      });
      onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      addLock.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mb-5 rounded-xl border border-border/70 bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          <GitFork size={16} aria-hidden="true" />
        </span>
        <div className="min-w-52 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">{t("digitalHumans.repos.title")}</p>
            {repoCount > 0 ? (
              <Badge variant="secondary">
                {t("digitalHumans.repos.active", { count: repoCount })}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
            {t("digitalHumans.repos.hint")}
          </p>
        </div>
        <Input
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder="owner/repo"
          aria-label={t("digitalHumans.repos.title")}
          aria-invalid={repoInvalid}
          className="h-8 w-full min-w-48 sm:w-64"
          disabled={busy}
        />
        <Button size="sm" onClick={() => void add()} disabled={busy || !normalizedRepo}>
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Plus size={13} aria-hidden="true" />
          )}
          {t("digitalHumans.repos.add")}
        </Button>
        {onManage ? (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {t("digitalHumans.repos.manage")}
          </Button>
        ) : null}
      </div>
      {repoInvalid ? (
        <p className="mt-1.5 text-xs text-status-err">{t("digitalHumans.repos.invalid")}</p>
      ) : null}
      {error ? <p className="mt-1.5 text-xs text-status-err">{error}</p> : null}
    </div>
  );
}

function CatalogEmptyState({
  onImport,
  onCreate,
  importBusy,
}: {
  onImport: () => void;
  onCreate: () => void;
  importBusy: boolean;
}) {
  const { t } = useT();
  return (
    <EmptyState
      Icon={UsersRound}
      title={t("digitalHumans.emptyCatalog")}
      description={t("digitalHumans.emptyCatalogDescription")}
      action={
        <>
          <Button size="sm" onClick={onImport} disabled={importBusy}>
            {importBusy ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload size={14} aria-hidden="true" />
            )}
            {t("digitalHumans.transfer.importDefinition")}
          </Button>
          <Button size="sm" variant="outline" onClick={onCreate}>
            <Plus size={14} aria-hidden="true" />
            {t("digitalHumans.editor.create")}
          </Button>
        </>
      }
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
  action,
}: {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
  iconClassName?: string;
  /** Optional call-to-action so a dead end can offer the way out. */
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon size={20} className={iconClassName} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
        {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
      </CardContent>
    </Card>
  );
}
