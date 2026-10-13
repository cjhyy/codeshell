import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { getPanelAppPermissionCopy } from "./panelAppPermissions";

interface PermissionListProps {
  permissions: readonly string[];
  addedPermissions?: readonly string[];
  removedPermissions?: readonly string[];
  reconfirmAdded?: boolean;
}

/** Describes package declarations; it does not infer runtime usage or grants. */
export function PanelAppPermissionList({
  permissions,
  addedPermissions = [],
  removedPermissions = [],
  reconfirmAdded = false,
}: PermissionListProps) {
  const { t } = useT();
  const added = new Set(addedPermissions);
  const rows = [
    ...permissions.map((permission) => ({ permission, removed: false })),
    ...removedPermissions.map((permission) => ({ permission, removed: true })),
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("ext.panels.declaredPermissionsHint")}</p>
      {permissions.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("ext.panels.noPermissions")}</p>
      )}
      {rows.length > 0 && (
        <ul
          className="divide-y rounded-md border"
          aria-label={t("ext.panels.declaredHostCapabilities")}
        >
          {rows.map(({ permission, removed }) => {
            const copy = getPanelAppPermissionCopy(permission, t);
            return (
              <li key={permission} className="space-y-1 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-foreground">{copy.label}</span>
                  {removed ? (
                    <Badge variant="secondary">{t("ext.panels.removedPermission")}</Badge>
                  ) : added.has(permission) ? (
                    <Badge variant="warning">
                      {t(
                        reconfirmAdded
                          ? "ext.panels.reconfirmPermission"
                          : "ext.panels.addedPermission",
                      )}
                    </Badge>
                  ) : null}
                  {copy.label !== permission && (
                    <code className="break-all text-[11px] text-muted-foreground">
                      {permission}
                    </code>
                  )}
                </div>
                <p className="break-words text-xs leading-relaxed text-muted-foreground">
                  {copy.description}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface AgentCapabilitiesProps {
  agent?: {
    tools: readonly { name: string; description?: string; readOnly?: boolean }[];
    skills: readonly string[];
  };
  nativeEntries?: Record<string, { entry: string; sha256: string }>;
}

export function PanelAppAgentCapabilities({ agent, nativeEntries }: AgentCapabilitiesProps) {
  const { t } = useT();
  const tools = agent?.tools ?? [];
  const skills = agent?.skills ?? [];
  const entries = Object.entries(nativeEntries ?? {});
  if (!tools.length && !skills.length && !entries.length) {
    return <p className="text-xs text-muted-foreground">{t("ext.panels.reviewAgentNone")}</p>;
  }
  return (
    <div className="space-y-3">
      {tools.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">
            {t("ext.panels.agentTools")} · {tools.length}
          </h4>
          <p className="text-xs text-muted-foreground">{t("ext.panels.agentToolsHint")}</p>
          <ul className="divide-y rounded-md border" aria-label={t("ext.panels.agentTools")}>
            {tools.map((tool) => (
              <li key={tool.name} className="space-y-1 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-xs text-foreground">{tool.name}</code>
                  <Badge variant={tool.readOnly ? "secondary" : "warning"}>
                    {t(tool.readOnly ? "ext.panels.toolReadOnly" : "ext.panels.toolMayWrite")}
                  </Badge>
                </div>
                <p className="break-words text-xs leading-relaxed text-muted-foreground">
                  {tool.description || t("ext.panels.toolDescriptionUnavailable")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {skills.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">
            {t("ext.panels.agentSkills")} · {skills.length}
          </h4>
          <ul className="space-y-2 rounded-md border p-3" aria-label={t("ext.panels.agentSkills")}>
            {skills.map((skill) => {
              const name = skill.split("/").at(-2) ?? skill;
              return (
                <li key={skill} className="space-y-1 text-xs">
                  <span className="break-all font-medium text-foreground">{name}</span>
                  {name !== skill && (
                    <code className="block break-all text-[11px] text-muted-foreground">
                      {skill}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {entries.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">
            {t("ext.panels.nativeTools")} · {entries.length}
          </h4>
          <p className="text-xs text-muted-foreground">{t("ext.panels.nativeToolsHint")}</p>
          <ul className="space-y-2 rounded-md border p-3" aria-label={t("ext.panels.nativeTools")}>
            {entries.map(([name, entry]) => (
              <li key={name} className="space-y-1 text-xs">
                <span className="break-all font-medium text-foreground">{name}</span>
                <code className="block break-all text-[11px] text-muted-foreground">
                  {entry.entry}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Shared installed-package view for Extensions and project Settings. */
export function PanelAppCapabilities({
  permissions,
  agent,
  nativeEntries,
}: Pick<PermissionListProps, "permissions"> & AgentCapabilitiesProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <div className="mt-2 min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-1.5 text-xs"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {t("ext.panels.capabilityDetails")}
        <Badge variant="outline">{permissions.length}</Badge>
      </Button>
      {expanded && (
        <div id={id} className="mt-2 space-y-4 rounded-lg border bg-muted/15 p-3">
          <section className="space-y-2">
            <h3 className="text-xs font-medium">{t("ext.panels.declaredHostCapabilities")}</h3>
            <PanelAppPermissionList permissions={permissions} />
          </section>
          <PanelAppAgentCapabilities agent={agent} nativeEntries={nativeEntries} />
        </div>
      )}
    </div>
  );
}
