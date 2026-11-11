import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useT } from "../../i18n";
import type { PetNoticeChannel, PetNoticeSystemRule } from "../../../shared/pet-notices";
import { usePetNoticesState, type NoticesReadApi } from "./usePetNoticesState";

function channelText(
  rule: PetNoticeSystemRule,
  channels: PetNoticeChannel[],
  t: ReturnType<typeof useT>["t"],
): string {
  if (rule.channel === "auto") return t("mimiSettings.rules.channelAuto");
  if (rule.channel === "desktop") return t("mimiSettings.rules.channelDesktop");
  const label = channels.find((channel) => channel.id === rule.channel)?.label ?? rule.channel;
  return t("mimiSettings.rules.channelIm", { channel: label });
}

/**
 * 规则与跟进, read-only for now: the "every Session" rule main reports, and
 * where the other reminders are set. Its switch lives in 通知与主动.
 */
export function RulesSection({
  onOpenNotifications,
  api,
}: {
  onOpenNotifications: () => void;
  api?: NoticesReadApi;
}) {
  const { t } = useT();
  const notices = usePetNoticesState(api);
  const rule = notices.state?.systemRule ?? null;
  return (
    <Card data-pet-setting="rules" className="rounded-2xl">
      <CardContent className="grid gap-4 p-6 max-[480px]:p-4">
        {notices.loadState === "loading" || (notices.loadState === "ready" && !rule) ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("ext.common.loading")}
          </p>
        ) : !rule ? (
          <div className="grid gap-2">
            <p role="alert" className="text-sm text-status-err [overflow-wrap:anywhere]">
              {t("ext.common.loadFailed", { error: notices.loadError })}
            </p>
            <Button type="button" className="justify-self-start" onClick={notices.reload}>
              {t("ext.common.retry")}
            </Button>
          </div>
        ) : (
          <ul className="grid gap-2">
            <li
              data-pet-rule="system"
              data-state={rule.state}
              className="flex flex-wrap items-start gap-3 rounded-xl border border-border/70 px-4 py-3"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t("mimiSettings.rules.systemTitle")}</span>
                  <Badge variant={rule.state === "active" ? "success" : "warning"}>
                    {rule.state === "active"
                      ? t("mimiSettings.rules.active")
                      : t("mimiSettings.rules.paused")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("mimiSettings.rules.events", {
                    events: rule.events
                      .map((event) => t(`mimiSettings.rules.event.${event}`))
                      .join(t("mimiSettings.rules.eventSeparator")),
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {channelText(rule, notices.state?.channels ?? [], t)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("mimiSettings.rules.toggleHint")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-pet-rules-open-notifications
                onClick={onOpenNotifications}
              >
                {t("mimiSettings.rules.openNotifications")}
              </Button>
            </li>
          </ul>
        )}
        <p className="text-xs leading-5 text-muted-foreground">
          {t("mimiSettings.rules.sessionNote")}
        </p>
      </CardContent>
    </Card>
  );
}
