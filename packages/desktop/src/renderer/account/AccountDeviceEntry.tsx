import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
import { useAccountFeature } from "./useAccountFeature";
import { AccountFeatureEntry } from "./AccountFeatureEntry";
export function AccountDeviceEntry({
  onOpen,
  onSignIn,
}: {
  onOpen: () => void;
  onSignIn: () => void;
}) {
  const feature = useAccountFeature("devices.dispatch");
  const { t } = useT();
  return (
    <AccountFeatureEntry
      feature={feature}
      label={t("accountFeatures.devices")}
      onSignIn={onSignIn}
      onPending={onOpen}
      className="mb-1 h-auto w-full flex-wrap justify-start"
    >
      <Button variant="ghost" className="mb-1 w-full justify-start" onClick={onOpen}>
        {t("accountFeatures.devices")}
      </Button>
    </AccountFeatureEntry>
  );
}
