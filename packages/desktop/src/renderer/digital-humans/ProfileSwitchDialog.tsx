import { X } from "lucide-react";
import { useDialogFocus } from "../ui/useDialogFocus";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProfileSwitchSourceSummary } from "../../shared/profile-switch";
import { useT } from "../i18n/I18nProvider";
import type { useProfileSwitch } from "./useProfileSwitch";

/** Recovery stays inside the two existing Profile sections, even with an empty library. */
export function ProfileSwitchRecovery({
  controller,
}: {
  controller: ReturnType<typeof useProfileSwitch>;
}) {
  const { t } = useT();
  if (!controller.unavailableDefault) return null;
  return (
    <div
      className="space-y-2 rounded-md border border-border p-3"
      data-testid="profile-switch-recovery"
    >
      <p className="text-sm">
        {t("digitalHumans.switchPreview.unavailableDefault", {
          name: controller.unavailableDefault.name,
        })}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={controller.busy}
        onClick={(event) => void controller.open(null, event.currentTarget)}
      >
        {t("settingsX.profiles.deactivate")}
      </Button>
    </div>
  );
}

/** Both existing project-default entry points render this same review. */
export function ProfileSwitchDialog({
  controller,
}: {
  controller: ReturnType<typeof useProfileSwitch>;
}) {
  const { t } = useT();
  const preview = controller.preview;
  const dialogFocus = useDialogFocus(!!preview, controller.opener, controller.focusLease);
  if (!preview) return null;
  const fallback = t("digitalHumans.switchPreview.fallback");
  const off = t("digitalHumans.switchPreview.off");
  const on = t("digitalHumans.switchPreview.on");
  const unknown = t("digitalHumans.switchPreview.unknown");
  const sourceText = (source: ProfileSwitchSourceSummary) =>
    `${source.label}: ${source.scopes.join(", ") || "—"} · ${t(`digitalHumans.switchPreview.${source.readPolicy}`)} · ${t(`digitalHumans.switchPreview.${source.status}`)}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
    >
      <DialogContent
        ref={dialogFocus.contentRef}
        data-dialog-focus-owner={dialogFocus.focusOwnerId}
        onCloseAutoFocus={dialogFocus.onCloseAutoFocus}
        showClose={false}
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="profile-switch-preview"
      >
        <DialogHeader className="shrink-0 flex-row items-start justify-between gap-3 space-y-0 border-b border-border/70 px-5 py-4 [@media(max-height:32rem)]:px-4 [@media(max-height:32rem)]:py-3">
          <div className="min-w-0">
            <DialogTitle className="text-base leading-6">
              {t("digitalHumans.switchPreview.title")}
            </DialogTitle>
            <DialogDescription className="mt-1.5 [@media(max-height:32rem)]:sr-only">
              {t("digitalHumans.switchPreview.description")}
            </DialogDescription>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={t("digitalHumans.close")}
            aria-disabled={controller.adopting}
            onClick={controller.close}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </DialogHeader>
        <div
          data-dialog-scroll
          role="region"
          tabIndex={0}
          aria-label={t("digitalHumans.switchPreview.title")}
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5 text-sm [overflow-wrap:anywhere] [@media(max-height:32rem)]:p-3"
        >
          <p className="hidden text-xs leading-5 text-muted-foreground [@media(max-height:32rem)]:block">
            {t("digitalHumans.switchPreview.description")}
          </p>
          <p>
            {t(
              preview.target.kind === "session"
                ? "digitalHumans.switchPreview.sessionRoot"
                : "digitalHumans.switchPreview.projectRoot",
            )}
          </p>
          <p className="font-medium">
            {preview.before?.label ?? fallback} → {preview.after?.label ?? fallback}
          </p>
          <p>{t("digitalHumans.switchPreview.scope")}</p>
          <dl className="space-y-2 rounded-md border border-border p-3">
            <div>
              <dt className="font-medium">{t("digitalHumans.switchPreview.instruction")}</dt>
              <dd>
                {preview.instruction.changed === null ? (
                  unknown
                ) : (
                  <>
                    {t(
                      preview.instruction.changed
                        ? "digitalHumans.switchPreview.changed"
                        : "digitalHumans.switchPreview.unchanged",
                    )}{" "}
                    · {preview.instruction.beforeLength}
                  </>
                )}{" "}
                → {preview.instruction.afterLength}
              </dd>
            </div>
            <div>
              <dt className="font-medium">{t("digitalHumans.portableMemory")}</dt>
              <dd>
                {preview.before?.available === false ? unknown : (preview.memory.before ?? off)} →{" "}
                {preview.memory.after ?? off}
              </dd>
            </div>
          </dl>
          <section>
            <h3 className="font-medium">{t("digitalHumans.switchPreview.capabilities")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("digitalHumans.switchPreview.configurationOnly")}
            </p>
            {preview.capabilities.length ? (
              <ul className="mt-2 space-y-1">
                {preview.capabilities.map((item) => (
                  <li key={`${item.kind}:${item.name}`}>
                    {item.kind}: {item.name} · {item.before ? on : off} → {item.after ? on : off}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("digitalHumans.switchPreview.noChanges")}</p>
            )}
            {preview.exclusiveSkillsOnly ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("digitalHumans.switchPreview.exclusive")}
              </p>
            ) : null}
          </section>
          {preview.missingDeclarations.length ? (
            <section>
              <h3 className="font-medium">{t("digitalHumans.switchPreview.missing")}</h3>
              <ul>
                {preview.missingDeclarations.map((item) => (
                  <li key={`${item.kind}:${item.name}`}>
                    {item.kind}: {item.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="space-y-2">
            <h3 className="font-medium">{t("digitalHumans.switchPreview.sources")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("digitalHumans.switchPreview.sourcesHint")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["before", "after"] as const).map((side) => (
                <div key={side}>
                  <h4 className="text-xs font-medium">
                    {t(`digitalHumans.switchPreview.${side}`)}
                  </h4>
                  {preview.sources[side].length ? (
                    <ul className="mt-1 space-y-1 break-words">
                      {preview.sources[side].map((source) => (
                        <li key={source.sourceId}>{sourceText(source)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>—</p>
                  )}
                </div>
              ))}
            </div>
          </section>
          <p className="text-xs text-muted-foreground">
            {t("digitalHumans.switchPreview.admission")}
          </p>
          {controller.error ? (
            <p role="alert" className="text-status-err">
              {controller.error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border/70 px-5 py-3 [@media(max-height:32rem)]:px-3 [@media(max-height:32rem)]:py-2">
          <Button variant="outline" disabled={controller.adopting} onClick={controller.close}>
            {t("common.cancel")}
          </Button>
          <Button
            aria-disabled={controller.adopting}
            aria-busy={controller.adopting}
            onClick={() => void controller.adopt()}
          >
            {t("digitalHumans.switchPreview.adopt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
