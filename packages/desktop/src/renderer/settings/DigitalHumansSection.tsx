import React from "react";
import { ExternalLink, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
import { useToast } from "../ui/ToastProvider";
import { DigitalHumanEditorDialog } from "../digital-humans/DigitalHumanEditorDialog";
import type { DigitalHumanProfileEntry, DigitalHumanSkillEntry } from "../digital-humans/types";
import { ProfileSection } from "./ProfileSection";

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
    return <ProfileSection cwd={projectPath} />;
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
        skills={skills}
        busy={busy}
        onOpenChange={setEditorOpen}
        onSave={(profile) => void save(profile)}
      />
    </section>
  );
}
