import { Card, CardContent } from "@/components/ui/card";
import {
  PetNotificationsFields,
  usePetNotificationsController,
  type NoticesApi,
  type SettingsWriter,
} from "./PetNotificationsFields";

/** 通知与主动: quiet hours, push budget, delegated results, the system rule, IM channels. */
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
    <Card data-pet-setting="notifications" className="rounded-2xl">
      <CardContent className="p-6 max-[480px]:p-4">
        <PetNotificationsFields controller={controller} onManageChannels={onManageChannels} />
      </CardContent>
    </Card>
  );
}
