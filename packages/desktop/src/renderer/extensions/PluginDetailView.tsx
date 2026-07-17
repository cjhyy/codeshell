import { useEffect, useState } from "react";
import type { PluginDetail, PluginMediaDto } from "../../preload/types";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  TerminalSquare,
  Bot,
  Webhook,
  Plug,
  Puzzle,
  PanelTop,
  ExternalLink,
  Images,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Clock3,
} from "lucide-react";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import {
  changePluginHookApproval,
  changePluginMcpApproval,
  pluginLegalLinks,
  pluginLogoSources,
  pluginScreenshotDataUrls,
  summarizePluginHookApproval,
  type PluginLegalLinkKind,
} from "./pluginPresentation";
import { signalHotReload } from "./applyUpdates";
import { useConfirm } from "../ui/DialogProvider";
import { requestComposerSeed } from "../chat/composerSeed";

/**
 * Plugin detail (feedback#15: 插件列表只显 "N skills",看不到里面有啥) —
 * read-only inventory of everything one plugin contributes: skills /
 * commands / agents / hooks / MCP servers. Same list→detail pattern as
 * MarketList→MarketDetail.
 */
export function PluginDetailView({
  installKey,
  cwd,
  onBack,
}: {
  installKey: string;
  cwd: string;
  onBack: () => void;
}) {
  const { t } = useT();
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<PluginMediaDto | null>(null);
  const [hookAction, setHookAction] = useState<"approve" | "revoke" | null>(null);
  const [mcpAction, setMcpAction] = useState<"approve" | "revoke" | null>(null);
  const [automationAction, setAutomationAction] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    setMedia(null);
    Promise.all([
      window.codeshell.getPluginDetail(installKey),
      window.codeshell.getPluginMedia(installKey, true).catch(() => null),
    ])
      .then(([d, nextMedia]) => {
        if (!alive) return;
        setDetail(d);
        setMedia(nextMedia);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(String((e as Error)?.message ?? e));
      });
    return () => {
      alive = false;
    };
  }, [installKey]);

  if (error)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("ext.common.loadFailed", { error })}
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          {t("ext.common.back")}
        </Button>
      </div>
    );
  if (!loaded)
    return <div className="p-4 text-sm text-muted-foreground">{t("ext.common.loading")}</div>;
  if (!detail)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("ext.pluginDetail.notFound")}
        <Button size="sm" variant="outline" className="ml-2" onClick={onBack}>
          {t("ext.common.back")}
        </Button>
      </div>
    );

  const { content } = detail;
  const logoSources = pluginLogoSources(media);
  const screenshots = pluginScreenshotDataUrls(media);
  const legalLinks = pluginLegalLinks(detail);
  const hookApproval = summarizePluginHookApproval(content.hooks);
  const total =
    content.skills.length +
    content.commands.length +
    content.agents.length +
    content.hooks.length +
    content.mcpServers.length +
    content.automationTemplates.length +
    content.panels.length;

  const changeHookApproval = async (action: "approve" | "revoke") => {
    setHookAction(action);
    try {
      await changePluginHookApproval(window.codeshell, action, installKey);
      signalHotReload();
      setDetail(await window.codeshell.getPluginDetail(installKey));
      toast({
        message:
          action === "approve"
            ? t("ext.pluginDetail.hookApprovalApprovedToast")
            : t("ext.pluginDetail.hookApprovalRevokedToast"),
        variant: "success",
      });
    } catch (cause) {
      toast({
        message: t("ext.pluginDetail.hookApprovalFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
      });
    } finally {
      setHookAction(null);
    }
  };

  const changeMcpApproval = async (action: "approve" | "revoke") => {
    setMcpAction(action);
    try {
      await changePluginMcpApproval(window.codeshell, action, installKey);
      signalHotReload();
      setDetail(await window.codeshell.getPluginDetail(installKey));
      toast({
        message:
          action === "approve"
            ? t("ext.pluginDetail.mcpApprovalApprovedToast")
            : t("ext.pluginDetail.mcpApprovalRevokedToast"),
        variant: "success",
      });
    } catch (cause) {
      toast({
        message: t("ext.pluginDetail.mcpApprovalFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
      });
    } finally {
      setMcpAction(null);
    }
  };

  const createAutomation = async (
    template: PluginDetail["content"]["automationTemplates"][number],
  ) => {
    const title = navigator.language.toLowerCase().startsWith("zh")
      ? (template.title["zh-CN"] ?? template.title.default)
      : (template.title.en ?? template.title.default);
    const approved = await confirm({
      title: t("ext.pluginDetail.automationConfirmTitle"),
      message: t("ext.pluginDetail.automationConfirmMessage", {
        name: title,
        schedule: template.schedule,
        permission: t(`ext.pluginDetail.automationPermission.${template.permissionLevel}`),
        workspace:
          template.workspace === "current"
            ? t("ext.pluginDetail.automationWorkspace.current")
            : t("ext.pluginDetail.automationWorkspace.none"),
      }),
      confirmLabel: t("ext.pluginDetail.automationCreate"),
      destructive: template.permissionLevel === "full",
    });
    if (!approved) return;
    setAutomationAction(template.id);
    try {
      await window.codeshell.createAutomationFromPluginTemplate(
        installKey,
        template.id,
        template.revision,
        template.workspace === "current" ? cwd : undefined,
      );
      toast({
        message: t("ext.pluginDetail.automationCreatedToast", { name: title }),
        variant: "success",
      });
    } catch (cause) {
      toast({
        message: t("ext.pluginDetail.automationCreateFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
        variant: "error",
      });
    } finally {
      setAutomationAction(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          ‹ {t("ext.common.back")}
        </button>
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background text-muted-foreground"
          style={
            detail.brandColor
              ? { borderColor: detail.brandColor, color: detail.brandColor }
              : undefined
          }
        >
          {logoSources.light ? (
            <>
              <img
                src={logoSources.light}
                alt={detail.displayName}
                className={`h-full w-full object-contain p-1.5 ${
                  logoSources.dark && logoSources.dark !== logoSources.light ? "dark:hidden" : ""
                }`}
              />
              {logoSources.dark && logoSources.dark !== logoSources.light && (
                <img
                  src={logoSources.dark}
                  alt={detail.displayName}
                  className="hidden h-full w-full object-contain p-1.5 dark:block"
                />
              )}
            </>
          ) : (
            <Puzzle className="h-5 w-5" aria-hidden="true" />
          )}
        </span>
        <span className="font-semibold">{detail.displayName}</span>
        <span className="text-xs text-muted-foreground">
          {detail.version} · {detail.sourceLabel}
        </span>
      </div>
      {(detail.displayName !== detail.name || detail.developerName || detail.category) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {detail.displayName !== detail.name && (
            <code className="rounded bg-muted px-1.5 py-0.5">{detail.name}</code>
          )}
          {detail.developerName && <span>{detail.developerName}</span>}
          {detail.category && (
            <span className="rounded bg-muted px-1.5 py-0.5">{detail.category}</span>
          )}
        </div>
      )}
      {(detail.longDescription || detail.description) && (
        <p className="text-xs leading-5 text-muted-foreground">
          {detail.longDescription ?? detail.description}
        </p>
      )}
      {legalLinks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {legalLinks.map((link) => (
            <Button
              key={link.kind}
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => {
                void window.codeshell.openExternal(link.url).catch(() => {
                  toast({
                    message: t("ext.pluginDetail.legalOpenFailed"),
                    variant: "error",
                  });
                });
              }}
            >
              <ExternalLink className="h-3 w-3" />
              {t(legalLinkLabel(link.kind))}
            </Button>
          ))}
        </div>
      )}
      {detail.capabilities && detail.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {detail.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {capability}
            </span>
          ))}
        </div>
      )}
      {hookApproval && (
        <section
          className={`flex flex-wrap items-center gap-2 rounded-md border p-3 ${
            hookApproval === "changed"
              ? "border-status-err/50 bg-status-err/5"
              : hookApproval === "pending"
                ? "border-status-warn/50 bg-status-warn/5"
                : "bg-muted/20"
          }`}
        >
          {hookApproval === "approved" ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-status-ok" />
          ) : (
            <ShieldAlert
              className={`h-4 w-4 shrink-0 ${
                hookApproval === "changed" ? "text-status-err" : "text-status-warn"
              }`}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">
              {t(`ext.pluginDetail.hookApproval.${hookApproval}.title`)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t(`ext.pluginDetail.hookApproval.${hookApproval}.description`)}
            </div>
          </div>
          {hookApproval === "pending" && (
            <Button
              type="button"
              size="sm"
              variant="solid"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={hookAction !== null}
              onClick={() => void changeHookApproval("approve")}
            >
              {hookAction === "approve" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("ext.pluginDetail.approveHooks")}
            </Button>
          )}
          {(hookApproval === "approved" || hookApproval === "legacy") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={hookAction !== null}
              onClick={() => void changeHookApproval("revoke")}
            >
              {hookAction === "revoke" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("ext.pluginDetail.revokeHooks")}
            </Button>
          )}
        </section>
      )}
      {(hookApproval === "pending" || hookApproval === "changed") && content.hookReview && (
        <section className="rounded-md border p-3">
          <div className="mb-1 text-xs font-medium">{t("ext.pluginDetail.hookDiffTitle")}</div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {content.hookReview.baselineAvailable
              ? t("ext.pluginDetail.hookDiffBaseline")
              : t("ext.pluginDetail.hookDiffNoBaseline")}
          </p>
          <ul className="space-y-2">
            {content.hookReview.items.map((item, index) => {
              const hook = item.current ?? item.previous;
              if (!hook) return null;
              return (
                <li
                  key={`${item.change}:${hook.rawEvent}:${hook.commandDigest}:${index}`}
                  className="rounded bg-muted/30 p-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        item.change === "removed"
                          ? "text-[10px] font-medium text-status-err"
                          : item.change === "unchanged"
                            ? "text-[10px] font-medium text-muted-foreground"
                            : "text-[10px] font-medium text-status-warn"
                      }
                    >
                      {t(`ext.pluginDetail.hookDiffChange.${item.change}`)}
                    </span>
                    <span className="rounded bg-muted px-1 font-mono text-[10px]">
                      {hook.rawEvent}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {t("ext.pluginDetail.hookDiffMatcher", {
                        matcher: hook.matcher || t("ext.pluginDetail.hookDiffAll"),
                      })}
                    </span>
                  </div>
                  {item.change === "changed" && item.previous && item.current ? (
                    <div className="mt-1 grid gap-1 font-mono text-[11px]">
                      <div className="break-all text-status-err">− {item.previous.command}</div>
                      <div className="break-all text-status-ok">+ {item.current.command}</div>
                    </div>
                  ) : (
                    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {hook.command}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {detail.mcpTrust && detail.mcpTrust.status !== "none" && (
        <section
          className={`flex flex-wrap items-center gap-2 rounded-md border p-3 ${
            detail.mcpTrust.status === "changed"
              ? "border-status-err/50 bg-status-err/5"
              : detail.mcpTrust.status === "pending"
                ? "border-status-warn/50 bg-status-warn/5"
                : "bg-muted/20"
          }`}
        >
          {detail.mcpTrust.status === "approved" ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-status-ok" />
          ) : (
            <ShieldAlert
              className={`h-4 w-4 shrink-0 ${
                detail.mcpTrust.status === "changed" ? "text-status-err" : "text-status-warn"
              }`}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">
              {t(`ext.pluginDetail.mcpApproval.${detail.mcpTrust.status}.title`)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t(`ext.pluginDetail.mcpApproval.${detail.mcpTrust.status}.description`, {
                count: detail.mcpTrust.serverNames.length,
              })}
            </div>
          </div>
          {detail.mcpTrust.status === "pending" && (
            <Button
              type="button"
              size="sm"
              variant="solid"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={mcpAction !== null}
              onClick={() => void changeMcpApproval("approve")}
            >
              {mcpAction === "approve" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("ext.pluginDetail.approveMcp")}
            </Button>
          )}
          {(detail.mcpTrust.status === "approved" || detail.mcpTrust.status === "legacy") && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={mcpAction !== null}
              onClick={() => void changeMcpApproval("revoke")}
            >
              {mcpAction === "revoke" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t("ext.pluginDetail.revokeMcp")}
            </Button>
          )}
        </section>
      )}
      {detail.defaultPrompt && detail.defaultPrompt.length > 0 && (
        <Section
          icon={<Sparkles className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.starterPromptsTitle")}
        >
          {detail.defaultPrompt.map((prompt, index) => (
            <li key={`${index}-${prompt}`} className="flex items-start gap-2">
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {prompt}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1 px-2 text-xs"
                onClick={() => {
                  if (
                    requestComposerSeed({
                      text: prompt,
                      source: "plugin-starter-prompt",
                    })
                  ) {
                    toast({
                      message: t("ext.pluginDetail.starterPromptAddedToast"),
                      variant: "success",
                    });
                  }
                }}
              >
                <Sparkles className="h-3 w-3" />
                {t("ext.pluginDetail.starterPromptUse")}
              </Button>
            </li>
          ))}
        </Section>
      )}
      {screenshots.length > 0 && (
        <section className="rounded-md border p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Images className="h-3.5 w-3.5" />
            {t("ext.pluginDetail.screenshotsTitle", { count: screenshots.length })}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {screenshots.map((src, index) => (
              <img
                key={`${index}-${src.slice(-24)}`}
                src={src}
                alt={t("ext.pluginDetail.screenshotAlt", { index: index + 1 })}
                className="w-full rounded-md border bg-muted/20 object-contain"
                loading="lazy"
              />
            ))}
          </div>
        </section>
      )}
      {total === 0 && screenshots.length === 0 && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          {t("ext.pluginDetail.empty")}
        </div>
      )}

      {content.skills.length > 0 && (
        <Section
          icon={<Sparkles className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.skillsTitle", { count: content.skills.length })}
        >
          {content.skills.map((s) => (
            <li key={s.name} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs">{s.name}</span>
              {s.description && (
                <span className="truncate text-xs text-muted-foreground">{s.description}</span>
              )}
            </li>
          ))}
        </Section>
      )}

      {content.commands.length > 0 && (
        <Section
          icon={<TerminalSquare className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.commandsTitle", { count: content.commands.length })}
        >
          {content.commands.map((c) => (
            <li key={c} className="font-mono text-xs">
              /{c}
            </li>
          ))}
        </Section>
      )}

      {content.agents.length > 0 && (
        <Section
          icon={<Bot className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.agentsTitle", { count: content.agents.length })}
        >
          {content.agents.map((a) => (
            <li key={a} className="font-mono text-xs">
              {a}
            </li>
          ))}
        </Section>
      )}

      {content.hooks.length > 0 && (
        <Section
          icon={<Webhook className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.hooksTitle", { count: content.hooks.length })}
        >
          {content.hooks.map((h, i) => (
            <li key={`${h.rawEvent}-${i}`} className="flex items-baseline gap-2">
              <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                {h.rawEvent}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">{h.command}</span>
              <span
                className={
                  h.approval === "changed"
                    ? "shrink-0 text-[10px] text-status-err"
                    : h.approval === "approved"
                      ? "shrink-0 text-[10px] text-status-ok"
                      : "shrink-0 text-[10px] text-status-warn"
                }
              >
                {t(`ext.pluginDetail.hookApprovalLabel.${h.approval}`)}
              </span>
            </li>
          ))}
        </Section>
      )}

      {content.mcpServers.length > 0 && (
        <Section
          icon={<Plug className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.mcpTitle", { count: content.mcpServers.length })}
        >
          {content.mcpServers.map((m) => (
            <li key={m} className="flex items-baseline gap-2">
              <span className="font-mono text-xs">{m}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("ext.pluginDetail.mcpDisplayAs", { name: detail.name, server: m })}
              </span>
            </li>
          ))}
        </Section>
      )}

      {content.automationTemplates.length > 0 && (
        <Section
          icon={<Clock3 className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.automationTemplatesTitle", {
            count: content.automationTemplates.length,
          })}
        >
          {content.automationTemplates.map((template) => {
            const title = navigator.language.toLowerCase().startsWith("zh")
              ? (template.title["zh-CN"] ?? template.title.default)
              : (template.title.en ?? template.title.default);
            return (
              <li key={template.id} className="rounded-md border bg-muted/20 p-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{title}</div>
                    {template.description && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {template.description}
                      </div>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                        {template.schedule}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {t(`ext.pluginDetail.automationPermission.${template.permissionLevel}`)}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5">
                        {t(`ext.pluginDetail.automationWorkspace.${template.workspace}`)}
                      </span>
                    </div>
                    <div className="mt-2 text-[10px] font-medium text-muted-foreground">
                      {t("ext.pluginDetail.automationPromptLabel")}
                    </div>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px]">
                      {template.prompt}
                    </pre>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                    disabled={automationAction !== null}
                    onClick={() => void createAutomation(template)}
                  >
                    {automationAction === template.id && (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    {t("ext.pluginDetail.automationUseTemplate")}
                  </Button>
                </div>
              </li>
            );
          })}
        </Section>
      )}

      {content.panels.length > 0 && (
        <Section
          icon={<PanelTop className="h-3.5 w-3.5" />}
          title={t("ext.pluginDetail.panelsTitle", { count: content.panels.length })}
        >
          {content.panels.map((panel) => (
            <li key={panel.id} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs">{panel.id}</span>
              <span className="truncate text-xs text-muted-foreground">
                {panel.title.default}
                {panel.permissions.length > 0
                  ? ` · ${t("ext.pluginDetail.panelPermissions", { permissions: panel.permissions.join(", ") })}`
                  : ` · ${t("ext.pluginDetail.panelNoPermissions")}`}
              </span>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function legalLinkLabel(
  kind: PluginLegalLinkKind,
):
  | "ext.pluginDetail.website"
  | "ext.pluginDetail.privacyPolicy"
  | "ext.pluginDetail.termsOfService" {
  if (kind === "privacy") return "ext.pluginDetail.privacyPolicy";
  if (kind === "terms") return "ext.pluginDetail.termsOfService";
  return "ext.pluginDetail.website";
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {title}
      </div>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}
