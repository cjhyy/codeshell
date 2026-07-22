import React from "react";
import { ExternalLink, Pencil, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "../i18n";
import { useToast } from "../ui/ToastProvider";
import { DigitalHumanEditorDialog } from "../digital-humans/DigitalHumanEditorDialog";
import type { DigitalHumanProfileEntry, DigitalHumanSkillEntry } from "../digital-humans/types";
import { ProfileSection } from "./ProfileSection";
import { writeSettings } from "../settingsBus";
import { useRefreshOnSettingsChange } from "./useSettingsResource";

interface Props {
  scope: "user" | "project";
  /** Project path when scope === "project"; used for activation. */
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
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [skills, setSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [editing, setEditing] = React.useState<DigitalHumanProfileEntry | undefined>();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    // Profiles are the primary content; a skills failure only degrades the
    // editor's skill picker, so it must not discard a fetched profile list.
    const [profileResult, skillResult] = await Promise.allSettled([
      window.codeshell.listProfiles(),
      window.codeshell.listSkills(projectPath ?? "/", { includeDisabled: true }),
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

  const save = async (profile: Omit<DigitalHumanProfileEntry, "active">) => {
    setBusy(true);
    try {
      await window.codeshell.saveProfile(profile);
      setEditorOpen(false);
      await refresh();
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
      setBusy(false);
    }
  };

  return (
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
                <span className="text-sm text-foreground">{profile.label}</span>
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
        busy={busy}
        onOpenChange={setEditorOpen}
        onSave={(profile) => void save(profile)}
      />
      <PetExternalSessionsToggles scope="user" />
    </section>
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
    <div className="space-y-3 rounded-md border border-border bg-background p-4">
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
