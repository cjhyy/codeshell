import { Bot, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PanelAppPreview } from "../../preload/types";
import { useT } from "../i18n/I18nProvider";

interface Props {
  busy: boolean;
  action: "install" | "update";
  preview: PanelAppPreview;
  onCancel: () => void;
  onInstall: () => void;
}

export function PanelAppInstallReviewDialog({ busy, action, preview, onCancel, onInstall }: Props) {
  const { t } = useT();

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        className="max-h-[88vh] max-w-xl overflow-hidden p-0"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle>
            {action === "update" ? t("ext.panels.reviewUpdateTitle") : t("ext.panels.reviewTitle")}
          </DialogTitle>
          <DialogDescription>
            {action === "update"
              ? t("ext.panels.reviewUpdateDescription")
              : t("ext.panels.reviewDescription")}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="text-base font-semibold text-foreground">{preview.title.default}</span>
            <Badge variant="secondary">{preview.id}</Badge>
            <Badge variant="outline">v{preview.version}</Badge>
          </div>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {preview.alreadyInstalled && action === "install" && (
            <div className="flex gap-2 rounded-lg border border-status-warn/40 bg-status-warn/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
              <span>{t("ext.panels.reviewAlreadyInstalled")}</span>
            </div>
          )}

          <section className="space-y-2 rounded-lg border bg-muted/15 p-3">
            <div className="text-sm font-medium">{t("ext.panels.reviewPackage")}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">{t("ext.panels.reviewSource")}</dt>
              <dd className="truncate">{preview.source.label}</dd>
              <dt className="text-muted-foreground">{t("ext.panels.reviewEntry")}</dt>
              <dd className="truncate font-mono">{preview.entry}</dd>
              <dt className="text-muted-foreground">{t("ext.panels.reviewMode")}</dt>
              <dd>
                {preview.singleton ? t("ext.panels.singleton") : t("ext.panels.multiInstance")}
              </dd>
            </dl>
            {preview.description && (
              <p className="text-xs text-muted-foreground">{preview.description}</p>
            )}
          </section>

          <section className="space-y-2 rounded-lg border bg-muted/15 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              {t("ext.panels.reviewPermissions")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preview.permissions.length === 0 ? (
                <Badge variant="outline">{t("ext.panels.noPermissions")}</Badge>
              ) : (
                preview.permissions.map((permission) => (
                  <Badge key={permission} variant="outline">
                    {permission}
                  </Badge>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("ext.panels.reviewIsolation")}</p>
          </section>

          <section className="space-y-2 rounded-lg border bg-muted/15 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bot className="h-4 w-4 text-muted-foreground" />
              {t("ext.panels.reviewAgent")}
            </div>
            {!preview.agent ||
            (preview.agent.tools.length === 0 && preview.agent.skills.length === 0) ? (
              <Badge variant="outline">{t("ext.panels.reviewAgentNone")}</Badge>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {preview.agent.tools.map((tool) => (
                    <Badge key={tool.name} variant={tool.readOnly ? "secondary" : "warning"}>
                      {tool.name}
                    </Badge>
                  ))}
                  {preview.agent.skills.map((skill) => (
                    <Badge key={skill} variant="outline">
                      {skill.split("/").at(-2) ?? skill}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("ext.panels.reviewAgentIsolation")}
                </p>
              </>
            )}
          </section>
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t("ext.panels.reviewCancel")}
          </Button>
          <Button type="button" disabled={busy} onClick={onInstall}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {busy && action === "update"
              ? t("ext.panels.applyingUpdate")
              : action === "update"
                ? t("ext.panels.reviewUpdate")
                : t("ext.panels.reviewInstall")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
