import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useLocalhostPorts } from "./useLocalhostPorts";

/** New-tab landing: discovered localhost dev servers as quick-open cards. */
export function NewTabLanding({ onOpen }: { onOpen: (url: string) => void }) {
  const { t } = useT();
  const ports = useLocalhostPorts();
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{t("panels.browser.local")}</span>
      </div>
      {ports.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t("panels.browser.noLocalServers")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {ports.map((p) => (
            <Button
              key={p}
              type="button"
              onClick={() => onOpen(`http://localhost:${p}`)}
              variant="outline"
              className="flex h-auto items-center gap-3 rounded-lg p-3 text-left"
            >
              <Globe className="h-5 w-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">localhost:{p}</div>
                <div className="truncate text-xs text-muted-foreground">http://localhost:{p}</div>
              </div>
              <span className="h-2 w-2 shrink-0 rounded-full bg-status-ok" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
