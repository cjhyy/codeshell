import type { TFunction } from "../i18n/I18nProvider";
import type { ConfirmDialogOptions } from "../ui/dialogState";
import type { ToastOptions } from "../ui/toastState";
import type { RendererConfigurationTarget } from "../../preload/types";
import { requireProjectConfigurationTarget } from "../configurationTarget";

interface RequirementsApi {
  previewProfileRequirements(
    name: string,
    target: RendererConfigurationTarget,
  ): Promise<{
    needsInstall: boolean;
    willRun: string[];
    warnings: string[];
    blockers: string[];
  }>;
  installProfileRequirements(
    name: string,
    target: RendererConfigurationTarget,
  ): Promise<{ ok: boolean; errors: string[] }>;
}

export interface EnsureDigitalHumanRequirementsOptions {
  name: string;
  projectPath: string | null;
  api: RequirementsApi;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  toast: (options: ToastOptions) => void;
  t: TFunction;
}

/**
 * Shared dependency gate for every way a profile can start affecting a
 * project: summon, project-default activation, and an existing Session switch.
 *
 * It fails closed when the preview itself fails. Profiles without `requires`
 * produce an empty successful preview, so allowing a preview error only hid
 * genuine IPC/storage failures and created partially configured Sessions.
 */
export async function ensureDigitalHumanRequirements({
  name,
  projectPath,
  api,
  confirm,
  toast,
  t,
}: EnsureDigitalHumanRequirementsOptions): Promise<boolean> {
  if (!projectPath) {
    toast({ message: t("digitalHumans.pickProject"), variant: "error" });
    return false;
  }

  let preview: Awaited<ReturnType<RequirementsApi["previewProfileRequirements"]>>;
  const target = requireProjectConfigurationTarget(projectPath);
  try {
    preview = await api.previewProfileRequirements(name, target);
  } catch (error) {
    toast({
      message: t("digitalHumans.requirements.checkFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
      variant: "error",
    });
    return false;
  }

  if (!preview.needsInstall && preview.blockers.length === 0) return true;
  const detail = [...preview.willRun, ...preview.warnings, ...preview.blockers].join("\n");

  if (!preview.needsInstall) {
    const accepted = await confirm({
      title: t("digitalHumans.requirements.blockedTitle"),
      message: t("digitalHumans.requirements.blockedMessage"),
      detail,
      confirmLabel: t("common.confirm"),
    });
    // External tools cannot be installed by the Skill installer. The warning
    // is explicit, but the profile itself remains usable for unaffected work.
    return accepted;
  }

  const accepted = await confirm({
    title: t("digitalHumans.requirements.installTitle"),
    message: t("digitalHumans.requirements.installMessage"),
    detail,
    confirmLabel: t("digitalHumans.requirements.install"),
  });
  if (!accepted) return false;

  try {
    const result = await api.installProfileRequirements(name, target);
    if (result.ok) return true;
    toast({
      message: t("digitalHumans.requirements.installFailed", {
        error: result.errors.join("; "),
      }),
      variant: "error",
    });
    return false;
  } catch (error) {
    toast({
      message: t("digitalHumans.requirements.installFailed", {
        error: error instanceof Error ? error.message : String(error),
      }),
      variant: "error",
    });
    return false;
  }
}
