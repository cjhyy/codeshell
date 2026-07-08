import React from "react";
import { Plus } from "lucide-react";
import type { CatalogEntry } from "../../preload/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { ConnCard, ConnCardFooter, ConnCardGrid } from "./connUi";
import { SignupLink } from "./SignupLink";
import type { SttFallback } from "./useModelConnections";

export interface ConnectionsEmptyStateProps {
  heading: string;
  sttFallback: SttFallback | null;
  textTemplates: CatalogEntry[];
  onAddFromTemplate: (entry: CatalogEntry, model?: string) => Promise<void>;
}

export function ConnectionsEmptyState({
  heading,
  sttFallback,
  textTemplates,
  onAddFromTemplate,
}: ConnectionsEmptyStateProps) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {sttFallback
          ? t("settingsX.textConn.sttFallbackListHint")
          : t("settingsX.textConn.emptyHint", { heading })}
      </p>
      {sttFallback && (
        <ConnCardGrid>
          <ConnCard isDefault>
            <header className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-status-ok" />
                <strong className="truncate text-sm font-medium text-foreground">
                  {sttFallback.reusedCredentialCatalogId ?? "OpenAI"}
                </strong>
                <Badge variant="accent">{t("settingsX.textConn.sttFallbackActive")}</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {sttFallback.model && (
                  <code className="break-all font-mono">{sttFallback.model}</code>
                )}
                {sttFallback.maskedKey && (
                  <>
                    <span>·</span>
                    <code className="font-mono">key ⋯{sttFallback.maskedKey}</code>
                  </>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("settingsX.textConn.sttFallbackDesc", {
                  model: sttFallback.model ?? "",
                  cred: sttFallback.reusedCredentialCatalogId ?? "OpenAI",
                  key: sttFallback.maskedKey ?? "",
                })}
              </p>
            </header>
          </ConnCard>
        </ConnCardGrid>
      )}
      {textTemplates.length > 0 && (
        <ConnCardGrid>
          {textTemplates.map((entry) => (
            <ConnCard key={entry.id}>
              <header className="flex items-start justify-between gap-2">
                <strong className="text-sm font-medium text-foreground">{entry.displayName}</strong>
                {entry.needsKey !== false && <SignupLink url={entry.signupUrl} />}
              </header>
              {entry.description && (
                <p className="text-xs leading-relaxed text-muted-foreground">{entry.description}</p>
              )}
              {entry.defaultModel && (
                <p className="text-xs text-muted-foreground">
                  <span className="opacity-70">{t("settingsX.textConn.defaultModelLabel")}</span>{" "}
                  <code className="rounded bg-muted px-1 py-0.5">{entry.defaultModel}</code>
                </p>
              )}
              <ConnCardFooter>
                <Button variant="solid" size="sm" onClick={() => void onAddFromTemplate(entry)}>
                  <Plus />
                  {t("settingsX.textConn.add")}
                </Button>
              </ConnCardFooter>
            </ConnCard>
          ))}
        </ConnCardGrid>
      )}
    </div>
  );
}
