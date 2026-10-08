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

/** Both existing project-default entry points render this same review. */
export function ProfileSwitchDialog({
  controller,
}: {
  controller: ReturnType<typeof useProfileSwitch>;
}) {
  const { t } = useT();
  const preview = controller.preview;
  if (!preview) return null;
  const fallback = t("digitalHumans.switchPreview.fallback");
  const off = t("digitalHumans.switchPreview.off");
  const on = t("digitalHumans.switchPreview.on");
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
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="profile-switch-preview"
      >
        <DialogHeader>
          <DialogTitle>{t("digitalHumans.switchPreview.title")}</DialogTitle>
          <DialogDescription>{t("digitalHumans.switchPreview.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
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
                {t(
                  preview.instruction.changed
                    ? "digitalHumans.switchPreview.changed"
                    : "digitalHumans.switchPreview.unchanged",
                )}{" "}
                · {preview.instruction.beforeLength} → {preview.instruction.afterLength}
              </dd>
            </div>
            <div>
              <dt className="font-medium">{t("digitalHumans.portableMemory")}</dt>
              <dd>
                {preview.memory.before ?? off} → {preview.memory.after ?? off}
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
        <DialogFooter>
          <Button variant="outline" disabled={controller.adopting} onClick={controller.close}>
            {t("common.cancel")}
          </Button>
          <Button disabled={controller.adopting} onClick={() => void controller.adopt()}>
            {t("digitalHumans.switchPreview.adopt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
