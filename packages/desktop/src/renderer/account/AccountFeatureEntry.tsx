import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { AccountFeatureView } from "../../shared/account-features.js";
import { useT } from "../i18n";
import { openAccountSettings } from "./useAccountFeature";

/** Keep unavailable actions consistent without disabling their separate setup controls. */
export function AccountFeatureEntry({
  feature,
  label,
  children,
  onSignIn = openAccountSettings,
  onPending,
  className,
}: {
  feature: AccountFeatureView;
  label: string;
  children: ReactNode;
  onSignIn?: () => void;
  /** Open setup/status only; business operations still require the Host's ready gate. */
  onPending?: () => void;
  className?: string;
}) {
  const { t } = useT();
  if (feature.state === "hidden") return null;
  if (feature.state === "ready") return <>{children}</>;
  const detail =
    feature.state === "sign-in"
      ? t("accountFeatures.signIn")
      : t(`accountFeatures.${feature.reason ?? "pending"}`);
  return (
    <Button
      type="button"
      variant="outline"
      className={["h-auto max-w-full flex-wrap whitespace-normal text-left", className]
        .filter(Boolean)
        .join(" ")}
      data-account-feature={feature.id}
      data-account-feature-state={feature.state}
      aria-label={label}
      title={detail}
      disabled={feature.state === "pending" && !onPending}
      onClick={() => {
        if (feature.state === "sign-in") onSignIn();
        else if (feature.state === "pending") onPending?.();
      }}
    >
      <span>{label}</span>
      <span className="text-xs font-normal">{detail}</span>
    </Button>
  );
}
