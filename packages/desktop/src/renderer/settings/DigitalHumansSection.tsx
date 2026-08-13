import React from "react";
import { Download, ExternalLink, Loader2, Pencil, Plus, RotateCcw, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { DigitalHumanEditorDialog } from "../digital-humans/DigitalHumanEditorDialog";
import { ensureDigitalHumanRequirements } from "../digital-humans/profileRequirements";
import { normalizeDigitalHumanSkillRepo } from "../digital-humans/types";
import type { DigitalHumanProfileEntry, DigitalHumanSkillEntry } from "../digital-humans/types";
import { ProfileSection } from "./ProfileSection";
import { writeSettings } from "../settingsBus";
import { useRefreshOnSettingsChange } from "./useSettingsResource";

interface Props {
  scope: "user" | "project";
  /** Selected/active project, used for activation and Skill installation status. */
  projectPath: string | null;
  /** Jump to the full digital-humans page (market / teams). */
  onOpenDigitalHumans?: () => void;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * 设置中心「数字人」模块。全局 scope = 数字人库管理(与数字人页共享同一
 * 编辑对话框);项目 scope = 按项目激活/关闭(复用 ProfileSection)。
 *
 * 全局 scope 下 listProfiles() 不带 cwd:条目仍是完整的 WorkspaceProfile
 * 投影(plugins/skills/mcp/agents 等字段齐全,编辑保存不会丢配置)。列表
 * 不显示激活状态 —— 「项目默认」属于项目上下文,由项目 scope 的
 * ProfileSection 负责展示与切换。
 */
export function DigitalHumansSection({ scope, projectPath, onOpenDigitalHumans }: Props) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [skills, setSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [editing, setEditing] = React.useState<DigitalHumanProfileEntry | undefined>();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [installingRequirements, setInstallingRequirements] = React.useState(false);
  const saveLock = React.useRef(false);
  const transferLock = React.useRef(false);
  const [transferBusy, setTransferBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    // Profiles are the primary content; a skills failure only degrades the
    // editor's skill picker, so it must not discard a fetched profile list.
    const [profileResult, skillResult] = await Promise.allSettled([
      window.codeshell.listProfiles(projectPath ?? undefined),
      window.codeshell.listSkills(projectPath, { includeDisabled: true }),
    ]);
    if (profileResult.status === "fulfilled") {
      setProfiles(profileResult.value);
      setError(null);
    } else {
      setError(errorMessage(profileResult.reason));
    }
    if (skillResult.status === "fulfilled") {
      setSkills(skillResult.value);
    } else {
      toast({
        message: t("settingsX.digitalHumans.skillsLoadFailed", {
          message: errorMessage(skillResult.reason),
        }),
        variant: "error",
      });
    }
  }, [projectPath, t, toast]);

  React.useEffect(() => {
    if (scope === "user") void refresh();
  }, [scope, refresh]);

  if (scope === "project") {
    if (!projectPath) return null;
    return (
      <div className="space-y-4">
        <ProfileSection cwd={projectPath} />
        <PetExternalSessionsToggles scope="project" projectPath={projectPath} />
      </div>
    );
  }

  const save = async (
    profile: Omit<DigitalHumanProfileEntry, "active">,
    options?: { installRequirements?: boolean },
  ) => {
    if (saveLock.current) return;
    saveLock.current = true;
    setBusy(true);
    setInstallingRequirements(Boolean(options?.installRequirements));
    try {
      await window.codeshell.saveProfile(profile, projectPath ?? undefined);
      await refresh();
      if (options?.installRequirements) {
        const ready = await ensureDigitalHumanRequirements({
          name: profile.name,
          projectPath,
          api: window.codeshell,
          confirm,
          toast,
          t,
        });
        if (!ready) {
          setEditing((current) => ({
            ...profile,
            active: current?.active ?? false,
          }));
          return;
        }
        await refresh();
      }
      setEditorOpen(false);
    } catch (caught) {
      // The section-body error <p> sits under the dialog overlay, so save
      // failures surface as a toast (same pattern as DigitalHumansView) and
      // the dialog stays open with the user's input intact.
      toast({
        message: t("digitalHumans.actionFailed", {
          name: profile.label,
          message: errorMessage(caught),
        }),
        variant: "error",
      });
    } finally {
      saveLock.current = false;
      setBusy(false);
      setInstallingRequirements(false);
    }
  };

  const runTransfer = async (key: string, name: string, action: () => Promise<void>) => {
    if (transferLock.current) return;
    transferLock.current = true;
    setTransferBusy(key);
    try {
      await action();
    } catch (caught) {
      toast({
        message: t("digitalHumans.actionFailed", {
          name,
          message: errorMessage(caught),
        }),
        variant: "error",
      });
    } finally {
      transferLock.current = false;
      setTransferBusy(null);
    }
  };

  const exportDefinition = (profile: DigitalHumanProfileEntry) =>
    runTransfer(`profile:${profile.name}`, profile.label, async () => {
      const result = await window.codeshell.exportProfileDefinition(profile.name);
      if (result.canceled) return;
      toast({
        message: t("digitalHumans.transfer.exported", {
          name: result.label,
          file: result.fileName,
        }),
      });
    });

  const exportLibraryRepo = () =>
    runTransfer("library", t("digitalHumans.publish.action"), async () => {
      const result = await window.codeshell.exportProfileRepo(
        profiles.map((profile) => profile.name),
      );
      if ("canceled" in result) return;
      toast({
        message: t("digitalHumans.publish.done", { count: profiles.length }),
        variant: "success",
      });
    });

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-md border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("settingsX.digitalHumans.title")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("settingsX.digitalHumans.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            {onOpenDigitalHumans ? (
              <Button size="sm" variant="outline" onClick={onOpenDigitalHumans}>
                <ExternalLink className="size-3.5" aria-hidden />
                {t("settingsX.digitalHumans.openMarket")}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(undefined);
                setEditorOpen(true);
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              {t("settingsX.digitalHumans.create")}
            </Button>
          </div>
        </div>
        {error ? <p className="text-xs text-status-err">{error}</p> : null}
        {/* Above the library, not below it: this is where digital humans come
          from, and a long profile list used to push it off-screen. */}
        <DigitalHumanReposPanel />
        {profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settingsX.digitalHumans.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {profiles.map((profile) => (
              <li
                key={profile.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-foreground">{profile.label}</span>
                    <Badge variant="success" className="shrink-0">
                      {t("digitalHumans.localInstalled")}
                    </Badge>
                  </div>
                  {profile.description ? (
                    <p className="truncate text-xs text-muted-foreground">{profile.description}</p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(profile);
                    setEditorOpen(true);
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden />
                  {t("settingsX.digitalHumans.edit")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DigitalHumanEditorDialog
          open={editorOpen}
          profile={editing}
          existingIds={profiles.map((profile) => profile.name)}
          skills={skills.filter((skill) => skill.source !== "project")}
          projectSkills={skills.filter((skill) => skill.source === "project")}
          projectPath={projectPath}
          busy={busy}
          installing={installingRequirements}
          onRequirementsInstalled={refresh}
          onOpenChange={setEditorOpen}
          onSave={(profile, options) => void save(profile, options)}
        />
        <details className="group rounded-md border border-border/70 bg-background/40">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-medium text-muted-foreground">
            {t("settingsX.digitalHumans.advancedExportTitle")}
          </summary>
          <div className="space-y-3 border-t border-border/70 px-3 py-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {t("settingsX.digitalHumans.advancedExportDescription")}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
              <p className="max-w-xl text-xs text-muted-foreground">
                {t("digitalHumans.publish.hint")}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={profiles.length === 0 || transferBusy !== null}
                onClick={() => void exportLibraryRepo()}
              >
                {transferBusy === "library" ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Upload className="size-3.5" aria-hidden />
                )}
                {t("digitalHumans.publish.action")}
              </Button>
            </div>
            {profiles.length > 0 ? (
              <ul className="divide-y divide-border/60 rounded-md border border-border/70">
                {profiles.map((profile) => {
                  const key = `profile:${profile.name}`;
                  return (
                    <li
                      key={profile.name}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-xs text-foreground">
                        {profile.label}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={transferBusy !== null}
                        onClick={() => void exportDefinition(profile)}
                      >
                        {transferBusy === key ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Download className="size-3.5" aria-hidden />
                        )}
                        {t("digitalHumans.transfer.exportDefinition")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </details>
      </section>
      <PetExternalSessionsToggles scope="user" />
    </div>
  );
}

type RepoRow = Awaited<ReturnType<typeof window.codeshell.listProfileRepos>>[number];

/**
 * 数字人仓库管理。
 *
 * 数字人不寄生于插件市场——它有自己的定义格式与分发通道，仓库只是把「一批定义」
 * 打包。添加会克隆远程仓库（网络 + 磁盘写入），所以按钮上明说，并把失败原因
 * 原样呈现，而不是吞掉。
 */
function DigitalHumanReposPanel() {
  const { t } = useT();
  const confirm = useConfirm();
  const [repos, setRepos] = React.useState<RepoRow[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const operationLock = React.useRef(false);
  const normalizedRepo = normalizeDigitalHumanSkillRepo(input);
  const repoInvalid = input.trim().length > 0 && normalizedRepo === null;

  const refresh = React.useCallback(async () => {
    try {
      setRepos(await window.codeshell.listProfileRepos());
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const runRepoOperation = async (operation: () => Promise<void>) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  };

  const add = async () => {
    if (!normalizedRepo) return;
    await runRepoOperation(async () => {
      const result = await window.codeshell.addProfileRepo(normalizedRepo);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInput("");
      await refresh();
    });
  };

  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-3">
      <div>
        <h4 className="text-xs font-medium text-foreground">
          {t("settingsX.digitalHumans.repos.title")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t("settingsX.digitalHumans.repos.description")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder={t("settingsX.digitalHumans.repos.placeholder")}
          aria-label={t("settingsX.digitalHumans.repos.title")}
          aria-invalid={repoInvalid}
          className="h-8 min-w-56 flex-1 text-xs"
          disabled={busy}
        />
        <Button size="sm" onClick={() => void add()} disabled={busy || !normalizedRepo}>
          {t("settingsX.digitalHumans.repos.add")}
        </Button>
      </div>
      {repoInvalid ? (
        <p className="text-xs text-status-err">{t("settingsX.digitalHumans.repos.invalid")}</p>
      ) : null}
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      {repos.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settingsX.digitalHumans.repos.empty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {repos.map((repo) => (
            <li
              key={repo.repo}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5"
            >
              <div className="min-w-0">
                <span className="font-mono text-xs text-foreground">{repo.repo}</span>
                <p className="text-[11px] text-muted-foreground">
                  {t("settingsX.digitalHumans.repos.count", { count: repo.count })}
                  {repo.errors.length > 0
                    ? ` · ${t("settingsX.digitalHumans.repos.issues", {
                        count: repo.errors.length,
                      })}`
                    : ""}
                </p>
                {repo.errors.length > 0 ? (
                  <details className="mt-1 max-w-xl text-[11px] text-status-warn">
                    <summary className="cursor-pointer select-none">
                      {t("settingsX.digitalHumans.repos.viewIssues")}
                    </summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {repo.errors.map((issue, index) => (
                        <li key={`${repo.repo}:${index}`} className="break-words">
                          {issue}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* addProfileRepo already fetch+resets an existing clone, so
                    updating was possible but had no button — the only visible
                    path was remove-then-add. */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    void runRepoOperation(async () => {
                      const result = await window.codeshell.addProfileRepo(repo.repo);
                      if (!result.ok) {
                        setError(result.error);
                        return;
                      }
                      await refresh();
                    });
                  }}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t("settingsX.digitalHumans.repos.update")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    const accepted = await confirm({
                      title: t("settingsX.digitalHumans.repos.removeTitle"),
                      message: t("settingsX.digitalHumans.repos.removeMessage", {
                        repo: repo.repo,
                      }),
                      detail: t("settingsX.digitalHumans.repos.removeDetail"),
                      confirmLabel: t("settingsX.digitalHumans.repos.remove"),
                      destructive: true,
                    });
                    if (!accepted) return;
                    await runRepoOperation(async () => {
                      await window.codeshell.removeProfileRepo(repo.repo);
                      await refresh();
                    });
                  }}
                >
                  {t("settingsX.digitalHumans.repos.remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface PetSettings {
  showExternalCodexSessions?: boolean;
  showExternalClaudeSessions?: boolean;
  [key: string]: unknown;
}

export type PetExternalSessionKey = "showExternalCodexSessions" | "showExternalClaudeSessions";
export type PetExternalSessionOverride = "on" | "off";
type PetExternalSessionOverrides = Partial<
  Record<PetExternalSessionKey, PetExternalSessionOverride>
>;

function petOf(v: unknown): PetSettings {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as PetSettings) : {};
}

/**
 * Compute the `pet` subtree to write when one external-session toggle flips.
 * Spreads the current subtree so the other toggle's value is preserved even if
 * the settings backend ever switched to a shallow merge.
 */
export function nextPetPatch(
  current: PetSettings,
  key: PetExternalSessionKey,
  next: boolean,
): PetSettings {
  return { ...current, [key]: next };
}

function projectPetOverridesOf(settings: unknown): PetExternalSessionOverrides {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const capabilityOverrides = (settings as Record<string, unknown>).capabilityOverrides;
  if (!capabilityOverrides || typeof capabilityOverrides !== "object") return {};
  const pet = (capabilityOverrides as Record<string, unknown>).pet;
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return {};
  const raw = pet as Record<string, unknown>;
  return {
    ...(raw.showExternalCodexSessions === "on" || raw.showExternalCodexSessions === "off"
      ? { showExternalCodexSessions: raw.showExternalCodexSessions }
      : {}),
    ...(raw.showExternalClaudeSessions === "on" || raw.showExternalClaudeSessions === "off"
      ? { showExternalClaudeSessions: raw.showExternalClaudeSessions }
      : {}),
  };
}

export function nextPetProjectOverridePatch(
  key: PetExternalSessionKey,
  next: boolean | "inherit",
): Record<string, unknown> {
  return {
    capabilityOverrides: {
      pet: { [key]: next === "inherit" ? null : next ? "on" : "off" },
    },
  };
}

function effectivePetToggle(
  pet: PetSettings,
  overrides: PetExternalSessionOverrides,
  key: PetExternalSessionKey,
): boolean {
  const override = overrides[key];
  if (override === "on") return true;
  if (override === "off") return false;
  return pet[key] ?? false;
}

/**
 * Two scope-aware toggles that opt Pet's global view into reading external CLI
 * session records (~/.codex, ~/.claude). User scope writes the global baseline;
 * project scope writes capabilityOverrides.pet on/off and may reset to inherit.
 *
 * The whole `pet` subtree is spread on write so toggling one switch never drops
 * the other's current value. (main's writeSettings deep-merges the patch, so
 * this is belt-and-suspenders, but it keeps the write self-describing.)
 */
export function PetExternalSessionsToggles({
  scope = "user",
  projectPath,
}: {
  scope?: "user" | "project";
  projectPath?: string | null;
}) {
  const { t } = useT();
  const [pet, setPet] = React.useState<PetSettings>({});
  const [overrides, setOverrides] = React.useState<PetExternalSessionOverrides>({});
  // Mirror the latest committed pet subtree so setToggle computes the optimistic
  // patch and its rollback base from live truth, not a render-time closure. This
  // is what makes toggling both switches within one render frame safe (the 2nd
  // click builds on the 1st) and keeps a failed write from reverting to a stale
  // snapshot.
  const petRef = React.useRef<PetSettings>(pet);
  petRef.current = pet;
  const overridesRef = React.useRef<PetExternalSessionOverrides>(overrides);
  overridesRef.current = overrides;

  const load = React.useCallback(async () => {
    if (scope === "project" && projectPath) {
      const [userSettings, projectSettings] = await Promise.all([
        window.codeshell.getSettings("user"),
        window.codeshell.getSettings("project", projectPath),
      ]);
      setPet(petOf((userSettings as Record<string, unknown> | null)?.pet));
      setOverrides(projectPetOverridesOf(projectSettings));
      return;
    }
    const settings = (await window.codeshell.getSettings("user")) ?? {};
    setPet(petOf((settings as Record<string, unknown>).pet));
    setOverrides({});
  }, [projectPath, scope]);

  useRefreshOnSettingsChange(() => void load(), [load]);

  const codex = effectivePetToggle(pet, overrides, "showExternalCodexSessions");
  const claude = effectivePetToggle(pet, overrides, "showExternalClaudeSessions");

  const setToggle = async (key: PetExternalSessionKey, next: boolean) => {
    if (scope === "project" && projectPath) {
      const prev = overridesRef.current;
      const optimistic = { ...prev, [key]: next ? "on" : "off" } as const;
      overridesRef.current = optimistic;
      setOverrides(optimistic);
      try {
        await writeSettings("project", nextPetProjectOverridePatch(key, next), projectPath);
      } catch {
        overridesRef.current = prev;
        setOverrides(prev);
      }
      return;
    }
    const prev = petRef.current;
    const optimistic = nextPetPatch(prev, key, next);
    petRef.current = optimistic;
    setPet(optimistic);
    try {
      await writeSettings("user", { pet: optimistic });
    } catch {
      // Revert to the value observed before this toggle; the settings-changed
      // listener re-loads truth anyway.
      petRef.current = prev;
      setPet(prev);
    }
  };

  const resetOverride = async (key: PetExternalSessionKey) => {
    if (scope !== "project" || !projectPath || !overridesRef.current[key]) return;
    const prev = overridesRef.current;
    const optimistic = { ...prev };
    delete optimistic[key];
    overridesRef.current = optimistic;
    setOverrides(optimistic);
    try {
      await writeSettings("project", nextPetProjectOverridePatch(key, "inherit"), projectPath);
    } catch {
      overridesRef.current = prev;
      setOverrides(prev);
    }
  };

  const scopeHint = (key: PetExternalSessionKey) => {
    const override = overrides[key];
    if (override) return t("settingsX.digitalHumans.projectOverride");
    return t("settingsX.digitalHumans.projectInherit", {
      state: pet[key]
        ? t("settingsX.digitalHumans.enabled")
        : t("settingsX.digitalHumans.disabled"),
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">
          {t("settingsX.digitalHumans.externalSessionsTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            scope === "project"
              ? "settingsX.digitalHumans.externalSessionsProjectSubtitle"
              : "settingsX.digitalHumans.externalSessionsSubtitle",
          )}
        </p>
      </div>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm text-foreground">
            {t("settingsX.digitalHumans.codexLabel")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("settingsX.digitalHumans.codexDesc")}
          </span>
          {scope === "project" ? (
            <span className="block text-xs text-muted-foreground">
              {scopeHint("showExternalCodexSessions")}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {scope === "project" && overrides.showExternalCodexSessions ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              aria-label={t("settingsX.digitalHumans.resetCodexOverride")}
              onClick={() => void resetOverride("showExternalCodexSessions")}
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <Switch
            aria-label={t("settingsX.digitalHumans.codexLabel")}
            checked={codex}
            onCheckedChange={(next) => void setToggle("showExternalCodexSessions", next)}
          />
        </span>
      </div>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm text-foreground">
            {t("settingsX.digitalHumans.claudeLabel")}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t("settingsX.digitalHumans.claudeDesc")}
          </span>
          {scope === "project" ? (
            <span className="block text-xs text-muted-foreground">
              {scopeHint("showExternalClaudeSessions")}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {scope === "project" && overrides.showExternalClaudeSessions ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              aria-label={t("settingsX.digitalHumans.resetClaudeOverride")}
              onClick={() => void resetOverride("showExternalClaudeSessions")}
            >
              <RotateCcw className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <Switch
            aria-label={t("settingsX.digitalHumans.claudeLabel")}
            checked={claude}
            onCheckedChange={(next) => void setToggle("showExternalClaudeSessions", next)}
          />
        </span>
      </div>
    </div>
  );
}
