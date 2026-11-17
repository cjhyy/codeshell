import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
export function AccountDeviceEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useT();
  return (
    <Button variant="ghost" className="mb-1 w-full justify-start" onClick={onOpen}>
      {t("accountFeatures.devices")}
    </Button>
  );
}
