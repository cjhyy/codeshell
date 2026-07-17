import { AlertTriangle, Info, Loader2, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

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
import type { LocalPluginPreview } from "../../preload/types";
import type { TranslationKey } from "../i18n/dict";
import { useT } from "../i18n/I18nProvider";

interface Props {
  busy: boolean;
  onCancel: () => void;
  onInstall: () => void;
  preview: LocalPluginPreview;
}

function ReviewSection({
  children,
  count,
  title,
}: {
  children: ReactNode;
  count?: number;
  title: string;
}) {
  return (
    <section className="space-y-2 rounded-lg border bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">
        <span>{title}</span>
        {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      </div>
      {children}
    </section>
  );
}

function warningTranslationKey(
  kind: LocalPluginPreview["warnings"][number]["kind"],
): TranslationKey {
  switch (kind) {
    case "executable-hooks":
      return "ext.plugins.reviewWarnings.executable-hooks";
    case "stdio-mcp":
      return "ext.plugins.reviewWarnings.stdio-mcp";
    case "network-mcp":
      return "ext.plugins.reviewWarnings.network-mcp";
    case "panel-permissions":
      return "ext.plugins.reviewWarnings.panel-permissions";
    case "automation-templates":
      return "ext.plugins.reviewWarnings.automation-templates";
    case "external-links":
      return "ext.plugins.reviewWarnings.external-links";
    case "media":
      return "ext.plugins.reviewWarnings.media";
  }
}

function NameList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="outline" className="max-w-full truncate font-normal">
          {value}
        </Badge>
      ))}
    </div>
  );
}

export function PluginInstallReviewDialog({ busy, onCancel, onInstall, preview }: Props) {
  const { t } = useT();
  const media = [
    preview.interface.media.composerIcon,
    preview.interface.media.logo,
    preview.interface.media.logoDark,
    ...preview.interface.media.screenshots,
  ].filter((value): value is string => Boolean(value));

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-hidden p-0"
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle>{t("ext.plugins.reviewTitle")}</DialogTitle>
          <DialogDescription>{t("ext.plugins.reviewDescription")}</DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="text-base font-semibold text-foreground">{preview.name}</span>
            <Badge variant="secondary">{preview.format}</Badge>
            <Badge variant="outline">{preview.version ?? t("ext.plugins.reviewNoVersion")}</Badge>
            <span className="truncate text-xs text-muted-foreground">{preview.source.label}</span>
          </div>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto px-5 py-4">
          {preview.alreadyInstalled && (
            <div className="flex gap-2 rounded-lg border border-status-warn/40 bg-status-warn/10 p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
              <span>
                {t("ext.plugins.reviewAlreadyInstalled", {
                  version: preview.installedVersion ?? t("ext.plugins.reviewNoVersion"),
                })}
              </span>
            </div>
          )}

          {preview.warnings.map((warning) => (
            <div
              key={warning.kind}
              className="flex gap-2 rounded-lg border bg-muted/20 p-2.5 text-xs"
            >
              {warning.severity === "warning" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span>{t(warningTranslationKey(warning.kind), { count: warning.count })}</span>
            </div>
          ))}

          <div className="grid gap-3 md:grid-cols-3">
            <ReviewSection title={t("ext.plugins.reviewSkills")} count={preview.skills.length}>
              {preview.skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {preview.skills.map((skill) => (
                    <li key={skill.name}>
                      <span className="font-medium">{skill.name}</span>
                      {skill.description && (
                        <span className="text-muted-foreground"> — {skill.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </ReviewSection>
            <ReviewSection title={t("ext.plugins.reviewCommands")} count={preview.commands.length}>
              <NameList values={preview.commands} empty={t("ext.plugins.reviewNone")} />
            </ReviewSection>
            <ReviewSection title={t("ext.plugins.reviewAgents")} count={preview.agents.length}>
              <NameList values={preview.agents} empty={t("ext.plugins.reviewNone")} />
            </ReviewSection>
          </div>

          <ReviewSection title={t("ext.plugins.reviewHooks")} count={preview.hooks.length}>
            {preview.hooks.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
            ) : (
              <ul className="space-y-2">
                {preview.hooks.map((hook, index) => (
                  <li key={`${hook.event}:${index}`} className="rounded border bg-background p-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{hook.event}</Badge>
                      {hook.matcher && (
                        <Badge variant="outline">
                          {t("ext.plugins.reviewMatcher", { matcher: hook.matcher })}
                        </Badge>
                      )}
                    </div>
                    <code className="mt-1.5 block break-all text-xs text-foreground">
                      {hook.command}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </ReviewSection>

          <ReviewSection title={t("ext.plugins.reviewMcp")} count={preview.mcpServers.length}>
            {preview.mcpServers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {preview.mcpServers.map((server) => (
                  <li key={server.name} className="rounded border bg-background p-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{server.name}</span>
                      <Badge variant="outline">{server.transport}</Badge>
                    </div>
                    {(server.command || server.url) && (
                      <code className="mt-1.5 block break-all">{server.command ?? server.url}</code>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </ReviewSection>

          <ReviewSection title={t("ext.plugins.reviewPanels")} count={preview.panels.length}>
            {preview.panels.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {preview.panels.map((panel) => (
                  <li key={panel.id} className="rounded border bg-background p-2">
                    <div className="font-medium">
                      {panel.title.default}{" "}
                      <span className="text-muted-foreground">({panel.id})</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{panel.entry}</div>
                    <div className="mt-1">
                      {panel.permissions.length > 0
                        ? t("ext.plugins.reviewPermissions", {
                            permissions: panel.permissions.join(", "),
                          })
                        : t("ext.plugins.reviewNoPermissions")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ReviewSection>

          <ReviewSection
            title={t("ext.plugins.reviewAutomations")}
            count={preview.automationTemplates.length}
          >
            {preview.automationTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {preview.automationTemplates.map((template) => (
                  <li key={template.id} className="rounded border bg-background p-2">
                    <div className="font-medium">
                      {template.title.default}{" "}
                      <span className="text-muted-foreground">({template.id})</span>
                    </div>
                    {template.description && (
                      <div className="mt-1 text-muted-foreground">{template.description}</div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge variant="outline">{template.schedule}</Badge>
                      <Badge variant="outline">{template.permissionLevel}</Badge>
                      <Badge variant="outline">{template.workspace}</Badge>
                    </div>
                    <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[11px]">
                      {template.prompt}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </ReviewSection>

          <div className="grid gap-3 md:grid-cols-2">
            <ReviewSection
              title={t("ext.plugins.reviewExternalLinks")}
              count={preview.interface.externalLinks.length}
            >
              {preview.interface.externalLinks.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("ext.plugins.reviewNone")}</p>
              ) : (
                <ul className="space-y-1 break-all text-xs">
                  {preview.interface.externalLinks.map((link) => (
                    <li key={link.kind}>
                      <span className="font-medium">{link.kind}</span>: {link.url}
                    </li>
                  ))}
                </ul>
              )}
            </ReviewSection>
            <ReviewSection title={t("ext.plugins.reviewMedia")} count={media.length}>
              <NameList values={media} empty={t("ext.plugins.reviewNone")} />
            </ReviewSection>
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("ext.plugins.reviewCancel")}
          </Button>
          <Button variant="solid" onClick={onInstall} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t("ext.plugins.reviewInstall")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
