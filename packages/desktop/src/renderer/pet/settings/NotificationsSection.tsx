import { Card, CardContent } from "@/components/ui/card";
import {
  PetNotificationsFields,
  usePetNotificationsController,
  type NoticesApi,
  type SettingsWriter,
} from "./PetNotificationsFields";
import { PetProactiveFields } from "./PetProactiveFields";

/**
 * 通知与主动: quiet hours, push budget, delegated results, the system rule,
 * IM channels; then 主动 (briefs, heartbeat, digest slots). One controller,
 * so both cards share the draft and its touched-only writes.
 */
export function NotificationsSection({
  onManageChannels,
  api,
  write,
}: {
  /** Jump to 消息连接, where the channels listed here are bound. */
  onManageChannels?: () => void;
  api?: NoticesApi;
  write?: SettingsWriter;
}) {
  const controller = usePetNotificationsController({
    ...(api ? { api } : {}),
    ...(write ? { write } : {}),
  });
  return (
    <div className="grid gap-4">
      <Card data-pet-setting="notifications" className="rounded-2xl">
        <CardContent className="p-6 max-[480px]:p-4">
          <PetNotificationsFields controller={controller} onManageChannels={onManageChannels} />
        </CardContent>
      </Card>
      {controller.loadState === "ready" && controller.draft && (
        <Card data-pet-setting="proactive" className="rounded-2xl">
          <CardContent className="p-6 max-[480px]:p-4">
            <PetProactiveFields controller={controller} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
