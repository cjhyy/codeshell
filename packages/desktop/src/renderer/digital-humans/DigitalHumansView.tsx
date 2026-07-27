import React from "react";
import {
  ArrowRight,
  Brain,
  Briefcase,
  Check,
  ChevronRight,
  Code2,
  Download,
  Eye,
  GitFork,
  MoreHorizontal,
  Loader2,
  MessageSquareText,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { DigitalHumanTeam, DigitalHumanTeamMode } from "../../shared/digital-human-team";
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
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSelection,
  CuratedDigitalHumanTeam,
} from "./types";
import { CURATED_DIGITAL_HUMAN_TEAMS, profileSamplePrompts } from "./marketplace";
import { useDigitalHumanOperations, useDigitalHumansLibrary } from "./useDigitalHumansLibrary";

interface Props {
  activeProjectPath: string | null;
  onUse: (selection: DigitalHumanSelection, starterPrompt?: string) => void;
  confirmDelete?: (request: DigitalHumanDeleteRequest) => Promise<boolean>;
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
type DigitalHumanDetail =
  | { kind: "catalog"; entry: DigitalHumanCatalogEntry }
  | { kind: "profile"; profile: DigitalHumanProfileEntry }
  | { kind: "team"; team: DigitalHumanTeam }
  | { kind: "curated-team"; team: CuratedDigitalHumanTeam };

const DIGITAL_HUMAN_CATEGORIES: readonly DigitalHumanCategory[] = [
  "product",
  "design",
  "engineering",
  "quality",
];

function capabilityCount(profile: DigitalHumanProfileEntry): number {
  return (
    profile.plugins.length + profile.skills.length + profile.mcp.length + profile.agents.length
  );
}

function modeKey(mode: DigitalHumanTeamMode): "auto" | "divide" | "compare" {
  return mode;
}

export function DigitalHumansView({ activeProjectPath, onUse, confirmDelete }: Props) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { profiles, catalog, teams, availableSkills, status, error, refresh } =
    useDigitalHumansLibrary(activeProjectPath);
  const operations = useDigitalHumanOperations(refresh);
  const [query, setQuery] = React.useState("");
  const [marketKind, setMarketKind] = React.useState<MarketKind>("single");
  const [marketCategory, setMarketCategory] = React.useState<DigitalHumanCategory | "all">("all");
  const [detail, setDetail] = React.useState<DigitalHumanDetail | null>(null);
  const [teamEditor, setTeamEditor] = React.useState<{ team?: DigitalHumanTeam } | null>(null);
  const [editor, setEditor] = React.useState<{ profile?: DigitalHumanProfileEntry } | null>(null);
  const [memoryProfile, setMemoryProfile] = React.useState<DigitalHumanProfileEntry | null>(null);
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
  const visibleCatalog = catalog.filter(
    (entry) =>
      (marketCategory === "all" || entry.category === marketCategory) &&
      (matches(entry) ||
        entry.tags.some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery))),
  );
  const visibleProfiles = profiles.filter(matches);
  const visibleTeams = teams.filter((team) =>
    matches({ name: team.id, label: team.name, description: team.description }),
  );
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));
  const visibleCuratedTeams = CURATED_DIGITAL_HUMAN_TEAMS.filter(
    (team) =>
      (marketCategory === "all" || team.category === marketCategory) &&
      (!normalizedQuery ||
        [team.id, team.name, team.description, ...team.tags, ...team.members].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery),
        )),
  );

  /**
   * Nothing is shipped in the market at all (as opposed to a filter hiding
   * everything). The bundled catalog and curated teams are both intentionally
   * empty now, so the whole browse UI would be chrome over a void.
   */
  const marketIsEmpty = catalog.length === 0 && CURATED_DIGITAL_HUMAN_TEAMS.length === 0;

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

  /** Write every library digital human out as a git-ready repo skeleton. */
  const publishProfileRepo = async () => {
    await operations.run("publish-repo", async () => {
      const result = await window.codeshell.exportProfileRepo(profiles.map((p) => p.name));
      if ("canceled" in result) return;
      toast({
        message: t("digitalHumans.publish.done", { count: profiles.length }),
        variant: "success",
      });
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
            ? t("digitalHumans.delete.blockedBySessions", {
                count: preview.blockingSessions.length,
              })
            : null,
        ].filter(Boolean);
        await confirm({
          title: t("digitalHumans.delete.blockedTitle", { name: profile.label }),
          message: reasons.join("\n"),
          detail: t("digitalHumans.delete.blockedDetail"),
          confirmLabel: t("common.confirm"),
        });
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
    await run(
      `delete-profile:${profile.name}`,
      () =>
        window.codeshell.deleteProfile(profile.name, {
          ...(activeProjectPath ? { cwd: activeProjectPath } : {}),
          ...(profile.active ? { clearActiveProject: true } : {}),
        }),
      { name: profile.label },
    );
  };

  const deleteTeamEntry = async (team: DigitalHumanTeam) => {
    const clearsCurrentSelection = false;
    const accepted = await requestDelete({
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
   * 依赖安装失败不阻断启用——数字人仍可用，只是部分能力缺失，如实告知即可。
   */
  const ensureProfileRequirements = async (name: string): Promise<boolean> => {
    if (!activeProjectPath) return true;
    let preview: Awaited<ReturnType<typeof window.codeshell.previewProfileRequirements>>;
    try {
      preview = await window.codeshell.previewProfileRequirements(name, activeProjectPath);
    } catch {
      // 预检本身失败不该挡住启用（例如老 profile 没有 requires）。
      return true;
    }
    if (!preview.needsInstall && preview.blockers.length === 0) return true;

    const detail = [...preview.willRun, ...preview.warnings, ...preview.blockers].join("\n");
    if (!preview.needsInstall) {
      // 没有可装的东西，只有装不了的外部依赖：告知即可，不做安装。
      await confirm({
        title: t("digitalHumans.requirements.blockedTitle"),
        message: t("digitalHumans.requirements.blockedMessage"),
        detail,
        confirmLabel: t("common.confirm"),
      });
      return true;
    }
    if (
      !(await confirm({
        title: t("digitalHumans.requirements.installTitle"),
        message: t("digitalHumans.requirements.installMessage"),
        detail,
        confirmLabel: t("digitalHumans.requirements.install"),
      }))
    ) {
      return false;
    }

    const result = await window.codeshell.installProfileRequirements(name, activeProjectPath);
    if (!result.ok) {
      toast({
        message: t("digitalHumans.requirements.installFailed", {
          error: result.errors.join("; "),
        }),
        variant: "error",
      });
    }
    return true;
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

  const launchCatalogEntry = async (
    entry: DigitalHumanCatalogEntry,
    starterPrompt?: string,
  ): Promise<void> => {
    if (!entry.installed) {
      const installed = await run(
        `install:${entry.name}`,
        () => window.codeshell.installCatalogProfile(entry.name),
        {
          name: entry.label,
          successMessage: t("digitalHumans.installDone", { name: entry.label }),
        },
      );
      if (!installed) return;
    }
    onUse({ kind: "single", id: entry.name, label: entry.label }, starterPrompt);
  };

  const launchCuratedTeam = async (
    blueprint: CuratedDigitalHumanTeam,
    starterPrompt?: string,
  ): Promise<void> => {
    const existingTeam = teams.find((team) => team.id === blueprint.id);
    if (existingTeam) {
      onUse(
        {
          kind: "team",
          id: existingTeam.id,
          label: existingTeam.name,
          members: existingTeam.members,
          mode: existingTeam.mode,
        },
        starterPrompt,
      );
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
    onUse(
      {
        kind: "team",
        id: blueprint.id,
        label: blueprint.name,
        members: [...blueprint.members],
        mode: blueprint.mode,
      },
      starterPrompt,
    );
  };

  const launchDetail = (starterPrompt?: string): void => {
    if (!detail) return;
    if (detail.kind === "catalog") {
      void launchCatalogEntry(detail.entry, starterPrompt);
      return;
    }
    if (detail.kind === "curated-team") {
      void launchCuratedTeam(detail.team, starterPrompt);
      return;
    }
    if (detail.kind === "profile") {
      onUse(
        { kind: "single", id: detail.profile.name, label: detail.profile.label },
        starterPrompt,
      );
      return;
    }
    onUse(
      {
        kind: "team",
        id: detail.team.id,
        label: detail.team.name,
        members: detail.team.members,
        mode: detail.team.mode,
      },
      starterPrompt,
    );
  };

  const detailBusy =
    detail?.kind === "catalog"
      ? operations.isBusy(`install:${detail.entry.name}`)
      : detail?.kind === "curated-team"
        ? operations.isBusy(`install-team:${detail.team.id}`)
        : false;

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
                <TabsList className="mb-1">
                  <TabsTrigger value="market">{t("digitalHumans.tabs.market")}</TabsTrigger>
                  <TabsTrigger value="mine">{t("digitalHumans.tabs.mine")}</TabsTrigger>
                  <TabsTrigger value="teams">{t("digitalHumans.tabs.teams")}</TabsTrigger>
                </TabsList>

                <TabsContent value="market" className="mt-5">
                  {marketIsEmpty ? (
                    // Nothing is shipped at all. Rendering the scene cards, the
                    // "browse (0)" heading and the category filters over an empty
                    // list is pure chrome — four cards with no entries and five
                    // buttons that filter nothing. Show only where to get one.
                    <CatalogEmptyState
                      onImport={() => void pickProfileDefinitionImport()}
                      onCreate={() => setEditor({})}
                      importBusy={importPickerBusy}
                    />
                  ) : (
                    <>
                      {!normalizedQuery && marketCategory === "all" ? (
                        <FeaturedScenes
                          catalog={catalog}
                          onSelectCategory={(category) => {
                            setMarketKind("single");
                            setMarketCategory(category);
                          }}
                        />
                      ) : null}

                      <div className="mt-6 flex flex-col gap-4">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h2 className="text-base font-semibold tracking-tight">
                                {t("digitalHumans.market.browseTitle")}
                              </h2>
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

                        <div
                          className="flex flex-wrap gap-1.5"
                          aria-label={t("digitalHumans.market.categoryLabel")}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant={marketCategory === "all" ? "secondary" : "ghost"}
                            className="h-7 rounded-full px-3"
                            onClick={() => setMarketCategory("all")}
                          >
                            {t("digitalHumans.market.category.all")}
                          </Button>
                          {DIGITAL_HUMAN_CATEGORIES.map((category) => (
                            <Button
                              key={category}
                              type="button"
                              size="sm"
                              variant={marketCategory === category ? "secondary" : "ghost"}
                              className="h-7 rounded-full px-3"
                              onClick={() => setMarketCategory(category)}
                            >
                              {t(`digitalHumans.market.category.${category}`)}
                            </Button>
                          ))}
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
                                busy={operations.isBusy(`install:${entry.name}`)}
                                onDetails={() => setDetail({ kind: "catalog", entry })}
                                onLaunch={() => void launchCatalogEntry(entry)}
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
                              busy={operations.isBusy(`install-team:${team.id}`)}
                              onDetails={() => setDetail({ kind: "curated-team", team })}
                              onLaunch={() => void launchCuratedTeam(team)}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </TabsContent>

                <TabsContent value="mine" className="mt-5">
                  {profiles.length > 0 ? (
                    // Publishing is the missing half of sharing: a single JSON
                    // has to be hand-delivered, whereas a repo layout can be
                    // pushed and installed by `owner/repo`.
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                      <p className="text-xs text-muted-foreground">
                        {t("digitalHumans.publish.hint")}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={operations.isBusy("publish-repo")}
                        onClick={() => void publishProfileRepo()}
                      >
                        <Upload size={13} aria-hidden="true" />
                        {t("digitalHumans.publish.action")}
                      </Button>
                    </div>
                  ) : null}
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
                          onDetails={() => setDetail({ kind: "profile", profile })}
                          onEdit={() => setEditor({ profile })}
                          onMemory={() => setMemoryProfile(profile)}
                          onExport={() => void exportProfileEntry(profile)}
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
                          onDetails={() => setDetail({ kind: "team", team })}
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
        skills={availableSkills.filter((skill) => skill.source !== "project")}
        projectSkills={availableSkills.filter((skill) => skill.source === "project")}
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

      <DigitalHumanMemoryDialog
        profile={memoryProfile}
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

function categoryIcon(category: DigitalHumanCategory, size = 17) {
  const props = { size, "aria-hidden": true as const };
  if (category === "product") return <Briefcase {...props} />;
  if (category === "design") return <Palette {...props} />;
  if (category === "engineering") return <Code2 {...props} />;
  return <ShieldCheck {...props} />;
}

function categoryTone(category: DigitalHumanCategory): string {
  if (category === "product") return "bg-primary/10 text-primary";
  if (category === "design") return "bg-status-warn/10 text-status-warn";
  if (category === "engineering") return "bg-status-running/10 text-status-running";
  return "bg-status-ok/10 text-status-ok";
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
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-semibold",
        category ? categoryTone(category) : "bg-muted text-muted-foreground",
        className,
      )}
      data-digital-human-avatar={id}
      aria-hidden="true"
    >
      {team ? <UsersRound size={18} /> : initials(label)}
    </span>
  );
}

function FeaturedScenes({
  catalog,
  onSelectCategory,
}: {
  catalog: DigitalHumanCatalogEntry[];
  onSelectCategory: (category: DigitalHumanCategory) => void;
}) {
  const { t } = useT();
  return (
    <section aria-labelledby="digital-human-featured-scenes">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="digital-human-featured-scenes" className="text-base font-semibold tracking-tight">
            {t("digitalHumans.market.featuredTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("digitalHumans.market.featuredDescription")}
          </p>
        </div>
        <Sparkles size={17} className="text-primary" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {DIGITAL_HUMAN_CATEGORIES.map((category) => {
          const entries = catalog.filter((entry) => entry.category === category).slice(0, 2);
          return (
            <Button
              key={category}
              type="button"
              variant="outline"
              className="group h-auto min-h-32 items-stretch justify-start overflow-hidden p-0 text-left"
              onClick={() => onSelectCategory(category)}
            >
              <span className="flex w-full flex-col">
                <span className={cn("flex items-center gap-2 px-4 py-3", categoryTone(category))}>
                  {categoryIcon(category, 16)}
                  <span className="font-semibold">
                    {t(`digitalHumans.market.scene.${category}.title`)}
                  </span>
                  <ArrowRight
                    size={14}
                    className="ml-auto transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
                <span className="flex flex-1 flex-col gap-1.5 px-4 py-3">
                  {entries.map((entry) => (
                    <span key={entry.name} className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                      <span className="truncate">{entry.label}</span>
                    </span>
                  ))}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function CatalogCard({
  entry,
  busy,
  onDetails,
  onLaunch,
}: {
  entry: DigitalHumanCatalogEntry;
  busy: boolean;
  onDetails: () => void;
  onLaunch: () => void;
}) {
  const { t } = useT();
  return (
    <Card
      className="group flex min-h-52 flex-col transition-colors hover:border-primary/30"
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
      <CardFooter className="justify-between gap-2 border-t border-border/60 pt-3">
        <Button size="sm" variant="ghost" className="px-2" onClick={onDetails}>
          {t("digitalHumans.market.details")}
          <ChevronRight size={13} aria-hidden="true" />
        </Button>
        <Button size="sm" onClick={onLaunch} disabled={busy}>
          <Sparkles size={13} aria-hidden="true" />
          {busy
            ? t("digitalHumans.installing")
            : entry.installed
              ? t("digitalHumans.summon")
              : t("digitalHumans.installAndSummon")}
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
  onLaunch,
}: {
  team: CuratedDigitalHumanTeam;
  catalogByName: Map<string, DigitalHumanCatalogEntry>;
  installed: boolean;
  busy: boolean;
  onDetails: () => void;
  onLaunch: () => void;
}) {
  const { t } = useT();
  return (
    <Card
      className="group flex min-h-60 flex-col transition-colors hover:border-primary/30"
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
      <CardFooter className="justify-between gap-2 border-t border-border/60 pt-3">
        <Button size="sm" variant="ghost" className="px-2" onClick={onDetails}>
          {t("digitalHumans.market.details")}
          <ChevronRight size={13} aria-hidden="true" />
        </Button>
        <Button size="sm" onClick={onLaunch} disabled={busy}>
          <Sparkles size={13} aria-hidden="true" />
          {busy
            ? t("digitalHumans.installing")
            : installed
              ? t("digitalHumans.summonTeam")
              : t("digitalHumans.installAndSummonTeam")}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ProfileCard({
  profile,
  hasProject,
  busy,
  onUse,
  onDetails,
  onEdit,
  onMemory,
  onExport,
  onDelete,
  onToggleDefault,
}: {
  profile: DigitalHumanProfileEntry;
  hasProject: boolean;
  busy: boolean;
  onUse: () => void;
  onDetails: () => void;
  onEdit: () => void;
  onMemory: () => void;
  onExport: () => void;
  onDelete: () => void;
  onToggleDefault: () => void;
}) {
  const { t } = useT();
  const count = capabilityCount(profile);
  return (
    <Card className="flex min-h-64 flex-col transition-colors hover:border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar id={profile.name} label={profile.label} />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="truncate text-sm">{profile.label}</CardTitle>
              {profile.active ? (
                <Badge variant="accent" className="shrink-0">
                  {t("digitalHumans.current")}
                </Badge>
              ) : null}
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
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5 pb-3">
        <Badge variant="secondary">{profile.basePreset}</Badge>
        {count > 0 ? (
          <Badge variant="secondary">{t("digitalHumans.capabilityCount", { count })}</Badge>
        ) : null}
        {profile.portableMemory ? (
          <Badge variant="secondary">{t("digitalHumans.portableMemory")}</Badge>
        ) : null}
      </CardContent>
      {/* One primary action; everything else collapses into an overflow menu.
          The old footer put 7 controls in a row — 4 of them same-weight icon
          buttons — so nothing read as the thing you were meant to click. */}
      <CardFooter className="items-center gap-2 border-t border-border/60 pt-3">
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
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={onToggleDefault}
          disabled={!hasProject || busy}
          title={
            hasProject ? t("digitalHumans.setProjectDefaultHint") : t("digitalHumans.pickProject")
          }
        >
          {profile.active ? t("digitalHumans.clearDefault") : t("digitalHumans.setProjectDefault")}
        </Button>
        <DropdownMenu>
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
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onDetails}>
              <ChevronRight size={13} aria-hidden="true" />
              {t("digitalHumans.market.details")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil size={13} aria-hidden="true" />
              {t("digitalHumans.editor.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onMemory}>
              <Brain size={13} aria-hidden="true" />
              {t("digitalHumans.memory.button")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport}>
              <Download size={13} aria-hidden="true" />
              {t("digitalHumans.transfer.exportDefinition")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-status-err focus:text-status-err" onSelect={onDelete}>
              <Trash2 size={13} aria-hidden="true" />
              {t("common.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
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
  onDelete,
}: {
  team: DigitalHumanTeam;
  memberLabels: string[];
  busy: boolean;
  onUse: () => void;
  onDetails: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  return (
    <Card className="flex min-h-60 flex-col transition-colors hover:border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <DigitalHumanAvatar id={team.id} label={team.name} team />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="truncate text-sm">{team.name}</CardTitle>
              <Badge variant="info" className="shrink-0">
                {t(`digitalHumans.team.mode.${modeKey(team.mode)}`)}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {memberLabels.length} {t("digitalHumans.market.members")}
            </p>
          </div>
        </div>
        <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
          {team.description ?? t("digitalHumans.team.defaultDescription")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-wrap content-start gap-1.5 pb-3">
        {memberLabels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 border-t border-border/60 pt-3">
        <Button size="sm" variant="ghost" className="px-2" onClick={onDetails} disabled={busy}>
          {t("digitalHumans.market.details")}
          <ChevronRight size={13} aria-hidden="true" />
        </Button>
        <Button size="sm" className="min-w-28 flex-1" onClick={onUse} disabled={busy}>
          <Sparkles size={14} aria-hidden="true" />
          {t("digitalHumans.summonTeam")}
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

function DigitalHumanDetailDialog({
  detail,
  profiles,
  catalog,
  teams,
  busy,
  onOpenChange,
  onLaunch,
}: {
  detail: DigitalHumanDetail | null;
  profiles: DigitalHumanProfileEntry[];
  catalog: DigitalHumanCatalogEntry[];
  teams: DigitalHumanTeam[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (starterPrompt?: string) => void;
}) {
  const { t } = useT();
  if (!detail) return null;

  const installedTeam =
    detail.kind === "curated-team" ? teams.find((team) => team.id === detail.team.id) : undefined;
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
        method: detail.entry.mainInstruction,
        capabilityCount: capabilityCount({ ...detail.entry, active: false }),
      };
    }
    if (detail.kind === "profile") {
      return {
        id: detail.profile.name,
        label: detail.profile.label,
        description: detail.profile.description ?? t("digitalHumans.noDescription"),
        category: undefined,
        tags: [
          detail.profile.basePreset,
          ...detail.profile.skills.slice(0, 3),
          ...(detail.profile.portableMemory ? [t("digitalHumans.portableMemory")] : []),
        ],
        prompts: profileSamplePrompts(detail.profile),
        installed: true,
        team: false,
        members: [] as string[],
        method: detail.profile.mainInstruction,
        capabilityCount: capabilityCount(detail.profile),
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
        method: t(
          `digitalHumans.team.modeDescription.${modeKey(installedTeam?.mode ?? detail.team.mode)}`,
        ),
        capabilityCount: 0,
      };
    }
    return {
      id: detail.team.id,
      label: detail.team.name,
      description: detail.team.description ?? t("digitalHumans.team.defaultDescription"),
      category: undefined,
      tags: [t(`digitalHumans.team.mode.${modeKey(detail.team.mode)}`)],
      prompts: [
        t("digitalHumans.detail.teamPrompt", { name: detail.team.name }),
        t("digitalHumans.detail.teamReviewPrompt", { name: detail.team.name }),
      ],
      installed: true,
      team: true,
      members: detail.team.members,
      method: t(`digitalHumans.team.modeDescription.${modeKey(detail.team.mode)}`),
      capabilityCount: 0,
    };
  })();

  const profileById = new Map(profiles.map((profile) => [profile.name, profile]));
  const catalogById = new Map(catalog.map((entry) => [entry.name, entry]));
  const memberEntries = view.members.map((id) => ({
    id,
    label: profileById.get(id)?.label ?? catalogById.get(id)?.label ?? id,
    category: catalogById.get(id)?.category,
  }));
  const primaryLabel = view.team
    ? view.installed
      ? t("digitalHumans.summonTeam")
      : t("digitalHumans.installAndSummonTeam")
    : view.installed
      ? t("digitalHumans.summon")
      : t("digitalHumans.installAndSummon");

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
                      {t("digitalHumans.detail.memberRole")}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{view.method}</p>
            </section>
          ) : (
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
          )}

          <section>
            <div className="flex items-center gap-2">
              <MessageSquareText size={15} className="text-primary" aria-hidden="true" />
              <h3 className="text-sm font-semibold">{t("digitalHumans.detail.tryTasks")}</h3>
            </div>
            <div className="mt-2 space-y-2">
              {view.prompts.map((prompt) => (
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
              ))}
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 border-t border-border/70 bg-background p-4">
          <Button className="w-full" size="lg" onClick={() => onLaunch()} disabled={busy}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={15} aria-hidden="true" />
            )}
            {busy ? t("digitalHumans.installing") : primaryLabel}
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

/**
 * The bundled catalog now ships empty on purpose (the 8 starters had no
 * capability difference). Say where digital humans come from instead of
 * showing "no search results", which reads as a broken filter.
 */
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
